import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { InternalEvent, RequestId, TurnId } from "./eventModel.js";
import type { ToolEvent } from "./toolEventModel.js";

/**
 * RequestContext：一次用户请求（request）的共享上下文骨架。
 *
 * 说明：
 * - request 表示用户视角的一次完整问题/任务。
 * - 一个 request 内部可能会包含多个 turn。
 * - 第一阶段这里只定义稳定骨架，不急于把所有业务字段一次塞满。
 */
export interface RequestContext {
  /** 本次请求唯一标识。 */
  requestId: RequestId;
  /** 当前请求开始时间。 */
  startedAt: string;
  /** request 级基础消息快照（system、history、summary、IDE context 等构建后的结果）。 */
  baseMessages: ChatCompletionMessageParam[];
}

/**
 * TurnContext：同一个 request 内，一次内部 LLM 推进的上下文骨架。
 *
 * 说明：
 * - turn 表示 agent 为完成 request 而进行的一次内部迭代。
 * - content / reasoning / tool 默认直接归属于 turn。
 */
export interface TurnContext {
  /** 所属 request。 */
  requestId: RequestId;
  /** 本轮 turn 唯一标识。 */
  turnId: TurnId;
  /** 当前 turn 开始时间。 */
  startedAt: string;
  /** 本轮真正发给模型的消息快照。 */
  effectiveMessages: ChatCompletionMessageParam[];
  /** 本轮原始运行事件（流式增量、工具阶段变化、调试事件等）。 */
  runtimeEvents: InternalEvent[];
  /** 本轮已规范化、准备进入后续输出/持久化链路的事件。 */
  committedEvents: InternalEvent[];
  /** 本轮工具调用上下文集合（运行态快照，供 ToolHandler 链路逐步补齐）。 */
  toolContexts: ToolContext[];
}

/**
 * ToolContext：单次工具调用的执行上下文骨架。
 *
 * 说明：
 * - 工具执行上下文挂在 turn 下面，描述“这一轮里这次工具调用”的运行态。
 * - 第一阶段先保留最少必要字段，后续再按执行链路扩展。
 */
export interface ToolContext {
  /** 所属 request。 */
  requestId: RequestId;
  /** 所属 turn。 */
  turnId: TurnId;
  /** 本次工具调用唯一标识。 */
  callId: string;
  /** 工具名。 */
  toolName: ToolEvent["toolName"];
  /** 工具大类。 */
  toolKind: ToolEvent["toolKind"];
  /**
   * 当前工具事件的逐步构建快照。
   *
   * 说明：
   * - 工具责任链各阶段会逐步补齐 phase、参数、AI payload、trace payload 等字段。
   * - 第一阶段不强制要求一开始就是完整 ToolEvent，因此这里使用 Partial 作为运行态快照。
   */
  partialToolEvent: Partial<ToolEvent>;
}

/** Request 级责任链节点：负责处理一次用户请求的某个阶段。 */
export interface RequestContextHandler {
  handle(input: import("./requestContextHandlerContract.js").RequestContextHandlerInput): Promise<import("./requestContextHandlerContract.js").RequestContextHandlerOutputDraft>;
}

/** Turn 级责任链节点：负责处理一次内部 LLM 推进的某个阶段。 */
export interface TurnContextHandler {
  handle(input: import("./turnContextHandlerContract.js").TurnContextHandlerInput): Promise<import("./turnContextHandlerContract.js").TurnContextHandlerOutputDraft>;
}

/** Tool 级责任链节点：负责处理一次工具调用的某个阶段。 */
export interface ToolDispatchHandler {
  handle(input: import("./toolDispatchHandlerContract.js").ToolDispatchHandlerInput): Promise<import("./toolDispatchHandlerContract.js").ToolDispatchHandlerOutputDraft>;
}

/** LLM 协议执行节点。 */
export interface LLMHandler {
  handle(input: import("./llmHandlerContract.js").LLMHandlerInput): Promise<import("./llmHandlerContract.js").LLMHandlerOutputDraft>;
}

/** 输出收尾节点。 */
export interface OutputHandler {
  handle(input: import("./outputHandlerContract.js").OutputHandlerInput): Promise<import("./outputHandlerContract.js").OutputHandlerOutputDraft>;
}
