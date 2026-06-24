/**
 * useToolCallQueue —— 事件渲染队列 hook（从 useChatSession 拆出）
 *
 * 当 AI 一次返回多个 tool_call 时，后端串行执行但事件在同一 microtask batch 到达前端，
 * React 批量 setState 导致多个卡片"同时弹出"。此队列让事件按序逐个处理：
 * 每处理一个事件后等 ~80ms，再处理下一个。
 *
 * ⚠️ 重要：所有事件都进队列（不只是 tool_call）。
 * 如果只延迟 tool_call 而 tool_result 直接透传，快速执行的工具（如 read_file 几毫秒）
 * 会导致 tool_result 先于 tool_call 处理 → 找不到 pending 段 → fallback 创建重复段 + 乱序。
 * 后端是严格串行的（for + await），前端也必须保持事件顺序一致。
 */

import { useRef, useCallback, useEffect } from "react";
import type { WsMessage } from "@/hooks/useWebSocket";
import type { EventHandlerCtx } from "./eventHandlers/types";

export interface ToolCallQueueApi {
  /** 拦截所有事件，按序逐个处理（80ms 间隔） */
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
        // 队列中还有 → 延迟后处理下一个
        if (queue.current.length > 0) {
          setTimeout(() => processQueue(), 80);
        } else {
          processing.current = false;
        }
      };

      // 所有事件都进队列：确保 tool_call 和对应的 tool_result 按序处理，
      // 避免 tool_result 在 tool_call 之前到达导致的乱序和重复。
      return (msg: WsMessage) => {
        queue.current.push(msg);
        if (!processing.current) {
          processing.current = true;
          processQueue();
        }
      };
    },
    [],
  );

  return { wrap, reset };
}
