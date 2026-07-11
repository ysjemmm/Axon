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
      compactionEnabled: false,
      toolResultKeepTurns: 3,
      rollingSummaryAccumulated: 50,
      triggerTokens: 100,
      ...overrides,
    };
  }

  it("计算 turnStats 并追加 assistant 消息", () => {
    const out = new TurnFinalizer().finalize(makeInput());
    expect(out.messages).toHaveLength(1);
    expect((out.messages[0] as any).turnStats.tokens).toBe(12);
    expect((out.messages[0] as any).content).toBe("最终回答");
    expect(out.credits).toBeGreaterThanOrEqual(0);
  });

  it("拿不到真实 output token 时回退字符估算", () => {
    const out = new TurnFinalizer().finalize(makeInput({ lastTurnOutputTokens: 0, lastCompletionTokens: 0, contentBuffer: "abcd", streamedContentThisRound: "abcd", lastTurnTokens: 0 }));
    expect((out.messages[0] as any).turnStats.tokens).toBe(4);
    expect(out.credits).toBeGreaterThanOrEqual(0);
  });

  it("压缩开启时会裁剪旧 tool 结果（至少保持返回消息数组）", () => {
    const out = new TurnFinalizer().finalize(makeInput({
      compactionEnabled: true,
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] } as any,
        { role: "tool", tool_call_id: "c1", content: "x".repeat(500) } as any,
      ],
    }));
    expect(Array.isArray(out.messages)).toBe(true);
    expect(out.messages.length).toBeGreaterThan(0);
  });

  it("累计 token 超阈值时返回 shouldTriggerRollingSummary=true", () => {
    const out = new TurnFinalizer().finalize(makeInput({ rollingSummaryAccumulated: 95, lastTurnTokens: 10, triggerTokens: 100 }));
    expect(out.nextRollingSummaryAccumulated).toBe(105);
    expect(out.shouldTriggerRollingSummary).toBe(true);
  });
});
