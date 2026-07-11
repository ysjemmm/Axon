import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { RequestContext, TurnContext } from "./handlerModel.js";
import type { RequestId, TurnId } from "./eventModel.js";

/** TurnContextHandler 输出阶段建议：用于细化 turn 构建层可能进入的稳定阶段。 */
export type TurnContextHandlerStage = "turn_received" | "messages_merged" | "turn_context_ready";

/**
 * TurnContextHandler 最小输入快照。
 *
 * 说明：
 * - 输入是在 request 级基础上下文之上，为某一轮 turn 准备实际发给模型的 messages。
 * - 第一阶段重点是明确 turn 的输入骨架，不急于把所有过滤/注入策略一次性固化进去。
 */
export interface TurnContextHandlerInput {
  requestId: RequestId;
  turnId: TurnId;
  startedAt: string;
  requestContext: RequestContext;
  /** 本轮新增消息（如用户输入、上一轮工具结果、临时注入提示等）。 */
  addedMessages: ChatCompletionMessageParam[];
}

/**
 * TurnContextHandler 输出草案。
 *
 * 说明：
 * - 输出的核心是 effectiveMessages，即本轮真正发给模型的完整消息快照。
 * - 同时初始化本轮事件容器与工具上下文容器。
 * - stage 用于标识当前 turn 构建层已经推进到哪个稳定阶段。
 */
export interface TurnContextHandlerOutputDraft {
  turnContext: TurnContext;
  stage: TurnContextHandlerStage;
}

/**
 * TurnContextHandler 契约：
 * - 输入：request 基础上下文 + 本轮新增消息
 * - 输出：本轮 turn 的执行上下文骨架
 */
export interface TurnContextHandlerContract {
  handle(input: TurnContextHandlerInput): Promise<TurnContextHandlerOutputDraft>;
}
