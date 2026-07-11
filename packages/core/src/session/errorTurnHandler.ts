/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ErrorTurnHandler -- 异常/取消场景下的 turn 统计兜底（从 AgentSession 解耦）
 *
 * 职责：当 agent loop 因取消、provider 异常、网关错误等原因非正常中断时，
 * 给最后一条 assistant 消息补上 turnStats（elapsed/tokens/credits/creditDetail），
 * 并推送 turn_cancelled 事件给前端，让历史恢复时能正确显示 cancelled/error 语义。
 *
 * 状态字段仍留在 session（@internal），本类通过构造注入的 session 引用读写。
 */

import type { AgentSession } from "../agentSession.js";
import { calculateCredits, buildCreditDetail } from "../credits.js";

export class ErrorTurnHandler {
  constructor(private readonly s: AgentSession) {}

  /** 在 cancel() 被调用但 agent loop 尚未产出任何统计时的兜底。 */
  sendTurnCancelledFallback(): void {
    const estimatedOutput = this.s.lastTurnOutputTokens || this.s.lastCompletionTokens || 0;
    const breakdown = { ...this.s.buildTokenBreakdown(), outputTokens: estimatedOutput };
    const turnTokens = breakdown.memoryTokens + breakdown.systemTokens + breakdown.questionTokens + breakdown.outputTokens;
    if (turnTokens <= 0) return;
    const credits = calculateCredits(this.s.model, breakdown);
    const creditDetail = buildCreditDetail(this.s.model, breakdown);
    this.s.send("turn_cancelled", {
      elapsed: 0,
      tokens: turnTokens,
      model: this.s.model,
      credits,
      creditDetail,
    });
  }

  /** 判断错误是否来自第三方 provider / 网关 / 基础设施层。 */
  isExternalProviderError(err: Error): boolean {
    const msg = (err.message || "").toLowerCase();
    if (!msg) return false;
    return (
      /\b429\b/.test(msg) ||
      /rate limit|quota|too many requests/.test(msg) ||
      /gateway|upstream|proxy|provider|service unavailable/.test(msg) ||
      /unexpected eof|connection reset|socket hang up|network error|fetch failed|timeout|timed out/.test(msg) ||
      /api key|authentication|unauthorized|forbidden/.test(msg)
    );
  }

  /** 把第三方错误展示给用户，但不写入长期消息历史。 */
  emitTransientError(errMsg: string, turnStartTime: number, streamedContentThisRound: string): void {
    if (!streamedContentThisRound) {
      this.s.send("stream_start", {});
    }
    this.s.send("stream_delta", { content: errMsg });
    const model = (this.s as any)._lastSentModel || this.s.model;
    this.s.send("stream_end", { elapsed: Date.now() - turnStartTime, tokens: this.s.lastTotalTokens, model } as any);
  }

  /**
   * 将一次 provider/网关级异常视为"本轮非正常中断"落盘。
   * 前端恢复历史时会显示 cancelled/error 语义。
   */
  stampAbortedTurnStats(turnStartTime: number, streamedContent?: string, reason?: "cancelled" | "error"): void {
    const status = reason === "cancelled" ? "cancelled" : "error";
    if (streamedContent && streamedContent.trim()) {
      const last = this.s.messages[this.s.messages.length - 1];
      if (!last || last.role !== "assistant" || !(last as any).content) {
        this.s.messages.push({ role: "assistant", content: streamedContent } as any);
      }
    }
    const elapsed = Date.now() - turnStartTime;
    const estimatedOutput = this.s.lastTurnOutputTokens || this.s.lastCompletionTokens
      || (streamedContent ? Math.ceil(streamedContent.length * 0.4) : 0);
    const breakdown = { ...this.s.buildTokenBreakdown(), outputTokens: estimatedOutput };
    const turnTokens = this.s.lastTurnTokens
      || (this.s.turnStartCumulative > 0 ? this.s.cumulativeTokens - this.s.turnStartCumulative : 0)
      || (breakdown.memoryTokens + breakdown.systemTokens + breakdown.questionTokens + breakdown.outputTokens);
    const credits = calculateCredits(this.s.model, breakdown);
    const creditDetail = buildCreditDetail(this.s.model, breakdown);
    for (let i = this.s.messages.length - 1; i >= 0; i--) {
      if (this.s.messages[i].role === "assistant") {
        (this.s.messages[i] as any).turnStats = { elapsed, tokens: turnTokens, model: this.s.model, credits, creditDetail };
        (this.s.messages[i] as any).turnStatus = status;
        break;
      }
    }
    this.s.persistMessages();
    this.s.send("turn_cancelled", { elapsed, tokens: turnTokens, model: this.s.model, credits, creditDetail });
  }

  /**
   * 取消退出时给最后一条 assistant 消息补上 turnStats。
   */
  stampCancelledTurnStats(turnStartTime: number, streamedContent?: string): void {
    if (streamedContent && streamedContent.trim()) {
      const last = this.s.messages[this.s.messages.length - 1];
      if (!last || last.role !== "assistant" || !(last as any).content) {
        this.s.messages.push({ role: "assistant", content: streamedContent } as any);
      }
    }
    const elapsed = Date.now() - turnStartTime;
    const estimatedOutput = this.s.lastTurnOutputTokens || this.s.lastCompletionTokens
      || (streamedContent ? Math.ceil(streamedContent.length * 0.4) : 0);
    const breakdown = { ...this.s.buildTokenBreakdown(), outputTokens: estimatedOutput };
    const turnTokens = this.s.lastTurnTokens
      || (this.s.turnStartCumulative > 0 ? this.s.cumulativeTokens - this.s.turnStartCumulative : 0)
      || (breakdown.memoryTokens + breakdown.systemTokens + breakdown.questionTokens + breakdown.outputTokens);
    const credits = calculateCredits(this.s.model, breakdown);
    const creditDetail = buildCreditDetail(this.s.model, breakdown);
    for (let i = this.s.messages.length - 1; i >= 0; i--) {
      if (this.s.messages[i].role === "assistant") {
        (this.s.messages[i] as any).turnStats = { elapsed, tokens: turnTokens, model: this.s.model, credits, creditDetail };
        (this.s.messages[i] as any).turnStatus = "cancelled";
        break;
      }
    }
    this.s.persistMessages();
    this.s.send("turn_cancelled", { elapsed, tokens: turnTokens, model: this.s.model, credits, creditDetail });
  }
}
