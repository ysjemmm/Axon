import type {
  OutputHandler,
  OutputHandlerContract,
  OutputHandlerInput,
  OutputHandlerOutputDraft,
} from "./index.js";

/**
 * OutputHandler 第一阶段实现骨架。
 *
 * 说明：
 * - 当前先不接入真实的持久化、前端事件输出、最终回复判定细节。
 * - 先验证输出收尾层契约已可被实现层稳定承接。
 */
export class DefaultOutputHandler implements OutputHandler, OutputHandlerContract {
  async handle(input: OutputHandlerInput): Promise<OutputHandlerOutputDraft> {
    // 规范化收尾：把本轮运行态事件并入已提交事件集合（运行态在前保留原有已提交事件）。
    // 第一阶段先做最小规范化——原样纳入，不丢事件；后续可在此加过滤/去噪/归并策略。
    const committedEvents = [...input.committedEvents, ...input.runtimeEvents];
    return {
      committedEvents,
      shouldContinue: input.finishReason === "tool_calls" || input.finishReason === "truncated",
      finalContent: input.finishReason === "complete" ? input.contentDraft : undefined,
      stage: "ready_to_commit",
    };
  }
}
