import { ToolName } from "../tools/index.js";

/** 委托工具执行请求。 */
export interface DelegatedToolExecuteRequest {
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallId: string;
}

/** 委托工具执行结果。 */
export interface DelegatedToolExecuteResult {
  result: string;
  status: "success" | "error";
}

/** DelegatedToolExecutor 依赖：把具体 runner 从 AgentSession 注入。 */
export interface DelegatedToolExecutorDeps {
  runDelegateTask: (args: Record<string, unknown>, toolCallId: string) => Promise<string>;
}

/**
 * 委托工具执行器：封装 delegate_task 分支，失败收敛为 `委托子 Agent 失败: ...`。
 */
export class DelegatedToolExecutor {
  constructor(private readonly deps: DelegatedToolExecutorDeps) {}

  async execute(req: DelegatedToolExecuteRequest): Promise<DelegatedToolExecuteResult> {
    const { toolName, toolArgs, toolCallId } = req;
    let result = "";
    let status: "success" | "error" = "success";

    try {
      if (toolName === ToolName.DelegateTask) {
        result = await this.deps.runDelegateTask(toolArgs, toolCallId);
      } else {
        status = "error";
        result = `委托执行失败: 未知工具 ${toolName}`;
      }
    } catch (err) {
      if (toolName === ToolName.DelegateTask) result = `委托子 Agent 失败: ${(err as Error).message}`;
      else result = `委托执行失败: ${(err as Error).message}`;
      status = "error";
    }

    return { result, status };
  }
}
