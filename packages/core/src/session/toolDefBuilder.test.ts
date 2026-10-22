import { describe, expect, it } from "vitest";
import { ToolDefBuilder } from "./toolDefBuilder.js";

/** 用最小假会话驱动工具装配，只看最终暴露给模型的工具名。 */
function toolNames(mode: string, questWebSearch = false, host?: unknown, mediaEnabled = false): string[] {
  const builder = new ToolDefBuilder(
    { mode, questWebSearch, mcpToolDefsCache: [], host, mediaEnabled } as any,
  );
  return builder.getToolDefs().map((t) => (t as { function?: { name?: string } }).function?.name ?? "");
}

describe("ToolDefBuilder 工具装配", () => {
  it("问答（Quest）模式默认只给 ask_user 与 create_artifact——不带读写/命令类工具", () => {
    const names = toolNames("quest");
    // create_artifact 由后端直接写到产物目录、不碰仓库，所以问答模式也可以交付成品；
    // 但除这两个之外不得有任何别的工具。
    expect(names).toEqual(["ask_user", "create_artifact"]);
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
    const def = builder.getToolDefs().find((t) => (t as any).function?.name === "create_artifact") as any;
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
    const def = builder.getToolDefs().find((t) => (t as any).function?.name === "render_media") as any;
    expect(def.function.parameters.properties.format.enum).toEqual(["gif", "mp4"]);
    expect(def.function.parameters.required).toEqual(["title", "html", "format"]);
  });
});
