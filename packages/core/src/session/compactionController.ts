/**
 * CompactionController —— 上下文压缩（手动 / 滚动 / 溢出迁移，从 AgentSession 解耦）
 *
 * 职责单一：承载三种压缩入口的执行逻辑——
 * - 手动压缩（compactSession）：用户点按钮，超过窗口 35% 才允许；
 * - 滚动摘要（maybeRollingSummary）：用户无感的异步增量压缩，控制上下文体积；
 * - 压缩选择（handleCompactionChoice / waitForCompactionChoice）：溢出时暂停等用户选"继续/新会话"。
 *
 * 压缩状态（isCompacting/compactionConfig/滚动计数/选择门 resolver/迁移消息等）与主循环共享，
 * 仍留在 session（@internal），本控制器通过 session 引用读写；自身不持有这些状态。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { getClient } from "../providers.js";
import { needsCompaction, compactMessages, rollingCompact } from "../compactor.js";
import type { AgentSession } from "../agentSession.js";

export class CompactionController {
  constructor(private readonly s: AgentSession) {}

  /** 手动触发上下文压缩（供前端"压缩上下文"按钮调用）。需超过当前模型窗口 35% 才允许。 */
  async compactSession(): Promise<void> {
    if (this.s.isCompacting) return;
    const ctxWindow = this.s.getContextWindow();
    if (!needsCompaction(this.s.lastTotalTokens, ctxWindow)) {
      this.s.send("compacting_end", { success: false, message: "当前上下文未超过模型窗口的 35%，无需压缩" });
      return;
    }
    this.s.isCompacting = true;
    this.s.send("compacting_start", {});
    try {
      const client = getClient(this.s.provider, this.s.model);
      this.s.send("status", { content: "整理上下文..." });
      this.s.messages = await compactMessages(this.s.messages, client, this.s.model);
      this.s.isCompacting = false;
      this.s.lastPromptTokens = 0; // 重置缓存，让 updateAndSendTokenUsage 从压缩后的 messages 重新估算
      this.s.send("compacting_end", { success: true, message: "上下文已手动压缩" });
      this.s.persistMessages();
      this.s.updateAndSendTokenUsage();
    } catch (err) {
      this.s.isCompacting = false;
      this.s.send("compacting_end", { success: false, message: `压缩失败：${(err as Error).message}` });
    }
  }

  /**
   * 滚动摘要：异步把旧消息压成摘要，控制上下文体积。
   *
   * 用户无感设计：
   * - 异步执行，不阻塞用户发下一条消息
   * - 不弹窗、不暂停（与 compactSession 的"暂停 + 弹窗"不同）
   * - 压缩期间用户如果又发了消息，那条消息用未压缩的 context 答复，压缩结果下一轮再生效
   * - 完成后只重置计数器 + 静默替换 messages + 持久化
   */
  async maybeRollingSummary(): Promise<void> {
    // 防止并发：已经在压缩中 / 正在手动压缩 / 正在溢出压缩
    if (this.s.rollingSummaryInProgress || this.s.isCompacting) return;
    // 用户关闭了滚动压缩 → 跳过（工具结果裁剪仍独立生效）
    if (!this.s.compactionConfig.enabled) return;
    this.s.rollingSummaryInProgress = true;

    try {
      const client = getClient(this.s.provider, this.s.model);
      const [newMessages, didCompact] = await rollingCompact(this.s.messages, client, this.s.model, this.s.compactionConfig.keepRecentMessages);
      if (didCompact) {
        // 安全区替换：用压缩后的消息替换当前 messages
        this.s.messages = newMessages;
        this.s.rollingSummaryAccumulated = 0; // 重置计数
        this.s.lastPromptTokens = 0; // 重置缓存，让 updateAndSendTokenUsage 从压缩后的 messages 重新估算
        this.s.persistMessages();
        this.s.updateAndSendTokenUsage();
        console.debug("[rolling] 滚动摘要完成，上下文体积已缩减");
        // 静默通知前端（状态栏可显示但不弹窗）
        this.s.send("rolling_summary_done", { success: true });
      }
    } catch (err) {
      // 压缩失败不阻塞：保留原 messages，下次再试
      console.warn("[rolling] 滚动摘要失败（忽略）:", (err as Error).message);
    } finally {
      this.s.rollingSummaryInProgress = false;
    }
  }

  /**
   * 处理用户对压缩方式的选择（由 sessionHub.compaction_choice 调用）。
   * - "continue"：只 resolve 承诺，压缩由 handleUserInput 继续执行
   * - "new_session"：立即压缩并存储迁移数据，resolve 承诺让 handleUserInput 退出
   */
  async handleCompactionChoice(choice: "continue" | "new_session"): Promise<void> {
    if (choice === "continue") {
      this.s.compactionChoiceResolve?.("continue");
      this.s.compactionChoiceResolve = null;
      return;
    }

    // new_session：压缩消息并存储用于迁移
    try {
      const client = getClient(this.s.provider, this.s.model);
      this.s.send("status", { content: "整理上下文..." });
      // 压缩前移除本轮刚推送的用户消息（它会在新会话中重新发送）
      const userMsg = this.s.messages.pop();
      this.s.compactionMigrationMessages = await compactMessages(this.s.messages, client, this.s.model);
      // 恢复用户消息到原会话（保持历史完整，仅压缩版本不包含它）
      if (userMsg) this.s.messages.push(userMsg);
    } catch (err) {
      this.s.compactionMigrationMessages = null;
      this.s.compactionChoiceResolve?.("continue"); // 压缩失败回退到继续
      this.s.compactionChoiceResolve = null;
      return;
    }

    this.s.compactionChoiceResolve?.("new_session");
    this.s.compactionChoiceResolve = null;
  }

  /**
   * 等待用户选择压缩方式。发送 compaction_needed 事件给前端，
   * 阻塞直到用户选择"继续"或"新会话"。120 秒超时自动选"继续"以防死锁。
   */
  waitForCompactionChoice(currentTokens: number, maxTokens: number): Promise<"continue" | "new_session"> {
    this.s.send("compaction_needed", {
      currentTokens,
      maxTokens,
      percent: Math.round((currentTokens / maxTokens) * 100),
    });
    return new Promise<"continue" | "new_session">((resolve) => {
      this.s.compactionChoiceResolve = resolve;
      // 用户取消时自动 resolve 为 continue（让压缩继续，然后正常取消）
      const cancelCheck = setInterval(() => {
        if (this.s.isCancelled && this.s.compactionChoiceResolve === resolve) {
          this.s.compactionChoiceResolve = null;
          clearInterval(cancelCheck);
          resolve("continue");
        }
      }, 500);
      // 兜底超时：120 秒自动选"继续"
      setTimeout(() => {
        clearInterval(cancelCheck);
        if (this.s.compactionChoiceResolve === resolve) {
          this.s.compactionChoiceResolve = null;
          resolve("continue");
        }
      }, 120_000);
    });
  }
}

/** 压缩选择门 resolver 类型（供 session @internal 字段标注） */
export type CompactionChoiceResolver = ((choice: "continue" | "new_session") => void) | null;

/** 压缩迁移消息类型别名 */
export type CompactionMigrationMessages = ChatCompletionMessageParam[] | null;
