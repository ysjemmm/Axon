import { describe, expect, it } from "vitest";
import { compareTurnResults } from "./turnResultComparator.js";
import type { LLMTurnResult } from "./types.js";
import type { LLMTurnRawResult } from "./llmTurnSource.js";

function legacy(partial: Partial<LLMTurnResult>): LLMTurnResult {
  return {
    content: "",
    toolCalls: [],
    finishReason: "stop",
    normalizedFinishReason: "complete",
    ...partial,
  };
}

function next(partial: Partial<LLMTurnRawResult>): LLMTurnRawResult {
  return {
    content: "",
    reasoningDeltas: [],
    toolCalls: [],
    finishReason: "complete",
    ...partial,
  };
}

describe("compareTurnResults", () => {
  it("完全一致时 equal=true 且无差异", () => {
    const c = compareTurnResults(
      legacy({ content: "最终回答", normalizedFinishReason: "complete" }),
      next({ content: "最终回答", finishReason: "complete" }),
    );
    expect(c.equal).toBe(true);
    expect(c.diffs).toEqual([]);
  });

  it("正文首尾空白差异被容忍", () => {
    const c = compareTurnResults(
      legacy({ content: "  回答  " }),
      next({ content: "回答" }),
    );
    expect(c.contentEqual).toBe(true);
    expect(c.equal).toBe(true);
  });

  it("finishReason 不一致时记录差异", () => {
    const c = compareTurnResults(
      legacy({ normalizedFinishReason: "complete" }),
      next({ finishReason: "error" }),
    );
    expect(c.finishReasonEqual).toBe(false);
    expect(c.equal).toBe(false);
    expect(c.diffs).toContainEqual({ field: "finishReason", legacy: "complete", next: "error" });
  });

  it("正文不一致时记录差异", () => {
    const c = compareTurnResults(
      legacy({ content: "老答案" }),
      next({ content: "新答案" }),
    );
    expect(c.contentEqual).toBe(false);
    expect(c.diffs).toContainEqual({ field: "content", legacy: "老答案", next: "新答案" });
  });

  it("工具调用数量不一致时记录差异", () => {
    const c = compareTurnResults(
      legacy({
        finishReason: "tool_calls",
        normalizedFinishReason: "tool_calls",
        toolCalls: [{ id: "1", name: "read_file", arguments: "{}" }],
      }),
      next({ finishReason: "tool_calls", toolCalls: [] }),
    );
    expect(c.toolCallsEqual).toBe(false);
    expect(c.equal).toBe(false);
  });

  it("工具调用名称/顺序不一致时记录差异", () => {
    const c = compareTurnResults(
      legacy({
        finishReason: "tool_calls",
        normalizedFinishReason: "tool_calls",
        toolCalls: [
          { id: "1", name: "read_file", arguments: "{}" },
          { id: "2", name: "search", arguments: "{}" },
        ],
      }),
      next({
        finishReason: "tool_calls",
        toolCalls: [
          { callId: "1", toolName: "search", toolKind: "search" },
          { callId: "2", toolName: "read_file", toolKind: "read" },
        ],
      }),
    );
    expect(c.toolCallsEqual).toBe(false);
    expect(c.diffs).toContainEqual({
      field: "toolCalls",
      legacy: ["read_file", "search"],
      next: ["search", "read_file"],
    });
  });

  it("工具调用完全一致时 toolCallsEqual=true", () => {
    const c = compareTurnResults(
      legacy({
        finishReason: "tool_calls",
        normalizedFinishReason: "tool_calls",
        toolCalls: [{ id: "1", name: "read_file", arguments: '{"path":"a.ts"}' }],
      }),
      next({
        finishReason: "tool_calls",
        toolCalls: [{ callId: "1", toolName: "read_file", toolKind: "read" }],
      }),
    );
    expect(c.toolCallsEqual).toBe(true);
    expect(c.equal).toBe(true);
  });
});
