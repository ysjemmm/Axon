import type {
  RequestContextHandler,
  RequestContextHandlerContract,
  RequestContextHandlerInput,
  RequestContextHandlerOutputDraft,
  RequestContext,
} from "./index.js";

/**
 * RequestContextHandler 第一阶段实现骨架。
 *
 * 说明：
 * - 这是第二阶段的第一个“实现层消费者”试点文件。
 * - 当前不接入复杂的记忆治理、summary、IDE context 注入，只验证：
 *   1. 实现层是否可以稳定消费 `llm/index.ts` 统一出口
 *   2. request 基础上下文骨架的最小构造是否顺畅
 */
export class DefaultRequestContextHandler implements RequestContextHandler, RequestContextHandlerContract {
  async handle(input: RequestContextHandlerInput): Promise<RequestContextHandlerOutputDraft> {
    const requestContext: RequestContext = {
      requestId: input.requestId,
      startedAt: input.startedAt,
      baseMessages: [...input.historyMessages],
    };

    return {
      requestContext,
      stage: "base_messages_built",
    };
  }
}
