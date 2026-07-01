/**
 * McpController —— MCP（Model Context Protocol）工具的预取/解析/调用（从 AgentSession 解耦）
 *
 * 职责单一：每轮用户输入前解析三来源 MCP 配置 → 连接 → 拉取工具清单，构建模型可见工具定义与
 * 「模型名 → 真实目标」映射；执行期负责把模型工具名解析为真实 server/tool 并调用（含确认门）。
 *
 * 通过构造注入的 session 引用读写 MCP 相关状态（mcp/mcpRegistry/mcpToolMap/mcpToolDefsCache，
 * 均 @internal），并复用 session 的工具确认门 waitForToolConfirmation。
 * MCP 是增强项：预取任何环节失败都不阻塞主流程，清空缓存即可。
 */

import type { ToolDef } from "../llm/types.js";
import { encodeMcpToolName, MCP_TOOL_PREFIX } from "../mcp/types.js";
import type { AgentSession } from "../agentSession.js";

export class McpController {
  constructor(private readonly s: AgentSession) {}

  /**
   * 预取 MCP 工具（每轮用户输入前）：解析三来源配置 → 同步连接 → 拉取工具清单，
   * 构建模型可见的工具定义与「模型名 → 真实目标」映射。
   * MCP 是增强项：任何环节失败都不阻塞主流程，清空缓存即可（其它工具照常）。Quest 模式不启用。
   */
  async prefetchMcpTools(): Promise<void> {
    this.s.mcpToolDefsCache = [];
    this.s.mcpToolMap.clear();
    if (!this.s.mcp || this.s.mode === "quest") return;
    try {
      const specs = await this.s.mcpRegistry.resolve();
      await this.s.mcp.syncServers(specs);
      const tools = await this.s.mcp.listTools();
      for (const t of tools) {
        let modelName = encodeMcpToolName(t.serverId, t.name);
        // 编码不可逆且可能冲突：撞名时加后缀保唯一，映射表才是权威解析依据
        if (this.s.mcpToolMap.has(modelName)) modelName = `${modelName}_${this.s.mcpToolMap.size}`;
        this.s.mcpToolMap.set(modelName, { serverId: t.serverId, toolName: t.name, serverName: t.serverName, autoApprove: t.autoApprove });
        this.s.mcpToolDefsCache.push({
          type: "function",
          function: {
            name: modelName,
            description: `[MCP·${t.serverName}] ${t.description || t.name}`,
            parameters: (t.inputSchema as Record<string, unknown>) || { type: "object", properties: {} },
          },
        } as ToolDef);
      }
      if (tools.length > 0) console.log(`[mcp] 已加载 ${tools.length} 个 MCP 工具（${specs.length} 个 server）`);
    } catch (err) {
      console.warn("[mcp] 预取 MCP 工具失败（忽略，不影响其它工具）:", (err as Error).message);
      this.s.mcpToolDefsCache = [];
      this.s.mcpToolMap.clear();
    }
  }

  /** 若是 MCP 工具，返回其真实 server 名与工具名（供前端卡片展示）。
   * 不在 mcpToolMap（已禁用/移除）时，从编码名尽力还原，至少让卡片能标出 server/tool 名。 */
  mcpMetaFor(toolName: string): { mcpServer?: string; mcpTool?: string } {
    const t = this.s.mcpToolMap.get(toolName);
    if (t) return { mcpServer: t.serverName, mcpTool: t.toolName };
    if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      const inner = toolName.slice(MCP_TOOL_PREFIX.length);
      const sep = inner.lastIndexOf("__");
      if (sep > 0) {
        // 去掉来源前缀（user_/workspace_/power_），下划线还原为空格
        const server = inner.slice(0, sep).replace(/^(user|workspace|power)_/, "").replace(/_/g, " ");
        return { mcpServer: server || "MCP", mcpTool: inner.slice(sep + 2) };
      }
    }
    return {};
  }

  /**
   * 执行一次 MCP 工具调用：autoApprove 命中直接放行，否则走确认门请用户批准本次调用。
   * 返回 result（给 AI，详细+含指令）+ userMessage（给前端卡片，简短）+ status。
   */
  async runMcpTool(modelToolName: string, args: Record<string, unknown>): Promise<{ result: string; status: "success" | "error"; userMessage?: string }> {
    const target = this.s.mcpToolMap.get(modelToolName);
    if (!target || !this.s.mcp) {
      return {
        result:
          `MCP 工具「${modelToolName}」当前不可用——它可能已被【禁用】、移除，或所属 server 未启用/未连接。` +
          `这不是连接抖动，请【不要重试该工具】，也不要推测是"连接不稳定/超时"。` +
          `如确实需要，请提示用户在 MCP 管理里启用对应 server；否则改用其它可用工具或直接回答。`,
        status: "error",
        userMessage: "该 MCP 工具已被禁用或不可用",
      };
    }
    if (!target.autoApprove) {
      const approved = await this.s.waitForToolConfirmation(target.toolName, args, "mcp", `${target.serverName} · ${target.toolName}`);
      if (!approved) {
        return {
          result: `用户拒绝了对 MCP 工具「${target.serverName}·${target.toolName}」的调用。不要重试，可改用其它方式或先询问用户。`,
          status: "error",
          userMessage: `已拒绝调用 ${target.serverName}·${target.toolName}`,
        };
      }
    }
    try {
      const res = await this.s.mcp.callTool(target.serverId, target.toolName, args);
      return { result: res.text, status: res.isError ? "error" : "success" };
    } catch (err) {
      return {
        result: `MCP 工具调用失败（${target.serverName}·${target.toolName}）：${(err as Error).message}`,
        status: "error",
        userMessage: `${target.serverName}·${target.toolName} 调用失败`,
      };
    }
  }
}
