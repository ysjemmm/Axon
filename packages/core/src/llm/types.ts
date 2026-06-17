/**
 * LLM 策略层的标准化类型定义。
 *
 * 目标：把"调用 LLM + 解析流式响应"抽象成统一接口，让上层 agent loop
 * 不关心底层是 Chat Completions 还是 Responses API。不同策略产出相同结构的
 * 流式事件和回合结果，上层逻辑（reasoning 检测、续写、自检、工具执行）完全复用。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/** 工具定义（与 OpenAI function tool 对齐，各策略自行转成对应 API 的格式） */
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * 流式过程中的标准化回调。策略在解析底层 SSE 时通过这些回调上报事件，
 * 上层据此推送给前端（reasoning_delta / stream_start / stream_delta / tool_call）。
 */
export interface LLMStreamCallbacks {
  /** 思考过程增量（reasoning_content / reasoning），不持久化 */
  onReasoningDelta(text: string): void;
  /** 正文文本增量 */
  onTextDelta(text: string): void;
  /** 首次检测到某个工具调用（工具名已确定），用于前端立刻显示 loading 卡片。
   * id 为该工具调用的真实 id（若此刻已可得），前端据此把 pending 卡片与后续
   * executing/result 事件精确关联，避免同名并行工具错位/幻影卡片。 */
  onToolCallDetected(name: string, id?: string): void;
}

/** 一次工具调用（标准化后，与具体 API 无关） */
export interface NormalizedToolCall {
  id: string;
  name: string;
  /** 原始 JSON 字符串参数（上层负责 JSON.parse） */
  arguments: string;
}

/** 模型 API 返回的真实 token 用量（来自 usage 字段，精确值） */
export interface TokenUsage {
  /** 输入（prompt）token 数 */
  promptTokens: number;
  /** 输出（completion）token 数 */
  completionTokens: number;
  /** 总 token 数 */
  totalTokens: number;
  /** 输入中命中提示缓存的 token 数（缓存部分按更低费率计费）；不可得时为 0 */
  cachedTokens?: number;
}

/** 一个回合的标准化结果（不管底层是 chat 还是 responses，都产出这个结构） */
export interface LLMTurnResult {
  /** 模型本回合输出的正文 */
  content: string;
  /** 本回合的工具调用列表（为空表示模型给出了最终回复） */
  toolCalls: NormalizedToolCall[];
  /** 结束原因：stop / tool_calls / length / content_filter 等 */
  finishReason: string | null;
  /** Responses API 专用：本次响应 id，用于下一轮 previous_response_id 续接 */
  responseId?: string;
  /** 模型 API 返回的真实 token 用量（流式末尾的 usage）；不可得时为 undefined */
  usage?: TokenUsage;
}

/** 策略执行一个回合所需的参数 */
export interface RunTurnParams {
  model: string;
  /** 统一的对话历史（OpenAI Chat 消息格式作为内部标准表示） */
  messages: ChatCompletionMessageParam[];
  /** 可用工具；为空数组表示本回合不提供工具（如强制总结收尾） */
  tools: ToolDef[];
  /** 中断信号 */
  signal?: AbortSignal;
  /** 流式事件回调 */
  callbacks: LLMStreamCallbacks;
  /** 采样温度 */
  temperature?: number;
}

/**
 * LLM 调用策略接口。
 * 每个策略封装一种底层协议（Chat Completions / Responses），
 * 对外暴露统一的 runTurn，产出标准化的 LLMTurnResult。
 */
export interface LLMStrategy {
  /** 策略名称，用于日志 */
  readonly name: string;
  /** 执行一个回合：发起请求 → 流式解析 → 返回标准化结果 */
  runTurn(params: RunTurnParams): Promise<LLMTurnResult>;
}
