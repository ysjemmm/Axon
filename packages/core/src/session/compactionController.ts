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
import { getStrategy } from "../providers.js";
import { needsCompaction, compactMessages, rollingCompact, generateSessionMemory } from "../compactor.js";
import type { LLMStrategy } from "../llm/types.js";
import type { AgentSession } from "../agentSession.js";

export class CompactionController {
  /**
   * 混合记忆策略的节流计数：主动 update_memory 仍是即时入口，后台只在积累到一定量后合并一次。
   * 这两个计数不写入快照——它们只是"距离下一次后台检查还有多少"，重启后重新积累比持久化
   * 一份容易失真的计数更简单安全。
   */
  private memoryRefreshTurns = 0;
  private memoryRefreshTokens = 0;
  private memoryRefreshInProgress = false;

  /** 混合策略阈值：三轮或约 6000 token，任一达到就后台更新一次会话记忆。 */
  private static readonly MEMORY_REFRESH_TURNS = 3;
  private static readonly MEMORY_REFRESH_TOKENS = 6_000;

  constructor(private readonly s: AgentSession) {}

  /**
   * 每轮正常回复结束后调用。达到阈值才启动后台记忆合并，不阻塞当前回复或下一轮输入。
   *
   * 如果这一轮同时触发了滚动摘要，滚动摘要会用压缩前快照刷新记忆，这里不再重复调用；
   * refreshMemory 成功/完成后会统一清零两个计数。
   */
  async maybeRefreshMemoryAfterTurn(turnTokens: number): Promise<void> {
    this.memoryRefreshTurns += 1;
    this.memoryRefreshTokens += Math.max(0, turnTokens);
    if (this.memoryRefreshInProgress || this.s.isCompacting || this.s.rollingSummaryInProgress) return;
    if (
      this.memoryRefreshTurns < CompactionController.MEMORY_REFRESH_TURNS
      && this.memoryRefreshTokens < CompactionController.MEMORY_REFRESH_TOKENS
    ) return;

    // 先消费本批计数，再开始异步调用。调用期间新完成的回合会累加到下一批，
    // 不能在 finally 里整体清零，否则用户连续输入时会丢掉这段期间的记忆触发量。
    this.memoryRefreshTurns = 0;
    this.memoryRefreshTokens = 0;
    this.memoryRefreshInProgress = true;
    try {
      const strategy = getStrategy(this.s.provider, this.s.model);
      const snapshot = [...this.s.messages];
      await this.refreshMemory(snapshot, strategy);
    } finally {
      this.memoryRefreshInProgress = false;
    }
  }

  /** 主动 update_memory 已经把最新内容写入，不要紧接着再后台调用一次。 */
  markMemoryUpdated(): void {
    this.memoryRefreshTurns = 0;
    this.memoryRefreshTokens = 0;
  }

  /** 手动触发上下文压缩（供前端"压缩上下文"按钮调用）。需超过当前模型窗口 35% 才允许。 */
  async compactSession(): Promise<void> {
    if (this.s.isCompacting) return;
    // ⚠️ 这里【不重算】——判定用的就是界面正在显示的那个值。
    // lastTotalTokens 是上一次推送出去的占用，也正是用户此刻在圆环/tooltip 上看到的数字。
    // 两者共用同一个数，才不会出现"显示 59% 却提示未超过 35%"这种自相矛盾
    // （59% 与 35% 不可能同时为真，出现即说明判定与显示各算了一份）。
    //
    // 这条路径的两种写法都试过，都不对：
    //   · 重算并推送（updateAndSendTokenUsage）→ 点击本身会改动界面数字，实测 39% → 26%；
    //   · 只重算不推送（recomputeTokenUsage）→ 判定用新值、界面停旧值，于是判定与显示打架。
    // 根因是 used = 本地估算 × 校准系数，而系数每轮会被端点实报数改写（区间 0.5~2.5），
    // 同一份上下文在不同时刻能差一倍以上。在把它做成真正稳定的量之前，
    // 宁可让判定与显示共用同一个（可能略滞后的）快照，也不要各算各的。
    // 代价：若某轮异常结束、没走正常循环末尾的推送，这里读到的是上一轮的旧快照。
    const ctxWindow = this.s.getContextWindow();
    if (!needsCompaction(this.s.lastTotalTokens, ctxWindow)) {
      this.s.send("compacting_end", { success: false, message: "当前上下文未超过模型窗口的 35%，无需压缩" });
      return;
    }
    await this.doCompact("上下文已手动压缩");
  }

  /** 强制压缩上下文（不检查阈值，用于上下文超限场景）。 */
  async forceCompactSession(): Promise<void> {
    if (this.s.isCompacting) return;
    await this.doCompact("上下文已压缩（因超出模型窗口限制）");
  }

  /**
   * 压缩时顺带做一次会话记忆的大更新。
   *
   * ── 为什么必须传「压缩前的快照」──
   * 摘要生成后，被压掉的原文就没了。而记忆要的恰恰是摘要保不住的那些细节
   * （具体路径、命令、报错原文、用户偏好），所以只能用压缩前的历史来生成。
   *
   * ── 为什么失败只告警 ──
   * 记忆没更新是可惜，但不该让一次已经成功的压缩因此失败、让用户重复操作。
   */
  private async refreshMemory(snapshot: ChatCompletionMessageParam[], strategy: LLMStrategy): Promise<void> {
    try {
      // 太少的历史没什么可记的，省一次调用
      if (snapshot.length < 3) return;
      const prev = this.s.getMemory();
      const updates = await generateSessionMemory(prev, snapshot, strategy, this.s.model);
      if (updates.length > 0) {
        this.s.applyMemoryUpdates(updates);
        console.debug(`[memory] 压缩时已合并会话记忆增量（${updates.length} 个知识块）`);
      }
    } catch (err) {
      console.warn("[memory] 压缩时更新会话记忆失败（忽略）:", (err as Error).message);
    }
  }

  /** 实际执行压缩的内部方法 */
  private async doCompact(successMessage: string): Promise<void> {
    this.s.isCompacting = true;
    this.s.send("compacting_start", {});
    // 压缩前留一份原文快照：记忆要用它生成，摘要替代后就再也拿不到这些细节了
    const snapshot = this.s.messages;
    try {
      const strategy = getStrategy(this.s.provider, this.s.model);
      this.s.send("status", { content: "整理上下文..." });
      this.s.messages = await compactMessages(this.s.messages, strategy, this.s.model);
      this.s.isCompacting = false;
      this.s.lastPromptTokens = 0;
      this.s.send("compacting_end", { success: true, message: successMessage });
      // ⚠️ 顺序不能反：持久化回调写盘时读的是 getLastTotalTokens()，必须先把压缩后的
      // 占用重算出来再落盘。反过来则磁盘上留下压缩【前】的旧占用，刷新页面时
      // hydrateTokenUsage 把它回填，界面从 4% 跳回 61%，要等用户发下一句话重算才降下来。
      this.s.updateAndSendTokenUsage();
      this.s.persistMessages();
      // 压缩前的完整快照即将交给记忆模型；消费掉压缩前累计的后台触发量，
      // 压缩期间新完成的回合仍会继续累加到下一批。
      this.markMemoryUpdated();
      await this.refreshMemory(snapshot, strategy);
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
      const strategy = getStrategy(this.s.provider, this.s.model);
      // 压缩前留原文快照，供记忆更新使用（滚动摘要同样会丢细节）
      const snapshot = this.s.messages;
      const [newMessages, didCompact] = await rollingCompact(this.s.messages, strategy, this.s.model, this.s.compactionConfig.keepRecentMessages);
      if (didCompact) {
        // 安全区替换：用压缩后的消息替换当前 messages
        this.s.messages = newMessages;
        this.s.rollingSummaryAccumulated = 0; // 重置计数
        this.s.lastPromptTokens = 0; // 重置缓存，让 updateAndSendTokenUsage 从压缩后的 messages 重新估算
        // 同 doCompact：先重算占用再落盘，否则磁盘留着压缩前的旧值
        this.s.updateAndSendTokenUsage();
        this.s.persistMessages();
        console.debug("[rolling] 滚动摘要完成，上下文体积已缩减");
        // 静默通知前端（状态栏可显示但不弹窗）
        this.s.send("rolling_summary_done", { success: true });
        // 滚动摘要同样会用压缩前快照刷新记忆，避免与后台混合入口重复调用。
        this.markMemoryUpdated();
        await this.refreshMemory(snapshot, strategy);
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
      const strategy = getStrategy(this.s.provider, this.s.model);
      this.s.send("status", { content: "整理上下文..." });
      // 压缩前留快照（含本轮用户消息），供记忆更新使用
      const snapshot = [...this.s.messages];
      // 压缩前移除本轮刚推送的用户消息（它会在新会话中重新发送）
      const userMsg = this.s.messages.pop();
      this.s.compactionMigrationMessages = await compactMessages(this.s.messages, strategy, this.s.model);
      // 恢复用户消息到原会话（保持历史完整，仅压缩版本不包含它）
      if (userMsg) this.s.messages.push(userMsg);
      this.markMemoryUpdated();
      await this.refreshMemory(snapshot, strategy);
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

  /**
   * 本轮请求前的自动压缩门：
   * - 溢出（lastTotalTokens > 窗口，通常是切换到更小窗口模型）-> 强制无感压缩；
   * - 达到窗口 75% -> 暂停询问用户「继续压缩 / 迁移到新会话」。
   * @returns true 表示用户选择迁移到新会话、本轮应中止；false 表示可继续本轮。
   */
  async maybeAutoCompactBeforeTurn(strategy: LLMStrategy): Promise<boolean> {
    const ctxWindow = this.s.getContextWindow();
    const overflowing = this.s.lastTotalTokens > ctxWindow;
    if (overflowing) {
      // 模型切换溢出：强制无感压缩
      // 压缩前留原文快照，供记忆更新使用
      const snapshot = this.s.messages;
      this.s.isCompacting = true;
      this.s.send("compacting_start", {});
      try {
        this.s.send("status", { content: "整理上下文..." });
        this.s.messages = await compactMessages(this.s.messages, strategy, this.s.model);
        this.s.isCompacting = false;
        this.s.lastPromptTokens = 0;
        this.s.send("compacting_end", { success: true, message: "切换模型后上下文已自动压缩" });
        // 先重算再落盘（同 doCompact）：这条路径原先完全不落盘，磁盘会一直停在压缩前的占用
        this.s.updateAndSendTokenUsage();
        this.s.persistMessages();
        await this.refreshMemory(snapshot, strategy);
      } catch (err) {
        this.s.isCompacting = false;
        this.s.send("compacting_end", { success: false, message: `压缩失败：${(err as Error).message}` });
      }
      return false;
    }
    if (this.s.lastTotalTokens > 0 && needsCompaction(this.s.lastTotalTokens, ctxWindow, 0.75)) {
      // >=75% 自动压缩阈值：暂停，让用户选择
      const choice = await this.waitForCompactionChoice(this.s.lastTotalTokens, ctxWindow);
      if (choice === "continue") {
        // 用户选择继续：压缩当前会话
        // 压缩前留原文快照，供记忆更新使用
        const snapshot = this.s.messages;
        this.s.isCompacting = true;
        this.s.send("compacting_start", {});
        try {
          this.s.send("status", { content: "整理上下文..." });
          this.s.messages = await compactMessages(this.s.messages, strategy, this.s.model);
          this.s.isCompacting = false;
          this.s.lastPromptTokens = 0;
          this.s.send("compacting_end", { success: true, message: "上下文已压缩" });
          // 先重算再落盘（同 doCompact），否则磁盘留着压缩前旧占用
          this.s.updateAndSendTokenUsage();
          this.s.persistMessages();
          await this.refreshMemory(snapshot, strategy);
        } catch (err) {
          this.s.isCompacting = false;
          this.s.send("compacting_end", { success: false, message: `压缩失败：${(err as Error).message}` });
        }
        return false;
      }
      // 用户选择迁移到新会话：handleCompactionChoice 已压缩并存储迁移数据，通知前端并中止本轮
      this.s.send("compaction_migrated", { migratedToNewSession: true });
      return true;
    }
    return false;
  }
}

/** 压缩选择门 resolver 类型（供 session @internal 字段标注） */
export type CompactionChoiceResolver = ((choice: "continue" | "new_session") => void) | null;

/** 压缩迁移消息类型别名 */
export type CompactionMigrationMessages = ChatCompletionMessageParam[] | null;
