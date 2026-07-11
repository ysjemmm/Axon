import { ToolName, type ToolMeta } from "../tools/index.js";

/** Relay 工具执行请求。 */
export interface RelayToolExecuteRequest {
  toolName: string;
  toolArgs: Record<string, unknown>;
  meta: ToolMeta;
}

/** Relay 工具执行结果。 */
export interface RelayToolExecuteResult {
  result: string;
  status: "success" | "error";
}

/** RelayToolExecutor 的依赖：把确认门与具体执行实现从 AgentSession 注入。 */
export interface RelayToolExecutorDeps {
  waitForToolConfirmation: (toolName: string, args: Record<string, unknown>, kind?: "relay" | "mcp", label?: string) => Promise<boolean>;
  runRelayCreate: (args: Record<string, unknown>) => Promise<string>;
  runRelaySaveDoc: (args: Record<string, unknown>) => Promise<string>;
  runRelayAdvance: (args: Record<string, unknown>) => Promise<string>;
  runRelayUpdateTask: (args: Record<string, unknown>) => Promise<string>;
  runRelayReviewTask: (args: Record<string, unknown>) => Promise<string>;
}

/**
 * Relay 工具执行器：封装 relay_* 工具族的确认门与具体调用。
 *
 * 从 AgentSession.dispatchToolCall 迁出的第三刀，保持行为完全一致：
 * - relay_create 先走确认门；用户拒绝时返回原来的 AI 文案，并写 meta.userMessage。
 * - 其余 relay_* 直接委托各自 runner。
 * - 所有异常都收敛为 status=error + 前缀化错误文案。
 */
export class RelayToolExecutor {
  constructor(private readonly deps: RelayToolExecutorDeps) {}

  async execute(req: RelayToolExecuteRequest): Promise<RelayToolExecuteResult> {
    const { toolName, toolArgs, meta } = req;
    let result = "";
    let status: "success" | "error" = "success";

    try {
      if (toolName === ToolName.RelayCreate) {
        const confirmed = await this.deps.waitForToolConfirmation(toolName, toolArgs);
        if (!confirmed) {
          result = "用户拒绝创建 Relay 工作流。请直接在本次对话中解决问题，不使用 Relay 长任务工作流。可以正常使用工具（读文件、写代码、执行命令等），只是不走 Relay 的分阶段流程。";
          meta.userMessage = "用户跳过了 Relay 创建";
          status = "error";
        } else {
          result = await this.deps.runRelayCreate(toolArgs);
        }
      } else if (toolName === ToolName.RelaySaveDoc) {
        result = await this.deps.runRelaySaveDoc(toolArgs);
      } else if (toolName === ToolName.RelayAdvance) {
        result = await this.deps.runRelayAdvance(toolArgs);
      } else if (toolName === ToolName.RelayUpdateTask) {
        result = await this.deps.runRelayUpdateTask(toolArgs);
      } else if (toolName === ToolName.RelayReviewTask) {
        result = await this.deps.runRelayReviewTask(toolArgs);
      } else {
        status = "error";
        result = `Relay 操作失败: 未知的 relay 工具 ${toolName}`;
      }
    } catch (err) {
      result = `Relay 操作失败: ${(err as Error).message}`;
      status = "error";
    }

    return { result, status };
  }
}
