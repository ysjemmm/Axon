/**
 * useToolCallQueue —— 事件渲染队列 hook（从 useChatSession 拆出）
 *
 * 当 AI 一次返回多个 tool_call 时，多个卡片事件可能在同一 microtask batch 到达前端，
 * React 批量 setState 导致多个卡片"同时弹出"。此队列让卡片按序逐个入场。
 *
 * ⚠️ 重要：所有事件都进队列（不只是 tool_call）。
 * 如果只延迟 tool_call 而 tool_result 直接透传，快速执行的工具（如 read_file 几毫秒）
 * 会导致 tool_result 先于 tool_call 处理 → 找不到 pending 段 → fallback 创建重复段 + 乱序。
 * 即使 command 工具可以并发，单个调用自己的 tool_call → tool_result 因果顺序仍必须保留。
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
import { DRAIN_TIMEOUT_MS } from "./useTypewriter";

/** 处理完这些事件后留一个间隔，让卡片逐个入场而不是齐刷刷弹出 */
const PACED_EVENTS = new Set<string>([
  AGENT_EVENT.TOOL_CALL,
  AGENT_EVENT.TOOL_RESULT,
  AGENT_EVENT.SUB_AGENT_START,
  AGENT_EVENT.SUB_AGENT_END,
]);

/** 卡片入场间隔 */
const CARD_GAP_MS = 80;

/** 等待打字机排空时的轮询间隔 */
const DRAIN_POLL_MS = 16;

/**
 * 卡片等待文字讲完的上限。超过就放行，避免模型吐字极多时卡片迟迟不出来。
 * 与 useTypewriter 的 DRAIN_TIMEOUT_MS 配套：drain 在该时长内必然排空（超时会一次倒出），
 * 这里多留一点余量给最后一帧写入。
 */
const CARD_WAIT_MAX_MS = DRAIN_TIMEOUT_MS + 200;

/**
 * 文字"写进消息"到"画到屏幕上"之间的延迟。
 * 打字机排空只代表字已写入 chatHistory；MarkdownRenderer 还要等一个解析节流窗口
 * （PARSE_THROTTLE_MS = 32ms）才真正重绘。卡片不经过这层节流，
 * 所以排空后立刻放行卡片，卡片仍会比最后一批字早画出来一拍。多等一个节流窗口 + 一帧。
 * ⚠️ 与 MarkdownRenderer 的 PARSE_THROTTLE_MS 配套。
 */
const TEXT_PAINT_LAG_MS = 32 + 16;

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
        // ── 卡片必须等前面的文字讲完再出 ──
        //
        // 早先只在 `draining`（收到 stream_pause 之后）才拦卡片。可后端在**流式阶段**
        // 就会为工具提前发卡（onToolCallDetected：工具名刚解析出来、参数还在流），
        // 而 stream_pause 要等整条流消费完才发 —— 最早那张卡片到达时打字机还在常态出字，
        // 闸门没关，卡片直接插在半截句子后面："我觉得应该这 | 样子做 + 卡片"一起冒出来。
        // handleToolCall 里虽然也会补一次 drain，但那是卡片**已经出队渲染**之后，晚了。
        //
        // 所以判据改成"打字机里还有没出完的字"，并在出队**之前**主动触发排空：
        // 卡片一到，文字加速讲完（drain 最多 400ms），讲完卡片再出。
        // 只拦卡片：status / token_usage / reasoning_delta 等与排版无关，照常放行。
        if (head && PACED_EVENTS.has(head.type as string)) {
          const tw = ctx.typewriter;
          if (tw.hasPending() || tw.draining.current) {
            const since = (head as { __waitSince?: number }).__waitSince ??= performance.now();
            if (performance.now() - since < CARD_WAIT_MAX_MS) {
              if (!tw.draining.current) tw.drain(ctx);
              setTimeout(processQueue, DRAIN_POLL_MS);
              return;
            }
          }
          // 刚等过排空（说明卡片前面确实有文字）→ 再等文字真正画到屏幕上
          const waited = head as { __waitSince?: number; __paintWaited?: boolean };
          if (waited.__waitSince !== undefined && !waited.__paintWaited) {
            waited.__paintWaited = true;
            setTimeout(processQueue, TEXT_PAINT_LAG_MS);
            return;
          }
        }
        const next = queue.current.shift();
        if (!next) {
          processing.current = false;
          return;
        }
        // ⚠️ 这里【不能】按 ctx.cancelled.current 丢弃事件（曾经有过这段，正是本 bug 的根源）。
        // cancelled 只在「下一轮发消息」(sendNow) 或新流开始 (handleStreamStart) 时才复位，
        // 而它在用户点「停止」时被置 true —— 于是从取消那一刻起、到下一条消息为止，
        // 期间到达的**所有**事件都被这段吞掉。压缩事件（compacting_start/end）不属于任何一轮，
        // 后端明明在压、前端却收不到，表现为"点了手动压缩但界面毫无反应"。
        // 本轮残留事件本就由各 handler 自己的 cancelled 守卫过滤
        // （stream_delta/pause/end、tool_call/result、sub_agent_* 都带守卫），
        // 队列只负责保序，不做取消语义判断。
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
