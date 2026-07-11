import { calculateCredits, buildCreditDetail } from "../credits.js";
import { pruneOldToolResults } from "../compactor.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/** 收尾器输入：把 finalizeAssistantReply 所需的会话状态显式化。 */
export interface TurnFinalizerInput {
  contentBuffer: string;
  streamedContentThisRound: string;
  turnStartTime: number;
  model: string;
  messages: ChatCompletionMessageParam[];
  lastTurnTokens: number;
  lastTurnOutputTokens: number;
  lastCompletionTokens: number;
  buildTokenBreakdown: () => { memoryTokens: number; systemTokens: number; questionTokens: number };
  compactionEnabled: boolean;
  toolResultKeepTurns: number;
  rollingSummaryAccumulated: number;
  triggerTokens: number;
}

/** 收尾器输出：调用方据此回写 session 状态并做副作用。 */
export interface TurnFinalizerOutput {
  messages: ChatCompletionMessageParam[];
  elapsed: number;
  turnTokens: number;
  credits: number;
  creditDetail: unknown;
  nextRollingSummaryAccumulated: number;
  shouldTriggerRollingSummary: boolean;
}

/**
 * TurnFinalizer —— turn 正常收尾的纯协作者。
 *
 * 目标：
 * - 从 AgentSession.finalizeAssistantReply 抽出“如何计算 turnStats / 如何更新消息数组”的纯逻辑，
 *   让剩余的 session 方法只负责副作用（persist / send / maybeRollingSummary）。
 * - 不接管副作用，不自己发 stream_end、不自己落盘，只返回计算结果给调用方。
 */
export class TurnFinalizer {
  finalize(input: TurnFinalizerInput): TurnFinalizerOutput {
    const elapsed = Date.now() - input.turnStartTime;
    const turnTokens = input.lastTurnTokens || input.contentBuffer.length;
    const realOutput = input.lastTurnOutputTokens || input.lastCompletionTokens;
    const estimatedOutput = realOutput > 0 ? realOutput : Math.ceil((input.contentBuffer.length + input.streamedContentThisRound.length) * 0.4);
    const breakdown = { ...input.buildTokenBreakdown(), outputTokens: estimatedOutput };
    const credits = calculateCredits(input.model, breakdown);
    const creditDetail = buildCreditDetail(input.model, breakdown);

    const nextMessages = [...input.messages, {
      role: "assistant",
      content: input.contentBuffer,
      turnStats: { elapsed, tokens: turnTokens, model: input.model, credits, creditDetail },
    } as any];

    const prunedMessages = input.compactionEnabled
      ? pruneOldToolResults(nextMessages, input.toolResultKeepTurns)
      : nextMessages;

    const nextRollingSummaryAccumulated = input.rollingSummaryAccumulated + turnTokens;
    const shouldTriggerRollingSummary = nextRollingSummaryAccumulated >= input.triggerTokens;

    return {
      messages: prunedMessages,
      elapsed,
      turnTokens,
      credits,
      creditDetail,
      nextRollingSummaryAccumulated,
      shouldTriggerRollingSummary,
    };
  }
}
