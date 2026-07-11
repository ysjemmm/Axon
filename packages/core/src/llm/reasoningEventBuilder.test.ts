import { describe, expect, it } from "vitest";
import { buildReasoningDeltaEvent, buildReasoningCommitEvent } from "./reasoningEventBuilder.js";

const ctx = { requestId: "req-1", turnId: "turn-1", now: () => "2025-01-01T00:00:00.000Z" };

describe("buildReasoningDeltaEvent", () => {
  it("应产出带固定 source/stage 的 reasoning.delta 事件", () => {
    const e = buildReasoningDeltaEvent(ctx, { text: "分析", partIndex: 0, itemId: "r1" }, "summary");
    expect(e).toEqual({
      type: "reasoning.delta",
      ts: "2025-01-01T00:00:00.000Z",
      requestId: "req-1",
      turnId: "turn-1",
      source: "llm",
      stage: "runtime",
      text: "分析",
      kind: "summary",
      partIndex: 0,
      itemId: "r1",
    });
  });

  it("无分段信息时 partIndex/itemId 为 undefined", () => {
    const e = buildReasoningDeltaEvent(ctx, { text: "思考" });
    expect(e.partIndex).toBeUndefined();
    expect(e.itemId).toBeUndefined();
    expect(e.stage).toBe("runtime");
    expect(e.source).toBe("llm");
  });
});

describe("buildReasoningCommitEvent", () => {
  it("应产出已提交层的 reasoning.commit 事件", () => {
    const e = buildReasoningCommitEvent(ctx, "完整思考内容", "full");
    expect(e).toEqual({
      type: "reasoning.commit",
      ts: "2025-01-01T00:00:00.000Z",
      requestId: "req-1",
      turnId: "turn-1",
      source: "llm",
      stage: "committed",
      text: "完整思考内容",
      kind: "full",
    });
  });
});
