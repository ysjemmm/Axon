import { resolve } from "node:path";
import type { AgentHost } from "../host/index.js";
import { executeToolCall, ToolName, type ToolMeta, type WebCapability } from "../tools/index.js";
import type { SkillLoaderFn, PowerLoaderFn } from "../tools/definitions.js";
import type { GateOutcome } from "../tools/commandGate.js";

/** 命令类工具执行请求。 */
export interface CommandToolExecuteRequest {
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallId: string;
  meta: ToolMeta;
}

/** 命令类工具执行结果。 */
export interface CommandToolExecuteResult {
  result: string;
  status: "success" | "error";
  commandWasEdited?: string;
  toolArgs: Record<string, unknown>;
}

/** CommandToolExecutor 的运行时依赖。 */
export interface CommandToolExecutorDeps {
  cwd: string;
  host: AgentHost;
  workspaces?: string[];
  web?: WebCapability;
  signal?: AbortSignal;
  skillLoader?: SkillLoaderFn;
  powerLoader?: PowerLoaderFn;
  /** 命令信任门：灾难硬拦 → 白名单 → 未信任则弹三档授权。 */
  gateCommand: (command: string, toolCallId?: string) => Promise<GateOutcome>;
  /** 命令执行后同步终端实际 cwd。 */
  trackTerminalCwd: (toolName: string, args: Record<string, unknown>, meta?: ToolMeta) => void;
}

/**
 * 命令类工具执行器：负责 execute_command / start_process 的确认门与实际执行。
 *
 * 从 AgentSession.dispatchToolCall 迁出的第一块执行分支，保持行为完全一致：
 * - 先走 gateCommand，保留「工具卡片先出现 → 再弹确认 → 用户操作」的产品顺序（卡片由调用方在进入执行器前发送）。
 * - 用户编辑命令时，执行编辑后的命令，但不改写 AI 原始 tool_call；只通过 commandWasEdited 给后续 AI 上下文提示。
 * - ToolError.userMessage 兜底写入 meta，供前端卡片展示简短错误文案。
 */
export class CommandToolExecutor {
  constructor(private readonly deps: CommandToolExecutorDeps) {}

  /** 命令类工具：显式 cwd → 解析为绝对路径（AI 可能传相对路径如 "."），否则用会话主工作区。 */
  displayCwd(toolName: string, toolArgs: Record<string, unknown>): string {
    if (toolName !== ToolName.ExecuteCommand && toolName !== ToolName.StartProcess) return "";
    const argCwd = typeof (toolArgs as { cwd?: unknown }).cwd === "string" && (toolArgs as { cwd: string }).cwd.trim();
    return argCwd ? resolve(this.deps.cwd, argCwd) : this.deps.cwd;
  }

  async execute(req: CommandToolExecuteRequest): Promise<CommandToolExecuteResult> {
    let toolArgs = req.toolArgs;
    let result = "";
    let status: "success" | "error" = "success";
    let commandWasEdited: string | undefined;

    const command = String((toolArgs as { command?: unknown }).command ?? "");
    const outcome = await this.deps.gateCommand(command, req.toolCallId);
    if (!outcome.allow) {
      result = outcome.aiMessage || "命令未执行。";
      if (outcome.userMessage) req.meta.userMessage = outcome.userMessage;
      status = "error";
      return { result, status, commandWasEdited, toolArgs };
    }

    // 用户编辑了命令：用编辑后的版本执行，但不改写 AI 自己的 tool_call（保留它真实的原始意图）。
    if (outcome.editedCommand) commandWasEdited = outcome.editedCommand;
    const execArgs = outcome.editedCommand
      ? { ...toolArgs, command: outcome.editedCommand }
      : toolArgs;
    if (outcome.editedCommand) toolArgs = execArgs; // 仅用于 tool_result 事件展示实际执行的命令

    try {
      result = await executeToolCall(
        req.toolName,
        execArgs,
        this.deps.cwd,
        this.deps.host,
        req.meta,
        this.deps.workspaces,
        this.deps.skillLoader,
        this.deps.web,
        this.deps.powerLoader,
        this.deps.signal,
      );
      this.deps.trackTerminalCwd(req.toolName, execArgs, req.meta);
    } catch (err) {
      const error = err as Error & { userMessage?: string };
      result = `错误: ${error.message}`;
      status = "error";
      if (error.name === "ToolError" && error.userMessage && !req.meta.userMessage) {
        req.meta.userMessage = error.userMessage;
      }
    }

    return { result, status, commandWasEdited, toolArgs };
  }
}
