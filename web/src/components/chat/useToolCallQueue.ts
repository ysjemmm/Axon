/**
 * useToolCallQueue —— tool_call 渲染队列 hook（从 useChatSession 拆出）
 *
 * 当 AI 一次返回多个 tool_call 时，后端串行执行但事件在同一 microtask batch 到达前端，
 * React 批量 setState 导致多个卡片"同时弹出"。此队列让 tool_call 卡片按序逐个入场：
 * 每插入一张卡片后等 ~150ms（入场动画播完），再处理队列中的下一个。
 */

import { useRef, useCallback, useEffect } from "react";
import type { WsMessage } from "@/hooks/useWebSocket";
import type { EventHandlerCtx } from "./eventHandlers/types";

export interface ToolCallQueueApi {
  /** 拦截 tool_call，让创建新卡片的事件排队；其他事件直接透传 */
  wrap: (
    handleEvent: (msg: WsMessage) => void,
    ctx: EventHandlerCtx,
  ) => (msg: WsMessage) => void;
  /** 清空队列（会话切换时） */
  reset: () => void;
}

export function useToolCallQueue(): ToolCallQueueApi {
  const queue = useRef<WsMessage[]>([]);
  const processing = useRef(false);

  const reset = useCallback(() => {
    queue.current = [];
    processing.current = false;
  }, []);

  useEffect(() => {
    return () => {
      queue.current = [];
      processing.current = false;
    };
  }, []);

  const wrap = useCallback(
    (handleEvent: (msg: WsMessage) => void, ctx: EventHandlerCtx) => {
      const processQueue = () => {
        const next = queue.current.shift();
        if (!next) {
          processing.current = false;
          return;
        }
        if (ctx.cancelled.current) {
          queue.current = [];
          processing.current = false;
          return;
        }
        handleEvent(next);
        if (queue.current.length > 0) {
          setTimeout(() => processQueue(), 150);
        } else {
          processing.current = false;
        }
      };

      return (msg: WsMessage) => {
        if (msg.type === "tool_call" && msg.name !== "delegate_task") {
          const msgStatus = (msg as any).status as string | undefined;
          const shouldQueue = !msgStatus || msgStatus === "pending";
          if (shouldQueue) {
            queue.current.push(msg);
            if (!processing.current) {
              processing.current = true;
              processQueue();
            }
            return;
          }
        }
        handleEvent(msg);
      };
    },
    [],
  );

  return { wrap, reset };
}
