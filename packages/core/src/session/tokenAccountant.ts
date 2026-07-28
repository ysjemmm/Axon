/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TokenAccountant -- Token 计量与上报（从 AgentSession 解耦）
 *
 * 两个**互不相同**的量，这里刻意分开，别再混：
 *
 *  ① 上下文占用（本地估算，唯一口径）
 *     "下一次请求会带多少 token"。用于占比展示 + 压缩决策。协议无关、与端点返不返回 usage
 *     无关，纯函数、单调递增。见 estimateContextTokens。
 *
 *  ② 计费用量（API 返回的 usage）
 *     端点报的 prompt/completion token。经中转网关后这是**网关的计费口径**，只用来算 credits，
 *     绝不用于 ①。见 recordTurnUsage。
 *
 * 早先两者共用一个字段（lastPromptTokens → lastTotalTokens），于是网关的计费口径直接驱动了
 * 压缩决策：实测同一段历史 deepseek 报 321207、Axon 官方 Claude 端点报 90710（差 3.5 倍），
 * 另一批轮次甚至报到 340 万、超过 1M 窗口，触发"溢出→强制压缩"，无端砍掉用户的对话历史。
 *
 * 状态字段仍留在 AgentSession（被主循环多处直接读写），本类通过构造注入的 session 引用
 * （@internal 字段）读写这些计量字段，自身不持有状态。
 */

import type { AgentSession } from "../agentSession.js";
import { messageText } from "./promptBuilder.js";
import {
  estimateTokensFromText,
  estimateChatMessagesTokens,
  estimateToolDefsTokens,
} from "../llm/tokenEstimator.js";

export class TokenAccountant {
  constructor(private readonly s: AgentSession) {}

  /** 获取最近一次的累计上下文 token 数 */
  getLastTotalTokens(): number {
    return this.s.lastTotalTokens;
  }

  /**
   * 从持久化快照回填上下文 token 统计。
   * 会话从磁盘恢复（刷新/切回历史会话）时调用：让 getLastTotalTokens() 在 messages 尚未装载完成、
   * 首次 updateAndSendTokenUsage() 还没跑之前就能返回上次落盘的值，而非默认的 0。
   * 否则任何触发持久化的操作（如追加用户消息、失败回合）都会用 0 回写、覆盖磁盘上已有的有效统计。
   */
  hydrateTokenUsage(totalTokens?: number): void {
    if (typeof totalTokens === "number" && totalTokens > 0 && this.s.lastTotalTokens <= 0) {
      this.s.lastTotalTokens = totalTokens;
    }
  }

  /**
   * 推送当前上下文 token 占用给前端。
   *
   * 口径固定为本地估算。这里刻意**不**优先采用 API 返回的 prompt_tokens——那个值换个 provider
   * 就换一套口径，同一段历史能差 3.5 倍，而这个数还同时驱动压缩决策
   * （compactionController 读 lastTotalTokens），一旦虚高就会无端砍掉对话历史。
   */
  updateAndSendTokenUsage(): void {
    const total = this.estimateContextTokens();

    this.s.lastTotalTokens = total;
    this.s.send("token_usage", {
      used: total,
      max: this.s.getContextWindow(),
      cumulative: this.s.cumulativeTokens, // 本任务累计消耗（含子 Agent），与 used（当前上下文占用）区分
    });
  }

  /**
   * 记录某回合 API 返回的真实 token 用量（来自 LLMTurnResult.usage）。
   *
   * ⚠️ 只服务 credits 计费，**不参与**上下文占比与压缩决策。端点报不报、报什么口径都不影响
   * 上下文统计（那条路走本地估算）。promptTokens 这里仍然留档，仅用于诊断对账。
   */
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
   * 把本轮 prompt 按来源拆分为 记忆 / system / 本次输入（供 tooltip 展示与 credits 计费）。
   * - system：系统提示 + 注入（风格/验证/多工作区/IDE/skill/power）+ 工具定义
   * - 记忆：本轮开始前的历史消息
   * - 本次输入：本轮新增消息（用户消息 + 工具结果 + 中间 assistant 回填）+ 本轮子 Agent
   *
   * 三段各自独立估算，加和即 estimateContextTokens（子 Agent 部分除外，那是额外消耗不占本次上下文）。
   * 早先的做法是"system 估算 + 剩余真实 token 按字符比例摊给记忆/本次输入"，那套依赖 API 报的
   * prompt_tokens 做总量；报数一错（实测差 3.5 倍），三段全跟着错，还会出现"记忆=0"这种
   * 明显不成立的分段（真实报数比 system 估算还小时被 Math.min 压到封顶）。
   */
  buildTokenBreakdown(): { memoryTokens: number; systemTokens: number; questionTokens: number; cachedTokens: number } {
    const boundary = Math.max(1, this.s.turnStartMsgCount);
    return {
      systemTokens: this.estimateSystemTokens(),
      memoryTokens: this.s.turnStartMsgCount > 1
        ? estimateChatMessagesTokens(this.s.messages.slice(1, boundary))
        : 0,
      questionTokens: estimateChatMessagesTokens(this.s.messages.slice(boundary)) + this.s.lastSubAgentTokens,
      // 端点报的缓存命中量：不参与计费（记忆档系数已含缓存折扣），只透给 tooltip 展示。
      // 由 breakdown 一并带出，省得每个调用点各自去取 lastCachedTokens——早先就是漏了这一步，
      // 才让 creditDetail.cachedInputTokens 恒为 0。
      cachedTokens: this.s.lastCachedTokens,
    };
  }

  /**
   * system 段（系统提示 + 动态注入 + 工具定义）的本地估算。contextTokens 与 breakdown 共用一份，
   * 保证"三段加和 == 总占用"，不会出现两处各估一份、加和对不上的情况。
   */
  private estimateSystemTokens(): number {
    const parts: string[] = [];
    if (this.s.messages[0]) parts.push(messageText(this.s.messages[0]));
    try {
      // 注入是真实请求体的一部分（风格/验证/多工作区/IDE/skill/power），漏掉会系统性低估几千 token
      for (const inj of this.s.promptBuilder.buildInjections()) parts.push(messageText(inj));
    } catch { /* 注入构建失败不该影响占比统计 */ }

    let toolsTokens = 0;
    try { toolsTokens = estimateToolDefsTokens(this.s.getToolDefs()); } catch { /* 同上 */ }

    return estimateTokensFromText(parts.join("\n")) + toolsTokens;
  }

  /**
   * 本地估算当前上下文占用 —— 全局唯一口径，协议无关。
   *
   * 输入是"下一次请求将要发出去的东西"：system 段（系统提示 + 注入 + 工具定义）+ 全部历史消息
   * （messages[0] 是 system，已计入 system 段，故从 1 开始切）。
   *
   * 为什么不信 API 报数（这是一次实测驱动的反转）：同一个官方端点在三种形态间切换——
   *  · 小请求把网关计费数字塞进 message_delta.input_tokens（真实 264，报 6955，虚高 26 倍）
   *  · 中等请求把完整 prompt 全记进 cache_read+cache_creation，input_tokens 恒为 0
   *  · 370K 量级只缓存稳定前缀，未缓存的尾部既不进 input_tokens 也不进缓存字段
   *    （端点 count_tokens 权威值 369690，流式 usage 只给 90710）
   * 靠解释这些字段去还原上下文，是在猜一个网关不肯如实告知的量，且每接一个新中转站就要重猜一次。
   *
   * 实测精度：1417 条消息的真实会话，本地 382489 vs 端点 count_tokens 369690，偏差 +3.5%。
   * 对占比展示和 75% 压缩阈值这两个用途绰绰有余，换来的是**稳定**——切换模型不跳变。
   *
   * 注：estimateSystemTokens 会调 buildInjections()，后者读上一次算出的占用（决定是否追加
   * "上下文接近上限"提醒），因此读到的是上一轮的值，有一轮滞后、不构成循环依赖。
   */
  private estimateContextTokens(): number {
    return this.estimateSystemTokens() + estimateChatMessagesTokens(this.s.messages.slice(1));
  }
}
