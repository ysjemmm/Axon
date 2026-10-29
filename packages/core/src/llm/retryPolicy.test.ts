import { describe, expect, it, vi } from "vitest";
import { abortableSleep, backoffDelay, classifyLLMError, createStreamWatchdog, StreamIdleError } from "./retryPolicy.js";

describe("classifyLLMError", () => {
  it("按状态码分类", () => {
    expect(classifyLLMError({ status: 429, message: "x" }).retryable).toBe(true);
    expect(classifyLLMError({ status: 503, message: "x" }).retryable).toBe(true);
    expect(classifyLLMError({ status: 400, message: "network capacity" }).retryable).toBe(false);
    expect(classifyLLMError(new Error("Anthropic Messages API 请求失败：HTTP 502 Bad Gateway")).retryable).toBe(true);
    expect(classifyLLMError(new Error("401 status code (no body)")).retryable).toBe(false);
  });
  it("额度用完不重试，网络错误重试，取消不重试", () => {
    expect(classifyLLMError({ status: 429, message: "You exceeded your current quota (insufficient_quota)" }).retryable).toBe(false);
    expect(classifyLLMError(new Error("fetch failed: ECONNRESET")).retryable).toBe(true);
    expect(classifyLLMError(Object.assign(new Error("aborted"), { name: "AbortError" })).retryable).toBe(false);
    expect(classifyLLMError(new StreamIdleError(120)).retryable).toBe(true);
  });
  it("读 retry-after", () => {
    const d = classifyLLMError({ status: 429, message: "x", headers: new Headers({ "retry-after": "7" }) });
    expect(d.retryAfterMs).toBe(7000);
    expect(backoffDelay(0, d.retryAfterMs)).toBe(7000);
  });
});

describe("abortableSleep / watchdog", () => {
  it("取消立即结束等待", async () => {
    const c = new AbortController();
    const p = abortableSleep(10_000, c.signal);
    c.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
  it("长时间没数据就断开，并报可重试的 StreamIdleError", () => {
    vi.useFakeTimers();
    const w = createStreamWatchdog(undefined, { firstEventMs: 1000, idleMs: 500 });
    vi.advanceTimersByTime(900);
    w.touch();
    vi.advanceTimersByTime(400);
    expect(w.signal.aborted).toBe(false);
    vi.advanceTimersByTime(200);
    expect(w.signal.aborted).toBe(true);
    expect(w.idleError()).toBeInstanceOf(StreamIdleError);
    w.dispose();
    vi.useRealTimers();
  });
});
