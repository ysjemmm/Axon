import { MCP_TOOL_PREFIX } from "../mcp/types.js";
import { ToolName } from "../tools/index.js";

/**
 * 工具分发路由：把 toolName 归类为 AgentSession 工具执行核的稳定分支。
 *
 * 这是从 agentSession.dispatchToolCall 抽出的第一刀：先只抽“走哪条分支”的决策，
 * 不改变任何执行/门控/落盘行为。后续可以围绕这些 route 继续把执行逻辑迁入独立 executor。
 */
export type ToolDispatchRoute =
  | "delegate_task"
  | "parallel_research"
  | "parallel_execute"
  | "relay"
  | "command"
  | "mcp"
  | "generic";

const RELAY_TOOLS = new Set<string>([
  ToolName.RelayCreate,
  ToolName.RelaySaveDoc,
  ToolName.RelayAdvance,
  ToolName.RelayUpdateTask,
  ToolName.RelayReviewTask,
]);

/** 根据工具名解析执行分支。 */
export function resolveToolDispatchRoute(toolName: string): ToolDispatchRoute {
  if (toolName === ToolName.DelegateTask) return "delegate_task";
  if (toolName === ToolName.ParallelResearch) return "parallel_research";
  if (toolName === ToolName.ParallelExecute) return "parallel_execute";
  if (RELAY_TOOLS.has(toolName)) return "relay";
  if (toolName === ToolName.ExecuteCommand || toolName === ToolName.StartProcess) return "command";
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return "mcp";
  return "generic";
}
