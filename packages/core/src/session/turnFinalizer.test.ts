import { describe, expect, it } from "vitest";
import { TurnFinalizer } from "./turnFinalizer.js";

describe("TurnFinalizer", () => {
  function makeInput(overrides: Partial<Parameters<TurnFinalizer["finalize"]>[0]> = {}) {
    return {
      contentBuffer: "最终回答",
      streamedContentThisRound: "最终回答",
      turnStartTime: Date.now() - 100,
      model: "gpt-5.5",
      messages: [],
      lastTurnTokens: 12,
      lastTurnOutputTokens: 8,
      lastCompletionTokens: 0,
      buildTokenBreakdown: () => ({ memoryTokens: 10, systemTokens: 20, questionTokens: 30 }),
      rollingSummaryAccumulated: 50,
      triggerTokens: 100,
      ...overrides,
    };
  }

  it("计算 turnStats 并追加 assistant 消息", () => {
    const out = new TurnFinalizer().finalize(makeInput({ effort: "xhigh", providerName: "My Router" }));
    expect(out.messages).toHaveLength(1);
    expect((out.messages[0] as any).turnStats.tokens).toBe(12);
    expect((out.messages[0] as any).turnStats.effort).toBe("xhigh");
    expect((out.messages[0] as any).turnStats.providerName).toBe("My Router");
    expect((out.messages[0] as any).content).toBe("最终回答");
    expect(out.credits).toBeGreaterThanOrEqual(0);
  });

  it("最终回复保留 Anthropic 思考块和签名", () => {
    const blocks = [{ thinking: "先分析需求", signature: "signed-final" }];
    const out = new TurnFinalizer().finalize(makeInput({ anthropicThinkingBlocks: blocks }));
    expect((out.messages[0] as any).anthropic_thinking_blocks).toEqual(blocks);
  });

  it("最终回复保留 chat 协议的 reasoning_content（带 tools 的请求必须全量回传）", () => {
    const out = new TurnFinalizer().finalize(makeInput({ reasoningContent: "先确认文件再回答" }));
    expect((out.messages[0] as any).reasoning_content).toBe("先确认文件再回答");
  });

  it("没有思考内容时不写该字段，不污染非推理模型的历史", () => {
    const out = new TurnFinalizer().finalize(makeInput());
    expect((out.messages[0] as any).reasoning_content).toBeUndefined();
  });

  it("拿不到真实 output token 时回退字符估算", () => {
    const out = new TurnFinalizer().finalize(makeInput({ lastTurnOutputTokens: 0, lastCompletionTokens: 0, contentBuffer: "abcd", streamedContentThisRound: "abcd", lastTurnTokens: 0 }));
    expect((out.messages[0] as any).turnStats.tokens).toBe(4);
    expect(out.credits).toBeGreaterThanOrEqual(0);
  });

  it("回合收尾不改写已有历史：旧工具结果原样保留，只在末尾追加（前缀缓存不断）", () => {
    // 足够老的工具结果（其后已有 3 次 user 消息），且超过旧裁剪阈值 800 字
    const oldOutput = "命令输出".repeat(1000);
    const history = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "execute_command", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: oldOutput },
      { role: "user", content: "u2" },
      { role: "user", content: "u3" },
      { role: "user", content: "u4" },
    ] as any[];
    const before = JSON.stringify(history);

    const out = new TurnFinalizer().finalize(makeInput({ messages: history }));

    // 已有部分逐字节不变 = 下一次请求的前缀与上一次完全一致
    expect(JSON.stringify(out.messages.slice(0, history.length))).toBe(before);
    expect((out.messages[3] as any).content).toBe(oldOutput);
    expect(out.messages).toHaveLength(history.length + 1);
  });

  it("累计 token 超阈值时返回 shouldTriggerRollingSummary=true", () => {
    const out = new TurnFinalizer().finalize(makeInput({ rollingSummaryAccumulated: 95, lastTurnTokens: 10, triggerTokens: 100 }));
    expect(out.nextRollingSummaryAccumulated).toBe(105);
    expect(out.shouldTriggerRollingSummary).toBe(true);
  });
});
