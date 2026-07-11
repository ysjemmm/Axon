import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { InternalEvent } from "./eventModel.js";
import type { RequestContext, TurnContext, ToolContext } from "./handlerModel.js";

/**
 * Handler 变更权限约束模型。
 *
 * 目标：
 * - 先把 request / turn / tool 三层责任链里“谁可以改什么”定义清楚。
 * - 避免后续实现时所有 handler 都能随意修改全部上下文，重新退化成大杂烩流程。
 * - 第一阶段先以类型与约定文档形式落地，后续如需要再进一步做运行时/编译时更严格约束。
 */

/** Request 级 handler 允许修改的字段。 */
export interface RequestContextPatch {
  startedAt?: string;
  baseMessages?: ChatCompletionMessageParam[];
}

/** Turn 级 handler 允许修改的字段。 */
export interface TurnContextPatch {
  startedAt?: string;
  effectiveMessages?: ChatCompletionMessageParam[];
  runtimeEvents?: InternalEvent[];
  committedEvents?: InternalEvent[];
  toolContexts?: ToolContext[];
}

/** Tool 级 handler 允许修改的字段。 */
export interface ToolContextPatch {
  partialToolEvent?: ToolContext["partialToolEvent"];
}

/**
 * Request 级权限约束：
 * - 不允许修改 requestId
 * - 不直接持有全量事件桶
 * - 主要负责补齐 request 级基础上下文（system/history/summary/IDE context）
 */
export interface RequestHandlerPolicy {
  /** 允许读取的上下文快照。 */
  readonly snapshot: RequestContext;
  /** 允许修改的字段集合。 */
  readonly writable: Array<keyof RequestContextPatch>;
}

/**
 * Turn 级权限约束：
 * - 允许构建/改写本轮 effectiveMessages
 * - 允许累计 runtimeEvents
 * - 允许把已规范化事件写入 committedEvents
 * - 允许增补本轮 toolContexts
 * - 不允许修改 requestId / turnId
 */
export interface TurnHandlerPolicy {
  readonly snapshot: TurnContext;
  readonly writable: Array<keyof TurnContextPatch>;
}

/**
 * Tool 级权限约束：
 * - 只允许逐步补齐 partialToolEvent
 * - 不直接修改 turn 的 committedEvents / effectiveMessages
 * - 工具阶段产生的原始事件先由上层桥接回 TurnContext.runtimeEvents
 */
export interface ToolHandlerPolicy {
  readonly snapshot: ToolContext;
  readonly writable: Array<keyof ToolContextPatch>;
}

/**
 * 第一阶段五段式责任链的推荐权限分配。
 *
 * 说明：
 * - RequestContextHandler：只改 request 级基础上下文
 * - TurnContextHandler：只改本轮消息构建与运行态容器初始化
 * - LLMHandler：只追加 runtimeEvents，不直接持久化
 * - ToolDispatchHandler：只补齐 toolContexts 内的 partialToolEvent，并把运行态事件上抛到 turn
 * - OutputHandler：负责把 runtimeEvents 规范化后写入 committedEvents，并决定是否进入后续输出/持久化链路
 */
export const DEFAULT_HANDLER_POLICIES = {
  requestContextHandler: {
    writable: ["startedAt", "baseMessages"],
  } satisfies Pick<RequestHandlerPolicy, "writable">,
  turnContextHandler: {
    writable: ["startedAt", "effectiveMessages", "runtimeEvents", "toolContexts"],
  } satisfies Pick<TurnHandlerPolicy, "writable">,
  llmHandler: {
    writable: ["runtimeEvents"],
  } satisfies Pick<TurnHandlerPolicy, "writable">,
  toolDispatchHandler: {
    writable: ["toolContexts", "runtimeEvents"],
  } satisfies Pick<TurnHandlerPolicy, "writable">,
  outputHandler: {
    writable: ["committedEvents"],
  } satisfies Pick<TurnHandlerPolicy, "writable">,
} as const;
