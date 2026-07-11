import { describe, expect, it, vi } from "vitest";
import { McpToolExecutor } from "./mcpToolExecutor.js";

describe("McpToolExecutor", () => {
  it("把 runMcpTool 的结果透传，并回填 meta.userMessage", async () => {
    const runMcpTool = vi.fn(async () => ({ result: "ok", status: "success" as const, userMessage: "已执行 MCP" }));
    const ex = new McpToolExecutor({ runMcpTool });
    const meta: any = {};
    const out = await ex.execute({ toolName: "mcp__server__tool", toolArgs: { x: 1 }, meta });

    expect(runMcpTool).toHaveBeenCalledWith("mcp__server__tool", { x: 1 });
    expect(out).toEqual({ result: "ok", status: "success" });
    expect(meta.userMessage).toBe("已执行 MCP");
  });

  it("没有 userMessage 时不写 meta.userMessage", async () => {
    const runMcpTool = vi.fn(async () => ({ result: "fail", status: "error" as const }));
    const ex = new McpToolExecutor({ runMcpTool });
    const meta: any = {};
    const out = await ex.execute({ toolName: "mcp__server__tool", toolArgs: {}, meta });

    expect(out).toEqual({ result: "fail", status: "error" });
    expect(meta.userMessage).toBeUndefined();
  });
});
