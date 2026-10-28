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
  | "relay"
  | "ask_user"
  | "ask_form"
  | "report_outputs"
  | "report_checks"
  | "update_memory"
  | "update_tasks"
  | "create_artifact"
  | "artifact_io"
  | "render_media"
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
  if (RELAY_TOOLS.has(toolName)) return "relay";
  if (toolName === ToolName.AskUser) return "ask_user";
  if (toolName === ToolName.AskForm) return "ask_form";
  if (toolName === ToolName.ReportOutputs) return "report_outputs";
  if (toolName === ToolName.ReportChecks) return "report_checks";
  if (toolName === ToolName.UpdateMemory) return "update_memory";
  if (toolName === ToolName.UpdateTasks) return "update_tasks";
  if (toolName === ToolName.CreateArtifact) return "create_artifact";
  if (toolName === ToolName.EditArtifact || toolName === ToolName.ReadArtifact || toolName === ToolName.ReadSkillFile) return "artifact_io";
  if (toolName === ToolName.RenderMedia) return "render_media";
  if (toolName === ToolName.ExecuteCommand || toolName === ToolName.StartProcess) return "command";
  if (toolName.startsWith(MCP_TOOL_PREFIX)) return "mcp";
  return "generic";
}
