import { describe, expect, it } from "vitest";
import { DefaultLLMHandler } from "./llmHandler.js";
import type { LLMTurnSource, LLMTurnRawResult } from "./llmTurnSource.js";

const input = {
  requestId: "req-1",
  turnId: "turn-1",
  effectiveMessages: [{ role: "user" as const, content: "你好" }],
};

/** 构造一个固定产物的回合来源，便于断言归一化结果。 */
function sourceOf(raw: LLMTurnRawResult): LLMTurnSource {
  return { run: async () => raw };
}

describe("DefaultLLMHandler", () => {
  it("未注入 source 时退回骨架模式（prepared 空草案）", async () => {
    const h = new DefaultLLMHandler();
    const out = await h.handle(input);
    expect(out.stage).toBe("prepared");
    expect(out.runtimeEvents).toEqual([]);
    expect(out.toolDrafts).toEqual([]);
    expect(out.contentDraft).toBe("");
    expect(out.finishReason).toBeUndefined();
  });

  it("把 reasoning 增量归一化成 delta 序列 + 一条 commit", async () => {
    const h = new DefaultLLMHandler(
      sourceOf({
        content: "最终回答",
        reasoningDeltas: [
          { text: "先看", partIndex: 0, itemId: "r1" },
          { text: "映射", partIndex: 0, itemId: "r1" },
        ],
        toolCalls: [],
        finishReason: "complete",
      }),
    );
    const out = await h.handle(input);
    const deltas = out.runtimeEvents.filter((e) => e.type === "reasoning.delta");
    const commits = out.runtimeEvents.filter((e) => e.type === "reasoning.commit");
    expect(deltas).toHaveLength(2);
    expect(commits).toHaveLength(1);
    expect((commits[0] as any).text).toBe("先看映射");
    expect(out.contentDraft).toBe("最终回答");
    expect(out.stage).toBe("content_completed");
  });

  it("无 reasoning 时不产出 commit 事件", async () => {
    const h = new DefaultLLMHandler(
      sourceOf({ content: "答", reasoningDeltas: [], toolCalls: [], finishReason: "complete" }),
    );
    const out = await h.handle(input);
    expect(out.runtimeEvents.filter((e) => e.type === "reasoning.commit")).toHaveLength(0);
  });

  it("识别到工具调用 → tool_calls_detected，产出 planned 态 ToolEvent", async () => {
    const h = new DefaultLLMHandler(
      sourceOf({
        content: "",
        reasoningDeltas: [],
        toolCalls: [
          { callId: "call-1", toolName: "read_file", toolKind: "read", parsedArgs: { path: "a.ts" }, rawArgsText: '{"path":"a.ts"}' },
        ],
        finishReason: "tool_calls",
      }),
    );
    const out = await h.handle(input);
    expect(out.stage).toBe("tool_calls_detected");
    expect(out.toolDrafts).toHaveLength(1);
    expect(out.toolDrafts[0].phase).toBe("planned");
    expect(out.toolDrafts[0].callId).toBe("call-1");
    expect(out.toolDrafts[0].parsedArgs).toEqual({ path: "a.ts" });
  });

  it("finishReason=error → failed 阶段", async () => {
    const h = new DefaultLLMHandler(
      sourceOf({ content: "半截", reasoningDeltas: [], toolCalls: [], finishReason: "error" }),
    );
    const out = await h.handle(input);
    expect(out.stage).toBe("failed");
    expect(out.finishReason).toBe("error");
  });
});
