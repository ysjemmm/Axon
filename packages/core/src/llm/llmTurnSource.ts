/**
 * LLMTurnSource —— 一次 LLM 回合原始产物的最小抽象（供新 pipeline 的 LLMHandler 注入）
 *
 * 背景：
 * - LLMHandler 只负责“把一次回合的原始产物归一化成统一内部事件与草案”，
 *   不应该自己耦合底层协议（Chat Completions / Responses）如何发请求、如何解析 SSE。
 * - 因此把“跑一次回合、拿到原始产物”抽象成 LLMTurnSource 接口，由外部注入。
 *
 * 设计要点：
 * - 纯接口，不含任何实现；第一阶段仅用于把“协议执行”与“事件归一化编排”解耦。
 * - 产出结构刻意贴近现有 strategy 的 runTurn 结果 + reasoning 增量序列，便于后续用真实 strategy 适配。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ReasoningDeltaInput } from "./reasoningAssembler.js";
import type { NormalizedFinishReason } from "./finishReasonMapper.js";
import type { ToolKind } from "./toolEventModel.js";

/** 一次回合里识别出的工具调用草案（尚未执行）。 */
export interface LLMToolCallDraft {
  callId: string;
  toolName: string;
  toolKind: ToolKind;
  parsedArgs?: Record<string, unknown>;
  rawArgsText?: string;
}

/** 一次 LLM 回合的原始产物（结构化）。 */
export interface LLMTurnRawResult {
  /** 本回合累计正文。 */
  content: string;
  /** 本回合按到达顺序产出的 reasoning 增量序列。 */
  reasoningDeltas: ReasoningDeltaInput[];
  /** 本回合识别出的工具调用草案。 */
  toolCalls: LLMToolCallDraft[];
  /** 归一化后的结束原因（产品语义）。 */
  finishReason: NormalizedFinishReason;
  /**
   * 本回合 API 返回的真实 token 用量（透传自底层 strategy）。
   * 用于精确驱动计费与压缩；provider 未返回时为 undefined，由调用方回退到字符数估算。
   */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number };
}

/**
 * LLM 回合来源：跑一次回合并返回结构化原始产物。
 *
 * 说明：
 * - 具体实现（接真实 ChatCompletions / Responses strategy）由上层注入，本层不感知协议细节。
 * - LLMHandler 拿到原始产物后，负责把 reasoning 增量、正文、工具草案归一化成统一事件与草案。
 */
export interface LLMTurnSource {
  run(messages: ChatCompletionMessageParam[]): Promise<LLMTurnRawResult>;
}
