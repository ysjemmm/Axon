/**
 * VSCodeChannel —— AgentChannel 的 webview 适配实现（进程内 IDE 形态）
 *
 * 出站：把 AgentEvent 通过 webview.postMessage 推给前端 React UI。
 * 与 server 的 WsChannel 对称——前端消费的事件结构完全一致，因此现有 web UI 无需改动即可复用。
 *
 * 入站（ControlCommand）不在本类：由 webview.onDidReceiveMessage 在扩展入口接收后交给
 * SessionHub.dispatch（与 server 的 ws.on("message") → hub.dispatch 对称）。
 */

import type { Webview } from "vscode";
import type { AgentChannel, AgentEvent } from "@axon/core";

export class VSCodeChannel implements AgentChannel {
  private webview: Webview | null = null;
  private listeners: Array<(event: AgentEvent) => void> = [];

  /** 绑定/重绑当前 webview（视图重建时调用） */
  setWebview(webview: Webview | null): void {
    this.webview = webview;
  }

  /** 注册旁路监听器（扩展层用于监听特定事件如 relay_updated 来刷新树） */
  onEmit(listener: (event: AgentEvent) => void): void {
    this.listeners.push(listener);
  }

  emit(event: AgentEvent): void {
    const wv = this.webview;
    if (!wv) {
      // webview 未就绪时静默丢弃（常见于 VS Code 侧栏折叠/展开重建期间），
      // 但对需要用户交互的事件（confirm_tool_request / confirm_command_request），
      // 上游 waitForToolConfirmation 有 120s 超时兜底，不会永久阻塞。
      console.warn("[VSCodeChannel] webview 为 null，丢弃事件:", event.type);
      return;
    }
    void wv.postMessage(event);
    // 旁路通知
    for (const l of this.listeners) {
      try { l(event); } catch { /* 不阻塞主流程 */ }
    }
  }
}
