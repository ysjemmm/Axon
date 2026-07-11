import type { InternalEvent } from "./eventModel.js";
import type { ToolContext, TurnContext } from "./handlerModel.js";
import type { NormalizedFinishReason } from "./finishReasonMapper.js";

/** OutputHandler 输出阶段建议：用于细化输出收尾层可能进入的稳定阶段。 */
export type OutputHandlerStage = "normalizing" | "ready_to_commit" | "finalized";

/**
 * OutputHandler 最小输入快照。
 *
 * 说明：
 * - 输入是某个 turn 已积累的运行态事件与工具上下文。
 * - OutputHandler 负责从运行态产物中筛选、规范化、提交可进入后续链路的事件与结果。
 */
export interface OutputHandlerInput {
  requestId: TurnContext["requestId"];
  turnId: TurnContext["turnId"];
  runtimeEvents: InternalEvent[];
  committedEvents: InternalEvent[];
  toolContexts: ToolContext[];
  contentDraft?: string;
  finishReason?: NormalizedFinishReason;
}

/**
 * OutputHandler 输出草案。
 *
 * 说明：
 * - committedEvents：已完成规范化、可进入持久化/前端输出链路的事件
 * - shouldContinue：本 request 是否还需要继续下一轮 turn
 * - finalContent：若本轮已经形成最终可回复内容，则在这里给出
 * - stage：当前输出草案处于输出收尾链路的哪个稳定阶段
 */
export interface OutputHandlerOutputDraft {
  committedEvents: InternalEvent[];
  shouldContinue: boolean;
  finalContent?: string;
  stage: OutputHandlerStage;
}

/**
 * OutputHandler 契约：
 * - 输入：turn 当前运行态产物
 * - 输出：可提交事件 + 是否继续 + 最终内容草案
 */
export interface OutputHandlerContract {
  handle(input: OutputHandlerInput): Promise<OutputHandlerOutputDraft>;
}
