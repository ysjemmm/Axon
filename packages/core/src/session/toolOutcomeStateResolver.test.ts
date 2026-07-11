import { describe, expect, it, vi } from "vitest";
import { ToolName } from "../tools/index.js";
import { ToolOutcomeStateResolver } from "./toolOutcomeStateResolver.js";

describe("ToolOutcomeStateResolver", () => {
  function guard() {
    return { recordToolResult: vi.fn() } as any;
  }

  it("编辑成功时识别 mutated + mutatedPaths", () => {
    const out = new ToolOutcomeStateResolver().resolve({
      toolName: ToolName.StrReplace,
      toolArgs: { path: "a.ts" },
      result: "ok",
      status: "success",
      meta: { fileDiff: { path: "a.ts" } } as any,
      guard: guard(),
      hostEditMode: "auto",
    });
    expect(out.mutated).toBe(true);
    expect(out.mutatedPaths).toEqual(["a.ts"]);
  });

  it("manual 模式下编辑成功识别 isPending=true", () => {
    const out = new ToolOutcomeStateResolver().resolve({
      toolName: ToolName.ApplyPatch,
      toolArgs: {},
      result: "ok",
      status: "success",
      meta: {} as any,
      guard: guard(),
      hostEditMode: "manual",
    });
    expect(out.isPending).toBe(true);
  });

  it("编辑工具失败识别 markTransient=true", () => {
    const out = new ToolOutcomeStateResolver().resolve({
      toolName: ToolName.CreateFile,
      toolArgs: {},
      result: "未找到匹配 oldStr",
      status: "error",
      meta: {} as any,
      guard: guard(),
      hostEditMode: "auto",
    });
    expect(out.markTransient).toBe(true);
  });

  it("check_diagnostics 成功识别 diagnosed=true", () => {
    const out = new ToolOutcomeStateResolver().resolve({
      toolName: ToolName.CheckDiagnostics,
      toolArgs: {},
      result: "ok",
      status: "success",
      meta: {} as any,
      guard: guard(),
      hostEditMode: "auto",
    });
    expect(out.diagnosed).toBe(true);
  });

  it("activeRelayTask 存在时收集 relayChangedPaths", () => {
    const out = new ToolOutcomeStateResolver().resolve({
      toolName: ToolName.ApplyPatch,
      toolArgs: {},
      result: "ok",
      status: "success",
      meta: { fileDiffs: [{ path: "a.ts" }, { path: "b.ts" }] } as any,
      guard: guard(),
      hostEditMode: "auto",
      activeRelayTask: { changedFiles: new Set<string>() },
    });
    expect(out.relayChangedPaths).toEqual(["a.ts", "b.ts"]);
  });
});
