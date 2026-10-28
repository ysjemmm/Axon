/**
 * McpController 预取：Quest（纯问答）模式同样要能拿到 MCP 工具。
 *
 * 回归背景：早先 prefetchMcpTools 里有一句 `if (... || this.s.mode === "quest") return;`，
 * 结果是问答模式下即使用户配好了 MCP server，模型一个工具都看不到 —— 而系统提示里
 * 明明列着可用技能/能力包。现在 Quest 与 Agent 共用同一套预取逻辑，这里锁死这个行为。
 */
import { describe, expect, it, vi } from "vitest";
import { McpController } from "./mcpController.js";
import type { McpCapability, McpToolInfo } from "../mcp/types.js";

/** 造一个只满足 McpController 需要的最小会话。 */
function makeSession(opts: {
  mode?: "agent" | "quest";
  mcp?: McpCapability | null;
  tools?: McpToolInfo[] | (() => Promise<McpToolInfo[]>);
}) {
  const tools = opts.tools ?? [];
  const callTool = vi.fn(async () => ({ text: "ok" }));
  const mcp: McpCapability | null =
    opts.mcp === null
      ? null
      : (opts.mcp ?? {
          syncServers: vi.fn(async () => {}),
          listTools: typeof tools === "function" ? tools : vi.fn(async () => tools),
          callTool,
        });
  const session = {
    mode: opts.mode ?? "quest",
    mcp,
    mcpToolDefsCache: [] as unknown[],
    mcpToolMap: new Map<string, unknown>(),
    mcpRegistry: { resolve: vi.fn(async () => [{ id: "user:fs", name: "fs", source: "user", transport: "stdio" }]) },
    waitForToolConfirmation: vi.fn(async () => true),
  };
  return { session, callTool };
}

const oneTool: McpToolInfo[] = [
  {
    serverId: "user:fs",
    serverName: "fs",
    name: "read_file",
    description: "读一个文件",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    autoApprove: false,
  },
];

describe("McpController.prefetchMcpTools", () => {
  it("Quest 模式也会预取 MCP 工具（不能被 mode 挡掉）", async () => {
    const { session } = makeSession({ mode: "quest", tools: oneTool });
    await new McpController(session as never).prefetchMcpTools();
    expect(session.mcpToolDefsCache).toHaveLength(1);
    const name = (session.mcpToolDefsCache[0] as { function: { name: string } }).function.name;
    expect(name.startsWith("mcp__")).toBe(true);
    expect(session.mcpToolMap.get(name)).toMatchObject({ serverId: "user:fs", toolName: "read_file", serverName: "fs" });
  });

  it("Agent 模式行为不变", async () => {
    const { session } = makeSession({ mode: "agent", tools: oneTool });
    await new McpController(session as never).prefetchMcpTools();
    expect(session.mcpToolDefsCache).toHaveLength(1);
  });

  it("没有 MCP 运行时（未注入）时清空缓存且不抛错", async () => {
    const { session } = makeSession({ mcp: null });
    await expect(new McpController(session as never).prefetchMcpTools()).resolves.toBeUndefined();
    expect(session.mcpToolDefsCache).toEqual([]);
    expect(session.mcpToolMap.size).toBe(0);
  });

  it("listTools 抛错时静默降级，缓存清空、不影响其它工具", async () => {
    const { session } = makeSession({
      tools: async () => {
        throw new Error("连接失败");
      },
    });
    await expect(new McpController(session as never).prefetchMcpTools()).resolves.toBeUndefined();
    expect(session.mcpToolDefsCache).toEqual([]);
    expect(session.mcpToolMap.size).toBe(0);
  });

  it("注入的工具描述带 [MCP·serverName] 前缀，inputSchema 原样透传", async () => {
    const { session } = makeSession({ tools: oneTool });
    await new McpController(session as never).prefetchMcpTools();
    const def = session.mcpToolDefsCache[0] as {
      function: { description: string; parameters: Record<string, unknown> };
    };
    expect(def.function.description).toContain("[MCP·fs]");
    expect(def.function.parameters).toEqual({ type: "object", properties: { path: { type: "string" } } });
  });
});
