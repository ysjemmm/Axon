import { calculateCredits, buildCreditDetail } from "../credits.js";
import { pruneOldToolResults } from "../compactor.js";
import { estimateTokensFromText } from "../llm/tokenEstimator.js";
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
  buildTokenBreakdown: () => { memoryTokens: number; systemTokens: number; questionTokens: number; cachedTokens?: number };
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
      turnStats: { elapsed, tokens: turnTokens, model: input.model, credits, creditDetail },
    } as any];

    // ⚠️ 这里的持久化裁剪仍受 compressionEnabled 约束，是有意的——不要再把它去掉。
    //
    // 它写回 this.messages 并落盘，是【破坏性】的：裁掉的历史工具结果不可恢复。
    // 而关闭滚动压缩的用户，其诉求正是"完整保留每一条原始消息"（见 CompactionUserConfig
    // 与设置项说明），所以这条路径保持跟随开关。
    //
    // 那"工具结果裁剪仍生效"的承诺由谁兑现？由请求组装侧兑现：
    // promptBuilder 会按 toolResultKeepTurns 裁剪【发给模型的副本】，不改动存储的历史。
    // 两处配合的结果是：关闭压缩时——存储完整、上行精简；开启压缩时——两者都裁。
    // 若在此处去掉门控，等于把"关闭压缩"也变成破坏性的，与该设置的存在意义相矛盾。
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
