import type {
  RequestContextHandler,
  TurnContextHandler,
  LLMHandler,
  ToolDispatchHandler,
  OutputHandler,
  RequestContextHandlerInput,
  TurnContextHandlerInput,
  RequestId,
  TurnId,
  InternalEvent,
} from "./index.js";

/**
 * PipelineOrchestrator 第一阶段最小输入。
 *
 * 说明：
 * - 仅用于打通 request -> turn -> llm -> tool -> output 这条最小空链路。
 * - 当前不接入真实会话历史存储、provider 调用、工具执行环境，只验证编排骨架与数据流方向。
 */
export interface PipelineOrchestratorInput {
  requestId: RequestId;
  turnId: TurnId;
  startedAt: string;
  userInput: string;
}

/**
 * PipelineOrchestrator 第一阶段最小输出。
 *
 * 说明：
 * - 返回五段式责任链每一层的输出快照，便于后续测试与阶段性断言。
 */
export interface PipelineOrchestratorOutput {
  requestStage: string;
  turnStage: string;
  llmStage: string;
  toolStage: string;
  outputStage: string;
  shouldContinue: boolean;
  finalContent?: string;
  /** 本轮最终提交的统一事件集合（供集成测试与调试观察事件汇总结果）。 */
  committedEvents: InternalEvent[];
}

/**
 * DefaultPipelineOrchestrator
 *
 * 第一阶段用途：
 * - 串起五段式责任链的默认实现骨架
 * - 验证统一出口与输入输出契约在真实编排路径上可闭合
 */
export class DefaultPipelineOrchestrator {
  constructor(
    private readonly requestContextHandler: RequestContextHandler,
    private readonly turnContextHandler: TurnContextHandler,
    private readonly llmHandler: LLMHandler,
    private readonly toolDispatchHandler: ToolDispatchHandler,
    private readonly outputHandler: OutputHandler,
  ) {}

  async run(input: PipelineOrchestratorInput): Promise<PipelineOrchestratorOutput> {
    const requestInput: RequestContextHandlerInput = {
      requestId: input.requestId,
      startedAt: input.startedAt,
      userInput: input.userInput,
      historyMessages: [],
    };
    const requestOutput = await this.requestContextHandler.handle(requestInput);

    const turnInput: TurnContextHandlerInput = {
      requestId: input.requestId,
      turnId: input.turnId,
      startedAt: input.startedAt,
      requestContext: requestOutput.requestContext,
      addedMessages: [{ role: "user", content: input.userInput }],
    };
    const turnOutput = await this.turnContextHandler.handle(turnInput);

    const llmOutput = await this.llmHandler.handle({
      requestId: input.requestId,
      turnId: input.turnId,
      effectiveMessages: turnOutput.turnContext.effectiveMessages,
    });

    const toolOutput = await this.toolDispatchHandler.handle({
      requestId: input.requestId,
      turnId: input.turnId,
      toolDrafts: llmOutput.toolDrafts,
      toolContexts: turnOutput.turnContext.toolContexts,
    });

    const output = await this.outputHandler.handle({
      requestId: input.requestId,
      turnId: input.turnId,
      runtimeEvents: [...turnOutput.turnContext.runtimeEvents, ...llmOutput.runtimeEvents, ...toolOutput.runtimeEvents],
      committedEvents: turnOutput.turnContext.committedEvents,
      toolContexts: toolOutput.toolContexts,
      contentDraft: llmOutput.contentDraft,
      finishReason: llmOutput.finishReason,
    });

    return {
      requestStage: requestOutput.stage,
      turnStage: turnOutput.stage,
      llmStage: llmOutput.stage,
      toolStage: toolOutput.stage,
      outputStage: output.stage,
      shouldContinue: output.shouldContinue,
      finalContent: output.finalContent,
      committedEvents: output.committedEvents,
    };
  }
}
