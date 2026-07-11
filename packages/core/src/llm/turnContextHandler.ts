import type {
  TurnContextHandler,
  TurnContextHandlerContract,
  TurnContextHandlerInput,
  TurnContextHandlerOutputDraft,
  TurnContext,
} from "./index.js";

/**
 * TurnContextHandler 第一阶段实现骨架。
 *
 * 说明：
 * - 这是第二阶段的第二个“实现层消费者”试点文件。
 * - 当前先验证：
 *   1. request 基础上下文 + 本轮新增消息 能否稳定组装成 turn 的 `effectiveMessages`
 *   2. `runtimeEvents / committedEvents / toolContexts` 的初始化骨架是否顺畅
 */
export class DefaultTurnContextHandler implements TurnContextHandler, TurnContextHandlerContract {
  async handle(input: TurnContextHandlerInput): Promise<TurnContextHandlerOutputDraft> {
    const turnContext: TurnContext = {
      requestId: input.requestId,
      turnId: input.turnId,
      startedAt: input.startedAt,
      effectiveMessages: [...input.requestContext.baseMessages, ...input.addedMessages],
      runtimeEvents: [],
      committedEvents: [],
      toolContexts: [],
    };

    return {
      turnContext,
      stage: "turn_context_ready",
    };
  }
}
