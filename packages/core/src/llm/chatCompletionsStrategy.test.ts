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
});
