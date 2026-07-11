import { describe, expect, it, vi } from "vitest";
import { NoToolTurnDecider } from "./noToolTurnDecider.js";

function guard(overrides: Partial<{ noteIncompleteRetry: () => boolean }> = {}) {
  return {
    noteIncompleteRetry: vi.fn(() => false),
    ...overrides,
  } as any;
}

describe("NoToolTurnDecider", () => {
  it("finishReason=error → abort_error", () => {
    const out = new NoToolTurnDecider().decide({
      contentBuffer: "x",
      finishReason: "error",
      guard: guard(),
      ts: { didSelfCheck: false, emptyRetried: false },
    });
    expect(out).toEqual({ action: "abort_error" });
  });

  it("truncated + 有内容 → continue_truncated", () => {
    const out = new NoToolTurnDecider().decide({
      contentBuffer: "半截",
      finishReason: "truncated",
      guard: guard(),
      ts: { didSelfCheck: false, emptyRetried: false },
    });
    expect(out).toEqual({ action: "continue_truncated" });
  });

  it("未完成回复且未超上限 → continue_incomplete(false)", () => {
    const out = new NoToolTurnDecider().decide({
      contentBuffer: "我还需要看一下这个文件",
      finishReason: "complete",
      guard: guard({ noteIncompleteRetry: () => false }),
      ts: { didSelfCheck: false, emptyRetried: false },
    });
    expect(out).toEqual({ action: "continue_incomplete", forceFinalizePrompt: false });
  });

  it("未完成回复且超上限 → continue_incomplete(true)", () => {
    const out = new NoToolTurnDecider().decide({
      contentBuffer: "我还需要看一下这个文件",
      finishReason: "complete",
      guard: guard({ noteIncompleteRetry: () => true }),
      ts: { didSelfCheck: false, emptyRetried: false },
    });
    expect(out).toEqual({ action: "continue_incomplete", forceFinalizePrompt: true });
  });

  it("空回复首次 → continue_empty_retry，并写回 emptyRetried", () => {
    const ts = { didSelfCheck: false, emptyRetried: false };
    const out = new NoToolTurnDecider().decide({
      contentBuffer: "",
      finishReason: "complete",
      guard: guard(),
      ts,
    });
    expect(out).toEqual({ action: "continue_empty_retry" });
    expect(ts.emptyRetried).toBe(true);
    expect(ts.didSelfCheck).toBe(true);
  });

  it("正常完成 → finalize，并写回 didSelfCheck", () => {
    const ts = { didSelfCheck: false, emptyRetried: true };
    const out = new NoToolTurnDecider().decide({
      contentBuffer: "最终回答",
      finishReason: "complete",
      guard: guard(),
      ts,
    });
    expect(out).toEqual({ action: "finalize" });
    expect(ts.didSelfCheck).toBe(true);
  });
});
