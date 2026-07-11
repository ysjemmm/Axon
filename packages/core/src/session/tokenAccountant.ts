/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TokenAccountant -- Token 计量与上报（从 AgentSession 解耦）
 *
 * 职责：记录每回合/子 Agent 的真实 token 用量，估算当前上下文占用，并向呈现端推送。
 * 状态字段仍留在 AgentSession（被主循环多处直接读写），本类通过构造注入的 session 引用
 * （@internal 字段）读写这些计量字段，自身不持有状态。
 *
 * buildTokenBreakdown（混合 prompt 注入 + 工具定义估算）在本类内，因为它需要访问
 * messages / promptBuilder / getToolDefs，这些都是 session 级状态，通过注入引用访问。
 */

import type { AgentSession } from "../agentSession.js";
import { messageText } from "./promptBuilder.js";

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

  /**
   * 把本轮 prompt 按来源拆分为 记忆 / system / 本次输入（供 tooltip 展示）。
   * - system：系统提示 + 注入（风格/验证/多工作区/IDE/skill/power）+ 工具定义
   * - 本次输入：本轮新增消息（用户消息 + 工具结果 + 中间 assistant 回填）的字符估算 + 本轮子 Agent
   * - 记忆：真实总 prompt − system − 本次输入（余量，吸收"字符估算 vs 真实 token"的偏差）
   *
   * 关键：用字符估算去算【本次输入】这个小桶，让【记忆】这个大桶承接真实总量的余量。
   * 反过来（估记忆、余量给本次输入）会把整段历史的估算误差--尤其 0.4/字符 对中文的严重低估
   * --全甩进"本次输入"，导致一句"关掉前端吧"也显示几万 token。
   */
  buildTokenBreakdown(): { memoryTokens: number; systemTokens: number; questionTokens: number } {
    // 各段字符数
    let thisTurnChars = 0;
    for (let i = Math.max(1, this.s.turnStartMsgCount); i < this.s.messages.length; i++) {
      thisTurnChars += messageText(this.s.messages[i]).length;
    }
    let memoryChars = 0;
    if (this.s.turnStartMsgCount > 1) {
      for (let i = 1; i < this.s.turnStartMsgCount; i++) memoryChars += messageText(this.s.messages[i]).length;
    }

    // system 直接估算（最稳定可知：系统提示文本 + 注入 + 工具定义 JSON）。
    // 自然文本约 0.4 token/字符；工具定义是结构化 JSON,token 密度更高,约 0.75。
    let systemChars = this.s.messages[0] ? messageText(this.s.messages[0]).length : 0;
    for (const inj of this.s.promptBuilder.buildInjections()) systemChars += messageText(inj).length;
    let toolsChars = 0;
    try { toolsChars = JSON.stringify(this.s.getToolDefs()).length; } catch { /* 忽略 */ }
    const systemEstimate = Math.ceil(systemChars * 0.4 + toolsChars * 0.75);

    // 有 API 返回的真实 prompt_tokens 时：
    // system 用估算（封顶不超过真实总数）；剩余的真实 token 按字符比例分给 记忆 / 本次提问,保证三段加和 = 真实总数。
    if (this.s.lastPromptTokens > 0) {
      const systemTokens = Math.min(systemEstimate, this.s.lastPromptTokens);
      const remaining = this.s.lastPromptTokens - systemTokens; // 记忆 + 本次提问 的真实总量
      const splitBase = memoryChars + thisTurnChars;
      let memoryTokens: number;
      let questionTokens: number;
      if (splitBase <= 0) {
        memoryTokens = 0;
        questionTokens = remaining;
      } else {
        memoryTokens = Math.round(remaining * (memoryChars / splitBase));
        questionTokens = remaining - memoryTokens;
      }
      return { memoryTokens, systemTokens, questionTokens: questionTokens + this.s.lastSubAgentTokens };
    }

    // 兜底：没拿到 API usage,纯字符估算
    const questionTokens = Math.ceil(thisTurnChars * 0.6) + this.s.lastSubAgentTokens;
    const memoryTokens = this.s.turnStartMsgCount <= 1 ? 0 : Math.ceil(memoryChars * 0.6);
    return { memoryTokens, systemTokens: systemEstimate, questionTokens };
  }
}
