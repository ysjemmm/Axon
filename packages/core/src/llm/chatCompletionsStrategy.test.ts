import { describe, expect, it, vi } from "vitest";
import { ChatCompletionsStrategy } from "./chatCompletionsStrategy.js";
import type { RunTurnParams } from "./types.js";

function makeAsyncIterable(chunks: any[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function makeParams(model: string, overrides: Partial<RunTurnParams> = {}): RunTurnParams {
  return {
    model,
    messages: [
      { role: "system", content: "system" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
      { role: "user", content: "u4" },
    ],
    tools: [],
    callbacks: {
      onReasoningDelta: () => {},
      onTextDelta: () => {},
      onToolCallDetected: () => {},
    },
    ...overrides,
  };
}

/** 跑一次 runTurn，捕获实际发给 API 的请求体（供参数断言复用，避免每处各写一遍 mock） */
async function captureBody(model: string, overrides: Partial<RunTurnParams> = {}): Promise<Record<string, any>> {
  const create = vi.fn().mockResolvedValue(
    makeAsyncIterable([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]),
  );
  const strategy = new ChatCompletionsStrategy({ chat: { completions: { create } } } as any);
  await strategy.runTurn(makeParams(model, overrides));
  return create.mock.calls[0]?.[0] as Record<string, any>;
}

describe("ChatCompletionsStrategy request body", () => {
  it("kimi-k3 不应下发 cache_control（即使消息数 > 6）", async () => {
    const create = vi.fn().mockResolvedValue(
      makeAsyncIterable([
        { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      ]),
    );
    const client = {
      chat: { completions: { create } },
    } as any;

    const strategy = new ChatCompletionsStrategy(client);
    await strategy.runTurn(
      makeParams("kimi-k3", {
        modelSupportsCacheControl: false,
      }),
    );

    const body = create.mock.calls[0]?.[0];
    expect(body).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("cache_control");
  });

  it("模型显式声明支持 cache_control 时才下发 breakpoint", async () => {
    const create = vi.fn().mockResolvedValue(
      makeAsyncIterable([
        { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      ]),
    );
    const client = {
      chat: { completions: { create } },
    } as any;

    const strategy = new ChatCompletionsStrategy(client);
    await strategy.runTurn(
      makeParams("some-compatible-model", {
        modelSupportsCacheControl: true,
      }),
    );

    const body = create.mock.calls[0]?.[0];
    expect(body).toBeTruthy();
    expect(JSON.stringify(body)).toContain("cache_control");
  });

  it("Provider 配置的 effort 值原样下发为 reasoning_effort（即使模型名无法识别厂商）", async () => {
    const body = await captureBody("private-gateway-model", {
      think: true,
      effort: "xhigh-custom",
      modelSupportsThinking: true,
    });
    expect(body.reasoning_effort).toBe("xhigh-custom");
  });

  it("kimi-k3 不应下发 reasoning_effort / thinking / stream_options", async () => {
    const create = vi.fn().mockResolvedValue(
      makeAsyncIterable([
        { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      ]),
    );
    const client = {
      chat: { completions: { create } },
    } as any;

    const strategy = new ChatCompletionsStrategy(client);
    await strategy.runTurn(
      makeParams("kimi-k3", {
        think: true,
        modelSupportsThinking: true,
        modelSupportsCacheControl: false,
      }),
    );

    const body = create.mock.calls[0]?.[0];
    expect(body).toBeTruthy();
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("stream_options");
  });

  // ── 关闭思考必须显式下发 ──────────────────────────────────────────────────
  // 背景（实测）：不带任何思考参数时，deepseek-v4-flash @ 该端点仍返回 reasoning_content
  // 且 usage.reasoning_tokens > 0 —— 它照旧在想、照旧计费，只是我们既看不到又用不上。
  // 所以 think=false 必须真的把参数发出去，否则开关形同虚设。
  it("deepseek-v4 关闭思考 → 显式下发 reasoning_effort=none", async () => {
    const body = await captureBody("deepseek-v4-flash", {
      think: false,
      modelSupportsThinking: true,
      modelSupportsCacheControl: false,
    });
    expect(body.reasoning_effort).toBe("none");
  });

  it("deepseek-v4 开启思考 → reasoning_effort=high（与关闭分支对称同一参数名）", async () => {
    const body = await captureBody("deepseek-v4-flash", {
      think: true,
      modelSupportsThinking: true,
      modelSupportsCacheControl: false,
    });
    expect(body.reasoning_effort).toBe("high");
  });

  it("非 effort 厂商族关闭思考时不下发任何思考参数（宁可少个能力也不猜参数名）", async () => {
    const body = await captureBody("kimi-k3", {
      think: false,
      modelSupportsThinking: true,
      modelSupportsCacheControl: false,
    });
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("thinking");
  });
});
