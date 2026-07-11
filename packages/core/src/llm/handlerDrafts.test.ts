import { describe, expect, it } from "vitest";
import {
  DefaultLLMHandler,
  DefaultToolDispatchHandler,
  type ToolEvent,
  type ToolContext,
} from "./index.js";

describe("DefaultLLMHandler", () => {
  it("当前骨架应返回稳定的空草案且 stage=prepared", async () => {
    const out = await new DefaultLLMHandler().handle({
      requestId: "req-1",
      turnId: "turn-1",
      effectiveMessages: [{ role: "user", content: "hi" }],
    });
    expect(out.runtimeEvents).toEqual([]);
    expect(out.toolDrafts).toEqual([]);
    expect(out.contentDraft).toBe("");
    expect(out.finishReason).toBeUndefined();
    expect(out.stage).toBe("prepared");
  });
});

describe("DefaultToolDispatchHandler", () => {
  const toolCtx: ToolContext = {
    requestId: "req-1",
    turnId: "turn-1",
    callId: "call-1",
    toolName: "read_file",
    toolKind: "read",
    partialToolEvent: {},
  };

  it("无 toolDrafts 时 stage 应为 dispatching 且不产出结果", async () => {
    const out = await new DefaultToolDispatchHandler().handle({
      requestId: "req-1",
      turnId: "turn-1",
      toolDrafts: [],
      toolContexts: [toolCtx],
    });
    expect(out.stage).toBe("dispatching");
    expect(out.toolResultsReady).toBe(false);
    expect(out.toolContexts).toEqual([toolCtx]);
    expect(out.runtimeEvents).toEqual([]);
  });

  it("存在 toolDrafts 时 stage 应为 draft_received", async () => {
    const draft = {
      type: "tool.phase",
      ts: new Date().toISOString(),
      requestId: "req-1",
      turnId: "turn-1",
      source: "tool",
      stage: "runtime",
      phase: "planned",
      callId: "call-1",
      toolName: "read_file",
      toolKind: "read",
    } as unknown as ToolEvent;

    const out = await new DefaultToolDispatchHandler().handle({
      requestId: "req-1",
      turnId: "turn-1",
      toolDrafts: [draft],
      toolContexts: [toolCtx],
    });
    expect(out.stage).toBe("draft_received");
    expect(out.toolContexts).toEqual([toolCtx]);
  });
});
