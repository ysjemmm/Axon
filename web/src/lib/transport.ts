/**
 * 传输层抽象 —— 让同一份 React UI 同时跑在两种形态下
 *
 *  - 浏览器（server 形态）：REST 走 fetch，Agent 流走 WebSocket
 *  - VS Code webview（IDE 形态）：两者都走 webview.postMessage（与扩展宿主的 SessionHub 通信）
 *
 * 组件与 apiClient / useWebSocket 只依赖本模块暴露的统一原语，不感知底层是 HTTP/WS 还是 postMessage。
 *
 * 协议（webview 形态）：
 *  - REST 请求：UI → 扩展  { __axonReq: true, id, method, path, body }
 *               扩展 → UI  { __axonRes: true, id, ok, data?, error? }
 *  - Agent 控制指令：UI → 扩展  ControlCommand（{type:"user_message",...} 等，无包裹）
 *  - Agent 事件：    扩展 → UI  AgentEvent（{type:"stream_delta",...} 等，无包裹）
 */

import { API_BASE, WS_BASE } from "./api";

/** VS Code webview 注入的 API（仅在 webview 环境存在） */
interface VSCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    acquireVsCodeApi?: () => VSCodeApi;
    __axonVSCode?: VSCodeApi;
  }
}

/** 惰性获取 vscode webview api（acquireVsCodeApi 每个会话只能调用一次，需缓存） */
function getVSCodeApi(): VSCodeApi | null {
  if (typeof window === "undefined") return null;
  if (window.__axonVSCode) return window.__axonVSCode;
  if (typeof window.acquireVsCodeApi === "function") {
    window.__axonVSCode = window.acquireVsCodeApi();
    return window.__axonVSCode;
  }
  return null;
}

/** 当前是否运行在 VS Code webview 中 */
export const isVSCode = getVSCodeApi() !== null;

// ── webview 形态：统一的 message 监听与分发 ───────────────────────────────

type AgentEventHandler = (event: Record<string, unknown>) => void;

const agentEventHandlers = new Set<AgentEventHandler>();
const pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let reqSeq = 0;
let messageListenerBound = false;

/** 绑定 webview 的全局 message 监听（只绑一次）：分流 REST 应答与 Agent 事件 */
function ensureWebviewListener(): void {
  if (messageListenerBound || typeof window === "undefined") return;
  messageListenerBound = true;
  window.addEventListener("message", (e: MessageEvent) => {
    const data = e.data;
    if (!data || typeof data !== "object") return;

    // REST 应答
    if (data.__axonRes === true && typeof data.id === "string") {
      const pending = pendingRequests.get(data.id);
      if (pending) {
        pendingRequests.delete(data.id);
        if (data.ok) pending.resolve(data.data);
        else pending.reject(new Error(data.error || "请求失败"));
      }
      return;
    }

    // 其余带 type 的视为 Agent 事件，广播给所有订阅者
    if (typeof data.type === "string") {
      for (const h of agentEventHandlers) h(data as Record<string, unknown>);
    }
  });
}

// ── REST 请求统一入口 ─────────────────────────────────────────────────────

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * 统一 REST 请求：
 *  - 浏览器：fetch(API_BASE + path)
 *  - webview：postMessage 请求 + requestId 应答配对
 */
export async function apiRequest<T = unknown>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const vscode = getVSCodeApi();
  if (vscode) {
    ensureWebviewListener();
    const id = `req-${++reqSeq}-${Date.now()}`;
    return new Promise<T>((resolve, reject) => {
      pendingRequests.set(id, { resolve: resolve as (v: unknown) => void, reject });
      vscode.postMessage({ __axonReq: true, id, method, path, body });
      // 超时保护：30s 未应答则拒绝
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error(`请求超时: ${method} ${path}`));
        }
      }, 30_000);
    });
  }

  // 浏览器：fetch
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error((data as { error?: string }).error || `请求失败 (${resp.status})`);
  }
  return data as T;
}

// ── Agent 流（控制指令出站 + 事件入站）────────────────────────────────────

/** Agent 连接句柄：统一 send（发 ControlCommand）与 connected 状态 */
export interface AgentConnection {
  send(cmd: Record<string, unknown>): void;
  /** 订阅 Agent 事件，返回取消订阅函数 */
  subscribe(handler: AgentEventHandler): () => void;
  /** 连接状态变化回调（webview 形态恒为 true） */
  onConnectedChange(cb: (connected: boolean) => void): void;
  close(): void;
}

/** 创建 Agent 连接：webview 用 postMessage，浏览器用 WebSocket（含自动重连） */
export function createAgentConnection(): AgentConnection {
  const vscode = getVSCodeApi();

  if (vscode) {
    // webview 形态：postMessage 通道，恒连接
    ensureWebviewListener();
    let connectedCb: ((c: boolean) => void) | null = null;
    queueMicrotask(() => connectedCb?.(true));
    return {
      send: (cmd) => vscode.postMessage(cmd),
      subscribe: (handler) => {
        agentEventHandlers.add(handler);
        return () => agentEventHandlers.delete(handler);
      },
      onConnectedChange: (cb) => { connectedCb = cb; cb(true); },
      close: () => { /* webview 无需关闭 */ },
    };
  }

  // 浏览器形态：WebSocket + 自动重连
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const handlers = new Set<AgentEventHandler>();
  let connectedCb: ((c: boolean) => void) | null = null;

  const connect = (): void => {
    if (ws) ws.close();
    ws = new WebSocket(`${WS_BASE}/ws`);
    ws.onopen = () => {
      connectedCb?.(true);
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    };
    ws.onclose = () => {
      connectedCb?.(false);
      if (!closed) reconnectTimer = setTimeout(connect, 3000);
    };
    ws.onerror = () => connectedCb?.(false);
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>;
        for (const h of handlers) h(data);
      } catch { /* 忽略非 JSON */ }
    };
  };
  connect();

  return {
    send: (cmd) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
    },
    subscribe: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onConnectedChange: (cb) => { connectedCb = cb; },
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
