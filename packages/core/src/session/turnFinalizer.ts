import { calculateCredits, buildCreditDetail } from "../credits.js";
import { estimateTokensFromText } from "../llm/tokenEstimator.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/** 收尾器输入：把 finalizeAssistantReply 所需的会话状态显式化。 */
export interface TurnFinalizerInput {
  contentBuffer: string;
  anthropicThinkingBlocks?: { thinking: string; signature?: string }[];
  /**
   * 本轮思考内容（chat 协议的 reasoning_content）。
   *
   * DeepSeek 官方文档：请求带 tools 时，历史轮次的 reasoning_content 必须完整回传，
   * 即使该轮没有实际调用工具；漏传会 400。不带 tools 时会被忽略，传了也无害。
   * 我们无法确定用户什么时候会带工具，所以凡是模型返回过思考就一律保留。
   */
  reasoningContent?: string;
  streamedContentThisRound: string;
  turnStartTime: number;
  model: string;
  providerName?: string;
  effort?: string;
  messages: ChatCompletionMessageParam[];
  lastTurnTokens: number;
  lastTurnOutputTokens: number;
  lastCompletionTokens: number;
  buildTokenBreakdown: () => { memoryTokens: number; systemTokens: number; questionTokens: number; cachedTokens?: number };
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
    // 端点没报 usage 时按文本估算。走统一的 estimateTokensFromText（CJK 0.7 / 其余 3.6 字符每 token），
    // 而非早先的 0.4/字符一刀切——后者对中文低估、对代码高估，同一段输出在不同代码路径能差一倍。
    const estimatedOutput = realOutput > 0
      ? realOutput
      : estimateTokensFromText(input.contentBuffer + input.streamedContentThisRound);
    const breakdown = { ...input.buildTokenBreakdown(), outputTokens: estimatedOutput };
    const credits = calculateCredits(input.model, breakdown);
    const creditDetail = buildCreditDetail(input.model, breakdown);

    const nextMessages = [...input.messages, {
      role: "assistant",
      content: input.contentBuffer,
      ...(input.reasoningContent ? { reasoning_content: input.reasoningContent } : {}),
      ...(input.anthropicThinkingBlocks?.length
        ? { anthropic_thinking_blocks: input.anthropicThinkingBlocks }
        : {}),
      turnStats: { elapsed, tokens: turnTokens, model: input.model, providerName: input.providerName, effort: input.effort, credits, creditDetail },
    } as any];

    // ⚠️ 这里【不再】在回合结束时裁剪旧工具结果（曾经调用 pruneOldToolResults）。
    //
    // 那一步会把刚退出"最近 N 轮"窗口的工具结果砍短，改写的是历史**中间**的消息：
    // 前缀缓存从被改的那条起全部失效，而每轮都有一批结果刚好变老，于是几乎每轮的首个请求
    // 都按全价计费（实测 cached=0，单次 ≈20 credit，同轮后续请求 ≈1 credit）。
    //
    // 现在工具结果在【写入历史时】就按各工具的单次上限一次裁到位（toolOutcomeRecorder →
    // capToolContent），此后发给模型、持久化、进缓存的都是这同一份，不再二次改写。
    // 旧结果的总体积交给滚动压缩——它本就是低频的整体重写。
    // 回归测试见 turnFinalizer.test.ts「回合收尾不改写已有历史」。

    const nextRollingSummaryAccumulated = input.rollingSummaryAccumulated + turnTokens;
    const shouldTriggerRollingSummary = nextRollingSummaryAccumulated >= input.triggerTokens;

    return {
      messages: nextMessages,
      elapsed,
      turnTokens,
      credits,
      creditDetail,
      nextRollingSummaryAccumulated,
      shouldTriggerRollingSummary,
    };
  }
}
