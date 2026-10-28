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
import { getStrategy, declaredThinkingFor } from "../providers.js";
import { needsCompaction, compactMessages, compactKeepingCurrentTurn, rollingCompact, generateSessionMemory } from "../compactor.js";
import type { LLMStrategy } from "../llm/types.js";
import type { AgentSession } from "../agentSession.js";
import { isRealUserMessage } from "./promptBuilder.js";

export class CompactionController {
  /**
   * 后台记忆整理的节流计数（不落盘：只是「距离下一次整理还有多远」，重启后重新积累即可）。
   */
  private memoryUserTurns = 0;
  private memoryRefreshTokens = 0;
  private memoryRefreshInProgress = false;
  /**
   * 记忆整理的游标：最后一条已整理过的消息（按对象引用定位，不按下标——轮首清理临时消息、
   * 压缩都会让下标漂移）。每次整理只看它之后的新消息。
   *
   * 早先每次都把【整段历史】交给模型：越聊越慢越贵，模型还会对早已整理过的内容反复 upsert，
   * 把用户后来手动补充的条目冲掉。
   */
  private memoryCursor: ChatCompletionMessageParam | null = null;

  /** 两个用户回合，或新增约 2 万 token，任一达到就后台整理一次 */
  private static readonly MEMORY_REFRESH_TURNS = 2;
  private static readonly MEMORY_REFRESH_TOKENS = 20_000;
  /** 单次整理最多看这么多条消息（新会话第一次整理、游标丢失时的上限） */
  private static readonly MEMORY_BATCH_MESSAGES = 80;
  /**
   * 用户交代长期有效的东西时立刻整理，不等攒够回合数：这正是记忆最该记住、也最容易
   * 在之后几轮被挤掉的内容。宁可多触发几次（每次只看新消息，很便宜）。
   */
  private static readonly DURABLE_HINT = /以后|今后|记住|记一下|别忘|统一(用|成|改)|一律|不要再|别再|总是|每次都|约定|规范|偏好|习惯/;

  constructor(private readonly s: AgentSession) {}

  /** 摘要生成选项：按当前模型声明的思考能力关闭思考 */
  private summaryOptions(): { modelSupportsThinking?: boolean } {
    return { modelSupportsThinking: declaredThinkingFor(this.s.model, this.s.provider) };
  }

  /** 游标之后、尚未整理过的消息（不含系统消息和单轮临时注入） */
  private takeUnprocessed(): { messages: ChatCompletionMessageParam[]; cursor: ChatCompletionMessageParam | null } {
    const all = this.s.messages;
    const idx = this.memoryCursor ? all.indexOf(this.memoryCursor) : -1;
    const start = Math.max(idx >= 0 ? idx + 1 : 1, all.length - CompactionController.MEMORY_BATCH_MESSAGES);
    const messages = all.slice(start).filter((m) => m.role !== "system" && !(m as { _ephemeralInjected?: boolean })._ephemeralInjected);
    const cursor = [...all].reverse().find((m) => !(m as { _ephemeralInjected?: boolean })._ephemeralInjected) ?? null;
    return { messages, cursor };
  }

  /**
   * 每轮正常回复结束后调用。达到阈值才启动后台整理，不阻塞当前回复或下一轮输入。
   * 如果这一轮同时触发了压缩，压缩会用压缩前的消息整理记忆，这里不再重复。
   */
  async maybeRefreshMemoryAfterTurn(turnTokens: number): Promise<void> {
    this.memoryUserTurns += 1;
    this.memoryRefreshTokens += Math.max(0, turnTokens);
    if (this.memoryRefreshInProgress || this.s.isCompacting || this.s.rollingSummaryInProgress) return;
    const lastUser = [...this.s.messages].reverse().find(isRealUserMessage);
    const userText = typeof lastUser?.content === "string" ? lastUser.content : this.s.lastUserInput?.content ?? "";
    const durable = CompactionController.DURABLE_HINT.test(userText);
    if (
      !durable
      && this.memoryUserTurns < CompactionController.MEMORY_REFRESH_TURNS
      && this.memoryRefreshTokens < CompactionController.MEMORY_REFRESH_TOKENS
    ) return;

    // 先消费本批计数和游标，再开始异步调用：调用期间新完成的回合累加到下一批
    this.memoryUserTurns = 0;
    this.memoryRefreshTokens = 0;
    const { messages, cursor } = this.takeUnprocessed();
    this.memoryCursor = cursor;
    if (messages.length === 0) return;
    this.memoryRefreshInProgress = true;
    try {
      const strategy = getStrategy(this.s.provider, this.s.model);
      await this.refreshMemory(messages, strategy);
    } finally {
      this.memoryRefreshInProgress = false;
    }
  }

  /**
   * 模型主动 update_memory 之后：清掉节流计数，避免紧接着又后台整理一次。
   * 游标不动——模型主动写的往往只是它当下想到的一两条，同一段对话里别的结论
   * 仍要交给下一次后台整理（整理时模型看得到已有记忆，不会重复写）。
   */
  markMemoryUpdated(): void {
    this.memoryUserTurns = 0;
    this.memoryRefreshTokens = 0;
  }

  /**
   * 压缩前调用：取出尚未整理的消息，并把游标移到压缩后的位置。
   * 压缩会把这些原文换成摘要，记忆必须用压缩前的原文来整理。
   */
  private takeForCompaction(): ChatCompletionMessageParam[] {
    const { messages } = this.takeUnprocessed();
    this.memoryUserTurns = 0;
    this.memoryRefreshTokens = 0;
    return messages;
  }

  /** 压缩完成后：游标落到新消息列表的末尾（压缩前的内容已交给记忆整理） */
  private resetCursorAfterCompaction(): void {
    const all = this.s.messages;
    this.memoryCursor = [...all].reverse().find((m) => !(m as { _ephemeralInjected?: boolean })._ephemeralInjected) ?? null;
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
      // 一条用户消息都没有的批次没什么可记的，省一次调用
      if (!snapshot.some((m) => m.role === "user")) return;
      const prev = this.s.getMemory();
      const updates = await generateSessionMemory(prev, snapshot, strategy, this.s.model, {
        modelSupportsThinking: declaredThinkingFor(this.s.model, this.s.provider),
      });
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
    // 压缩前取出尚未整理进记忆的原文：摘要替代后就再也拿不到这些细节了
    const snapshot = this.takeForCompaction();
    try {
      const strategy = getStrategy(this.s.provider, this.s.model);
      this.s.send("status", { content: "整理上下文..." });
      this.s.messages = await compactMessages(this.s.messages, strategy, this.s.model, undefined, this.summaryOptions());
      this.s.isCompacting = false;
      this.s.lastPromptTokens = 0;
      this.s.send("compacting_end", { success: true, message: successMessage });
      // ⚠️ 顺序不能反：持久化回调写盘时读的是 getLastTotalTokens()，必须先把压缩后的
      // 占用重算出来再落盘。反过来则磁盘上留下压缩【前】的旧占用，刷新页面时
      // hydrateTokenUsage 把它回填，界面从 4% 跳回 61%，要等用户发下一句话重算才降下来。
      this.s.updateAndSendTokenUsage();
      this.s.persistMessages();
      this.resetCursorAfterCompaction();
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
      // 压缩前取出尚未整理进记忆的原文（滚动摘要同样会丢细节）
      const pending = this.takeUnprocessed().messages;
      const [newMessages, didCompact] = await rollingCompact(this.s.messages, strategy, this.s.model, this.s.compactionConfig.keepRecentMessages, this.summaryOptions());
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
        // 滚动摘要同样用压缩前的原文整理记忆，避免与后台入口重复调用
        this.memoryUserTurns = 0;
        this.memoryRefreshTokens = 0;
        this.resetCursorAfterCompaction();
        await this.refreshMemory(pending, strategy);
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
      // 压缩前取出尚未整理进记忆的原文（含本轮用户消息）
      const snapshot = this.takeForCompaction();
      // 压缩前移除本轮刚推送的用户消息（它会在新会话中重新发送）
      const userMsg = this.s.messages.pop();
      this.s.compactionMigrationMessages = await compactMessages(this.s.messages, strategy, this.s.model, undefined, this.summaryOptions());
      // 恢复用户消息到原会话（保持历史完整，仅压缩版本不包含它）
      if (userMsg) this.s.messages.push(userMsg);
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
   * - 达到自动压缩线（session.getAutoCompactAt）-> 暂停询问用户「继续压缩 / 迁移到新会话」。
   * @returns true 表示用户选择迁移到新会话、本轮应中止；false 表示可继续本轮。
   */
  async maybeAutoCompactBeforeTurn(strategy: LLMStrategy): Promise<boolean> {
    const ctxWindow = this.s.getContextWindow();
    const overflowing = this.s.lastTotalTokens > ctxWindow;
    if (overflowing) {
      // 模型切换溢出：强制无感压缩
      // 压缩前取出尚未整理进记忆的原文，供记忆更新使用
      const snapshot = this.takeForCompaction();
      this.s.isCompacting = true;
      this.s.send("compacting_start", {});
      try {
        this.s.send("status", { content: "整理上下文..." });
        this.s.messages = await compactMessages(this.s.messages, strategy, this.s.model, undefined, this.summaryOptions());
        this.s.isCompacting = false;
        this.s.lastPromptTokens = 0;
        this.s.send("compacting_end", { success: true, message: "切换模型后上下文已自动压缩" });
        // 先重算再落盘（同 doCompact）：这条路径原先完全不落盘，磁盘会一直停在压缩前的占用
        this.s.updateAndSendTokenUsage();
        this.s.persistMessages();
        this.resetCursorAfterCompaction();
        await this.refreshMemory(snapshot, strategy);
      } catch (err) {
        this.s.isCompacting = false;
        this.s.send("compacting_end", { success: false, message: `压缩失败：${(err as Error).message}` });
      }
      return false;
    }
    const autoAt = this.s.getAutoCompactAt();
    if (this.s.lastTotalTokens > 0 && autoAt > 0 && this.s.lastTotalTokens >= autoAt) {
      // 达到自动压缩线：暂停，让用户选择
      const choice = await this.waitForCompactionChoice(this.s.lastTotalTokens, ctxWindow);
      if (choice === "continue") {
        // 用户选择继续：压缩当前会话
        // 压缩前取出尚未整理进记忆的原文，供记忆更新使用
        const snapshot = this.takeForCompaction();
        this.s.isCompacting = true;
        this.s.send("compacting_start", {});
        try {
          this.s.send("status", { content: "整理上下文..." });
          this.s.messages = await compactMessages(this.s.messages, strategy, this.s.model, undefined, this.summaryOptions());
          this.s.isCompacting = false;
          this.s.lastPromptTokens = 0;
          this.s.send("compacting_end", { success: true, message: "上下文已压缩" });
          // 先重算再落盘（同 doCompact），否则磁盘留着压缩前旧占用
          this.s.updateAndSendTokenUsage();
          this.s.persistMessages();
          this.resetCursorAfterCompaction();
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

  /**
   * 回答进行中的压缩门：每轮工具结果并入之后、下一次请求之前调用。
   *
   * 回合开始前的那道门（maybeAutoCompactBeforeTurn）只在用户发消息时检查一次，而一次回答里
   * 连读十几个文件、跑几条命令就能涨几十上百 k——开头 80%、中途撞上窗口上限直接报错。
   * 这里越过自动压缩线就无感压缩（不弹窗：用户正在等回答，此刻打断问「要不要压缩」没有意义），
   * 当前用户请求原样保留，见 compactKeepingCurrentTurn。
   *
   * @returns 是否压缩了
   */
  async maybeCompactMidTurn(strategy: LLMStrategy): Promise<boolean> {
    if (this.s.isCompacting || this.s.rollingSummaryInProgress) return false;
    const autoAt = this.s.getAutoCompactAt();
    if (!(autoAt > 0) || this.s.lastTotalTokens < autoAt) return false;
    let turnStart = -1;
    for (let i = this.s.messages.length - 1; i >= 1; i--) {
      if (isRealUserMessage(this.s.messages[i])) { turnStart = i; break; }
    }
    if (turnStart < 1) return false;

    const snapshot = this.takeForCompaction();
    this.s.isCompacting = true;
    this.s.send("compacting_start", { inline: true });
    try {
      this.s.send("status", { content: "上下文接近上限，正在整理..." });
      const before = this.s.messages;
      // 保留部分控制在压缩线的 40%：压完之后还要留出接着干活的空间，不然没几轮又要压
      const keepTokens = Math.round(autoAt * 0.4);
      const next = await compactKeepingCurrentTurn(before, strategy, this.s.model, turnStart, keepTokens, this.summaryOptions());
      this.s.isCompacting = false;
      if (next === before) {
        this.s.send("compacting_end", { success: true, inline: true, message: "" });
        return false;
      }
      this.s.messages = next;
      this.s.lastPromptTokens = 0;
      this.s.send("compacting_end", { success: true, inline: true, message: "上下文已自动压缩，继续当前任务" });
      this.s.updateAndSendTokenUsage();
      this.s.persistMessages();
      this.resetCursorAfterCompaction();
      // 记忆整理不阻塞本轮：用户在等回答
      void this.refreshMemory(snapshot, strategy);
      return true;
    } catch (err) {
      this.s.isCompacting = false;
      // 失败不中断本轮：真撞上限时由请求报错走 context_overflow 引导
      this.s.send("compacting_end", { success: false, inline: true, message: `自动压缩失败：${(err as Error).message}` });
      return false;
    }
  }
}

/** 压缩选择门 resolver 类型（供 session @internal 字段标注） */
export type CompactionChoiceResolver = ((choice: "continue" | "new_session") => void) | null;

/** 压缩迁移消息类型别名 */
export type CompactionMigrationMessages = ChatCompletionMessageParam[] | null;
