import { describe, expect, it, vi } from "vitest";
import { ToolName } from "../tools/index.js";
import { ToolOutcomePostSync } from "./toolOutcomePostSync.js";

describe("ToolOutcomePostSync", () => {
  function makeSync() {
    const trace = vi.fn();
    const markLastToolMessageTransient = vi.fn();
    const enqueueScreenshot = vi.fn();
    const sendEditsUpdated = vi.fn();
    const onPendingChanged = vi.fn();
    const sync = new ToolOutcomePostSync({ trace, markLastToolMessageTransient, enqueueScreenshot, sendEditsUpdated, onPendingChanged });
    return { sync, trace, markLastToolMessageTransient, enqueueScreenshot, sendEditsUpdated, onPendingChanged };
  }

  it("总会补 tool.result trace", () => {
    const { sync, trace } = makeSync();
    sync.run({ toolName: "search", toolCallId: "c1", status: "success", result: "ok", meta: {} as any, isPending: false, turnCount: 1 });
    expect(trace).toHaveBeenCalledWith("tool.result", expect.objectContaining({ toolName: "search", toolCallId: "c1", status: "success" }), 1);
  });

  it("有 __markTransientApplied 时标记最后一条 tool 消息为 transient", () => {
    const { sync, markLastToolMessageTransient } = makeSync();
    const meta: any = { __markTransientApplied: true };
    sync.run({ toolName: "str_replace", toolCallId: "c1", status: "error", result: "x", meta, isPending: false, turnCount: 1 });
    expect(markLastToolMessageTransient).toHaveBeenCalled();
    expect(meta.__markTransientApplied).toBeUndefined();
  });

  it("有 screenshotDataUrl 时入队", () => {
    const { sync, enqueueScreenshot } = makeSync();
    sync.run({ toolName: "screenshot_page", toolCallId: "c1", status: "success", result: "ok", meta: { screenshotDataUrl: "data:image/png;base64,abc" } as any, isPending: false, turnCount: 1 });
    expect(enqueueScreenshot).toHaveBeenCalledWith("data:image/png;base64,abc");
  });

  it("pending 编辑时同步 edits_updated 并触发 onPendingChanged", () => {
    const { sync, sendEditsUpdated, onPendingChanged } = makeSync();
    sync.run({ toolName: ToolName.StrReplace, toolCallId: "c1", status: "success", result: "ok", meta: {} as any, isPending: true, turnCount: 1 });
    expect(sendEditsUpdated).toHaveBeenCalled();
    expect(onPendingChanged).toHaveBeenCalled();
  });

  it("auto 模式下编辑成功也会补发 edits_updated", () => {
    const { sync, sendEditsUpdated, onPendingChanged } = makeSync();
    sync.run({ toolName: ToolName.ApplyPatch, toolCallId: "c1", status: "success", result: "ok", meta: {} as any, isPending: false, turnCount: 1 });
    expect(sendEditsUpdated).toHaveBeenCalled();
    expect(onPendingChanged).not.toHaveBeenCalled();
  });
});
