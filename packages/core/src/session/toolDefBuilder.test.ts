import { describe, expect, it } from "vitest";
import { ToolDefBuilder } from "./toolDefBuilder.js";

/** 用最小假会话驱动工具装配，只看最终暴露给模型的工具名。 */
function toolNames(
  mode: string,
  questWebSearch = false,
  host?: unknown,
  mediaEnabled = false,
  mcpToolDefsCache: unknown[] = [],
): string[] {
  const builder = new ToolDefBuilder(
    { mode, questWebSearch, mcpToolDefsCache, host, mediaEnabled } as any,
  );
  return builder.getAllToolDefs().map((t) => (t as { function?: { name?: string } }).function?.name ?? "");
}

/** 造两个假的 MCP 工具定义（形状与 McpController 预取出来的一致）。 */
function fakeMcpTools(): unknown[] {
  return ["mcp__user_fs__read", "mcp__power_kb__search"].map((n) => ({
    type: "function",
    function: { name: n, description: `[MCP·fake] ${n}`, parameters: { type: "object", properties: {} } },
  }));
}

describe("ToolDefBuilder 工具装配", () => {
  it("问答（Quest）模式默认给的工具都不碰仓库", () => {
    const names = toolNames("quest");
    // create_artifact / edit_artifact / read_artifact 只在产物目录内读写，问答模式也能交付、修改成品。
    // read_skill_file 只读技能 / Power 目录里的附属文件；update_memory 只改会话自己的记忆；update_tasks 只记进度清单。
    // use_skill / activate_power 只读方法论文本——技能与能力包清单会在系统提示里列给模型，
    // 没有这两个工具清单就是死的（列了名字却加载不到）。
    expect(names).toEqual([
      "ask_user", "create_artifact", "edit_artifact", "read_artifact", "read_skill_file", "update_memory", "update_tasks",
      "use_skill", "activate_power",
    ]);
  });

  it("问答模式拿不到任何读写 / 命令 / 浏览器工具（只读原则不被 use_skill 的引入带偏）", () => {
    const names = toolNames("quest", true, { mediaRenderer: {}, imageGenerator: {} }, true);
    for (const forbidden of [
      "read_file", "create_file", "str_replace", "apply_patch",
      "execute_command", "start_process", "list_dir", "search", "check_diagnostics",
      "open_browser", "screenshot_page", "browser_eval",
      "delegate_task", "relay_create",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("问答模式注入 MCP 工具（用户自配的外部能力，非 autoApprove 走确认门）", () => {
    const names = toolNames("quest", false, undefined, false, fakeMcpTools());
    expect(names).toContain("mcp__user_fs__read");
    expect(names).toContain("mcp__power_kb__search");
  });

  it("MCP 缓存为空时不注入任何 mcp__ 工具（没配 server / 预取失败）", () => {
    expect(toolNames("quest").some((n) => n.startsWith("mcp__"))).toBe(false);
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

  it("问答模式给了 create_artifact，但依然拿不到任何写文件 / 命令工具", () => {
    const names = toolNames("quest", true);
    expect(names).toContain("create_artifact");
    for (const forbidden of ["create_file", "str_replace", "apply_patch", "execute_command", "start_process"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("Agent 模式同时含 ask_user 与读写/编排类工具", () => {
    const names = toolNames("agent");
    expect(names).toContain("ask_user");
    expect(names).toContain("read_file");
    expect(names).toContain("delegate_task");
  });

  it("Agent 模式同样含 create_artifact", () => {
    expect(toolNames("agent")).toContain("create_artifact");
  });

  it("create_artifact 的 type 枚举与后端校验的合法取值一致", () => {
    const builder = new ToolDefBuilder({ mode: "quest", questWebSearch: false, mcpToolDefsCache: [] } as any);
    const def = builder.getAllToolDefs().find((t) => (t as any).function?.name === "create_artifact") as any;
    expect(def.function.parameters.properties.type.enum).toEqual(["html", "svg", "markdown", "code", "text"]);
    expect(def.function.parameters.required).toEqual(["title", "type", "content"]);
  });

  it("开关默认关闭时，即使宿主有能力也不暴露 render_media（不下载、不诱导模型调用）", () => {
    expect(toolNames("quest", false, { mediaRenderer: {} }, false)).not.toContain("render_media");
  });

  it("宿主没有媒体渲染能力时，开关打开也不暴露 render_media（否则模型会调一个必然失败的工具）", () => {
    expect(toolNames("quest", false, {}, true)).not.toContain("render_media");
  });

  it("开关打开且宿主有能力时，问答模式多给 render_media，但依然拿不到任何写文件 / 命令工具", () => {
    const names = toolNames("quest", true, { mediaRenderer: {} }, true);
    expect(names).toContain("render_media");
    for (const forbidden of ["create_file", "str_replace", "apply_patch", "execute_command", "start_process"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("render_media 的 format 枚举只含 gif / mp4，必填项不含声音相关字段（无声是合法的）", () => {
    const builder = new ToolDefBuilder({
      mode: "quest", questWebSearch: false, mcpToolDefsCache: [], host: { mediaRenderer: {} }, mediaEnabled: true,
    } as any);
    const def = builder.getAllToolDefs().find((t) => (t as any).function?.name === "render_media") as any;
    expect(def.function.parameters.properties.format.enum).toEqual(["gif", "mp4"]);
    expect(def.function.parameters.required).toEqual(["title", "html", "format"]);
  });
});
