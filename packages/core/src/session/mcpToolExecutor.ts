import type { ToolMeta } from "../tools/index.js";

/** MCP 工具执行请求。 */
export interface McpToolExecuteRequest {
  toolName: string;
  toolArgs: Record<string, unknown>;
  meta: ToolMeta;
}

/** MCP 工具执行结果。 */
export interface McpToolExecuteResult {
  result: string;
  status: "success" | "error";
}

/** McpToolExecutor 的依赖：把具体 MCP 路由从 AgentSession 注入。 */
export interface McpToolExecutorDeps {
  runMcpTool: (modelToolName: string, args: Record<string, unknown>) => Promise<{ result: string; status: "success" | "error"; userMessage?: string }>;
}

/**
 * MCP 工具执行器：封装 mcp 工具路由与 userMessage 回填。
 *
 * 从 AgentSession.dispatchToolCall 迁出的下一刀，保持行为完全一致：
 * - 调用 McpController.runMcpTool
 * - 把返回的 userMessage 回填到 meta.userMessage（供前端卡片简短展示）
 */
export class McpToolExecutor {
  constructor(private readonly deps: McpToolExecutorDeps) {}

  async execute(req: McpToolExecuteRequest): Promise<McpToolExecuteResult> {
    const out = await this.deps.runMcpTool(req.toolName, req.toolArgs);
    if (out.userMessage) req.meta.userMessage = out.userMessage;
    return { result: out.result, status: out.status };
  }
}
