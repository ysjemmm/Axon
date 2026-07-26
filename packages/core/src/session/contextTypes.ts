/**
 * 三层 Context 类型定义 —— Session / Conversation / ConversationTurn
 *
 * 背景：AgentSession 此前把会话级、对话级、turn 级的状态字段全部拍平混在一起，
 * 导致字段生命周期不清晰（何时重置、跨不跨对话）、语义重叠（如 LoopGuardSnapshot
 * 里 reflectionsUsed 本该按对话重置却被当会话级字段跨对话保留，造成新话题继承
 * 旧话题的失败配额，提前触发"多次尝试均未成功"兜底）。
 *
 * 三层定义：
 * - SessionContext：整个会话生命周期，只增不减或持续变化，跨对话保留（如累计 token、
 *   model/provider、按目标聚合的失败次数）。
 * - ConversationContext：一次用户输入 → 结束（正常/取消/异常），每次新用户输入时新建/重置。
 * - ConversationTurnContext：一次 LLM API 请求的最小粒度，每次请求更新。
 *
 * 本文件只定义类型和工厂函数，不涉及状态迁移逻辑（迁移在 agentSession.ts 分步进行）。
 */

/** 按目标（文件路径 / 搜索词 / 命令前缀）聚合的失败次数记录 */
export interface TargetFailureRecord {
  key: string;
  count: number;
  toolName: string;
  path?: string;
}

/**
 * Session 级上下文：跨对话保留的会话状态。
 * 字段只增不减或持续变化，不随单次对话结束而重置。
 */
export interface SessionContext {
  /** 累计 input token（含子 Agent），只增不减 */
  sessionInputTokens: number;
  /** 累计 output token，只增不减 */
  sessionOutputTokens: number;
  /** 滚动摘要累计增量，超过阈值触发异步摘要（跨对话累加，触发后清零） */
  rollingSummaryAccumulated: number;
  /** delegate_task 子 Agent 委托计数器（全局自增） */
  delegateSeq: number;
  /** parallel_research 批次计数器（全局自增） */
  researchSeq: number;
  /** parallel_execute 批次计数器（全局自增） */
  executionSeq: number;
  /**
   * 按目标（文件路径/搜索词/命令前缀）聚合的累计失败次数。
   * 跨对话保留是合理的——"这个文件/命令老出问题"这一事实不该因为换了个话题就丢失，
   * 与 reflectionsUsed/summaryRestartsUsed（对话级，见 ConversationContext）语义不同。
   */
  targetFailures: Map<string, TargetFailureRecord>;
}

/** 创建一个初始的 SessionContext */
export function createSessionContext(): SessionContext {
  return {
    sessionInputTokens: 0,
    sessionOutputTokens: 0,
    rollingSummaryAccumulated: 0,
    delegateSeq: 0,
    researchSeq: 0,
    executionSeq: 0,
    targetFailures: new Map(),
  };
}

/**
 * Conversation 级上下文：一次用户输入开始 → 结束（正常完成/取消/异常）的状态。
 * 每次新用户输入到来时新建（或原地重置），不跨对话保留。
 */
export interface ConversationContext {
  /** 本次对话所有 turn 的 input token 之和 */
  conversationInputTokens: number;
  /** 本次对话所有 turn 的 output token 之和 */
  conversationOutputTokens: number;
  /** 本次对话中所有子 Agent（delegate/parallel）消耗的 token 总和 */
  conversationSubAgentTokens: number;
  /** 对话开始时 sessionInputTokens 的快照，取消时用差值复原本次对话已消耗量 */
  turnStartInputSnapshot: number;
  /** 对话开始前的消息条数快照，收尾时用于切出本次对话新增的消息 */
  turnStartMsgCount: number;
  /** 本次对话内是否已推进过一次 Relay 阶段（确认门：一次对话最多推进一个文档阶段） */
  relayAdvancedThisConversation: boolean;
  /**
   * 投降前升级阶梯已用的反思次数。语义是"这次对话内失控升级到哪一步了"，
   * 必须按对话重置——否则旧话题的失败经历会提前消耗新话题的反思配额（bug 根因）。
   */
  reflectionsUsed: number;
  /** 投降前升级阶梯已用的深度复盘次数，同上按对话重置 */
  summaryRestartsUsed: number;
  /** 正在执行中的 relay 任务上下文（relayId/taskId/改动过的文件），供评审定位 */
  activeRelayTask: { relayId: string; taskId: string; changedFiles: Set<string> } | null;
}

/** 创建一个初始的 ConversationContext */
export function createConversationContext(): ConversationContext {
  return {
    conversationInputTokens: 0,
    conversationOutputTokens: 0,
    conversationSubAgentTokens: 0,
    turnStartInputSnapshot: 0,
    turnStartMsgCount: 0,
    relayAdvancedThisConversation: false,
    reflectionsUsed: 0,
    summaryRestartsUsed: 0,
    activeRelayTask: null,
  };
}

/**
 * ConversationTurn 级上下文：一次 LLM API 请求的最小粒度状态。
 * 每次 recordTurnUsage 更新，是当前"最新一次请求"的快照，不做历史累加
 * （历史累加由调用方同时写入 ConversationContext / SessionContext 完成）。
 */
export interface ConversationTurnContext {
  /** 最新一次 API 请求返回的 prompt token（真实值） */
  turnInputTokens: number;
  /** 最新一次 API 请求返回的 completion token（真实值） */
  turnOutputTokens: number;
  /** 最新一次 API 请求的缓存命中 token（credits 打折计算用） */
  cachedTokens: number;
}

/** 创建一个初始的 ConversationTurnContext */
export function createConversationTurnContext(): ConversationTurnContext {
  return {
    turnInputTokens: 0,
    turnOutputTokens: 0,
    cachedTokens: 0,
  };
}
