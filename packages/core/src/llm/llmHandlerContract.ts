import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { InternalEvent } from "./eventModel.js";
import type { ToolEvent } from "./toolEventModel.js";
import type { TurnContext } from "./handlerModel.js";
import type { NormalizedFinishReason } from "./finishReasonMapper.js";

/** LLMHandler 输出阶段建议：用于细化协议执行层可能进入的稳定阶段。 */
export type LLMHandlerStage = "prepared" | "streaming" | "tool_calls_detected" | "content_completed" | "failed";

/**
 * LLMHandler 最小输入快照。
 *
 * 说明：
 * - 第一阶段只约束协议执行层最少依赖什么，不把 provider/client/strategy 细节耦合进公共骨架。
 * - effectiveMessages 是本轮真正发给模型的完整输入快照。
 */
export interface LLMHandlerInput {
  requestId: TurnContext["requestId"];
  turnId: TurnContext["turnId"];
  effectiveMessages: ChatCompletionMessageParam[];
}

/**
 * LLMHandler 产出的最小结果草案。
 *
 * 说明：
 * - runtimeEvents：本轮协议执行过程中产生的统一内部事件（content/reasoning/status/debug 等）
 * - toolDrafts：从本轮模型输出中识别出的工具调用草案（尚未进入 ToolDispatchHandler 之前）
 * - finishReason：协议层或标准化层判断出的结束原因草案
 * - contentDraft：本轮累计正文草案（供后续 TurnDecision / OutputHandler 判断）
 * - stage：当前输出草案处于协议执行链路的哪个稳定阶段
 */
export interface LLMHandlerOutputDraft {
  runtimeEvents: InternalEvent[];
  toolDrafts: ToolEvent[];
  finishReason?: NormalizedFinishReason;
  contentDraft?: string;
  /**
   * 本回合 API 返回的真实 token 用量（透传自底层 strategy）。
   * 供上层在 canary 真正驱动 UI 时精确计费/驱动压缩；provider 未返回时为 undefined。
   */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number };
  stage: LLMHandlerStage;
}

/**
 * LLMHandler 契约：
 * - 输入：一个已准备好的 turn 输入快照
 * - 输出：协议执行后产生的事件与草案，不直接做持久化
 */
export interface LLMHandlerContract {
  handle(input: LLMHandlerInput): Promise<LLMHandlerOutputDraft>;
}
