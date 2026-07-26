/**
 * useTypewriter —— 打字机效果 hook（从 useChatSession 拆出）
 *
 * 封装流式文本的 buffer + RAF 逐帧出字逻辑。
 * buffer 积压越多出字越快（比例出字），收尾阶段（stream_end）与工具卡片前排空（stream_pause）加速。
 */

import { useRef, useCallback } from "react";
import type { TextSegment } from "./types";

/** 正常出字基准：25 字符/帧，约 60fps → 1500 字/秒 */
const BASE_BATCH = 25;
/** stream_end 收尾出字基准 */
const ENDING_BATCH = 80;
/** stream_pause 排空出字基准（要赶在工具卡片之前出完，比收尾再快些） */
const DRAIN_BATCH = 100;
/** 积压加速：让当前 buffer 在约这么多帧内排完 */
const BACKLOG_FRAMES = 8;
/** 单帧出字上限：再快就不像"打字"而像"贴上去"了 */
const MAX_BATCH = 220;
/** 排空最长等待：超时直接倒出，避免模型吐得多时工具卡片迟迟不出现 */
const DRAIN_TIMEOUT_MS = 400;
/** 写入目标缺失时的重试上限（帧）：约 2 秒，异常状态下兜底放弃，避免无限空转 */
const STASH_MAX_FRAMES = 120;

/** 打字机只需要的最小上下文（解耦循环类型引用，不与 EventHandlerCtx 形成循环依赖） */
export interface TypewriterCtx {
  setChatHistory: React.Dispatch<React.SetStateAction<import("./types").ChatMessage[]>>;
  finishLoading: () => void;
}

export interface TypewriterApi {
  buffer: React.MutableRefObject<string>;
  raf: React.MutableRefObject<number | null>;
  streamEnding: React.MutableRefObject<{ elapsed: number; tokens: number } | null>;
  /** 是否正在为工具卡片排空文本（事件队列据此暂缓放行后续卡片事件） */
  draining: React.MutableRefObject<boolean>;
  start: (ctx: TypewriterCtx) => void;
  /** 加速排空剩余文本；排完（或 400ms 超时）后 draining 自动置回 false */
  drain: (ctx: TypewriterCtx) => void;
  cancel: () => void;
  pause: () => void;
  reset: () => void;
  flush: (ctx: TypewriterCtx) => void;
}

/**
 * 计算本帧出字量：基准值与"按积压量摊到 BACKLOG_FRAMES 帧"取大者。
 * 固定速率的问题是积压时排不动，只能靠 pause/end 瞬间倒出兜底——那一下正是割裂感的来源。
 */
function nextBatchSize(len: number, base: number): number {
  const size = Math.max(base, Math.ceil(len / BACKLOG_FRAMES));
  return Math.min(size, MAX_BATCH, len);
}

/** 从 buffer 头部安全切一批（不切断代理对，避免 emoji 裂成两半） */
function takeBatch(buffer: React.MutableRefObject<string>, base: number): string {
  let size = nextBatchSize(buffer.current.length, base);
  if (size < buffer.current.length) {
    const lastCode = buffer.current.charCodeAt(size - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) size++;
  }
  const batch = buffer.current.slice(0, size);
  buffer.current = buffer.current.slice(size);
  return batch;
}

/**
 * 把一批文字追加到最后一个 text segment。
 * 反向查找而非取末尾：stream_pause 之后末尾可能已经是 tool segment。
 *
 * ⚠️ 这批字在调用前已经被 takeBatch 从 buffer 里取走了，所以这里**绝不能悄悄丢弃**。
 * 早先的实现是 `if (textIdx >= 0) { 追加 }`——找不到 text 段就什么都不做，
 * 那批字就凭空消失了，这正是"工具卡片前的正文被吞掉"的真正来源。
 * 靠给事件之间加延时（等 RAF 把 buffer 排空）只是让它不容易发生，并没有堵住这个洞。
 * 现在找不到就补一个 text 段，任何时序下都不丢字。
 */
function appendToLastText(ctx: TypewriterCtx, batch: string, stash?: (batch: string) => void): void {
  if (!batch) return;
  ctx.setChatHistory((prev) => {
    const updated = [...prev];
    const last = updated[updated.length - 1];
    // 没有可写入的 assistant 消息（本轮还没建段，或末尾已被 user 消息顶掉）。
    // 凭空造一条消息会缺 turnGen 等字段、扰乱轮次匹配，所以先把这批字暂存，
    // 下一帧拼回 buffer 头部重试——绝不能就地丢掉。
    // stash 是幂等赋值，StrictMode 下 updater 被调两次也不会重复暂存。
    if (last?.role !== "assistant" || !last.segments) {
      stash?.(batch);
      return prev;
    }

    const segs = [...last.segments];
    let textIdx = -1;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].type === "text") { textIdx = i; break; }
    }
    if (textIdx >= 0) {
      const textSeg = segs[textIdx];
      segs[textIdx] = { type: "text" as const, content: (textSeg as any).content + batch } as TextSegment;
    } else {
      // 当前消息里还没有 text 段（例如工具卡片先于 stream_start 建段）→ 补一个，而不是丢字
      segs.push({ type: "text", content: batch } as TextSegment);
    }
    updated[updated.length - 1] = { ...last, segments: segs };
    return updated;
  });
}

/** 收尾：把最后一条 assistant 消息标记为完结并挂上本轮统计 */
function finalizeStreaming(ctx: TypewriterCtx, stats: { elapsed: number; tokens: number }): void {
  ctx.setChatHistory((prev) => {
    const updated = [...prev];
    const last = updated[updated.length - 1];
    if (last?.role === "assistant") {
      updated[updated.length - 1] = { ...last, streaming: false, turnStats: stats, turnStatus: "success" };
    }
    return updated;
  });
  ctx.finishLoading();
}

export function useTypewriter(): TypewriterApi {
  const buffer = useRef<string>("");
  const raf = useRef<number | null>(null);
  const streamEnding = useRef<{ elapsed: number; tokens: number } | null>(null);
  const draining = useRef(false);
  /** 写入目标缺失时暂存的那一批字，下一帧拼回 buffer 重试 */
  const stashed = useRef("");
  /** 连续重试帧数，用于在异常状态下兜底放弃（避免无限空转） */
  const stashFrames = useRef(0);

  const stash = useCallback((batch: string) => {
    stashed.current = batch;
  }, []);

  /** 每帧开头调用：把上一帧没写进去的字拼回 buffer 头部，保持原有顺序 */
  const restoreStashed = useCallback(() => {
    if (!stashed.current) {
      stashFrames.current = 0;
      return;
    }
    if (stashFrames.current >= STASH_MAX_FRAMES) {
      console.warn(`[typewriter] 持续找不到可写入的消息，放弃 ${stashed.current.length} 个字符`);
      stashed.current = "";
      stashFrames.current = 0;
      return;
    }
    stashFrames.current++;
    buffer.current = stashed.current + buffer.current;
    stashed.current = "";
  }, []);

  const start = useCallback((ctx: TypewriterCtx) => {
    if (raf.current) cancelAnimationFrame(raf.current);
    streamEnding.current = null;
    draining.current = false;

    const typewriterTick = () => {
      restoreStashed();
      if (buffer.current.length > 0) {
        const base = streamEnding.current ? ENDING_BATCH : BASE_BATCH;
        appendToLastText(ctx, takeBatch(buffer, base), stash);
        raf.current = requestAnimationFrame(typewriterTick);
        return;
      }

      if (streamEnding.current) {
        const stats = streamEnding.current;
        streamEnding.current = null;
        raf.current = null;
        finalizeStreaming(ctx, stats);
        return;
      }
      raf.current = requestAnimationFrame(typewriterTick);
    };

    raf.current = requestAnimationFrame(typewriterTick);
  }, []);

  const drain = useCallback((ctx: TypewriterCtx) => {
    if (raf.current) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
    draining.current = true;
    const startedAt = performance.now();

    const finish = () => {
      raf.current = null;
      draining.current = false;
      // 超时兜底：残余一次性倒出（正常情况下此时 buffer 已空）
      const remaining = buffer.current;
      buffer.current = "";
      appendToLastText(ctx, remaining, stash);
      // 兜底：正常不会发生（事件队列保序，且排空期间暂缓放行，stream_end 排在工具事件之后），
      // 但万一 stream_end 在排空期间被处理过，它看到 raf 非空就只标记了 streamEnding 直接返回，
      // 这里必须补收尾，否则消息会永远停在 streaming 状态。
      if (streamEnding.current) {
        const stats = streamEnding.current;
        streamEnding.current = null;
        finalizeStreaming(ctx, stats);
      }
    };

    const drainTick = () => {
      restoreStashed();
      if (buffer.current.length === 0 || performance.now() - startedAt >= DRAIN_TIMEOUT_MS) {
        finish();
        return;
      }
      appendToLastText(ctx, takeBatch(buffer, DRAIN_BATCH), stash);
      raf.current = requestAnimationFrame(drainTick);
    };

    // 已经排空则不必等一帧，立即结束以免白白拖住工具卡片
    if (buffer.current.length === 0) {
      draining.current = false;
      return;
    }
    raf.current = requestAnimationFrame(drainTick);
  }, []);

  const cancel = useCallback(() => {
    buffer.current = "";
    streamEnding.current = null;
    draining.current = false;
    stashed.current = "";
    stashFrames.current = 0;
    if (raf.current) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
  }, []);

  const pause = useCallback(() => {
    if (raf.current) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
  }, []);

  const reset = cancel;

  const flush = useCallback((ctx: TypewriterCtx) => {
    const remaining = stashed.current + buffer.current;
    stashed.current = "";
    buffer.current = "";
    appendToLastText(ctx, remaining, stash);
  }, [stash]);

  return { buffer, raf, streamEnding, draining, start, drain, cancel, pause, reset, flush };
}
