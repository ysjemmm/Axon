import { afterEach, describe, expect, it, vi } from "vitest";
import { ResponsesStrategy } from "./responsesStrategy.js";
import { AnthropicMessagesStrategy } from "./anthropicMessagesStrategy.js";
import type { RunTurnParams } from "./types.js";

const callbacks = {
  onReasoningDelta: () => {},
  onTextDelta: () => {},
  onToolCallDetected: () => {},
};

function params(overrides: Partial<RunTurnParams>): RunTurnParams {
  return {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    callbacks,
    ...overrides,
  };
}

describe("effort 请求编码", () => {
  afterEach(() => vi.restoreAllMocks());

  it("Responses：写入 reasoning.effort", async () => {
    let body: any;
    const client = {
      responses: {
        create: vi.fn(async (b: any) => {
          body = b;
          return { async *[Symbol.asyncIterator]() { yield { type: "response.completed", response: { usage: {}, output: [] } }; } };
        }),
      },
    };
    const strategy = new ResponsesStrategy(client as any);
    await strategy.runTurn(params({ model: "gpt-5.6-sol", think: true, effort: "max", modelSupportsThinking: true }));
    expect(body.reasoning).toEqual({ summary: "auto", effort: "max" });
  });

  it("Anthropic：写入 adaptive thinking + output_config.effort", async () => {
    let body: any;
    const encoder = new TextEncoder();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: message_start\ndata: {"message":{"usage":{"input_tokens":1}}}\n\n'));
          controller.enqueue(encoder.encode('event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }));
    const strategy = new AnthropicMessagesStrategy("https://example.test", "key");
    await strategy.runTurn(params({ model: "claude-opus", think: true, effort: "xhigh", modelSupportsThinking: true }));
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "xhigh" });
    expect(body.thinking.budget_tokens).toBeUndefined();
  });
});