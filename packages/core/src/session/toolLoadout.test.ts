import { describe, expect, it } from "vitest";
import { ToolLoadout, LOAD_TOOLS, loadToolsResult } from "./toolLoadout.js";
import type { ToolDef } from "../llm/types.js";

const def = (name: string) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } }) as unknown as ToolDef;
const names = (defs: ToolDef[]) => defs.map((d) => (d as { function: { name: string } }).function.name);

const base = ["read_file", "execute_command", "open_browser", "browser_click", "screenshot_page", "relay_create", "create_artifact", "ask_form"];
const ghTools = Array.from({ length: 10 }, (_, i) => `mcp__connector_gh__tool_${i}`);
const smallTools = ["mcp__user_fs__read", "mcp__user_fs__write"];
const all = [...base, ...ghTools, ...smallTools].map(def);
const mcpMap = new Map<string, { serverName: string; toolName: string }>([
  ...ghTools.map((t, i) => [t, { serverName: "GitHub", toolName: i === 0 ? "get_issue" : `list_pull_requests_${i}` }] as const),
  ...smallTools.map((t) => [t, { serverName: "fs", toolName: t.split("__").pop()! }] as const),
]);

describe("工具按需加载", () => {
  it("默认只放常驻工具 + load_tools；工具少的 MCP 服务常驻，工具多的进索引", () => {
    const loadout = new ToolLoadout();
    const groups = loadout.groups(all, mcpMap);
    expect(groups.map((g) => g.id)).toEqual(["browser", "relay", "artifact", "form", "mcp:GitHub"]);
    const shown = names(loadout.apply(all, groups));
    expect(shown).toEqual(["read_file", "execute_command", ...smallTools, LOAD_TOOLS]);
    const index = (loadout.apply(all, groups).at(-1) as { function: { description: string } }).function.description;
    expect(index).toContain("browser：浏览器自动化");
    expect(index).toContain("mcp:GitHub：[MCP·GitHub] 10 个工具");
  });

  it("load_tools 加载后整组可用，并且保持；全部加载后不再附 load_tools", () => {
    const loadout = new ToolLoadout();
    const groups = loadout.groups(all, mcpMap);
    const res = loadout.load({ groups: ["browser", "nope"] }, groups);
    expect(loadToolsResult(res, groups).result).toMatch(/已加载：browser（3 个工具）.*未找到：nope/);
    expect(names(loadout.apply(all, groups))).toContain("browser_click");
    loadout.load({ groups: ["relay", "artifact", "form", "mcp:github"] }, groups);
    expect(names(loadout.apply(all, groups))).not.toContain(LOAD_TOOLS);
  });

  it("用户输入命中关键词时预加载；直接调用未加载的工具也会把整组加载上", () => {
    const loadout = new ToolLoadout();
    const groups = loadout.groups(all, mcpMap);
    expect(loadout.preload("帮我打开 localhost:5173 看看页面", groups)).toEqual(["browser"]);
    expect(loadout.preload("看下 github 上那个 issue", groups)).toContain("mcp:GitHub");
    loadout.noteToolUsed("relay_create", groups);
    expect(loadout.isLoaded("relay")).toBe(true);
  });

  it("从历史推回已加载的组（重开会话）", () => {
    const loadout = new ToolLoadout();
    const groups = loadout.groups(all, mcpMap);
    loadout.hydrate([
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "screenshot_page", arguments: "{}" } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "2", type: "function", function: { name: LOAD_TOOLS, arguments: JSON.stringify({ groups: ["form"] }) } }] },
    ] as never, groups);
    expect(loadout.isLoaded("browser")).toBe(true);
    expect(loadout.isLoaded("form")).toBe(true);
    expect(loadout.isLoaded("relay")).toBe(false);
  });

  it("豁免的组常驻（问答模式的产物）", () => {
    const loadout = new ToolLoadout();
    expect(loadout.groups(all, mcpMap, ["artifact"]).map((g) => g.id)).not.toContain("artifact");
  });
});
