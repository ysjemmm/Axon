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
import { markTurnEnd } from "@/lib/turnEndProbe";

/**
 * ── 出字粒度：为什么这些数字比看起来"应该"的小 ──
 *
 * 每帧追加的那一批字是**瞬间从无到有**的：一帧里塞 25 个字，看到的就是"一簇字蹦出来"，
 * 而不是字在流动。批量越大，这种颗粒感越强——积压时旧参数单帧能倒 220 字，那已经不是
 * 打字而是"贴上去"，正是用户描述的"唰的一下出现"。
 *
 * 所以常态批量压到个位数，让相邻两帧的增量小于一个视觉单元；同时把积压加速摊到更多帧上，
 * 避免一波积压把粒度瞬间拉回大批量。
 *
 * 代价是纯粹的吞吐下降（300 字/秒 vs 1500 字/秒）。这个代价可以付：模型实际吐字速度远低于
 * 300 字/秒，常态下 buffer 压根攒不起来，只有长代码块整段到达时才会触发积压加速。
 */

/** 正常出字基准：5 字符/帧，约 60fps → 300 字/秒（远高于模型实际吐字速度） */
const BASE_BATCH = 5;
/**
 * ── 常态节拍（只约束 normal 模式）──
 *
 * 为什么需要：只有每帧上限（MAX_BATCH）而没有节拍时，追赶能冲到上千字/秒，
 * 一屏文字不到 0.2 秒吐完 —— 配合淡入动画也来不及看，就是"一闪而过"。
 *
 * 三个条件一起成立才出字，少一个就坏一头：
 *   · 攒够 PACE_MIN_BATCH 字        → 别出太碎
 *   · 或距首次积压已超 PACE_MAX_WAIT_MS → 慢速时别看着像卡住
 *   · 且距上次出字已过 PACE_BEAT_MS  → 治"一闪而过"
 *
 * ⚠️ 只作用在 normal：ending（收尾挂统计）与 draining（工具卡前让位）是"必须尽快出完"的路径，
 * 一旦被节拍卡住会出现"统计先出现、文字还在吐"或"工具卡插在半个句子里"。
 * 两条红线是靠"根本不经过这个分支"保住的，不是靠调参小心。
 */
const PACE_BEAT_MS = 80;
const PACE_MIN_BATCH = 10;
const PACE_MAX_WAIT_MS = 120;
/**
 * 严重积压时绕过节拍：节拍会让显示速度有硬上限（每批 ≤MAX_BATCH.normal / 每 PACE_BEAT_MS），
 * 模型吐得飞快时积压只会越滚越大、最后模型早停了文字还在吐。
 * 积压超过这个量级说明已经"落后太多"，此时观感让位于追赶 —— 放宽节拍，尽快追上。
 */
const PACE_BACKLOG_ESCAPE = 2000;
/**
 * 收尾（stream_end）出字基准。
 *
 * ⚠️ 收尾不必赶：它后面没有工具卡片在等，唯一在等的是底部统计行。
 * 早先收尾按"16 帧排完积压"、每帧上限 200 字——模型发完时打字机常积压上千字，
 * 于是约 0.3 秒一口气倒完，肉眼就是"前面在一个个淡入，后面唰地整段出来"。
 * 现在收尾按 ENDING_TARGET_MS 摊开：积压少时和常态一样细，积压多时逐步提速，
 * 但总时长封顶在 ENDING_MAX_MS，不会让用户盯着一段已经生成完的文字慢慢爬。
 */
const ENDING_BATCH = 8;
/** 收尾时期望把积压摊在这么长时间里吐完（ms） */
const ENDING_TARGET_MS = 900;
/** 收尾总时长上限（ms）：再长就逐帧放大批量，保证在这个时间内落终态 */
const ENDING_MAX_MS = 1500;
/**
 * 排空（工具卡片前）出字基准与时长。
 *
 * ⚠️ 排空同样按时间摊开，而不是按帧硬倒。早先是"每帧 ≥60 字、16 帧排完"，
 * 常态限速（约 200 字/秒）低于模型吐字速度时，卡片到达那一刻往往积压几百字，
 * 于是约 0.1 秒内整段倒出——几段文字同时出现，240ms 的淡入完全看不出来，
 * 观感就是"这段话一下子冒出来"（实测：1181 字 3.9 秒吐完，卡片到达时积压约 400 字）。
 *
 * 排空时卡片只是"生成中/待执行"占位，晚几百毫秒出现不影响执行，
 * 所以和收尾一样摊到 DRAIN_TARGET_MS，并用 DRAIN_TIMEOUT_MS 封顶。
 */
const DRAIN_BATCH = 8;
/** 排空时期望把积压摊在这么长时间里吐完（ms） */
const DRAIN_TARGET_MS = 600;
/** 积压加速：让当前 buffer 在约这么多帧内排完。帧数越多，追赶越平缓 */
const BACKLOG_FRAMES = 16;

/**
 * 单帧出字上限，**按模式分开**。
 *
 * 早先三个模式共用一个 220 的上限，于是常态下只要有积压就会飙到 220 字/帧——
 * 为「排空要赶在卡片前」「收尾要尽快落终态」这两个特殊需求付的代价，被常态观感一起承担了。
 * 分开之后：常态优先细腻，排空/收尾优先及时，各自不牵累对方。
 */
const MAX_BATCH: Record<TypewriterMode, number> = {
  // 16 字/帧 ≈ 上限 960 字/秒（配合 PACE_BEAT_MS 后实际约 200 字/秒）——
  // 从 48 降下来是治"一闪而过"的一半，另一半是下面的节拍。
  normal: 16,
  draining: 160,
  // 收尾的批量由剩余时间动态决定（见 endingBatchSize），这里只是兜底上限
  ending: 400,
};
/**
 * 排空最长时长：超时直接倒出，避免模型吐得多时工具卡片迟迟不出现。
 * ⚠️ 与 useToolCallQueue 的 CARD_WAIT_MAX_MS 配套（那边要比这里多留余量）。
 */
export const DRAIN_TIMEOUT_MS = 1000;
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
  /** 马上结清当前这段回复：倒出积压，正在收尾的立刻收尾（新一轮开始前调用） */
  settle: (ctx: TypewriterCtx) => void;
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
 * 按"剩余时间里还剩多少帧"摊开积压：离目标时长越近批量越大，过了上限就把剩余全部倒出。
 * 收尾与排空共用——两者都是"必须在限定时间内出完"，但不该一口气倒完。
 */
function timedBatchSize(len: number, elapsedMs: number, base: number, targetMs: number, maxMs: number, cap: number): number {
  if (elapsedMs >= maxMs) return len;
  // 目标时长内按剩余帧数摊；已过目标时长（节拍被拖慢等）就按"到上限还剩几帧"摊，逐步提速
  const remainMs = elapsedMs < targetMs ? targetMs - elapsedMs : maxMs - elapsedMs;
  const framesLeft = Math.max(1, Math.round(remainMs / 16));
  const size = Math.max(base, Math.ceil(len / framesLeft));
  return Math.min(size, cap, len);
}

/**
 * 计算本帧出字量。
 * · ending / draining：按已经过的时长摊开（见 timedBatchSize）
 * · normal：基准值与"按积压量摊到 BACKLOG_FRAMES 帧"取大者，再按模式上限封顶。
 * 固定速率的问题是积压时排不动，只能靠瞬间倒出兜底——那一下正是割裂感的来源。
 */
export function nextBatchSize(len: number, mode: TypewriterMode, elapsedMs = 0): number {
  if (mode === "ending") {
    return timedBatchSize(len, elapsedMs, ENDING_BATCH, ENDING_TARGET_MS, ENDING_MAX_MS, MAX_BATCH.ending);
  }
  if (mode === "draining") {
    return timedBatchSize(len, elapsedMs, DRAIN_BATCH, DRAIN_TARGET_MS, DRAIN_TIMEOUT_MS, MAX_BATCH.draining);
  }
  const size = Math.max(batchBaseFor(mode), Math.ceil(len / BACKLOG_FRAMES));
  return Math.min(size, MAX_BATCH[mode], len);
}

/** 从 buffer 头部安全切一批（不切断代理对，避免 emoji 裂成两半） */
function takeBatch(buffer: React.MutableRefObject<string>, mode: TypewriterMode, elapsedMs = 0): string {
  let size = nextBatchSize(buffer.current.length, mode, elapsedMs);
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
  // ⚠️ 临时诊断：记录收尾窗口内的布局变化（定位偶发闪烁后删除）
  markTurnEnd("回复完成");
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
  /** 进入 draining 模式的时刻：排空批量按"已经排了多久"动态放大 */
  const drainSince = useRef(0);
  /** ending 模式下待挂载的本轮统计 */
  const endStats = useRef<TurnStats | null>(null);
  /** 进入 ending 模式的时刻：收尾批量按"已经收尾了多久"动态放大（见 nextBatchSize） */
  const endingSince = useRef(0);
  /** 写入目标缺失时暂存的那一批字，下一帧拼回 buffer 重试 */
  const stashed = useRef("");
  /** 节拍：本批首次出现积压的时刻（用于"最多等 PACE_MAX_WAIT_MS 就放行"） */
  const pacePendingSince = useRef(0);
  /** 节拍：上一次真正出字的时刻 */
  const paceLastEmitAt = useRef(0);
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
      const now = performance.now();
      const backlog = buffer.current.length;
      // ── normal 节拍 ──
      // 攒够一批、或等够兜底时长、并且过了一个节拍，才允许出字。
      // 严重积压（≥ PACE_BACKLOG_ESCAPE）时整体绕过：那种情况观感让位于追赶。
      if (mode.current === "normal" && backlog < PACE_BACKLOG_ESCAPE) {
        if (pacePendingSince.current === 0) pacePendingSince.current = now;
        const enough = backlog >= PACE_MIN_BATCH;
        const waited = now - pacePendingSince.current >= PACE_MAX_WAIT_MS;
        const beatOk = now - paceLastEmitAt.current >= PACE_BEAT_MS;
        if ((!enough && !waited) || !beatOk) {
          raf.current = requestAnimationFrame(tick);
          return;
        }
      }
      // 排空超时：剩余一次性倒出，避免模型吐得多时工具卡片被拖住太久
      if (mode.current === "draining" && now >= drainDeadline.current) {
        const rest = buffer.current;
        buffer.current = "";
        appendToLastText(ctx, rest, stash);
      } else {
        const elapsed = mode.current === "ending"
          ? now - endingSince.current
          : mode.current === "draining" ? now - drainSince.current : 0;
        const batch = takeBatch(buffer, mode.current, elapsed);
        if (mode.current === "normal") {
          paceLastEmitAt.current = now;
          if (buffer.current.length === 0) pacePendingSince.current = 0;
        }
        appendToLastText(ctx, batch, stash);
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
    drainSince.current = performance.now();
    drainDeadline.current = drainSince.current + DRAIN_TIMEOUT_MS;
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
    endingSince.current = performance.now();
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

  /**
   * 马上结清当前这段回复：没出完的字一次性落进去，正在收尾的就立刻收尾（打上本轮统计）。
   * 新一轮要开始时调用（后台任务通知轮、插话开的新一轮、用户发下一句）——否则上一段回复还没打完的字
   * 会接到新一轮的回复里，一句话被拆到两个气泡里，看起来像两个 AI 在同时说话。
   */
  const settle = useCallback((ctx: TypewriterCtx) => {
    const stats = mode.current === "ending" ? endStats.current : null;
    if (hasPending()) {
      const remaining = stashed.current + buffer.current;
      stashed.current = "";
      stashFrames.current = 0;
      buffer.current = "";
      appendToLastText(ctx, remaining, stash);
    }
    if (stats) finalizeStreaming(ctx, stats);
    mode.current = "normal";
    draining.current = false;
    endStats.current = null;
    stopLoop();
  }, [hasPending, stash, stopLoop]);

  return { push, hasPending, draining, start, drain, finish, flush, settle, cancel, reset: cancel };
}
