import { describe, expect, it } from "vitest";
import { ToolDefBuilder } from "./toolDefBuilder.js";

/** 用最小假会话驱动工具装配，只看最终暴露给模型的工具名。 */
function toolNames(mode: string, questWebSearch = false): string[] {
  const builder = new ToolDefBuilder(
    { mode, questWebSearch, mcpToolDefsCache: [] } as any,
  );
  return builder.getToolDefs().map((t) => (t as { function?: { name?: string } }).function?.name ?? "");
}

describe("ToolDefBuilder 工具装配", () => {
  it("问答（Quest）模式默认只给 ask_user——不带读写/命令类工具", () => {
    const names = toolNames("quest");
    expect(names).toEqual(["ask_user"]);
  });

  it("问答模式开启联网时，ask_user 与 web_search/web_fetch 并存", () => {
    const names = toolNames("quest", true);
    expect(names).toContain("ask_user");
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
    // 问答模式仍不得混入"动仓库"的工具
    expect(names).not.toContain("read_file");
    expect(names).not.toContain("execute_command");
  });

  it("Agent 模式同时含 ask_user 与读写/编排类工具", () => {
    const names = toolNames("agent");
    expect(names).toContain("ask_user");
    expect(names).toContain("read_file");
    expect(names).toContain("delegate_task");
  });
});
