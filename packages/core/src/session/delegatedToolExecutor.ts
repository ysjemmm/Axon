import { ToolName } from "../tools/index.js";

/** 委托/并行工具执行请求。 */
export interface DelegatedToolExecuteRequest {
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallId: string;
}

/** 委托/并行工具执行结果。 */
export interface DelegatedToolExecuteResult {
  result: string;
  status: "success" | "error";
}

/** DelegatedToolExecutor 依赖：把具体 runner 从 AgentSession 注入。 */
export interface DelegatedToolExecutorDeps {
  runDelegateTask: (args: Record<string, unknown>, toolCallId: string) => Promise<string>;
  runParallelResearch: (args: Record<string, unknown>, toolCallId: string) => Promise<string>;
  runParallelExecution: (args: Record<string, unknown>, toolCallId: string) => Promise<string>;
}

/**
 * 委托/并行工具执行器：封装 delegate_task / parallel_research / parallel_execute 三个分支。
 *
 * 从 AgentSession.dispatchToolCall 迁出的下一刀，保持行为完全一致：
 * - delegate_task 失败 → `委托子 Agent 失败: ...`
 * - parallel_research 失败 → `并行调研失败: ...`
 * - parallel_execute 失败 → `并行执行失败: ...`
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
      } else if (toolName === ToolName.ParallelResearch) {
        result = await this.deps.runParallelResearch(toolArgs, toolCallId);
      } else if (toolName === ToolName.ParallelExecute) {
        result = await this.deps.runParallelExecution(toolArgs, toolCallId);
      } else {
        status = "error";
        result = `委托/并行执行失败: 未知工具 ${toolName}`;
      }
    } catch (err) {
      if (toolName === ToolName.DelegateTask) result = `委托子 Agent 失败: ${(err as Error).message}`;
      else if (toolName === ToolName.ParallelResearch) result = `并行调研失败: ${(err as Error).message}`;
      else if (toolName === ToolName.ParallelExecute) result = `并行执行失败: ${(err as Error).message}`;
      else result = `委托/并行执行失败: ${(err as Error).message}`;
      status = "error";
    }

    return { result, status };
  }
}
