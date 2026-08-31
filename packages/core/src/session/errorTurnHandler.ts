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
import { estimateTokensFromText } from "../llm/tokenEstimator.js";
import { getModelDisplayName } from "../providers.js";

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
      modelName: getModelDisplayName(this.s.model, this.s.provider),
      credits,
      creditDetail,
      // 这条路径是 cancel() 的兜底，语义上确实是"用户取消"
      reason: "cancelled",
    });
  }

  /**
   * 把本轮已流式出来的内容补录为一条 assistant 消息——仅当它尚未存在于本轮历史时。
   * 去重：本轮流式内容可能已作为带 tool_calls 的 assistant 消息 content 落在历史里
   * （工具执行后才中断的场景），此时再 push 一条纯文本会导致内容重复。
   * 向前扫描到本轮用户消息边界，若已有相同内容的 assistant 消息则跳过。
   */
  private recordStreamedContentOnce(streamedContent?: string): void {
    if (!streamedContent || !streamedContent.trim()) return;
    const trimmed = streamedContent.trim();
    for (let i = this.s.messages.length - 1; i >= 0; i--) {
      const m = this.s.messages[i];
      if (m.role === "user") break; // 越过本轮边界，不再回溯
      if (m.role === "assistant") {
        const c = (m as any).content || (m as any).runtimeContent || "";
        if (typeof c === "string" && c.trim() === trimmed) return; // 已记录，跳过
      }
    }
    this.s.messages.push({ role: "assistant", content: streamedContent } as any);
  }

  /**
   * 丢弃"残缺工具轮"——带 tool_calls 但并非每个 call 都有对应 tool 结果的 assistant 消息，
   * 连同它已有的部分 tool 结果一起从历史里移除。
   *
   * 用于【取消/中断】场景的持久化前清理：与 sanitizeToolPairing（补 error 占位、保证发给 LLM 的
   * 协议合法）语义相反——这里是直接丢弃，避免残缺工具轮被持久化后 reload"复活"成凭空出现的
   * 工具卡片。仅清理末尾正在进行的这一轮，不动历史里已完整的工具轮。
   *
   * @returns 是否发生了丢弃（用于决定要不要重新落盘）
   */
  private dropIncompleteToolTurns(): boolean {
    const msgs = this.s.messages;
    let changed = false;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i] as any;
      if (m.role !== "assistant" || !Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
      // 收集紧跟其后的 tool 结果
      const provided = new Set<string>();
      let j = i + 1;
      while (j < msgs.length && (msgs[j] as any).role === "tool") {
        const tcId = (msgs[j] as any).tool_call_id;
        if (typeof tcId === "string") provided.add(tcId);
        j++;
      }
      const allResolved = m.tool_calls.every(
        (tc: any) => typeof tc.id === "string" && provided.has(tc.id),
      );
      if (!allResolved) {
        // 残缺：丢弃 assistant + 它后面那段 tool 结果（[i, j)）
        msgs.splice(i, j - i);
        changed = true;
      }
    }
    return changed;
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
    this.s.send("stream_end", { elapsed: Date.now() - turnStartTime, tokens: this.s.lastTotalTokens, model, modelName: getModelDisplayName(model, this.s.provider) } as any);
  }

  /**
   * 将一次 provider/网关级异常视为"本轮非正常中断"落盘。
   * 前端恢复历史时会显示 cancelled/error 语义。
   */
  stampAbortedTurnStats(turnStartTime: number, streamedContent?: string, reason?: "cancelled" | "error"): void {
    const status = reason === "cancelled" ? "cancelled" : "error";
    // 先丢弃残缺工具轮（取消发生在工具执行中途时会留下 assistant+部分 tool 结果），
    // 避免持久化后 reload 复活成凭空出现的工具卡片；再补录已流式的文本内容。
    this.dropIncompleteToolTurns();
    this.recordStreamedContentOnce(streamedContent);
    const elapsed = Date.now() - turnStartTime;
    const estimatedOutput = this.s.lastTurnOutputTokens || this.s.lastCompletionTokens
      || (streamedContent ? estimateTokensFromText(streamedContent) : 0);
    const breakdown = { ...this.s.buildTokenBreakdown(), outputTokens: estimatedOutput };
    const turnTokens = this.s.lastTurnTokens
      || (this.s.turnStartCumulative > 0 ? this.s.cumulativeTokens - this.s.turnStartCumulative : 0)
      || (breakdown.memoryTokens + breakdown.systemTokens + breakdown.questionTokens + breakdown.outputTokens);
    const credits = calculateCredits(this.s.model, breakdown);
    const creditDetail = buildCreditDetail(this.s.model, breakdown);
    for (let i = this.s.messages.length - 1; i >= 0; i--) {
      if (this.s.messages[i].role === "assistant") {
        (this.s.messages[i] as any).turnStats = { elapsed, tokens: turnTokens, model: this.s.model, modelName: getModelDisplayName(this.s.model, this.s.provider), credits, creditDetail };
        (this.s.messages[i] as any).turnStatus = status;
        break;
      }
    }
    this.s.persistMessages();
    // reason 必须跟着 status 一起发：落盘的消息记了 error，事件却不带原因的话，
    // 前端只能一律按 "cancelled" 渲染——于是"网关挂了"和"用户点了停止"在界面上无从区分。
    this.s.send("turn_cancelled", { elapsed, tokens: turnTokens, model: this.s.model, modelName: getModelDisplayName(this.s.model, this.s.provider), credits, creditDetail, reason: status });
  }

  /**
   * 取消退出时给最后一条 assistant 消息补上 turnStats。
   */
  stampCancelledTurnStats(turnStartTime: number, streamedContent?: string): void {
    // 先丢弃残缺工具轮，再补录已流式文本（理由同 stampAbortedTurnStats）。
    this.dropIncompleteToolTurns();
    this.recordStreamedContentOnce(streamedContent);
    const elapsed = Date.now() - turnStartTime;
    const estimatedOutput = this.s.lastTurnOutputTokens || this.s.lastCompletionTokens
      || (streamedContent ? estimateTokensFromText(streamedContent) : 0);
    const breakdown = { ...this.s.buildTokenBreakdown(), outputTokens: estimatedOutput };
    const turnTokens = this.s.lastTurnTokens
      || (this.s.turnStartCumulative > 0 ? this.s.cumulativeTokens - this.s.turnStartCumulative : 0)
      || (breakdown.memoryTokens + breakdown.systemTokens + breakdown.questionTokens + breakdown.outputTokens);
    const credits = calculateCredits(this.s.model, breakdown);
    const creditDetail = buildCreditDetail(this.s.model, breakdown);
    for (let i = this.s.messages.length - 1; i >= 0; i--) {
      if (this.s.messages[i].role === "assistant") {
        (this.s.messages[i] as any).turnStats = { elapsed, tokens: turnTokens, model: this.s.model, modelName: getModelDisplayName(this.s.model, this.s.provider), credits, creditDetail };
        (this.s.messages[i] as any).turnStatus = "cancelled";
        break;
      }
    }
    this.s.persistMessages();
    this.s.send("turn_cancelled", { elapsed, tokens: turnTokens, model: this.s.model, modelName: getModelDisplayName(this.s.model, this.s.provider), credits, creditDetail, reason: "cancelled" });
  }
}
