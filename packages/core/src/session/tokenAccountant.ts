/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TokenAccountant —— Token 计量与上报（从 AgentSession 解耦）
 *
 * 职责单一：记录每回合/子 Agent 的真实 token 用量，估算当前上下文占用，并向呈现端推送。
 * 状态字段仍留在 AgentSession（被主循环多处直接读写），本类通过构造注入的 session 引用
 * （@internal 字段）读写这些计量字段，自身不持有状态。
 *
 * 注意：跨域的 buildTokenBreakdown（混合 prompt 注入 + 工具定义估算）仍留在 AgentSession，
 * 不属于纯计量职责。
 */

import type { AgentSession } from "../agentSession.js";

export class TokenAccountant {
  constructor(private readonly s: AgentSession) {}

  /** 获取最近一次的累计上下文 token 数 */
  getLastTotalTokens(): number {
    return this.s.lastTotalTokens;
  }

  /**
   * 从持久化快照回填上下文 token 统计。
   * 会话从磁盘恢复（刷新/切回历史会话）时调用：让 getLastTotalTokens() 立即返回上次落盘的值，
   * 而非默认的 0。否则在拿到本进程第一次真实 usage 之前，任何触发持久化的操作（如追加用户消息、
   * 失败回合）都会用 0 回写、覆盖磁盘上已有的有效 token 统计。
   */
  hydrateTokenUsage(totalTokens?: number): void {
    if (typeof totalTokens === "number" && totalTokens > 0 && this.s.lastTotalTokens <= 0) {
      this.s.lastTotalTokens = totalTokens;
    }
  }

  /**
   * 推送当前上下文 token 占用给前端。
   * 优先用 API 返回的真实 prompt token（lastPromptTokens）；尚未拿到时回退到字符数粗估。
   */
  updateAndSendTokenUsage(): void {
    let total = this.s.lastPromptTokens;
    if (total <= 0) {
      // 尚未拿到 API 真实 usage：用字符数粗估（约 0.4 token/字符）兜底
      let chars = 0;
      for (const m of this.s.messages) {
        if (!m) continue;
        if (typeof m.content === "string") chars += m.content.length;
        else if (Array.isArray(m.content)) {
          for (const part of m.content as any[]) if (part.type === "text") chars += (part.text || "").length;
        }
      }
      total = Math.ceil(chars * 0.4);
    }

    this.s.lastTotalTokens = total;
    this.s.send("token_usage", {
      used: total,
      max: this.s.getContextWindow(),
      cumulative: this.s.cumulativeTokens, // 本任务累计消耗（含子 Agent），与 used（当前上下文占用）区分
    });
  }

  /** 记录某回合 API 返回的真实 token 用量（来自 LLMTurnResult.usage） */
  recordTurnUsage(usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number }): void {
    if (usage && usage.promptTokens > 0) {
      this.s.lastPromptTokens = usage.promptTokens;
    }
    if (usage && usage.completionTokens > 0) {
      this.s.lastCompletionTokens = usage.completionTokens;
      this.s.lastTurnOutputTokens += usage.completionTokens; // 跨回合累加：每轮工具调用生成的输出都计入本轮输出
    }
    // 缓存命中 token：每轮独立记录（用于本轮 credits 计算的折扣）
    this.s.lastCachedTokens = usage?.cachedTokens ?? 0;
    if (usage) {
      const turnTotal = usage.totalTokens || (usage.promptTokens + usage.completionTokens);
      if (turnTotal > 0) {
        this.s.cumulativeTokens += turnTotal;
        this.s.lastTurnTokens = turnTotal;
      }
    }
  }

  /** 累加子 Agent 消耗的 token 到本会话累计量 */
  addSubAgentTokens(tokens: number): void {
    if (tokens > 0) {
      this.s.cumulativeTokens += tokens;
      this.s.lastSubAgentTokens += tokens; // 本轮 subagent 用量（计入 tooltip 的"本次问题"）
    }
  }

  /** 获取本会话累计 token 消耗（含子 Agent） */
  getCumulativeTokens(): number {
    return this.s.cumulativeTokens;
  }
}
