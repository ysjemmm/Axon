/**
 * useToolCallQueue —— 事件渲染队列 hook（从 useChatSession 拆出）
 *
 * 当 AI 一次返回多个 tool_call 时，后端串行执行但事件在同一 microtask batch 到达前端，
 * React 批量 setState 导致多个卡片"同时弹出"。此队列让卡片按序逐个入场。
 *
 * ⚠️ 重要：所有事件都进队列（不只是 tool_call）。
 * 如果只延迟 tool_call 而 tool_result 直接透传，快速执行的工具（如 read_file 几毫秒）
 * 会导致 tool_result 先于 tool_call 处理 → 找不到 pending 段 → fallback 创建重复段 + 乱序。
 * 后端是严格串行的（for + await），前端也必须保持事件顺序一致。
 *
 * 但"入队保序"不等于"每条都要等 80ms"：早先的实现对所有事件一律留 80ms 间隔，
 * 把 stream_delta 也限流成了 12 条/秒。打字机每次拿到一小段就把 buffer 吃空、
 * 然后空转等下一条，视觉上就是"一批一批地蹦字"。
 * 现在只有卡片类事件（见 PACED_EVENTS）后面留间隔，其余事件连续放行、由打字机 RAF 自己控速。
 */

import { useRef, useCallback, useEffect } from "react";
import type { WsMessage } from "@/hooks/useWebSocket";
import type { EventHandlerCtx } from "./eventHandlers/types";
import { AGENT_EVENT } from "@/lib/constants";

/** 处理完这些事件后留一个间隔，让卡片逐个入场而不是齐刷刷弹出 */
const PACED_EVENTS = new Set<string>([
  AGENT_EVENT.TOOL_CALL,
  AGENT_EVENT.TOOL_RESULT,
  AGENT_EVENT.SUB_AGENT_START,
  AGENT_EVENT.SUB_AGENT_END,
  AGENT_EVENT.PARALLEL_EXECUTE_START,
  AGENT_EVENT.PARALLEL_RESEARCH_START,
]);

/** 卡片入场间隔 */
const CARD_GAP_MS = 80;

/** 等待打字机排空时的轮询间隔 */
const DRAIN_POLL_MS = 16;

export interface ToolCallQueueApi {
  /** 拦截所有事件，按序逐个处理（卡片类之间留 80ms 间隔） */
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
        const head = queue.current[0];
        // 打字机正在为工具卡片排空文本（stream_pause）→ 让**卡片类**事件等它排完再放行，
        // 否则卡片会插在半截文字后面，正是"文字和卡片一起蹦出来"的观感来源。
        // 只拦卡片：status / token_usage / reasoning_delta 等与排版无关，没必要一起被压
        // 0~400ms（早先不区分类型，等于给整条事件流平白加了一道闸）。
        if (head && PACED_EVENTS.has(head.type as string) && ctx.typewriter.draining.current) {
          setTimeout(processQueue, DRAIN_POLL_MS);
          return;
        }
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
        if (queue.current.length === 0) {
          processing.current = false;
          return;
        }
        // 卡片类事件后留间隔；其余（stream_delta / reasoning_delta / status ...）连续放行
        if (PACED_EVENTS.has(next.type as string)) {
          setTimeout(processQueue, CARD_GAP_MS);
        } else {
          queueMicrotask(processQueue);
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
