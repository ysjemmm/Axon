/**
 * 模型请求的重试策略（主会话与子 Agent 共用一份）。
 *
 * 早先两处各写一套正则，判断互相矛盾：主会话把消息里带「network」「capacity」的 4xx 也重试，
 * 子 Agent 却会重试「quota」（额度用完，重试多少次都没用），不重试普通的 500。
 * 再叠上 OpenAI SDK 自己默认的 2 次重试，一次请求最多能发出 18 次；
 * 服务端给的 retry-after 被忽略；退避等待期间点「停止」要等最长 16 秒才停下来。
 *
 * 这里统一成：
 *   · 按 HTTP 状态码分类（408 / 409 / 425 / 429 / 5xx 可重试），额度 / 欠费类的 429 不重试
 *   · 网络层错误（连接重置、DNS、超时、流式无响应）可重试
 *   · 尊重 retry-after（上限 60 秒），其余按指数退避加抖动
 *   · 等待可被取消信号立即打断
 */

export interface RetryDecision {
  retryable: boolean;
  /** 服务端要求的等待时间（来自 retry-after 头） */
  retryAfterMs?: number;
}

/** 流式响应长时间没有任何数据时抛出的错误（由调用方的看门狗触发），可重试 */
export class StreamIdleError extends Error {
  constructor(seconds: number) {
    super(`模型流式响应 ${seconds} 秒没有任何数据，已断开重试`);
    this.name = "StreamIdleError";
  }
}

/** 从错误里取 HTTP 状态码：OpenAI SDK 的 APIError 带 status；其它路径看消息里的「HTTP 502」「502 status code」 */
export function errorStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; message?: string } | null;
  if (typeof e?.status === "number") return e.status;
  const msg = e?.message ?? "";
  const m = /\bHTTP\s+(\d{3})\b/i.exec(msg) ?? /^(\d{3})\s+status code/i.exec(msg) ?? /^(\d{3})\b/.exec(msg.trim());
  return m ? Number(m[1]) : undefined;
}

function retryAfterMs(err: unknown): number | undefined {
  const headers = (err as { headers?: unknown } | null)?.headers as { get?: (k: string) => string | null } | Record<string, string> | undefined;
  if (!headers) return undefined;
  const raw = typeof (headers as { get?: unknown }).get === "function"
    ? (headers as { get: (k: string) => string | null }).get("retry-after")
    : (headers as Record<string, string>)["retry-after"];
  if (!raw) return undefined;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 60_000) : undefined;
}

/** 额度用完 / 欠费：重试没有意义 */
const PERMANENT_QUOTA = /insufficient_quota|quota (?:exceeded|exhausted)|exceeded your (?:current )?quota|billing|余额不足|欠费|额度(?:已)?用完/i;
/** 网络层的瞬时错误 */
const NETWORK = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error|connection (?:reset|refused|error|closed)|unexpected eof|premature close|terminated|recv failure/i;

export function classifyLLMError(err: unknown): RetryDecision {
  if (!err) return { retryable: false };
  const e = err as Error;
  if (e.name === "AbortError") return { retryable: false };
  if (err instanceof StreamIdleError || e.name === "StreamIdleError") return { retryable: true };
  const msg = e.message ?? "";
  if (PERMANENT_QUOTA.test(msg)) return { retryable: false };
  const status = errorStatus(err);
  if (status !== undefined) {
    const retryable = status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599 && status !== 501);
    return { retryable, retryAfterMs: retryable ? retryAfterMs(err) : undefined };
  }
  if (NETWORK.test(msg)) return { retryable: true };
  // 没有状态码的过载提示（部分网关把 529 / 过载写在消息里）
  if (/overloaded|too many requests|rate.?limit|temporarily unavailable|service unavailable|bad gateway|gateway timeout/i.test(msg)) {
    return { retryable: true };
  }
  return { retryable: false };
}

/** 第 attempt 次重试前的等待：指数退避（1s 起，封顶 16s）加 ±20% 抖动，避免大家同时重试 */
export function backoffDelay(attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined) return retryAfter;
  const base = Math.min(1000 * 2 ** attempt, 16_000);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/** 可被取消的等待：信号触发时立即以 AbortError 结束 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 流式看门狗：在 signal 之上再挂一个「多久没数据就断开」的控制器。
 * 还没收到任何数据时给得宽一些（有的模型先静默推理几分钟才开始输出），收到过数据之后收紧。
 */
export interface StreamWatchdog {
  signal: AbortSignal;
  /** 每收到一次流式数据调用一次 */
  touch: () => void;
  /** 看门狗触发过就返回它的错误（调用方据此把 AbortError 换成可重试的 StreamIdleError） */
  idleError: () => StreamIdleError | null;
  dispose: () => void;
}

export function createStreamWatchdog(parent: AbortSignal | undefined, opts: { firstEventMs?: number; idleMs?: number } = {}): StreamWatchdog {
  const firstEventMs = opts.firstEventMs ?? 300_000;
  const idleMs = opts.idleMs ?? 120_000;
  const controller = new AbortController();
  let fired: StreamIdleError | null = null;
  let seen = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    const ms = seen ? idleMs : firstEventMs;
    timer = setTimeout(() => {
      fired = new StreamIdleError(Math.round(ms / 1000));
      controller.abort(fired);
    }, ms);
  };
  const onParentAbort = () => { if (timer) clearTimeout(timer); controller.abort(parent?.reason); };
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  arm();
  return {
    signal: controller.signal,
    touch: () => { seen = true; arm(); },
    idleError: () => fired,
    dispose: () => { if (timer) clearTimeout(timer); parent?.removeEventListener("abort", onParentAbort); },
  };
}
