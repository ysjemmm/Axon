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

  /**
   * 校准系数的可信区间。
   *
   * 端点实报 prompt_tokens 与本地估算的比值落在这个区间内才采信。实测的正常偏差是
   * 15% 上下（deepseek 会话：估算 418k vs 实收 481k）；而网关把计费数字塞进 usage 时
   * 会出现 26 倍虚高、恒报 0 这类明显不是 prompt 规模的取值——那些必须丢弃，
   * 否则会把上下文统计和压缩决策一起带偏。
   */
  private static readonly CALIBRATION_MIN = 0.5;
  private static readonly CALIBRATION_MAX = 2.5;

  /** 已就"端点报数不可信"提示过一次，避免逐轮刷屏 */
  private warnedImplausible = false;

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
   * 口径 = 本地估算 × 校准系数。校准系数由端点实报的 prompt_tokens 反推（见 updateCalibration），
   * 目的是让界面显示的"已用上下文"与端点实际收到的 prompt 规模一致——此前纯本地估算对代码密集
   * 内容系统性偏低（实测 deepseek 会话偏低 17%），界面上看到的是 400k、后台实收却是 490k。
   *
   * 仍然以估算为基（而不是直接取端点报数），是因为估算单调、稳定、不随端点口径跳变；
   * 端点报数只用它的**比值**来校正尺度，异常值由可信区间挡掉。
   * 这个值同时驱动压缩决策（compactionController 读 lastTotalTokens），所以校准后触发时机也更准。
   */
  updateAndSendTokenUsage(): void {
    const estimate = this.estimateContextTokens();
    // 换模型后 tokenizer 不同，旧系数作废，退回未校准的估算
    const total = this.s.promptCalibrationModel === this.s.model
      ? Math.round(estimate * this.s.promptCalibration)
      : estimate;

    this.s.lastTotalTokens = total;
    this.s.send("token_usage", {
      used: total,
      max: this.s.getContextWindow(),
      cumulative: this.s.cumulativeTokens, // 本任务累计消耗（含子 Agent），与 used（当前上下文占用）区分
    });
  }

  /**
   * 用端点实报的 prompt_tokens 反推本地估算的校正系数。
   *
   * 调用时机是"某回合的 usage 刚回来"，此刻 this.s.messages 与本次请求体一致，
   * 因此 realPromptTokens ÷ estimateContextTokens() 就是这次请求上真实的估算偏差。
   * 每轮都重算，所以换模型、换端点、开/关压缩都能自动跟上，不需要额外的失效逻辑。
   */
  private updateCalibration(realPromptTokens: number): void {
    const estimate = this.estimateContextTokens();
    if (estimate <= 0) return;

    const ratio = realPromptTokens / estimate;
    if (ratio < TokenAccountant.CALIBRATION_MIN || ratio > TokenAccountant.CALIBRATION_MAX) {
      // 端点报数明显不是 prompt 规模（网关计费口径 / 恒报 0）→ 丢弃校准，退回纯本地估算
      this.s.promptCalibration = 1;
      this.s.promptCalibrationModel = "";
      if (!this.warnedImplausible) {
        this.warnedImplausible = true;
        console.warn(
          `[token] 端点实报 prompt_tokens=${realPromptTokens} 与本地估算 ${estimate} 相差 ${ratio.toFixed(2)}×，` +
          `超出可信区间 [${TokenAccountant.CALIBRATION_MIN}, ${TokenAccountant.CALIBRATION_MAX}]，` +
          `上下文统计退回本地估算口径（此提示只出现一次）。`,
        );
      }
      return;
    }

    const prev = this.s.promptCalibrationModel === this.s.model ? this.s.promptCalibration : 1;
    this.s.promptCalibration = ratio;
    this.s.promptCalibrationModel = this.s.model;
    // 只在系数明显变化时打一行，便于用户/日志核对"显示值是否已与后台对齐"
    if (Math.abs(ratio - prev) / prev > 0.05) {
      console.log(
        `[token] 上下文口径已校准：端点实报 ${realPromptTokens} ÷ 本地估算 ${estimate} = ${ratio.toFixed(3)}×` +
        `（此后界面"已用上下文"与端点实收一致）`,
      );
    }
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
      // 端点实报值：顺手用它校正上下文统计的尺度（详见 updateCalibration）
      this.updateCalibration(usage.promptTokens);
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
