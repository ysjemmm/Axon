/**
 * useTypewriter —— 打字机效果 hook（从 useChatSession 拆出）
 *
 * 封装流式文本的 buffer + RAF 逐帧出字逻辑。
 * buffer 积压越多出字越快（比例出字），工具卡片前排空与收尾阶段进一步加速。
 *
 * ⚠️ 设计约束：**全程只有一个 RAF 循环**，由 start() 拉起、cancel() 停掉。
 * 「加速排空」（工具卡片前）与「收尾」（stream_end）都只是循环内的速率模式切换，
 * 绝不 cancel 主循环后另起一条 RAF。
 *
 * 早先的实现是 drain() 自己 cancel 主循环、再跑一条独立的 drainTick，两条循环共用
 * raf 这一个 ref，谁都能覆盖对方的句柄，于是漏出三个洞：
 * · drain 结束只置 raf=null 而不恢复主循环 → 之后到达的 stream_delta 全堆在 buffer 里没人消费
 * · drain 的"buffer 已空"捷径直接 return，跳过了收尾检查 → 消息永远停在 streaming
 * · drain 顺手承担收尾（finalizeStreaming），可它也被工具卡片路径调用 →
 *   工具还没执行就把整条消息盖成 success + finishLoading，后续内容继续往"已完结"的消息上追加
 *
 * 现在职责彻底分开：raf 只表示循环句柄，运行状态看 raf!==null，速率看 mode，
 * 收尾只由 finish() 显式请求（对应 stream_end 语义），drain() 永远不碰终态。
 */

import { useRef, useCallback } from "react";
import type { ChatMessage, TextSegment } from "./types";

/** 正常出字基准：25 字符/帧，约 60fps → 1500 字/秒 */
const BASE_BATCH = 25;
/** 收尾（stream_end）出字基准 */
const ENDING_BATCH = 80;
/** 排空（工具卡片前）出字基准：要赶在卡片之前出完，比收尾再快些 */
const DRAIN_BATCH = 100;
/** 积压加速：让当前 buffer 在约这么多帧内排完 */
const BACKLOG_FRAMES = 8;
/** 单帧出字上限：再快就不像"打字"而像"贴上去"了 */
const MAX_BATCH = 220;
/** 排空最长等待：超时直接倒出，避免模型吐得多时工具卡片迟迟不出现 */
const DRAIN_TIMEOUT_MS = 400;
/** 写入目标缺失时的重试上限（帧）：约 2 秒，异常状态下兜底放弃，避免无限空转 */
const STASH_MAX_FRAMES = 120;

/**
 * 出字速率模式。仅影响每帧出字量与排空/收尾的截止条件，不影响循环是否运行。
 * · normal   常态逐帧出字，buffer 空时空转等待下一批 delta
 * · draining 为即将插入的工具卡片加速排空；排完自动回到 normal
 * · ending   本轮已收到 stream_end；排完即标记消息完结并停掉循环
 */
type TypewriterMode = "normal" | "draining" | "ending";

/** 本轮统计（stream_end 携带，收尾时挂到消息上） */
export type TurnStats = NonNullable<ChatMessage["turnStats"]>;

/** 打字机只需要的最小上下文（解耦循环类型引用，不与 EventHandlerCtx 形成循环依赖） */
export interface TypewriterCtx {
  setChatHistory: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  finishLoading: () => void;
}

export interface TypewriterApi {
  /** 追加一批流式文本（stream_delta） */
  push: (text: string) => void;
  /** 是否还有未出字的积压（含暂存待重试的那一批） */
  hasPending: () => boolean;
  /** 是否正在为工具卡片排空文本（事件队列据此暂缓放行卡片事件） */
  draining: React.MutableRefObject<boolean>;
  /** 启动/复用打字机循环（stream_start） */
  start: (ctx: TypewriterCtx) => void;
  /** 加速排空剩余文本，排完（或 400ms 超时）自动回到常态。**不涉及终态** */
  drain: (ctx: TypewriterCtx) => void;
  /** 收尾（stream_end）：排空剩余文本后把消息标记为完结 */
  finish: (ctx: TypewriterCtx, stats: TurnStats) => void;
  /** 立即同步倒出全部积压（不改变模式，不收尾） */
  flush: (ctx: TypewriterCtx) => void;
  /** 丢弃全部积压并停掉循环（取消 / 切换会话） */
  cancel: () => void;
  reset: () => void;
}

/** 各模式下的单帧出字基准 */
function batchBaseFor(mode: TypewriterMode): number {
  if (mode === "draining") return DRAIN_BATCH;
  if (mode === "ending") return ENDING_BATCH;
  return BASE_BATCH;
}

/**
 * 计算本帧出字量：基准值与"按积压量摊到 BACKLOG_FRAMES 帧"取大者。
 * 固定速率的问题是积压时排不动，只能靠瞬间倒出兜底——那一下正是割裂感的来源。
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
 * 反向查找而非取末尾：排空之后末尾可能已经是 tool segment。
 *
 * ⚠️ 这批字在调用前已被 takeBatch 从 buffer 里取走，所以这里**绝不能悄悄丢弃**。
 * 找不到 text 段就补一个；连可写入的 assistant 消息都没有，就交给 stash 下一帧重试。
 */
function appendToLastText(ctx: TypewriterCtx, batch: string, stash: (batch: string) => void): void {
  if (!batch) return;
  ctx.setChatHistory((prev) => {
    const updated = [...prev];
    const last = updated[updated.length - 1];
    // 没有可写入的 assistant 消息（本轮还没建段，或末尾已被 user 消息顶掉）。
    // 凭空造一条消息会缺 turnGen 等字段、扰乱轮次匹配，所以先暂存，下一帧拼回 buffer 头部重试。
    // stash 是幂等赋值，StrictMode 下 updater 被调两次也不会重复暂存。
    if (last?.role !== "assistant" || !last.segments) {
      stash(batch);
      return prev;
    }

    const segs = [...last.segments];
    let textIdx = -1;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (segs[i].type === "text") { textIdx = i; break; }
    }
    if (textIdx >= 0) {
      const textSeg = segs[textIdx] as TextSegment;
      segs[textIdx] = { type: "text", content: textSeg.content + batch };
    } else {
      // 当前消息里还没有 text 段（例如工具卡片先于 stream_start 建段）→ 补一个，而不是丢字
      segs.push({ type: "text", content: batch });
    }
    updated[updated.length - 1] = { ...last, segments: segs };
    return updated;
  });
}

/** 收尾：把最后一条 assistant 消息标记为完结并挂上本轮统计 */
function finalizeStreaming(ctx: TypewriterCtx, stats: TurnStats): void {
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
  const mode = useRef<TypewriterMode>("normal");
  const draining = useRef(false);
  /** draining 模式的截止时刻（performance.now() 基准） */
  const drainDeadline = useRef(0);
  /** ending 模式下待挂载的本轮统计 */
  const endStats = useRef<TurnStats | null>(null);
  /** 写入目标缺失时暂存的那一批字，下一帧拼回 buffer 重试 */
  const stashed = useRef("");
  /** 连续重试帧数，用于在异常状态下兜底放弃（避免无限空转） */
  const stashFrames = useRef(0);
  /**
   * 循环运行期间使用的上下文。
   * 存在 ref 里而非闭包捕获，drain()/finish() 才能在**不重建循环**的前提下改变它的行为。
   */
  const ctxRef = useRef<TypewriterCtx | null>(null);

  const stash = useCallback((batch: string) => {
    stashed.current = batch;
  }, []);

  const hasPending = useCallback(() => buffer.current.length > 0 || stashed.current.length > 0, []);

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

  /**
   * 唯一的逐帧循环。
   * 出字 → 排空/收尾判定 → 决定是继续下一帧还是停下，全部收敛在这里，
   * 外部任何操作都只是改 mode / buffer，不再自行调度 RAF。
   */
  const tick = useCallback(() => {
    const ctx = ctxRef.current;
    if (!ctx) { raf.current = null; return; }

    restoreStashed();

    if (buffer.current.length > 0) {
      // 排空超时：剩余一次性倒出，避免模型吐得多时工具卡片被拖住太久
      if (mode.current === "draining" && performance.now() >= drainDeadline.current) {
        const rest = buffer.current;
        buffer.current = "";
        appendToLastText(ctx, rest, stash);
      } else {
        appendToLastText(ctx, takeBatch(buffer, batchBaseFor(mode.current)), stash);
        raf.current = requestAnimationFrame(tick);
        return;
      }
    }

    // 还有没写进去的字（找不到写入目标）→ 下一帧重试，此时不能判定"已排空"
    if (stashed.current) {
      raf.current = requestAnimationFrame(tick);
      return;
    }

    // 已排空：排空模式回到常态（卡片事件随即被放行）
    if (mode.current === "draining") {
      mode.current = "normal";
      draining.current = false;
    }

    // 已排空且本轮结束 → 收尾并停掉循环
    if (mode.current === "ending") {
      const stats = endStats.current;
      endStats.current = null;
      mode.current = "normal";
      raf.current = null;
      if (stats) finalizeStreaming(ctx, stats);
      return;
    }

    // 常态：空转等待下一批 delta
    raf.current = requestAnimationFrame(tick);
  }, [restoreStashed, stash]);

  /** 循环没在跑就拉起来；已在跑则什么都不做（保证全程只有一条循环） */
  const ensureRunning = useCallback(() => {
    if (raf.current === null) raf.current = requestAnimationFrame(tick);
  }, [tick]);

  const stopLoop = useCallback(() => {
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
  }, []);

  const push = useCallback((text: string) => {
    if (text) buffer.current += text;
  }, []);

  const start = useCallback((ctx: TypewriterCtx) => {
    ctxRef.current = ctx;
    mode.current = "normal";
    draining.current = false;
    endStats.current = null;
    ensureRunning();
  }, [ensureRunning]);

  const drain = useCallback((ctx: TypewriterCtx) => {
    // 收尾优先：已进入 ending 不降级为排空，否则收尾条件永远等不到
    if (mode.current === "ending") return;
    if (!hasPending()) {
      // 无积压：无需排空，也不凭空拉起循环（纯工具轮没有正文流）
      mode.current = "normal";
      draining.current = false;
      return;
    }
    ctxRef.current = ctx;
    mode.current = "draining";
    draining.current = true;
    drainDeadline.current = performance.now() + DRAIN_TIMEOUT_MS;
    ensureRunning();
  }, [ensureRunning, hasPending]);

  const finish = useCallback((ctx: TypewriterCtx, stats: TurnStats) => {
    ctxRef.current = ctx;
    draining.current = false;
    // 无积压：立即收尾，不必多等一帧
    if (!hasPending()) {
      mode.current = "normal";
      endStats.current = null;
      stopLoop();
      finalizeStreaming(ctx, stats);
      return;
    }
    mode.current = "ending";
    endStats.current = stats;
    ensureRunning();
  }, [ensureRunning, hasPending, stopLoop]);

  const flush = useCallback((ctx: TypewriterCtx) => {
    const remaining = stashed.current + buffer.current;
    stashed.current = "";
    stashFrames.current = 0;
    buffer.current = "";
    appendToLastText(ctx, remaining, stash);
  }, [stash]);

  const cancel = useCallback(() => {
    buffer.current = "";
    stashed.current = "";
    stashFrames.current = 0;
    mode.current = "normal";
    draining.current = false;
    endStats.current = null;
    stopLoop();
    ctxRef.current = null;
  }, [stopLoop]);

  return { push, hasPending, draining, start, drain, finish, flush, cancel, reset: cancel };
}
