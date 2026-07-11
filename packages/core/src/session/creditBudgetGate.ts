/**
 * Credits 预算门——将 Credits 花费与预算配置对齐，提供分两级响应：
 *   · 软提醒（warnAt）：只注入一条系统提示引导模型尽快收尾，不打断，每轮最多提醒一次。
 *   · 硬暂停（pauseAt）：暂停循环，把真实花费展示给用户，由用户选择「继续」或「停止」。
 *
 * 从 AgentSession 拆出，收敛预算门的状态、配置与决策逻辑。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { calculateCredits, formatCredits, DEFAULT_CREDIT_BUDGET_CONFIG } from "../credits.js";
import type { CreditBudgetUserConfig } from "../credits.js";
import type { AgentSession } from "../agentSession.js";

export class CreditBudgetGate {
  /** 预算配置（运行时可更新） */
  config: CreditBudgetUserConfig = { ...DEFAULT_CREDIT_BUDGET_CONFIG };

  /** 本轮已发过一次软提醒（warnAt），避免同一轮反复注入 */
  private warnedThisTurn = false;

  /** 本轮硬暂停阈值的运行时快照：用户选择"继续"后翻倍，避免同一个长任务反复打断 */
  private pauseThreshold = 0;

  /** 预算选择门：硬暂停触发时，await 此 Promise 阻塞直到用户在"继续/停止"中选择 */
  private choiceResolve: ((choice: "continue" | "stop") => void) | null = null;

  constructor(private readonly s: AgentSession) {}

  /** 在一轮用户输入开始时重置本轮状态 */
  resetForTurn(): void {
    this.warnedThisTurn = false;
    this.pauseThreshold = this.config.pauseAt;
  }

  /** 设置配置 */
  setConfig(cfg: Partial<CreditBudgetUserConfig>): void {
    this.config = { ...this.config, ...cfg };
  }

  /**
   * 本轮 Credits 预算门：每轮工具调用前检查本轮累计花费，分两级响应。
   * @returns true 表示用户选择停止、本轮应立即中止；false 表示可继续本轮。
   */
  async check(turnStartTime: number, streamedContentThisRound: string): Promise<boolean> {
    if (!this.config.enabled) return false;
    const breakdown = this.s.buildTokenBreakdown();
    const estimatedOutput = this.s.lastTurnOutputTokens || this.s.lastCompletionTokens || 0;
    const spent = calculateCredits(this.s.model, { ...breakdown, outputTokens: estimatedOutput });

    if (spent >= this.pauseThreshold) {
      const choice = await this.waitForChoice(spent);
      if (choice === "stop") {
        this.s.messages.push({
          role: "assistant",
          content: `本轮任务已消耗 ${formatCredits(spent)} credits，用户选择在此暂停。已完成的部分保留，需要继续时请告诉我下一步。`,
        } as ChatCompletionMessageParam);
        this.s.stampCancelledTurnStats(turnStartTime, streamedContentThisRound);
        return true;
      }
      // 用户选择继续：阈值翻倍，避免同一任务后续反复打断
      this.pauseThreshold = spent * 2;
      return false;
    }

    if (!this.warnedThisTurn && spent >= this.config.warnAt) {
      this.warnedThisTurn = true;
      this.s.messages.push({
        role: "system",
        content:
          `⚠️ 本轮任务已消耗 ${formatCredits(spent)} credits，成本较高。如果当前目标已经基本达成或还差不多的收尾工作，` +
          `请尽快用文字给用户一个结论性回复，不要为了"更完美"继续做非必要的额外探索/验证。` +
          `如果任务确实还没做完（用户明确要求的核心工作尚未完成），仍应继续把它做完，不要半途而废。`,
        _tailInjected: true,
        _ephemeralInjected: true,
      } as ChatCompletionMessageParam);
    }
    return false;
  }

  /**
   * 等待用户对预算暂停做出选择。发送 credit_budget_paused 事件给前端，
   * 阻塞直到用户选择"继续"或"停止"。120 秒超时自动选"继续"（防死锁）。
   */
  private waitForChoice(spent: number): Promise<"continue" | "stop"> {
    this.s.send("credit_budget_paused", { spent, threshold: this.pauseThreshold, model: this.s.model });
    return new Promise<"continue" | "stop">((resolve) => {
      this.choiceResolve = resolve;
      const cancelCheck = setInterval(() => {
        if (this.s.isCancelled && this.choiceResolve === resolve) {
          this.choiceResolve = null;
          clearInterval(cancelCheck);
          resolve("stop");
        }
      }, 500);
      setTimeout(() => {
        clearInterval(cancelCheck);
        if (this.choiceResolve === resolve) {
          this.choiceResolve = null;
          resolve("continue");
        }
      }, 120_000);
    });
  }

  /** 处理用户对预算暂停的选择（由 sessionHub 的 credit_budget_choice 调用） */
  handleChoice(choice: "continue" | "stop"): void {
    this.choiceResolve?.(choice);
    this.choiceResolve = null;
  }
}
