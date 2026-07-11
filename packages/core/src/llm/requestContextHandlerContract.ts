import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { RequestContext } from "./handlerModel.js";
import type { RequestId } from "./eventModel.js";

/** RequestContextHandler 输出阶段建议：用于细化 request 起点层可能进入的稳定阶段。 */
export type RequestContextHandlerStage = "request_received" | "history_loaded" | "base_messages_built";

/**
 * RequestContextHandler 最小输入快照。
 *
 * 说明：
 * - 输入代表一次用户 request 的起始信息。
 * - 第一阶段先聚焦“构建 request 级基础上下文”，不急于把记忆治理、压缩策略等复杂逻辑都塞进来。
 */
export interface RequestContextHandlerInput {
  requestId: RequestId;
  startedAt: string;
  /** 用户本次输入的原始文本。 */
  userInput: string;
  /** request 开始时可用的历史消息快照。 */
  historyMessages: ChatCompletionMessageParam[];
}

/**
 * RequestContextHandler 输出草案。
 *
 * 说明：
 * - 输出的核心是 request 级基础消息骨架，即后续 turn 都会默认继承的 baseMessages。
 * - stage 用于标识当前 request 起点层已经推进到哪个稳定阶段。
 */
export interface RequestContextHandlerOutputDraft {
  requestContext: RequestContext;
  stage: RequestContextHandlerStage;
}

/**
 * RequestContextHandler 契约：
 * - 输入：一次 request 的起始信息
 * - 输出：该 request 的基础上下文骨架
 */
export interface RequestContextHandlerContract {
  handle(input: RequestContextHandlerInput): Promise<RequestContextHandlerOutputDraft>;
}
