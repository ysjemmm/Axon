/**
 * 多会话事件总线 —— 按 clientId 把 Agent 事件路由到对应的面板（ChatPanel）
 *
 * 背景：多会话并发下，App 级持有唯一一条 Agent 连接（ws / postMessage），
 * 所有面板共享。后端给每个出站事件打上 `clientId` 标签（事件应送达的面板）。
 * 本总线据此把事件分发给订阅了该 clientId 的面板 handler——
 * 后台 RUNNING 会话的流式事件因此能精确送达其（隐藏但保活的）面板，
 * 切走不中断、切回无缝衔接。
 *
 * 无 clientId 的事件（如工作区文件夹变化广播）广播给所有面板。
 */

import { useEffect, useRef } from "react";
import type { WsMessage } from "./useWebSocket";

type Handler = (msg: WsMessage) => void;

/** 全局事件总线：按 clientId 分发 Agent 事件 */
class SessionEventBus {
  private handlers = new Map<string, Set<Handler>>();

  /** 订阅指定面板（clientId）的事件流，返回取消订阅函数 */
  subscribe(clientId: string, handler: Handler): () => void {
    let set = this.handlers.get(clientId);
    if (!set) {
      set = new Set();
      this.handlers.set(clientId, set);
    }
    set.add(handler);
    return () => {
      const s = this.handlers.get(clientId);
      if (!s) return;
      s.delete(handler);
      if (s.size === 0) this.handlers.delete(clientId);
    };
  }

  /** 分发一条事件：有 clientId 则定向，否则广播给所有面板 */
  dispatch(msg: WsMessage): void {
    const cid = (msg as { clientId?: string }).clientId;
    if (cid) {
      const set = this.handlers.get(cid);
      if (set) set.forEach((h) => h(msg));
      // clientId 有但暂无订阅者：丢弃（面板尚未挂载或已卸载）
      return;
    }
    // 无 clientId 的全局事件：广播给所有面板
    for (const set of this.handlers.values()) {
      set.forEach((h) => h(msg));
    }
  }
}

export const sessionEventBus = new SessionEventBus();

/**
 * Hook：订阅指定面板（clientId）的事件流。
 * handler 用 ref 持有，避免因 handler 引用变化导致频繁重订阅。
 */
export function useSessionEvents(clientId: string, handler: Handler): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!clientId) return;
    return sessionEventBus.subscribe(clientId, (msg) => handlerRef.current(msg));
  }, [clientId]);
}
