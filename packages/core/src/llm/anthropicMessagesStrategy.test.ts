import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicMessagesStrategy } from "./anthropicMessagesStrategy.js";

const callbacks = {
  onReasoningDelta: vi.fn(),
  onTextDelta: vi.fn(),
  onToolCallDetected: vi.fn(),
};

function stream(events: Array<[string, Record<string, unknown>]>): Response {
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { status: 200 });
}

describe("Anthropic extended thinking 回传", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("保留工具轮的 thinking、signature，并在下一次请求中放在 tool_use 前", async () => {
    const requests: Record<string, any>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      if (requests.length === 1) {
        return stream([
          ["content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }],
          ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "先读取" } }],
          ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "文件" } }],
          ["content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "signed-block" } }],
          ["content_block_start", { index: 1, content_block: { type: "tool_use", id: "call-1", name: "read_file" } }],
          ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' } }],
          ["message_delta", { delta: { stop_reason: "tool_use" } }],
        ]);
      }
      return stream([["message_delta", { delta: { stop_reason: "end_turn" } }]]);
    }));

    const strategy = new AnthropicMessagesStrategy("https://example.test/v1", "test-key");
    const first = await strategy.runTurn({
      model: "claude-opus-4-1", messages: [{ role: "user", content: "读取文件" }], tools: [], callbacks,
    });
    expect(first.anthropicThinkingBlocks).toEqual([{ thinking: "先读取文件", signature: "signed-block" }]);
    expect(callbacks.onReasoningDelta).toHaveBeenCalledTimes(2);

    await strategy.runTurn({
      model: "claude-opus-4-1", tools: [], callbacks,
      messages: [
        { role: "user", content: "读取文件" },
        {
          role: "assistant", content: null,
          anthropic_thinking_blocks: first.anthropicThinkingBlocks,
          tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
        } as any,
        { role: "tool", tool_call_id: "call-1", content: "文件内容" },
      ],
    });
    expect(requests[1].messages[1].content).toEqual([
      { type: "thinking", thinking: "先读取文件", signature: "signed-block" },
      { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.txt" } },
    ]);
    // 最后一条消息带缓存断点（见 applyAnthropicCache）
    expect(requests[1].messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "call-1", content: "文件内容", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("缺少签名的历史块不回传，避免协议拒绝", async () => {
    let request: any;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      request = JSON.parse(String(init.body));
      return stream([["message_delta", { delta: { stop_reason: "end_turn" } }]]);
    }));
    const strategy = new AnthropicMessagesStrategy("https://example.test/v1", "test-key");
    await strategy.runTurn({
      model: "claude-opus-4-1", tools: [], callbacks,
      messages: [
        { role: "user", content: "你好" },
        { role: "assistant", content: "回答", anthropic_thinking_blocks: [{ thinking: "无签名" }] } as any,
        { role: "user", content: "继续" },
      ],
    });
    expect(request.messages[1].content).toEqual([{ type: "text", text: "回答" }]);
  });

  it("多个思考块按原始块索引顺序回传各自的签名", async () => {
    let request: any;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      request = JSON.parse(String(init.body));
      return stream([["message_delta", { delta: { stop_reason: "end_turn" } }]]);
    }));
    const strategy = new AnthropicMessagesStrategy("https://example.test/v1", "test-key");
    await strategy.runTurn({
      model: "claude-opus-4-1", tools: [], callbacks,
      messages: [
        { role: "user", content: "分析" },
        {
          role: "assistant", content: "结果",
          anthropic_thinking_blocks: [
            { thinking: "第一段", signature: "sig-1" },
            { thinking: "第二段", signature: "sig-2" },
          ],
        } as any,
        { role: "user", content: "继续" },
      ],
    });
    expect(request.messages[1].content).toEqual([
      { type: "thinking", thinking: "第一段", signature: "sig-1" },
      { type: "thinking", thinking: "第二段", signature: "sig-2" },
      { type: "text", text: "结果" },
    ]);
  });
});

describe("Anthropic Prompt Caching", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function capture(params: Record<string, unknown>): Promise<any> {
    let request: any;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      request = JSON.parse(String(init.body));
      return stream([["message_delta", { delta: { stop_reason: "end_turn" } }]]);
    }));
    const strategy = new AnthropicMessagesStrategy("https://example.test/v1", "test-key");
    await strategy.runTurn({ model: "claude-opus-5-5", tools: [], callbacks, ...params } as any);
    return request;
  }

  it("系统提示词、上一条用户消息、最后一条消息打断点", async () => {
    const req = await capture({
      messages: [
        { role: "system", content: "系统提示" },
        { role: "user", content: "第一问" },
        { role: "assistant", content: "第一答" },
        { role: "user", content: "第二问" },
      ],
    });
    expect(req.system).toEqual([{ type: "text", text: "系统提示", cache_control: { type: "ephemeral" } }]);
    expect(req.messages[0].content).toEqual([{ type: "text", text: "第一问", cache_control: { type: "ephemeral" } }]);
    expect(req.messages[1].content).toEqual([{ type: "text", text: "第一答" }]);
    expect(req.messages[2].content).toEqual([{ type: "text", text: "第二问", cache_control: { type: "ephemeral" } }]);
  });

  it("历史中间的 system 不并进顶层 system，而是就地变成 system-reminder，前缀不随注入变化", async () => {
    const req = await capture({
      messages: [
        { role: "system", content: "系统提示" },
        { role: "user", content: "第一问" },
        { role: "assistant", content: "第一答" },
        { role: "system", content: "本轮注入" },
        { role: "user", content: "第二问" },
      ],
    });
    expect(req.system[0].text).toBe("系统提示");
    expect(req.messages[2].content.map((b: any) => b.text)).toEqual(["<system-reminder>\n本轮注入\n</system-reminder>", "第二问"]);
  });

  it("provider 声明 cacheControl: false 时不打断点", async () => {
    const req = await capture({ modelSupportsCacheControl: false, messages: [{ role: "system", content: "s" }, { role: "user", content: "q" }] });
    expect(req.system).toBe("s");
    expect(req.messages[0].content).toBe("q");
  });

  it("新版 Claude 未选推理强度时用 adaptive 思考，旧模型仍用 budget_tokens", async () => {
    const newer = await capture({ messages: [{ role: "user", content: "q" }], modelSupportsThinking: true });
    expect(newer.thinking).toEqual({ type: "adaptive" });
    const older = await capture({ model: "claude-opus-4-1", messages: [{ role: "user", content: "q" }], modelSupportsThinking: true });
    expect(older.thinking.type).toBe("enabled");
  });
});
