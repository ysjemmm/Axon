import { describe, expect, it } from "vitest";
import { resolveToolKind } from "./toolKindResolver.js";
import { ToolName } from "../tools/catalog.js";

describe("resolveToolKind", () => {
  it("文件读取类归为 read", () => {
    expect(resolveToolKind(ToolName.ReadFile)).toBe("read");
    expect(resolveToolKind(ToolName.ListDir)).toBe("read");
  });

  it("文件编辑类归为 edit", () => {
    expect(resolveToolKind(ToolName.CreateFile)).toBe("edit");
    expect(resolveToolKind(ToolName.StrReplace)).toBe("edit");
    expect(resolveToolKind(ToolName.ApplyPatch)).toBe("edit");
  });

  it("命令/进程类归为 command", () => {
    expect(resolveToolKind(ToolName.ExecuteCommand)).toBe("command");
    expect(resolveToolKind(ToolName.StartProcess)).toBe("command");
  });

  it("浏览器类归为 browser", () => {
    expect(resolveToolKind(ToolName.OpenBrowser)).toBe("browser");
    expect(resolveToolKind(ToolName.BrowserGetHtml)).toBe("browser");
  });

  it("工作区搜索归为 search，联网归为 network", () => {
    expect(resolveToolKind(ToolName.Search)).toBe("search");
    expect(resolveToolKind(ToolName.WebSearch)).toBe("network");
    expect(resolveToolKind(ToolName.WebFetch)).toBe("network");
  });

  it("诊断归为 diagnostics", () => {
    expect(resolveToolKind(ToolName.CheckDiagnostics)).toBe("diagnostics");
  });

  it("编排类归为 orchestration", () => {
    expect(resolveToolKind(ToolName.DelegateTask)).toBe("orchestration");
    expect(resolveToolKind(ToolName.ParallelResearch)).toBe("orchestration");
  });

  it("未知工具名（如 MCP 动态工具）回退到 other", () => {
    expect(resolveToolKind("mcp__some_dynamic_tool")).toBe("other");
    expect(resolveToolKind("")).toBe("other");
  });
});
