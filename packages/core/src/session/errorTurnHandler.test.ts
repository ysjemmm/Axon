import { describe, expect, it, vi } from "vitest";
import { ErrorTurnHandler } from "./errorTurnHandler.js";

/**
 * 构造一个最小 AgentSession stub，只提供 ErrorTurnHandler 取消收尾用到的字段/方法。
 */
function makeSession(messages: any[]) {
  const send = vi.fn();
  const persistMessages = vi.fn();
  const s: any = {
    messages,
    model: "test-model",
    lastTurnOutputTokens: 0,
    lastCompletionTokens: 0,
    lastTurnTokens: 0,
    turnStartCumulative: 0,
    cumulativeTokens: 0,
    lastTotalTokens: 0,
    buildTokenBreakdown: () => ({ memoryTokens: 0, systemTokens: 0, questionTokens: 0, outputTokens: 0 }),
    persistMessages,
    send,
  };
  return { s, send, persistMessages };
}

describe("ErrorTurnHandler 取消收尾", () => {
  it("丢弃残缺工具轮：assistant 有 2 个 tool_calls 但只有 1 个 tool 结果 → 整轮移除", () => {
    const messages = [
      { role: "user", content: "帮我改代码" },
      {
        role: "assistant",
        content: "第一行",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "str_replace", arguments: "{}" } },
          { id: "call_b", type: "function", function: { name: "str_replace", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "已编辑 A" },
      // call_b 的结果缺失（取消发生在执行中途）
    ];
    const { s, persistMessages } = makeSession(messages);
    const handler = new ErrorTurnHandler(s);

    handler.stampCancelledTurnStats(Date.now(), "第一行");

    // 残缺工具轮（assistant + call_a 结果）被丢弃
    expect(s.messages.find((m: any) => m.role === "assistant" && m.tool_calls)).toBeUndefined();
    expect(s.messages.find((m: any) => m.role === "tool")).toBeUndefined();
    // "第一行" 作为纯文本 assistant 消息补录（唯一一条，不重复）
    const assistants = s.messages.filter((m: any) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe("第一行");
    expect(persistMessages).toHaveBeenCalled();
  });

  it("完整工具轮不受影响：所有 tool_calls 都有结果 → 保留", () => {
    const messages = [
      { role: "user", content: "改代码" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "str_replace", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "已编辑 A" },
    ];
    const { s } = makeSession(messages);
    const handler = new ErrorTurnHandler(s);

    handler.stampCancelledTurnStats(Date.now(), "");

    // 完整工具轮保留
    expect(s.messages.find((m: any) => m.role === "assistant" && m.tool_calls)).toBeDefined();
    expect(s.messages.find((m: any) => m.role === "tool" && m.tool_call_id === "call_a")).toBeDefined();
  });

  it("去重：流式内容已作为带 tool_calls 的 assistant content 落库，不重复补录", () => {
    // 场景：完整工具轮 + assistant.content 恰好等于 streamedContent
    const messages = [
      { role: "user", content: "改代码" },
      {
        role: "assistant",
        content: "第一行",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "str_replace", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "已编辑 A" },
    ];
    const { s } = makeSession(messages);
    const handler = new ErrorTurnHandler(s);

    handler.stampCancelledTurnStats(Date.now(), "第一行");

    // 不应再 push 一条重复的 "第一行" 纯文本 assistant
    const firstLineMsgs = s.messages.filter(
      (m: any) => m.role === "assistant" && (m.content || "").trim() === "第一行",
    );
    expect(firstLineMsgs).toHaveLength(1);
  });

  it("纯文本轮（无工具）取消：正常补录流式内容", () => {
    const messages = [{ role: "user", content: "写首诗" }];
    const { s } = makeSession(messages);
    const handler = new ErrorTurnHandler(s);

    handler.stampCancelledTurnStats(Date.now(), "床前明月光");

    const assistants = s.messages.filter((m: any) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe("床前明月光");
    expect(assistants[0].turnStatus).toBe("cancelled");
  });
});
