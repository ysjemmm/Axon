import type { ToolEvent } from "./toolEventModel.js";
import type { ToolContext, TurnContext } from "./handlerModel.js";
import type { InternalEvent } from "./eventModel.js";

/** ToolDispatchHandler 输出阶段建议：用于细化工具分发层可能进入的稳定阶段。 */
export type ToolDispatchStage = "draft_received" | "dispatching" | "tool_executing" | "tool_completed" | "tool_failed";

/**
 * ToolDispatchHandler 最小输入快照。
 *
 * 说明：
 * - 输入是 LLMHandler 已识别出的工具调用草案，以及当前 turn 的运行态上下文。
 * - 第一阶段先不强耦合具体宿主实现，仅约束“工具分发层至少吃什么”。
 */
export interface ToolDispatchHandlerInput {
  requestId: TurnContext["requestId"];
  turnId: TurnContext["turnId"];
  toolDrafts: ToolEvent[];
  toolContexts: ToolContext[];
}

/**
 * ToolDispatchHandler 输出草案。
 *
 * 说明：
 * - runtimeEvents：工具执行过程中新增的运行态事件
 * - toolContexts：执行后更新过的工具上下文集合
 * - toolResultsReady：是否已有可交给后续输出链路消费的工具结果
 * - stage：当前输出草案处于工具分发链路的哪个稳定阶段
 */
export interface ToolDispatchHandlerOutputDraft {
  runtimeEvents: InternalEvent[];
  toolContexts: ToolContext[];
  toolResultsReady: boolean;
  stage: ToolDispatchStage;
}

/**
 * ToolDispatchHandler 契约：
 * - 输入：工具调用草案 + 当前 turn 的工具运行态上下文
 * - 输出：更新后的工具上下文与新增运行态事件
 */
export interface ToolDispatchHandlerContract {
  handle(input: ToolDispatchHandlerInput): Promise<ToolDispatchHandlerOutputDraft>;
}
