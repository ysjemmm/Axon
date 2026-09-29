import { describe, expect, it } from "vitest";
import { workspaceOfPath } from "./focusWorkspace.js";

const WS = ["d:\\projects\\Axon", "d:\\projects\\axon-ide-shell", "d:\\me\\ai-router"];

describe("workspaceOfPath：文件属于哪个工作区", () => {
  it("命中文件所在的工作区", () => {
    expect(workspaceOfPath("d:\\projects\\Axon\\web\\src\\App.tsx", WS)).toBe("d:\\projects\\Axon");
    expect(workspaceOfPath("d:\\me\\ai-router\\kiro-reverser\\x.ts", WS)).toBe("d:\\me\\ai-router");
  });

  it("大小写不敏感（Windows 文件系统语义）", () => {
    expect(workspaceOfPath("D:\\PROJECTS\\AXON\\web\\src\\App.tsx", WS)).toBe("d:\\projects\\Axon");
  });

  it("正斜杠与反斜杠等价", () => {
    expect(workspaceOfPath("d:/projects/Axon/web/src/App.tsx", WS)).toBe("d:\\projects\\Axon");
  });

  it("不属于任何工作区时返回 null", () => {
    expect(workspaceOfPath("d:\\somewhere\\else\\a.ts", WS)).toBeNull();
    expect(workspaceOfPath("", WS)).toBeNull();
    expect(workspaceOfPath("d:\\projects\\Axon\\a.ts", [])).toBeNull();
  });

  it("前缀相似但不构成父子关系时不算命中", () => {
    // d:\projects\Axon-IDE 与 d:\projects\Axon 是相邻目录，不是父子
    expect(workspaceOfPath("d:\\projects\\Axon-IDE\\a.ts", ["d:\\projects\\Axon"])).toBeNull();
  });

  it("工作区存在父子关系时取最长匹配", () => {
    const nested = ["d:\\projects\\Axon", "d:\\projects\\Axon\\packages\\core"];
    expect(workspaceOfPath("d:\\projects\\Axon\\packages\\core\\src\\a.ts", nested)).toBe(
      "d:\\projects\\Axon\\packages\\core",
    );
    expect(workspaceOfPath("d:\\projects\\Axon\\web\\src\\a.ts", nested)).toBe("d:\\projects\\Axon");
  });

  it("工作区路径带结尾斜杠也能命中", () => {
    expect(workspaceOfPath("d:\\projects\\Axon\\a.ts", ["d:\\projects\\Axon\\"])).toBe("d:\\projects\\Axon\\");
  });

  it("文件恰为工作区根时视为命中", () => {
    expect(workspaceOfPath("d:\\projects\\Axon", WS)).toBe("d:\\projects\\Axon");
  });

  it("忽略空字符串工作区项", () => {
    expect(workspaceOfPath("d:\\projects\\Axon\\a.ts", ["", "d:\\projects\\Axon"])).toBe("d:\\projects\\Axon");
  });
});
