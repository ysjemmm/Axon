import { describe, expect, it } from "vitest";
import { normalizeFinishReason, finishReasonToTurnPhase } from "./finishReasonMapper.js";

describe("normalizeFinishReason", () => {
  it("stop -> complete", () => {
    expect(normalizeFinishReason("stop")).toBe("complete");
  });

  it("tool_calls -> tool_calls", () => {
    expect(normalizeFinishReason("tool_calls")).toBe("tool_calls");
  });

  it("length -> truncated", () => {
    expect(normalizeFinishReason("length")).toBe("truncated");
  });

  it("content_filter -> error", () => {
    expect(normalizeFinishReason("content_filter")).toBe("error");
  });

  it("error -> error（Responses failed 归一化后的核心场景）", () => {
    expect(normalizeFinishReason("error")).toBe("error");
  });

  it("cancelled -> cancelled", () => {
    expect(normalizeFinishReason("cancelled")).toBe("cancelled");
  });

  it("null 不冒充正常完成，保守归为 error", () => {
    expect(normalizeFinishReason(null)).toBe("error");
  });

  it("undefined 保守归为 error", () => {
    expect(normalizeFinishReason(undefined)).toBe("error");
  });

  it("未知值保守归为 error（绝不当作 complete）", () => {
    expect(normalizeFinishReason("something_new")).toBe("error");
  });
});

describe("finishReasonToTurnPhase", () => {
  it("complete -> complete", () => {
    expect(finishReasonToTurnPhase("complete")).toBe("complete");
  });

  it("tool_calls 也算该 turn 正常完成 -> complete", () => {
    expect(finishReasonToTurnPhase("tool_calls")).toBe("complete");
  });

  it("truncated -> truncated", () => {
    expect(finishReasonToTurnPhase("truncated")).toBe("truncated");
  });

  it("error -> error", () => {
    expect(finishReasonToTurnPhase("error")).toBe("error");
  });

  it("cancelled -> cancelled", () => {
    expect(finishReasonToTurnPhase("cancelled")).toBe("cancelled");
  });
});
