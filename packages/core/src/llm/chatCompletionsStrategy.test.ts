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

  it("GPT Chat 使用自动 Prompt Caching，不注入 cache_control 且保持消息结构稳定", async () => {
    const messages = makeParams("gpt-5.6-sol").messages;
    const body = await captureBody("gpt-5.6-sol", {
      messages,
      modelSupportsCacheControl: true,
    });

    expect(JSON.stringify(body)).not.toContain("cache_control");
    expect(body.messages).toEqual(messages);
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
    // 支持思考的模型默认下发 reasoning_effort=high
    expect(body.reasoning_effort).toBe("high");
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

  it("deepseek-v4 开启思考但未配置强度 → 默认下发 reasoning_effort=high", async () => {
    const body = await captureBody("deepseek-v4-flash", {
      think: true,
      modelSupportsThinking: true,
      modelSupportsCacheControl: false,
    });
    expect(body.reasoning_effort).toBe("high");
  });

  it.each(["qwen3.7-plus", "glm-5.2"])("%s 未配置强度 → 默认下发 reasoning_effort=high", async (model) => {
    const body = await captureBody(model, {
      think: true,
      modelSupportsThinking: true,
      modelSupportsCacheControl: false,
    });
    expect(body.reasoning_effort).toBe("high");
  });

  it("非 effort 厂商族关闭思考时也下发 reasoning_effort=none（宁可少个能力也不猜参数名）", async () => {
    const body = await captureBody("kimi-k3", {
      think: false,
      modelSupportsThinking: true,
      modelSupportsCacheControl: false,
    });
    expect(body.reasoning_effort).toBe("none");
    expect(body).not.toHaveProperty("thinking");
  });

  it("Chat 网关的 analysis 字段进入思考链，不泄露到正文", async () => {
    const reasoning: string[] = [];
    const text: string[] = [];
    const create = vi.fn().mockResolvedValue(makeAsyncIterable([
      { choices: [{ delta: { analysis: "internal plan" }, finish_reason: null }] },
      { choices: [{ delta: { content: "最终回答" }, finish_reason: "stop" }] },
    ]));
    const strategy = new ChatCompletionsStrategy({ chat: { completions: { create } } } as any);
    const result = await strategy.runTurn(makeParams("claude-opus-5.5", {
      callbacks: {
        onReasoningDelta: (value) => reasoning.push(value),
        onTextDelta: (value) => text.push(value),
        onToolCallDetected: () => {},
      },
    }));

    expect(reasoning).toEqual(["internal plan"]);
    expect(text).toEqual(["最终回答"]);
    expect(result.reasoningContent).toBe("internal plan");
    expect(result.content).toBe("最终回答");
  });

  it("结构化 content parts 按 analysis/text 类型拆分", async () => {
    const reasoning: string[] = [];
    const text: string[] = [];
    const create = vi.fn().mockResolvedValue(makeAsyncIterable([
      {
        choices: [{
          delta: {
            content: [
              { type: "analysis", text: "先检查协议" },
              { type: "text", text: "已找到原因" },
            ],
          },
          finish_reason: "stop",
        }],
      },
    ]));
    const strategy = new ChatCompletionsStrategy({ chat: { completions: { create } } } as any);
    const result = await strategy.runTurn(makeParams("claude-opus-5.5", {
      callbacks: {
        onReasoningDelta: (value) => reasoning.push(value),
        onTextDelta: (value) => text.push(value),
        onToolCallDetected: () => {},
      },
    }));

    expect(reasoning).toEqual(["先检查协议"]);
    expect(text).toEqual(["已找到原因"]);
    expect(result.content).toBe("已找到原因");
  });

  it("stream=true 但网关返回 choice.message 时仍能读取正文", async () => {
    const create = vi.fn().mockResolvedValue(makeAsyncIterable([
      { choices: [{ message: { content: "fallback text" }, finish_reason: "stop" }] },
    ]));
    const strategy = new ChatCompletionsStrategy({ chat: { completions: { create } } } as any);
    const result = await strategy.runTurn(makeParams("compatible-model"));
    expect(result.content).toBe("fallback text");
  });
});
