/**
 * Agent Session - 每个 WebSocket 连接一个实例
 *
 * 复用 cli 的核心逻辑，但通过 WS 推送中间状态给前端。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type OpenAI from "openai";
import { resolve } from "node:path";
import { executeToolCall, toolContentLimit, ToolError, ToolName, ToolCallStatus, statusForTool, SOFT_FAIL_TOOLS, EDIT_PERSIST_TOOLS, REQUIRED_ARGS_TOOLS, type ToolMeta, type WebCapability, type ApprovalDecision, type TrustRule, type GateOutcome } from "./tools/index.js";
import { calculateCredits, buildCreditDetail } from "./credits.js";
import type { AgentHost } from "./host/index.js";
import type { AgentChannel, AgentEvent } from "./channel/index.js";
import { needsCompaction, compactMessages, reflectiveCompact, pruneOldToolResults, DEFAULT_COMPACTION_CONFIG, setPruneKeepChars } from "./compactor.js";
import type { CompactionUserConfig } from "./compactor.js";
import type { SerializedPendingEdit } from "./storage/types.js";
import type { LLMStreamCallbacks, ToolDef } from "./llm/types.js";
import { SkillRegistry } from "./skills/skillLoader.js";
import { PowerRegistry } from "./powers/powerLoader.js";
import { looksLikeIncompleteReply, parseToolArguments, LoopGuard, policyForModel, isSoftToolFailure, buildReflectionPrompt, buildSummaryRestartPrompt, type StuckTarget } from "./agentGuards.js";
import { McpRegistry } from "./mcp/mcpRegistry.js";
import { MCP_TOOL_PREFIX, type McpCapability } from "./mcp/types.js";
import { modelContextWindow } from "./llm/modelContext.js";
import { SYSTEM_PROMPT, QUEST_SYSTEM_PROMPT } from "./systemPrompt.js";
import { getClient, getStrategy, ZHIPU_PROVIDER } from "./providers.js";
import { PromptBuilder, messageText } from "./session/promptBuilder.js";
import { TokenAccountant } from "./session/tokenAccountant.js";
import { ToolDefBuilder } from "./session/toolDefBuilder.js";
import { McpController } from "./session/mcpController.js";
import { DelegateRunner } from "./session/delegateRunner.js";
import { ParallelRunner } from "./session/parallelRunner.js";
import { RelayToolRunner } from "./session/relayToolRunner.js";
import { CommandGateController } from "./session/commandGateController.js";
import { EditController } from "./session/editController.js";
import { CompactionController } from "./session/compactionController.js";
import { RelayStore } from "./relay/relayStore.js";
import { SnapshotManager, SNAPSHOT_TOOLS } from "./snapshot/index.js";
import type { EditSnapshot } from "./host/scopedHost.js";


export class AgentSession {
  /** @internal 提示构建/Token 计量等协作者按 @internal 约定只读访问以下会话状态 */
  model: string;
  /** @internal */ provider: string;
  /** @internal */ messages: ChatCompletionMessageParam[];
  /** @internal */ cwd: string; // 主工作区（第一个路径，命令执行的默认目录）
  /** @internal */ terminalCwd: string; // 终端实际工作目录（cd 后可能不同于主工作区）
  /** @internal */ workspaces: string[]; // 所有工作区路径列表
  private channel: AgentChannel;
  /** @internal */ host: AgentHost;
  private homeDir: string;
  /** @internal */ web?: WebCapability;
  // MCP（Model Context Protocol）：可选注入的运行时能力（host 实现连接/调用），注入方式同 web。
  // mcpRegistry 解析三来源配置，mcp 负责连接与调用；本轮工具定义与「模型名→真实目标」映射预取缓存。
  /** @internal */ mcp?: McpCapability;
  /** @internal */ mcpRegistry: McpRegistry;
  /** @internal */ mcpToolDefsCache: ToolDef[] = [];
  /** @internal */ mcpToolMap = new Map<string, { serverId: string; toolName: string; serverName: string; autoApprove: boolean }>();
  /** 快照管理器（闪电回滚） */
  private snapshotMgr: SnapshotManager;
  /** 提示构建协作者（请求消息/注入/IDE 上下文，解耦自本类） */
  private readonly promptBuilder: PromptBuilder;
  /** Token 计量协作者（记录/估算/上报 token 用量，解耦自本类） */
  private readonly tokenAccountant: TokenAccountant;
  /** 工具定义装配协作者（通用工具 + delegate + relay + MCP，解耦自本类） */
  private readonly toolDefBuilder: ToolDefBuilder;
  /** MCP 工具预取/解析/调用协作者（解耦自本类） */
  private readonly mcpController: McpController;
  /** delegate_task 子 Agent 委托执行协作者（解耦自本类） */
  private readonly delegateRunner: DelegateRunner;
  /** parallel_research / parallel_execute 并行编排协作者（解耦自本类） */
  private readonly parallelRunner: ParallelRunner;
  /** Relay 工具执行协作者（create/saveDoc/advance/updateTask/reviewTask，解耦自本类） */
  private readonly relayToolRunner: RelayToolRunner;
  /** 对话轮次计数（用于快照 id） */
  private turnCount = 0;
  /** @internal */ lastTotalTokens = 0;
  /** @internal */ lastPromptTokens = 0;
  /** @internal */ lastCompletionTokens = 0;
  /** @internal */ lastCachedTokens = 0;
  /** @internal */ cumulativeTokens = 0;
  /** @internal */ lastTurnTokens = 0;
  /** 本轮开始前的累计 token 快照（取消时用差值复原本轮消耗） */
  private turnStartCumulative = 0;
  /** 本轮（最近一次用户输入）调用的子 Agent 累计 token，turn 开始时清零 */
  /** @internal */ lastSubAgentTokens = 0;
  /** 本轮（最近一次用户输入）所有回合的输出 token 累加，turn 开始时清零。
   *  注意：一次用户输入可能触发多回合（每次工具调用都是一回合），
   *  lastCompletionTokens 只保留最后一回合，会漏掉中间回合生成 tool_call 的输出。 */
  /** @internal */ lastTurnOutputTokens = 0;
  /** 本轮开始前的消息条数快照（push 本轮用户消息之前记录）。
   *  收尾时 messages[turnStartMsgCount..] 即本轮新增内容（用户消息 + 工具结果 + 中间 assistant 回填）。 */
  /** @internal */ turnStartMsgCount = 0;
  private abortController: AbortController | null = null;
  /** @internal */ get abortSignal(): AbortSignal | undefined { return this.abortController?.signal; }
  // 取消标志：cancel() 时置 true，agent loop 各处据此立即停止。
  // 独立于 abortController（后者 abort 后会被置 null，无法再判断状态）
  private cancelled = false;
  /** @internal */ get isCancelled(): boolean { return this.cancelled; }
  // 回复风格（concise/default/detailed），影响每次请求时注入的风格指令
  /** @internal */ replyStyle = "default";
  // 编辑模式与暂存区：manual 模式下文件改动暂存不落盘，等用户确认
  // 持久化回调：pendingEdits 变动时通知外部存储
  /** @internal */ onPendingChanged?: () => void;
  // 持久化回调：messages 发生实质变更（追加用户消息/assistant 回复/工具结果）时通知外部增量落盘。
  // 与 ws 连接解耦——即便前端切走、连接断开，回复仍能持续落盘，切回来不丢。
  private onMessagesChanged?: () => void;
  // Skill 注册表：发现并加载全局/工作区两级 skill（渐进式披露）
  /** @internal */ skillRegistry: SkillRegistry;
  // Power 注册表：发现并加载全局/工作区两级 power
  private powerRegistry: PowerRegistry | null = null;
  // 本轮请求的 skill 清单提示（handleUserInput 开头异步预取，buildRequestMessages 同步注入）
  /** @internal */ skillsPromptCache: string | null = null;
  // 本轮请求的 Power 清单提示
  /** @internal */ powersPromptCache: string | null = null;
  // 本轮请求的 IDE 上下文提示（仅 IDE 形态有 host.ideContext 时；handleUserInput 开头预取）。
  // 活动文件/选区是同步可得，git diff 是异步，统一在预取阶段拼好，buildRequestMessages 同步注入。
  /** @internal */ ideContextCache: string | null = null;
  // 子 agent 委托计数器：为每次 delegate_task 生成唯一 delegateId
  /** @internal */ delegateSeq = 0;
  // Relay 长任务工作流存储（落盘在主工作区 .axon/relays/）
  /** @internal */ relayStore: RelayStore;
  // 并行调研委托计数器：为每次 parallel_research 生成唯一 batchId
  /** @internal */ researchSeq = 0;
  // 并行执行委托计数器：为每次 parallel_execute 生成唯一 batchId
  /** @internal */ executionSeq = 0;
  // 并行执行的文件回滚快照（key = AI 路径 path）。auto 落盘无原生 undo，靠此实现一键回滚。
  /** @internal */ parallelSnapshots = new Map<string, EditSnapshot>();
  // 工具确认门：relay_create 等需要用户确认的操作，await 此 Promise 阻塞直到用户响应
  private toolConfirmResolve: ((confirmed: boolean) => void) | null = null;
  // 压缩选择门：自动压缩触发时（>=75%），await 此 Promise 阻塞直到用户在"继续/新会话"中选择
  /** @internal */ compactionChoiceResolve: ((choice: "continue" | "new_session") => void) | null = null;
  // 迁移数据：compactionChoice = new_session 时，存储压缩后的消息供 sessionHub 在新会话中注入
  /** @internal */ compactionMigrationMessages: ChatCompletionMessageParam[] | null = null;
  // 当前轮用户输入（compactionChoice = new_session 时用于迁移到新会话）
  /** @internal */ lastUserInput: { content: string; model?: string; images?: string[]; provider?: string; userMeta?: Record<string, unknown> } | null = null;
  // 命令信任门：execute_command 的"灾难硬拦 + 白名单 + 人工授权"，状态与逻辑收敛在 CommandGateController
  private readonly commandGateController: CommandGateController;
  /** 待确认改动接受/拒绝/撤销 + 并行回滚控制器（解耦自本类） */
  private readonly editController: EditController;
  /** 上下文压缩控制器（手动/滚动/溢出迁移，解耦自本类） */
  private readonly compactionController: CompactionController;
  // 当前会话 id（用于把 relay 关联到会话；由外部 index.ts 注入）
  /** @internal */ currentRelaySessionId?: string;
  /** 正在执行上下文压缩时为 true。此期间不允许取消，避免压缩中断导致消息状态不完整。 */
  isCompacting = false;
  /** 滚动摘要：自上次摘要以来的累计 token 增量。每轮 stream_end 后累加，超过阈值触发异步摘要。 */
  /** @internal */ rollingSummaryAccumulated = 0;
  /** 滚动摘要是否正在进行中（防止并发）。 */
  /** @internal */ rollingSummaryInProgress = false;
  /** 滚动压缩配置（运行时可更新）。来自呈现端注入，默认启用。 */
  /** @internal */ compactionConfig: CompactionUserConfig = { ...DEFAULT_COMPACTION_CONFIG };
  // 执行中的 relay 任务上下文：记录当前正在执行哪个 relay/任务，及该任务改动过的文件（供评审定位）
  /** @internal */ activeRelayTask: { relayId: string; taskId: string; changedFiles: Set<string> } | null = null;
  // 本轮用户输入内是否已推进过一次 Relay 阶段。确认门铁律：一条用户消息最多推进一个文档阶段，
  // 防止模型在同一回合里自己写完文档又自己 advance、连续跨多个阶段（无视用户确认）。
  /** @internal */ relayAdvancedThisTurn = false;

  // ── Quest（纯问答）模式 ──────────────────────────────────────────────────
  // mode=quest 时：不绑定工作区语义、禁用所有读写/执行工具（仅在开启联网时放行 web 工具）、
  // 使用问答系统提示。think 控制是否把 reasoning_delta 转发给前端。
  /** @internal */ readonly mode: "agent" | "quest";
  private questThink = false;
  /** @internal */ questWebSearch = false;

  constructor(cwd: string, channel: AgentChannel, host: AgentHost, existingMessages?: ChatCompletionMessageParam[], workspaces?: string[], homeDir?: string, web?: WebCapability, mode: "agent" | "quest" = "agent", mcp?: McpCapability) {
    this.mode = mode;
    this.model = process.env.DEFAULT_MODEL || "gpt-5.5";
    this.provider = process.env.DEFAULT_PROVIDER || ZHIPU_PROVIDER;
    this.messages = existingMessages && existingMessages.length > 0
      ? existingMessages
      : [{ role: "system", content: mode === "quest" ? QUEST_SYSTEM_PROMPT : SYSTEM_PROMPT }];
    this.cwd = cwd;
    this.terminalCwd = cwd;
    this.workspaces = workspaces && workspaces.length > 0 ? workspaces : [cwd];
    this.channel = channel;
    this.host = host;
    this.homeDir = homeDir ?? "";
    this.web = web;
    this.skillRegistry = new SkillRegistry(this.workspaces, this.host, this.homeDir);
    this.powerRegistry = new PowerRegistry(this.workspaces, this.host, this.homeDir);
    this.mcp = mcp;
    this.mcpRegistry = new McpRegistry(this.workspaces, this.host, this.homeDir, this.powerRegistry);
    this.relayStore = new RelayStore(this.cwd, this.host);
    this.snapshotMgr = new SnapshotManager(this.host, this.cwd);
    this.promptBuilder = new PromptBuilder(this);
    this.tokenAccountant = new TokenAccountant(this);
    this.toolDefBuilder = new ToolDefBuilder(this);
    this.mcpController = new McpController(this);
    this.delegateRunner = new DelegateRunner(this);
    this.parallelRunner = new ParallelRunner(this);
    this.relayToolRunner = new RelayToolRunner(this);
    this.commandGateController = new CommandGateController(this);
    this.editController = new EditController(this);
    this.compactionController = new CompactionController(this);
    // 延迟初始化快照：等第一次实际需要时才 init（不在构造函数里跑 git 命令，
    // 避免 session 切换时终端面板被意外弹出）
  }

  /** 设置滚动压缩配置（由呈现端在启动时 / 配置变更时调用） */
  setCompactionConfig(cfg: Partial<CompactionUserConfig>): void {
    this.compactionConfig = { ...this.compactionConfig, ...cfg };
    // 同步工具结果裁剪参数到 compactor 模块
    setPruneKeepChars(this.compactionConfig.toolResultPruneChars);
  }

  /** 获取当前压缩配置（诊断 / UI 展示用） */
  getCompactionConfig(): CompactionUserConfig {
    return this.compactionConfig;
  }

  /** 获取当前完整消息列表（持久化用） */
  getMessages(): ChatCompletionMessageParam[] {
    return this.messages;
  }

  /** 注册 pendingEdits 变动回调（外部用于触发持久化） */
  setOnPendingChanged(cb: () => void): void {
    this.onPendingChanged = cb;
  }

  /** 注册 messages 变更回调（外部用于增量持久化，与 ws 连接解耦） */
  setOnMessagesChanged(cb: () => void): void {
    this.onMessagesChanged = cb;
  }

  /** 触发一次消息持久化回调（内部在关键节点调用）。回调内部自行容错，不阻塞主流程。 */
  /** @internal */ persistMessages(): void {
    try {
      this.onMessagesChanged?.();
    } catch (err) {
      console.warn("[session] 增量持久化回调出错（忽略）:", (err as Error).message);
    }
  }

  /** 序列化 pendingEdits 为可持久化数组 */
  serializePendingEdits(): SerializedPendingEdit[] {
    return this.host.edits.serialize().map((e) => ({
      absPath: e.absPath,
      path: e.path,
      originalContent: e.originalContent,
      newContent: e.newContent,
      isNew: e.isNew,
      hunks: e.hunks,
      fullRewrite: e.fullRewrite,
      editId: e.editId,
    }));
  }

  /** 从持久化数据恢复 pendingEdits */
  restorePendingEdits(edits: SerializedPendingEdit[]): void {
    this.host.edits.restore(edits.map((e) => ({
      path: e.path,
      absPath: e.absPath,
      originalContent: e.originalContent,
      newContent: e.newContent,
      isNew: e.isNew,
      hunks: e.hunks,
      fullRewrite: e.fullRewrite,
      editId: e.editId,
    })));
  }

  /** 获取当前工作区路径 */
  getWorkspace(): string {
    return this.cwd;
  }

  /** 设置工作区路径（切换会话/更换工作区时调用） */
  setWorkspace(dir: string): void {
    this.cwd = dir;
    this.workspaces = [dir];
    this.skillRegistry?.setWorkspaces(this.workspaces);
    this.mcpRegistry?.setWorkspaces(this.workspaces);
    this.relayStore?.setWorkspace(this.cwd);
  }

  /** 设置多工作区路径（工作区组绑定时调用） */
  setWorkspaces(dirs: string[]): void {
    this.workspaces = dirs.length > 0 ? dirs : [this.cwd];
    this.cwd = this.workspaces[0]; // 主工作区为第一个
    this.terminalCwd = this.cwd;
    this.skillRegistry?.setWorkspaces(this.workspaces);
    this.mcpRegistry?.setWorkspaces(this.workspaces);
    this.relayStore?.setWorkspace(this.cwd);
  }

  /** 跟踪终端实际工作目录（execute_command / start_process 执行后同步） */
  private trackTerminalCwd(toolName: string, args: Record<string, unknown>, meta?: ToolMeta): void {
    if (toolName !== "execute_command" && toolName !== "start_process") return;
    // 优先用 shell integration 返回的真实 cwd
    if (meta?.terminalCwd) {
      this.terminalCwd = meta.terminalCwd;
      return;
    }
    const argCwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : undefined;
    this.terminalCwd = argCwd ? resolve(this.cwd, argCwd) : this.cwd;
  }

  /** 获取所有工作区路径 */
  getWorkspaces(): string[] {
    return this.workspaces;
  }

  /** 设置编辑模式（auto=直接落盘 / manual=暂存待确认） */
  setEditMode(mode: "auto" | "manual"): void {
    this.host.edits.setMode(mode);
  }

  /** 是否有待确认的改动 */
  hasPendingEdits(): boolean {
    return this.host.edits.hasPending();
  }

  /** 待确认改动的相对路径列表 */
  getPendingPaths(): string[] {
    return this.host.edits.getPendingPaths();
  }

  /** 待确认改动的编辑单元 id 列表（供前端逐次卡片精确匹配） */
  getPendingEditIds(): string[] {
    return this.host.edits.getPendingEditIds();
  }

  /** 待确认改动的完整 diff（原始磁盘内容 → 最终内容），供前端汇总条展示整体差异 */
  getPendingDiffs(): { path: string; oldContent: string; newContent: string }[] {
    return this.host.edits.getPendingDiffs();
  }

  /** 已接受、可撤销的相对路径列表（LIFO） */
  getUndoablePaths(): string[] {
    return this.host.edits.getUndoablePaths();
  }

  /** 向前端推送待确认列表（含完整 diff）；rejected 为本次被拒绝的路径列表 */
  /** 向前端推送待确认列表（委托 EditController；主循环工具落盘后也会调用） */
  private sendEditsUpdated(rejected?: string[]): void {
    this.editController.sendEditsUpdated(rejected);
  }

  /** 接受待确认改动并落盘（委托 EditController）。path 省略时接受全部。 */
  async acceptEdits(path?: string): Promise<void> {
    await this.editController.accept(path);
  }

  /** 拒绝待确认改动并丢弃（委托 EditController）。path 省略时拒绝全部。 */
  async rejectEdits(path?: string): Promise<void> {
    await this.editController.reject(path);
  }

  /** 撤销一笔已接受的文件改动（委托 EditController）。 */
  async undoEdits(path: string): Promise<void> {
    await this.editController.undo(path);
  }

  /** 列出所有快照（供前端展示回滚时间线）。问答模式无文件编辑操作，不生产快照，直接返回空。 */
  async listSnapshots() {
    if (this.mode === "quest") return [];
    return this.snapshotMgr.list();
  }

  /** 回滚到指定快照。问答模式禁止回滚。 */
  async restoreSnapshot(id: string): Promise<boolean> {
    if (this.mode === "quest") return false;
    const ok = await this.snapshotMgr.restore(id);
    if (ok) {
      this.send("status", { content: `已回滚到快照 ${id}`, phase: "done" });
    }
    return ok;
  }

  /**
   * 回滚一个并行执行（parallel_execute）写入的文件。
   * 并行子 Agent auto 落盘，无原生 undo 记录，靠 parallelSnapshots 里捕获的"改动前快照"恢复：
   * - 新建文件 → 删除
   * - 已存在文件 → 写回原始内容
   * @param path AI 使用的路径（前端从文件变更清单回传）
   */
  /** 回滚一个并行执行（parallel_execute）写入的文件（委托 EditController）。 */
  async undoParallelFile(path: string): Promise<void> {
    await this.editController.undoParallelFile(path);
  }

  /** 获取最近一次的累计 token 数（委托 TokenAccountant） */
  getLastTotalTokens(): number {
    return this.tokenAccountant.getLastTotalTokens();
  }

  /** 从持久化快照回填上下文 token 统计（委托 TokenAccountant） */
  hydrateTokenUsage(totalTokens?: number): void {
    this.tokenAccountant.hydrateTokenUsage(totalTokens);
  }

  /** 取消当前进行中的请求。压缩进行中时忽略——中断会破坏消息完整性。 */
  cancel(): void {
    if (this.isCompacting) return;
    this.cancelled = true;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    // 直接发送 turn_cancelled 兜底：agent loop 可能在 prefetch 阶段就被 abort 了，
    // 根本没走到 stampCancelledTurnStats。这里保证前端至少能拿到字符估算值。
    this.sendTurnCancelledFallback();
  }

  /** 在 cancel() 被调用但 agent loop 尚未产出任何统计时的兜底 */
  private sendTurnCancelledFallback(): void {
    // 取消时用字符估算兜底 outputTokens（已接收的流式内容字符数 * 0.4）
    const estimatedOutput = this.lastTurnOutputTokens || this.lastCompletionTokens || 0;
    const breakdown = { ...this.buildTokenBreakdown(), outputTokens: estimatedOutput };
    const turnTokens = breakdown.memoryTokens + breakdown.systemTokens + breakdown.questionTokens + breakdown.outputTokens;
    if (turnTokens <= 0) return; // 没有任何数据可发
    const credits = calculateCredits(this.model, breakdown);
    const creditDetail = buildCreditDetail(this.model, breakdown);
    this.send("turn_cancelled", {
      elapsed: 0,
      tokens: turnTokens,
      model: this.model,
      credits,
      creditDetail,
    });
  }

  /** 手动触发上下文压缩（供前端"压缩上下文"按钮调用）。需超过当前模型窗口 35% 才允许。 */
  /** 手动触发上下文压缩（委托 CompactionController）。 */
  async compactSession(): Promise<void> {
    await this.compactionController.compactSession();
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
  /** 滚动摘要：异步把旧消息压成摘要，控制上下文体积（委托 CompactionController）。 */
  private async maybeRollingSummary(): Promise<void> {
    await this.compactionController.maybeRollingSummary();
  }

  /** 把 open_browser 打开的浏览器页面带到前台（前端点击工具卡片输出时触发） */
  async focusBrowser(): Promise<void> {
    try { await this.host.webBrowser?.focus(); } catch { /* 忽略 */ }
  }

  /**
   * 取消退出时给最后一条 assistant 消息补上 turnStats（让 persistOnCancel 落盘后前端恢复时仍可展示）。
   * 如果当前轮有已输出但未 push 的流式内容，先追加为 assistant 消息再标记 turnStats。
   */
  private stampCancelledTurnStats(turnStartTime: number, streamedContent?: string): void {
    // 如果有流式内容但还没 push 到 messages，先 push
    if (streamedContent && streamedContent.trim()) {
      const last = this.messages[this.messages.length - 1];
      // 只在最后一条不是 assistant 或没内容时追加（避免重复）
      if (!last || last.role !== "assistant" || !(last as any).content) {
        this.messages.push({ role: "assistant", content: streamedContent } as any);
      }
    }
    const elapsed = Date.now() - turnStartTime;
    // outputTokens：优先用 API 返回的真实值，没有时用流式内容字符数估算（约 0.4 token/字符）
    const estimatedOutput = this.lastTurnOutputTokens || this.lastCompletionTokens
      || (streamedContent ? Math.ceil(streamedContent.length * 0.4) : 0);
    const breakdown = { ...this.buildTokenBreakdown(), outputTokens: estimatedOutput };
    // 取消时可能没有任何 LLM 返回数据（lastTurnTokens=0, cumulative 也没涨）。
    // 用 buildTokenBreakdown 的字符估算兜底，至少不显示 0。
    const turnTokens = this.lastTurnTokens
      || (this.turnStartCumulative > 0 ? this.cumulativeTokens - this.turnStartCumulative : 0)
      || (breakdown.memoryTokens + breakdown.systemTokens + breakdown.questionTokens + breakdown.outputTokens);
    const credits = calculateCredits(this.model, breakdown);
    const creditDetail = buildCreditDetail(this.model, breakdown);
    // 找到 messages 里最后一条 assistant 消息并追加 turnStats
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i].role === "assistant") {
        (this.messages[i] as any).turnStats = { elapsed, tokens: turnTokens, model: this.model, credits, creditDetail };
        break;
      }
    }
    this.persistMessages();
    // 把真实的四段拆分推给前端：取消时前端会先乐观合成一份粗糙 creditDetail（system/本次提问为 0），
    // 这里用后端算出的真实 breakdown 覆盖它，避免 tooltip 显示 system=0、本次提问=0。
    this.send("turn_cancelled", { elapsed, tokens: turnTokens, model: this.model, credits, creditDetail });
  }

  /**
   * 删除一个 relay：若当前会话正在跑这个 relay，先取消其关联的子 Agent 执行（abort 信号会
   * 中断委托/调研/评审子 Agent），让能落盘的数据立即落盘、已产生的 token 完成统计，再删除产物。
   * @returns 是否取消了正在进行的执行（true 表示当前会话确有该 relay 在跑并已中断）
   */
  async deleteRelay(relayId: string): Promise<{ cancelled: boolean }> {
    // 当前会话正在执行这个 relay 的任务 → 取消（abort 会让子 Agent 停止，
    // 主循环的取消检查会停下，已追加的消息由增量回调落盘，子 Agent token 在 catch 里已累加）
    const isRunningThisRelay = this.activeRelayTask?.relayId === relayId;
    if (isRunningThisRelay) {
      this.cancel();
      this.activeRelayTask = null;
    }
    // 立即落盘当前对话状态（用户取消语义：保留已产生的进展）
    this.persistMessages();
    // 删除 relay 产物（文档 + 元数据）
    await this.relayStore.remove(relayId);
    this.send("relay_deleted", { relayId });
    return { cancelled: isRunningThisRelay };
  }

  /** 暴露 relay 存储给外部（REST API 读取 relay 列表/详情用） */
  getRelayStore(): RelayStore {
    return this.relayStore;
  }

  /** 外部 resolve 工具确认门（由 SessionHub.dispatch confirm_tool 调用） */
  resolveToolConfirmation(confirmed: boolean): void {
    if (this.toolConfirmResolve) {
      this.toolConfirmResolve(confirmed);
      this.toolConfirmResolve = null;
    }
  }

  /** 外部 resolve 压缩选择门（由 SessionHub.dispatch compaction_choice 调用） */
  resolveCompactionChoice(choice: "continue" | "new_session"): void {
    if (this.compactionChoiceResolve) {
      this.compactionChoiceResolve(choice);
      this.compactionChoiceResolve = null;
    }
  }

  /** 获取压缩迁移数据（handleCompactionChoice("new_session") 后由 sessionHub 读取） */
  getCompactionMigrationData(): { messages: ChatCompletionMessageParam[]; userInput: { content: string; model?: string; images?: string[]; provider?: string; userMeta?: Record<string, unknown> } } | null {
    if (!this.compactionMigrationMessages || !this.lastUserInput) return null;
    return { messages: this.compactionMigrationMessages, userInput: this.lastUserInput };
  }

  /**
   * 处理用户对压缩方式的选择（由 sessionHub.compaction_choice 调用）。
   * - "continue"：只 resolve 承诺，压缩由 handleUserInput 继续执行
   * - "new_session"：立即压缩并存储迁移数据，resolve 承诺让 handleUserInput 退出
   */
  /** 处理用户对压缩方式的选择（委托 CompactionController）。 */
  async handleCompactionChoice(choice: "continue" | "new_session"): Promise<void> {
    await this.compactionController.handleCompactionChoice(choice);
  }

  /**
   * 等待用户确认工具执行。发送 confirm_tool_request 事件给前端，
   * 阻塞直到用户确认或拒绝。若 120 秒内无响应（webview 未就绪等），自动拒绝以免永久死锁。
   */
  /** @internal */ waitForToolConfirmation(toolName: string, args: Record<string, unknown>, kind: "relay" | "mcp" = "relay", label?: string): Promise<boolean> {
    this.send("confirm_tool_request", { toolName, args, kind, label });
    return new Promise<boolean>((resolve) => {
      this.toolConfirmResolve = resolve;
      // 兜底超时：若前端 120 秒内未应答（如 webview 被 VS Code 回收导致事件丢失），自动拒绝，避免 agent loop 永久阻塞
      setTimeout(() => {
        if (this.toolConfirmResolve === resolve) {
          this.toolConfirmResolve = null;
          resolve(false);
        }
      }, 120_000);
    });
  }

  /**
   * 等待用户选择压缩方式。发送 compaction_needed 事件给前端，
   * 阻塞直到用户选择"继续"或"新会话"。120 秒超时自动选"继续"以防死锁。
   */
  /** 等待用户选择压缩方式（委托 CompactionController）。 */
  private waitForCompactionChoice(currentTokens: number, maxTokens: number): Promise<"continue" | "new_session"> {
    return this.compactionController.waitForCompactionChoice(currentTokens, maxTokens);
  }

  /** 注入持久化的命令信任白名单（委托 CommandGateController） */
  setTrustedCommands(patterns: string[]): void {
    this.commandGateController.setTrustedPatterns(patterns);
  }

  /** 注册"新批准规则"持久化回调（委托 CommandGateController） */
  setOnCommandTrustApproved(cb: (rule: TrustRule, target?: "user" | "workspace") => void): void {
    this.commandGateController.setOnApproved(cb);
  }

  /** 当前命令信任白名单（委托 CommandGateController） */
  listTrustedCommands(): TrustRule[] {
    return this.commandGateController.listRules();
  }

  /** 外部 resolve 命令审批门（委托 CommandGateController） */
  resolveCommandApproval(requestId: string, decision: ApprovalDecision): void {
    this.commandGateController.resolveApproval(requestId, decision);
  }

  /**
   * 命令信任门（共享，委托 CommandGateController）：主循环与子 Agent 的 execute_command
   * 都走这一个 gate，保证白名单、灾难硬拦、人工授权三层语义一致，批准结果父子共享。
   */
  /** @internal */ gateCommand(command: string, toolCallId?: string): Promise<GateOutcome> {
    return this.commandGateController.gate(command, toolCallId);
  }

  /** 设置当前会话 id（relay 关联用，由 index.ts 在加载/创建会话时调用） */
  setSessionId(id: string): void {
    this.currentRelaySessionId = id;
  }

  /** 获取当前会话 id（持久化时绑定到正确的会话文件，避免切换会话后串写） */
  getSessionId(): string {
    return this.currentRelaySessionId || "";
  }

  /** 工具定义装配（委托 ToolDefBuilder） */
  private getToolDefs(): ToolDef[] {
    return this.toolDefBuilder.getToolDefs();
  }

  /** 设置 Quest 模式选项（每轮用户输入前由 SessionHub 注入） */
  setQuestOptions(opts: { think?: boolean; webSearch?: boolean }): void {
    if (typeof opts.think === "boolean") this.questThink = opts.think;
    if (typeof opts.webSearch === "boolean") this.questWebSearch = opts.webSearch;
  }

  /** use_skill 工具的 skill 加载器（绑定 this，传给 executeToolCall） */
  /** @internal */ loadSkillForTool = async (name: string): Promise<{ name: string; dir: string; body: string } | null> => {
    const skill = await this.skillRegistry.load(name);
    return skill ? { name: skill.name, dir: skill.dir, body: skill.body } : null;
  };

  /** activate_power 工具的 Power 加载器（绑定 this，传给 executeToolCall） */
  private loadPowerForTool = async (name: string) => {
    if (!this.powerRegistry) return null;
    const power = await this.powerRegistry.load(name);
    if (!power) return null;
    return {
      name: power.name,
      displayName: power.displayName,
      body: power.body,
      keywords: power.keywords,
      mcpServerCount: power.mcpServerCount,
      skillCount: power.skillCount,
      skills: power.skills.map((s) => ({ name: s.name, description: s.description })),
      mcpServers: power.mcpConfig?.mcpServers || {},
      steeringFiles: power.steeringFiles,
    };
  };

  /**
   * 执行 delegate_task（委托 DelegateRunner）。
   */
  private async runDelegateTask(
    args: Record<string, unknown>,
    toolCallId: string,
  ): Promise<string> {
    return this.delegateRunner.run(args, toolCallId);
  }

  /**
   * 执行 relay_create：创建一个新的 Relay 长任务工作流，通知前端打开/刷新面板。
   */
  /** 执行 relay_create（委托 RelayToolRunner） */
  private async runRelayCreate(args: Record<string, unknown>): Promise<string> {
    return this.relayToolRunner.create(args);
  }

  /** 执行 relay_save_doc：写入某阶段文档，通知前端刷新。 */
  /** 执行 relay_save_doc（委托 RelayToolRunner） */
  private async runRelaySaveDoc(args: Record<string, unknown>): Promise<string> {
    return this.relayToolRunner.saveDoc(args);
  }

  /** 执行 relay_advance：用户确认后推进阶段（确认门）。 */
  /** 执行 relay_advance（委托 RelayToolRunner） */
  private async runRelayAdvance(args: Record<string, unknown>): Promise<string> {
    return this.relayToolRunner.advance(args);
  }

  /** 执行 relay_update_task：更新任务状态并回写 plan.md 复选框。 */
  /** 执行 relay_update_task（委托 RelayToolRunner） */
  private async runRelayUpdateTask(args: Record<string, unknown>): Promise<string> {
    return this.relayToolRunner.updateTask(args);
  }

  /**
   * 执行 relay_review_task：对指定任务跑两阶段只读评审，结果落盘并回填给主 Agent。
   * 评审子 Agent 的事件用 sub_agent_event 包装（带独立 reviewId），前端各自渲染卡片。
   */
  /** 执行 relay_review_task（委托 RelayToolRunner） */
  private async runRelayReviewTask(args: Record<string, unknown>): Promise<string> {
    return this.relayToolRunner.reviewTask(args);
  }

  /**
   * 执行 parallel_research：派发多个只读子 Agent 并发调研，聚合结论回填。
   * 每路子 Agent 的事件用 sub_agent_event 包装（带独立 delegateId），前端各自渲染卡片。
   */
  /** 执行 parallel_research（委托 ParallelRunner） */
  private async runParallelResearch(args: Record<string, unknown>, toolCallId: string): Promise<string> {
    return this.parallelRunner.research(args, toolCallId);
  }

  /**
   * 执行 parallel_execute：派发多个子 Agent 并行执行写任务，各自有文件作用域隔离。
   * 每路子 Agent 的事件用 sub_agent_event 包装（带独立 delegateId），前端各自渲染卡片。
   */
  /** 执行 parallel_execute（委托 ParallelRunner） */
  private async runParallelExecution(args: Record<string, unknown>, toolCallId: string): Promise<string> {
    return this.parallelRunner.execute(args, toolCallId);
  }

  /** 发消息给前端 */
  /** @internal */ send(type: string, data: Record<string, unknown> = {}): void {
    this.channel.emit({ type, ...data } as AgentEvent);
  }

  /** 根据当前模型返回上下文窗口大小（统一来源 modelContextWindow） */
  /** @internal */ getContextWindow(): number {
    return modelContextWindow(this.model);
  }

  /** 推送当前上下文 token 占用给前端（委托 TokenAccountant） */
  /** @internal */ updateAndSendTokenUsage(): void {
    this.tokenAccountant.updateAndSendTokenUsage();
  }

  /** 记录某回合 API 返回的真实 token 用量（委托 TokenAccountant） */
  private recordTurnUsage(usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number }): void {
    this.tokenAccountant.recordTurnUsage(usage);
  }

  /** 累加子 Agent 消耗的 token（委托 TokenAccountant） */
  /** @internal */ addSubAgentTokens(tokens: number): void {
    this.tokenAccountant.addSubAgentTokens(tokens);
  }

  /** 获取本会话累计 token 消耗（含子 Agent）（委托 TokenAccountant） */
  getCumulativeTokens(): number {
    return this.tokenAccountant.getCumulativeTokens();
  }

  /**
   * 把本轮 prompt 按来源拆分为 记忆 / system / 本次输入（供 tooltip 展示）。
   * - system：系统提示 + 注入（风格/验证/多工作区/IDE/skill/power）+ 工具定义
   * - 本次输入：本轮新增消息（用户消息 + 工具结果 + 中间 assistant 回填）的字符估算 + 本轮子 Agent
   * - 记忆：真实总 prompt − system − 本次输入（余量，吸收"字符估算 vs 真实 token"的偏差）
   *
   * 关键：用字符估算去算【本次输入】这个小桶，让【记忆】这个大桶承接真实总量的余量。
   * 反过来（估记忆、余量给本次输入）会把整段历史的估算误差——尤其 0.4/字符 对中文的严重低估
   * ——全甩进"本次输入"，导致一句"关掉前端吧"也显示几万 token。
   */
  private buildTokenBreakdown(): { memoryTokens: number; systemTokens: number; questionTokens: number } {
    // 各段字符数
    let thisTurnChars = 0;
    for (let i = Math.max(1, this.turnStartMsgCount); i < this.messages.length; i++) {
      thisTurnChars += messageText(this.messages[i]).length;
    }
    let memoryChars = 0;
    if (this.turnStartMsgCount > 1) {
      for (let i = 1; i < this.turnStartMsgCount; i++) memoryChars += messageText(this.messages[i]).length;
    }

    // system 直接估算（最稳定可知：系统提示文本 + 注入 + 工具定义 JSON）。
    // 自然文本约 0.4 token/字符；工具定义是结构化 JSON,token 密度更高,约 0.75。
    let systemChars = this.messages[0] ? messageText(this.messages[0]).length : 0;
    for (const inj of this.promptBuilder.buildInjections()) systemChars += messageText(inj).length;
    let toolsChars = 0;
    try { toolsChars = JSON.stringify(this.getToolDefs()).length; } catch { /* 忽略 */ }
    const systemEstimate = Math.ceil(systemChars * 0.4 + toolsChars * 0.75);

    // 有 API 返回的真实 prompt_tokens 时：
    // system 用估算（封顶不超过真实总数）；剩余的真实 token 按字符比例分给 记忆 / 本次提问,保证三段加和 = 真实总数。
    if (this.lastPromptTokens > 0) {
      const systemTokens = Math.min(systemEstimate, this.lastPromptTokens);
      const remaining = this.lastPromptTokens - systemTokens; // 记忆 + 本次提问 的真实总量
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
      return { memoryTokens, systemTokens, questionTokens: questionTokens + this.lastSubAgentTokens };
    }

    // 兜底：没拿到 API usage,纯字符估算
    const questionTokens = Math.ceil(thisTurnChars * 0.6) + this.lastSubAgentTokens;
    const memoryTokens = this.turnStartMsgCount <= 1 ? 0 : Math.ceil(memoryChars * 0.6);
    return { memoryTokens, systemTokens: systemEstimate, questionTokens };
  }

  /**
   * 反思·换路（轻量层）：卡在某目标反复失败时，重读其真实状态 + 注入复盘引导，给一次"换路"机会。
   * 重量版体现在 readStuckTargetState——主动把卡住文件的最新内容塞回上下文，消除"拿旧状态硬改"的根因。
   */
  private async injectReflection(stuck: StuckTarget | null, guard: LoopGuard): Promise<void> {
    this.send("status", { content: "重新理清思路...", phase: "thinking" });
    const freshState = await this.readStuckTargetState(stuck);
    this.messages.push({ role: "system", content: buildReflectionPrompt(stuck) + freshState } as ChatCompletionMessageParam);
    guard.noteReflected();
    this.persistMessages();
  }

  /**
   * 摘要重启（重量层）：把反复失败的过程压成复盘摘要、清除噪声原文，再重读真实状态，
   * 让模型带着干净上下文换一条完全不同的路重来。是投降前的最后一搏。
   */
  private async injectSummaryRestart(stuck: StuckTarget | null, guard: LoopGuard, client: OpenAI): Promise<void> {
    this.send("status", { content: "整理思路，换个方式重来...", phase: "thinking" });
    this.messages = await reflectiveCompact(this.messages, client, this.model);
    const freshState = await this.readStuckTargetState(stuck);
    this.messages.push({ role: "system", content: buildSummaryRestartPrompt(stuck) + freshState } as ChatCompletionMessageParam);
    guard.noteSummaryRestart();
    this.persistMessages();
  }

  /** 重读卡住目标的最新真实内容（仅当卡在某个文件上时）；失败不阻塞，返回空串。 */
  private async readStuckTargetState(stuck: StuckTarget | null): Promise<string> {
    if (!stuck?.path) return "";
    try {
      const content = await executeToolCall("read_file", { path: stuck.path }, this.cwd, this.host, {}, this.workspaces);
      return `\n\n以下是 ${stuck.path} 的最新真实内容，请基于它（而不是你记忆中的旧状态）重新规划：\n${content}`;
    } catch {
      return ""; // 文件可能已删除/路径变化，读不到不影响反思引导本身
    }
  }

  /**
   * 预取 MCP 工具（每轮用户输入前）：解析三来源配置 → 同步连接 → 拉取工具清单，
   * 构建模型可见的工具定义与「模型名 → 真实目标」映射。
   * MCP 是增强项：任何环节失败都不阻塞主流程，清空缓存即可（其它工具照常）。Quest 模式不启用。
   */
  /** 预取 MCP 工具（委托 McpController） */
  private async prefetchMcpTools(): Promise<void> {
    await this.mcpController.prefetchMcpTools();
  }

  /** 工具是否必须有参数（空参数对象视为调用失败，避免把 {} 当有效参数执行） */
  private toolRequiresArguments(toolName: string): boolean {
    if (REQUIRED_ARGS_TOOLS.has(toolName)) return true;
    // MCP 工具一律要求带参数
    if (toolName.startsWith(MCP_TOOL_PREFIX)) return true;
    return false;
  }

  /** 若是 MCP 工具，返回其真实 server 名与工具名（供前端卡片展示）。
   * 不在 mcpToolMap（已禁用/移除）时，从编码名尽力还原，至少让卡片能标出 server/tool 名。 */
  /** MCP 工具的真实 server/tool 名（委托 McpController） */
  private mcpMetaFor(toolName: string): { mcpServer?: string; mcpTool?: string } {
    return this.mcpController.mcpMetaFor(toolName);
  }

  /**
   * 执行一次 MCP 工具调用：autoApprove 命中直接放行，否则走确认门请用户批准本次调用。
   * 返回 result（给 AI，详细+含指令）+ userMessage（给前端卡片，简短）+ status。
   */
  /** 执行 MCP 工具调用（委托 McpController） */
  private async runMcpTool(modelToolName: string, args: Record<string, unknown>): Promise<{ result: string; status: "success" | "error"; userMessage?: string }> {
    return this.mcpController.runMcpTool(modelToolName, args);
  }

  /**
   * 本轮请求前的自动压缩门：
   * - 溢出（lastTotalTokens > 窗口，通常是切换到更小窗口模型）→ 强制无感压缩；
   * - 达到窗口 75% → 暂停询问用户「继续压缩 / 迁移到新会话」。
   * @returns true 表示用户选择迁移到新会话、本轮应中止；false 表示可继续本轮。
   */
  private async maybeAutoCompactBeforeTurn(client: OpenAI): Promise<boolean> {
    const ctxWindow = this.getContextWindow();
    const overflowing = this.lastTotalTokens > ctxWindow;
    if (overflowing) {
      // 模型切换溢出：强制无感压缩
      this.isCompacting = true;
      this.send("compacting_start", {});
      try {
        this.send("status", { content: "整理上下文..." });
        this.messages = await compactMessages(this.messages, client, this.model);
        this.isCompacting = false;
        this.lastPromptTokens = 0; // 重置缓存，让 updateAndSendTokenUsage 从压缩后的 messages 重新估算
        this.send("compacting_end", { success: true, message: "切换模型后上下文已自动压缩" });
        this.updateAndSendTokenUsage();
      } catch (err) {
        this.isCompacting = false;
        this.send("compacting_end", { success: false, message: `压缩失败：${(err as Error).message}` });
      }
      return false;
    }
    if (this.lastTotalTokens > 0 && needsCompaction(this.lastTotalTokens, ctxWindow, 0.75)) {
      // >=75% 自动压缩阈值：暂停，让用户选择
      const choice = await this.waitForCompactionChoice(this.lastTotalTokens, ctxWindow);
      if (choice === "continue") {
        // 用户选择继续：压缩当前会话
        this.isCompacting = true;
        this.send("compacting_start", {});
        try {
          this.send("status", { content: "整理上下文..." });
          this.messages = await compactMessages(this.messages, client, this.model);
          this.isCompacting = false;
          this.lastPromptTokens = 0; // 重置缓存，让 updateAndSendTokenUsage 从压缩后的 messages 重新估算
          this.send("compacting_end", { success: true, message: "上下文已压缩" });
          this.updateAndSendTokenUsage();
        } catch (err) {
          this.isCompacting = false;
          this.send("compacting_end", { success: false, message: `压缩失败：${(err as Error).message}` });
        }
        return false;
      }
      // 用户选择迁移到新会话：handleCompactionChoice 已压缩并存储迁移数据，通知前端并中止本轮
      this.send("compaction_migrated", { migratedToNewSession: true });
      return true;
    }
    return false;
  }

  /**
   * 按工具类型分发单次工具执行。重复调用拦截 / 子 Agent 委托 / 并行编排 / Relay 工具 /
   * 命令信任门 / MCP / 通用工具，各分支统一产出 result + status；meta 按引用填充（userMessage 等）。
   * @returns result/status/commandWasEdited，以及实际执行所用的 toolArgs（命令可能被用户编辑）。
   */
  private async dispatchToolCall(
    toolName: string,
    toolArgs: Record<string, unknown>,
    toolCallId: string,
    verdict: { allowed: boolean; message?: string },
    meta: ToolMeta,
    guard: LoopGuard,
  ): Promise<{ result: string; status: "success" | "error"; commandWasEdited?: string; toolArgs: Record<string, unknown> }> {
    let result = "";
    let status: "success" | "error" = "success";
    let commandWasEdited: string | undefined; // execute_command 专用：用户编辑后的命令（仅注入 AI 上下文，不渲染给前端）

    if (!verdict.allowed) {
      // 检测到鬼打墙：拿一模一样的参数反复调同一个工具。不再执行，直接回引导
      result = verdict.message || "调用被拦截。";
      status = "error";
    } else if (toolName === ToolName.DelegateTask) {
      // 委托子 agent：不走通用 executeToolCall，由 AgentSession 特殊处理（隔离执行 + 事件包装）
      try {
        result = await this.runDelegateTask(toolArgs, toolCallId);
      } catch (err) {
        result = `委托子 Agent 失败: ${(err as Error).message}`;
        status = "error";
      }
    } else if (toolName === ToolName.ParallelResearch) {
      // 并行调研：派发多个只读子 agent 并发执行，聚合结论
      try {
        result = await this.runParallelResearch(toolArgs, toolCallId);
      } catch (err) {
        result = `并行调研失败: ${(err as Error).message}`;
        status = "error";
      }
    } else if (toolName === ToolName.ParallelExecute) {
      // 并行执行：派发多个子 agent 并发执行写任务（文件分区隔离）
      try {
        result = await this.runParallelExecution(toolArgs, toolCallId);
      } catch (err) {
        result = `并行执行失败: ${(err as Error).message}`;
        status = "error";
      }
    } else if (toolName === ToolName.RelayCreate || toolName === ToolName.RelaySaveDoc || toolName === ToolName.RelayAdvance || toolName === ToolName.RelayUpdateTask || toolName === ToolName.RelayReviewTask) {
      // Relay 工作流工具：由 AgentSession 管理状态机与落盘
      try {
        if (toolName === ToolName.RelayCreate) {
          // 确认门：relay_create 需要用户确认后才执行
          const confirmed = await this.waitForToolConfirmation(toolName, toolArgs);
          if (!confirmed) {
            result = "用户拒绝创建 Relay 工作流。请直接在本次对话中解决问题，不使用 Relay 长任务工作流。可以正常使用工具（读文件、写代码、执行命令等），只是不走 Relay 的分阶段流程。";
            meta.userMessage = "用户跳过了 Relay 创建";
            status = "error";
          } else {
            result = await this.runRelayCreate(toolArgs);
          }
        }
        else if (toolName === ToolName.RelaySaveDoc) result = await this.runRelaySaveDoc(toolArgs);
        else if (toolName === ToolName.RelayAdvance) result = await this.runRelayAdvance(toolArgs);
        else if (toolName === ToolName.RelayUpdateTask) result = await this.runRelayUpdateTask(toolArgs);
        else result = await this.runRelayReviewTask(toolArgs);
      } catch (err) {
        result = `Relay 操作失败: ${(err as Error).message}`;
        status = "error";
      }
    } else if (toolName === ToolName.ExecuteCommand || toolName === ToolName.StartProcess) {
      // 命令信任门：灾难硬拦 → 白名单 → 未信任则弹三档授权（execute_command 与 start_process 共用同一 gate）
      const command = String((toolArgs as { command?: unknown }).command ?? "");
      const outcome = await this.gateCommand(command, toolCallId);
      if (!outcome.allow) {
        result = outcome.aiMessage || "命令未执行。";
        if (outcome.userMessage) meta.userMessage = outcome.userMessage;
        status = "error";
      } else {
        // 用户编辑了命令：用编辑后的版本执行，但【不改写】AI 自己的 tool_call（保留它真实的原始意图），
        // "命令被用户改过"这件事只通过工具结果（aiHint）告知 AI，避免它看到自己消息被篡改而困惑。
        if (outcome.editedCommand) commandWasEdited = outcome.editedCommand;
        const execArgs = outcome.editedCommand
          ? { ...toolArgs, command: outcome.editedCommand }
          : toolArgs;
        if (outcome.editedCommand) toolArgs = execArgs; // 仅用于 tool_result 事件展示实际执行的命令
        try {
          result = await executeToolCall(toolName, execArgs, this.cwd, this.host, meta, this.workspaces, this.loadSkillForTool, this.web, this.loadPowerForTool, this.abortController?.signal);
          // 同步终端工作目录（后续命令不传 cwd 时默认在此执行）
          this.trackTerminalCwd(toolName, execArgs, meta);
        } catch (err) {
          const error = err as Error;
          result = `错误: ${error.message}`;
          status = "error";
          if (error.name === "ToolError" && (error as ToolError).userMessage && !meta.userMessage) {
            meta.userMessage = (error as ToolError).userMessage;
          }
        }
      }
    } else if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      // MCP 工具：经审批门后路由到对应 server（autoApprove 命中则免确认）
      const out = await this.runMcpTool(toolName, toolArgs);
      result = out.result;
      status = out.status;
      if (out.userMessage) meta.userMessage = out.userMessage; // 给前端卡片的简短文案（区别于给 AI 的详细 result）
    } else {
      // 通用工具执行：在写文件工具执行前创建快照（问答模式不做快照）
      if (this.mode !== "quest" && SNAPSHOT_TOOLS.has(toolName)) {
        const filesToSnapshot = await extractTargetFiles(toolName, toolArgs, this.cwd, this.host, this.workspaces);
        if (filesToSnapshot.length > 0) {
          const turnId = `turn-${this.turnCount}`;
          const created = await this.snapshotMgr.beforeEdit(turnId, filesToSnapshot).catch(() => false);
          // 快照创建成功 → 主动推送新列表给前端（无需用户手动刷新）
          if (created) {
            const snapshots = await this.snapshotMgr.list().catch(() => []);
            this.send("snapshots_listed", { snapshots });
          }
        }
      }
      try {
        result = await executeToolCall(toolName, toolArgs, this.cwd, this.host, meta, this.workspaces, this.loadSkillForTool, this.web, this.loadPowerForTool, this.abortController?.signal);
        this.trackTerminalCwd(toolName, toolArgs, meta);
        // 反复零碎读同一文件检测：超过阈值时追加提示，引导模型用已读内容而非继续切片重读
        if (toolName === "read_file" && typeof toolArgs.path === "string") {
          result += guard.noteFileRead(toolArgs.path);
        }
      } catch (err) {
        const error = err as Error;
        result = `错误: ${error.message}`;
        status = "error";
        // ToolError 携带给用户的简短文案：兜底写入 meta（工具内部通常已写，这里防漏）
        if (error.name === "ToolError" && (error as ToolError).userMessage && !meta.userMessage) {
          meta.userMessage = (error as ToolError).userMessage;
        }
      }
    }

    return { result, status, commandWasEdited, toolArgs };
  }

  /**
   * 正常收尾：把最终 assistant 回复（含 turnStats）落盘、推 stream_end、裁剪旧工具结果、
   * 按阈值异步触发滚动摘要。仅在"本轮无工具调用且确定为最终回复"时调用，调用后即结束本轮。
   */
  private finalizeAssistantReply(contentBuffer: string, turnStartTime: number, streamedContentThisRound: string, rounds: number): void {
    const elapsed = Date.now() - turnStartTime;
    const turnTokens = this.lastTurnTokens || contentBuffer.length;
    // Credits 计算：请求级四段加权（记忆/system/本次输入/输出），见 credits.ts
    // outputTokens：优先用 API 返回的真实值，没有时用流式内容 + 工具调用参数的字符数估算
    const realOutput = this.lastTurnOutputTokens || this.lastCompletionTokens;
    const estimatedOutput = realOutput > 0 ? realOutput : Math.ceil((contentBuffer.length + streamedContentThisRound.length) * 0.4);
    const breakdown = { ...this.buildTokenBreakdown(), outputTokens: estimatedOutput };
    const credits = calculateCredits(this.model, breakdown);
    const creditDetail = buildCreditDetail(this.model, breakdown);
    this.messages.push({ role: "assistant", content: contentBuffer, turnStats: { elapsed, tokens: turnTokens, model: this.model, credits, creditDetail } } as any);
    this.persistMessages(); // 最终回复落盘，切走也保留
    console.debug("[stream] Turn 结束，总耗时:", elapsed, "ms");
    console.debug(`[agent-loop] round=${rounds} 分支=正常收尾（stream_end，本轮结束对话）`);
    // 本轮真实 token（拿不到 usage 时回退到字符数估算）
    this.send("stream_end", { elapsed, tokens: turnTokens, model: this.model, credits, creditDetail });
    // 本轮结束：裁剪旧 tool 结果，控制上下文体积增长（每轮都做，用户无感）
    this.messages = pruneOldToolResults(this.messages, this.compactionConfig.toolResultKeepTurns);
    this.persistMessages();

    // 滚动摘要：累计 token 超阈值 → 异步触发（不阻塞用户发下一条）
    this.rollingSummaryAccumulated += turnTokens;
    if (this.rollingSummaryAccumulated >= this.compactionConfig.triggerTokens) {
      this.maybeRollingSummary();
    }
  }

  /**
   * 记录单次工具执行结果：软失败计数/隐藏卡片、编辑工具连续失败落盘控制、改动文件追踪、
   * 发 tool_call(补发)/tool_result 事件、按类型截断后写入对话历史、截图收集、待确认列表同步。
   * @param mutatedFiles 就地填充本轮改动过的文件路径
   * @returns mutated/diagnosed：本次是否产生了文件改动 / 是否执行了 check_diagnostics（供调用方累计 didMutate/didDiagnose）
   */
  private recordToolOutcome(
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    result: string,
    status: "success" | "error",
    commandWasEdited: string | undefined,
    meta: ToolMeta,
    displayCwd: string,
    guard: LoopGuard,
    mutatedFiles: Set<string>,
  ): { mutated: boolean; diagnosed: boolean } {
    let mutated = false;
    let diagnosed = false;

    // 连续失败计数：失败累加，成功归零。str_replace 未匹配/参数非法等"软失败"不计入
    // （错误返回里带了实际内容/行号，模型据此重试是正常纠错，不应被过早掐断）
    const softFail = status === "error" && isSoftToolFailure(toolName, result);
    guard.recordToolResult(status !== "error", softFail, { toolName, args: toolArgs });

    // 编辑工具失败：不展示卡片也不落盘。
    // str_replace / create_file / apply_patch 的错误信息只是给 AI 的纠错反馈，
    // 用户不需要看到（前端由 hidden 控制不展示，sessionHub 由 _transient 控制不落盘）。
    const isEditError = status === "error" && EDIT_PERSIST_TOOLS.has(toolName);
    if (isEditError) {
      meta.hidden = true;
      if (meta.userMessage) delete meta.userMessage;
      (this as any).__markNextAsTransient = true;
    }

    // 手动模式下文件改动是否进入了暂存（待确认）
    const isPending = this.host.edits.getMode() === "manual" && (toolName === ToolName.StrReplace || toolName === ToolName.CreateFile || toolName === ToolName.ApplyPatch) && status === "success";
    // 记录本轮是否有过实质文件改动（仅 str_replace/create_file/apply_patch 成功才算）。
    // execute_command 不计入——跑命令看输出是验证/查看行为，不是"改动"。
    if (status === "success" && (toolName === ToolName.StrReplace || toolName === ToolName.CreateFile || toolName === ToolName.ApplyPatch)) {
      mutated = true;
      // apply_patch 可能改多个文件：优先用 fileDiffs 收集全部改动路径
      const diffs = meta.fileDiffs && meta.fileDiffs.length > 0 ? meta.fileDiffs : (meta.fileDiff ? [meta.fileDiff] : []);
      for (const d of diffs) {
        if (d.path) mutatedFiles.add(d.path);
      }
    }
    // 执行中的 relay 任务：记录本任务改动过的文件（供两阶段评审定位改动点）
    if (status === "success" && this.activeRelayTask) {
      const diffs = meta.fileDiffs && meta.fileDiffs.length > 0 ? meta.fileDiffs : (meta.fileDiff ? [meta.fileDiff] : []);
      for (const d of diffs) {
        if (d.path) this.activeRelayTask.changedFiles.add(d.path);
      }
    }
    if (status === "success" && toolName === ToolName.CheckDiagnostics) {
      diagnosed = true;
    }
    // 软失败工具延迟展示：成功前不发 tool_call，现在确认可见才补发
    if (SOFT_FAIL_TOOLS.has(toolName) && !meta.hidden) {
      this.send("tool_call", { id: toolCallId, name: toolName, args: toolArgs, cwd: displayCwd, status: ToolCallStatus.Success, ...this.mcpMetaFor(toolName) });
    }
    this.send("tool_result", { id: toolCallId, name: toolName, args: toolArgs, result: result.slice(0, 500), status, fileDiff: meta.fileDiff, fileDiffs: meta.fileDiffs, readRange: meta.readRange, diagnostics: meta.diagnostics, searchResults: (meta as any).searchResults, fetchResult: (meta as any).fetchResult, powerActivated: (meta as any).powerActivated, pending: isPending, userMessage: meta.userMessage, hidden: meta.hidden, resolvedPath: (meta as any).resolvedPath, ...this.mcpMetaFor(toolName) });
    // 存入历史时按工具类型截断：read_file/web_fetch 给大预算（避免模型分页重读），
    // search/list_dir 中等，其余较小。模型在本轮已看过完整内容，后续轮次只需够用的记忆。
    const maxToolContent = toolContentLimit(toolName);
    // 用户编辑了命令时，aiHint 仅注入 AI 上下文：明确"你请求的命令被用户改了"，叙事一致不困惑
    const aiHint = commandWasEdited
      ? `[系统提示：用户在审批环节将你请求的命令手动改为 "${commandWasEdited}" 并执行。这是用户的正常操作（不是你的错误），以下输出来自实际执行的 "${commandWasEdited}"。请据此继续，不要重试、不要道歉。]\n`
      : "";
    const contentForAI = aiHint + result;
    const storedResult = contentForAI.length > maxToolContent
      ? contentForAI.slice(0, maxToolContent) + `\n\n[内容已截断，原始长度 ${result.length} 字符。如需更多内容，请用更大的行范围一次性读取，不要分多次零碎读取]`
      : contentForAI;
    this.messages.push({ role: "tool", tool_call_id: toolCallId, _toolName: toolName, content: storedResult, displayContent: commandWasEdited ? result : undefined, displayCommand: commandWasEdited || undefined, status, fileDiff: meta.fileDiff, fileDiffs: meta.fileDiffs, readRange: meta.readRange, diagnostics: meta.diagnostics, searchResults: (meta as any).searchResults, fetchResult: (meta as any).fetchResult, powerActivated: (meta as any).powerActivated, pending: isPending, userMessage: meta.userMessage, ...this.mcpMetaFor(toolName) } as any);
    // 标记编辑工具连续软失败（在阈值内）为 transient，不落盘
    if ((this as any).__markNextAsTransient) {
      (this as any).__markNextAsTransient = false;
      (this.messages[this.messages.length - 1] as any)._transient = true;
    }
    // screenshot_page：收集截图 URL，等所有 tool 结果都 push 完后再统一追加 user 图片消息
    if (meta.screenshotDataUrl) {
      ((this as any).__pendingScreenshots ??= []).push(meta.screenshotDataUrl);
    }
    // 同步当前待确认/可撤销列表给前端
    if (isPending) {
      this.sendEditsUpdated();
      this.onPendingChanged?.();
    } else if (status === "success" && (toolName === ToolName.StrReplace || toolName === ToolName.CreateFile || toolName === ToolName.ApplyPatch)) {
      // auto 模式下编辑已落盘并记入 undoable，但前端还不知道 → 补发一次，让工具卡片显示撤销图标
      this.sendEditsUpdated();
    }

    return { mutated, diagnosed };
  }

  /**
   * 处理"本轮无工具调用"的情形——这是候选最终回复，但需先排除几类异常：
   * 1) 输出被 max_tokens 截断 → 注入续写引导，回到下一轮；
   * 2) 未完成的"内心 OS"（英文思考片段）→ 注入纠正引导（超重试上限则强制收尾引导），回到下一轮；
   * 3) 空回复兜底（finish=stop 但内容为空）→ 注入重说引导，回到下一轮（最多 1 次）；
   * 4) 改过文件但未诊断 → 自动跑一次 diagnostics，有错则注入修复引导回到下一轮；
   * 5) 以上都不命中 → 正常收尾（finalizeAssistantReply）。
   * @returns "continue"=已注入引导、应进入下一轮；"done"=已正常收尾、本轮结束。
   */
  private async handleNoToolCallTurn(
    contentBuffer: string,
    finishReason: string | null | undefined,
    guard: LoopGuard,
    ts: TurnState,
    mutatedFiles: Set<string>,
    turnStartTime: number,
    streamedContentThisRound: string,
    rounds: number,
  ): Promise<"continue" | "done"> {
    // 根源处理 1：输出被 max_tokens 截断（finish_reason=length）→ 让模型接着写，而不是把半截内容当成最终答案
    if (finishReason === "length" && contentBuffer) {
      console.log("[agent] 输出被截断（length），注入续写引导");
      this.messages.push({ role: "assistant", content: contentBuffer });
      this.messages.push({
        role: "system",
        content: "你上一段输出因长度限制被截断了。请直接接着把剩余内容补完，不要重复已经说过的部分，也不要重新开头。",
      });
      return "continue";
    }

    if (looksLikeIncompleteReply(contentBuffer)) {
      const exceeded = guard.noteIncompleteRetry();
      // 超过重试上限：不再续写，避免模型反复吐内心 OS 陷入死循环，转为强制收尾
      if (exceeded) {
        console.log("[agent] reasoning 泄露续写已达上限，强制收尾");
        this.messages.push({ role: "assistant", content: contentBuffer });
        this.messages.push({
          role: "system",
          content: "你已多次输出未完成的内心 OS。现在必须基于已有信息，要么调用一个具体工具继续推进，要么给出完整的中文最终回答。二选一，不要再输出任何英文思考片段。",
        });
        return "continue";
      }
      // 把这次半成品记入历史，注入引导，让下一轮纠正
      console.log("[agent] 检测到未完成回复，注入引导让模型重新生成:", JSON.stringify(contentBuffer.slice(0, 100)));
      this.messages.push({ role: "assistant", content: contentBuffer });
      this.messages.push({
        role: "system",
        content:
          `你刚才输出的是内心思考（英文片段或"我还需要看 X"这类），不是给用户的回复。这种内容绝对不能作为一轮的结束。\n` +
          `现在立即二选一：\n` +
          `1. 如果还需要信息 → 直接调用对应工具（read_file/search 等），不要用文字描述"我需要看 X"\n` +
          `2. 如果信息已够 → 给出完整、结构化的中文最终回答\n` +
          `不要再输出任何英文思考片段或过渡句。`,
      });
      return "continue";
    }
    // 完成前自检：已关闭（速度优先，避免 DeepSeek 等模型多跑一轮验证）。
    ts.didSelfCheck = true; // 跳过自检轮
    // 空回复兜底：模型声称结束（finish=stop、无工具调用）但内容为空，
    // 这通常是 API 侧偶发的 SSE 异常（output item 未产出）。不要给用户显示空白——
    // 注入引导让模型重新生成一次回复。最多重试 1 次，防无限循环。
    if (!contentBuffer && !ts.emptyRetried) {
      console.debug(`[agent-loop] round=${rounds} 空回复兜底：content 为空但 finish=stop，注入重说引导`);
      ts.emptyRetried = true;
      this.messages.push({
        role: "system",
        content: "你上一轮的回复内容为空（可能是网络波动）。请直接给出你的中文回答，不要调工具。",
      });
      return "continue";
    }
    // 自动语法检查：改了文件且模型没主动调过 check_diagnostics → 代码层自动跑一次。
    // 有错误时注入系统消息让模型修复（不收尾），无错误则正常收尾。
    // 这样不靠模型"记得调 check"，代码确保每次改文件后都有语法检查。
    if (ts.didMutate && !ts.didDiagnose && mutatedFiles.size > 0) {
      ts.didDiagnose = true; // 只跑一次
      const { resolve: resolvePath } = require("node:path");
      const absPaths = [...mutatedFiles].map((p) => resolvePath(this.cwd, p));
      try {
        const diagResults = await this.host.diagnostics.check(this.cwd, absPaths);
        const hasErrors = diagResults.some((r) => !r.ok);
        if (hasErrors) {
          // 有语法/类型错误：把结果告诉模型，让它修复后再给最终回复
          const errSummary = diagResults
            .filter((r) => !r.ok)
            .map((r) => `${r.path}: ${r.details || `${r.errorCount} 个错误`}`)
            .join("\n");
          console.debug(`[agent-loop] 自动 diagnostics 发现错误，注入修复引导`);
          this.messages.push({ role: "assistant", content: contentBuffer });
          const okFiles = diagResults.filter((r) => r.ok).map((r) => r.path);
          const okNote = okFiles.length > 0 ? `\n（已检查通过：${okFiles.join("、")}）` : "";
          this.messages.push({
            role: "system",
            content:
              `⚠️ 自动语法检查：你改动的文件中有错误。你必须修复它们。\n${errSummary}${okNote}\n\n` +
              `用 str_replace 逐个修复后，再次调 check_diagnostics 确认全部无错。全部通过后再给用户最终回答。`,
          });
          return "continue";
        }
      } catch {
        // diagnostics 执行失败（如文件已删除），不阻塞正常收尾
      }
    }
    this.finalizeAssistantReply(contentBuffer, turnStartTime, streamedContentThisRound, rounds);
    return "done";
  }

  /**
   * 增强渲染代码块输出时的动态进度提示。根据已输出的流式内容判断：
   * - 检测到代码块开始标记 → "正在绘制 X..."（X=流程图/序列图/SVG 图形/页面原型）
   * - 内容增长到一定量 → "正在添加细节..."
   * - 接近结束（检测到闭合标记） → 回到"正在回复..."
   * 避免每个 chunk 都发状态（节流：只在阶段切换时发一次）。
   */
  private _drawingPhase: "none" | "started" | "detail" = "none";
  private updateDrawingStatus(content: string): void {
    // 检测是否在增强代码块内（已开始但未闭合）
    const openMatch = content.match(/```(svg|mermaid|html)\s*\n/);
    if (!openMatch) {
      if (this._drawingPhase !== "none") {
        this._drawingPhase = "none";
        this.send("status", { content: "正在回复...", phase: "responding" });
      }
      return;
    }
    const lang = openMatch[1];
    const afterOpen = content.slice(content.indexOf(openMatch[0]) + openMatch[0].length);
    // 已闭合（出现独立行的 ```）→ 图形完成，恢复"正在回复..."
    if (/\n```\s*(\n|$)/.test(afterOpen)) {
      if (this._drawingPhase !== "none") {
        this._drawingPhase = "none";
        this.send("status", { content: "正在回复...", phase: "responding" });
      }
      return;
    }
    // 正在输出代码块内容
    const blockLen = afterOpen.length;
    if (this._drawingPhase === "none") {
      // 刚进入代码块 → 发具体的"正在绘制 X..."
      this._drawingPhase = "started";
      let label: string;
      if (lang === "svg") label = "正在绘制 SVG 图形...";
      else if (lang === "html") label = "正在构建页面原型...";
      else {
        // mermaid：根据前几行判断图表类型
        const head = afterOpen.slice(0, 80).toLowerCase();
        if (/sequencediagram/i.test(head)) label = "正在绘制序列图...";
        else if (/statedragram|statediagram/i.test(head)) label = "正在绘制状态图...";
        else if (/classdiagram/i.test(head)) label = "正在绘制类图...";
        else if (/erdiagram/i.test(head)) label = "正在绘制 ER 图...";
        else if (/gantt/i.test(head)) label = "正在绘制甘特图...";
        else if (/pie/i.test(head)) label = "正在绘制饼图...";
        else label = "正在绘制流程图...";
      }
      this.send("status", { content: label, phase: "responding" });
    } else if (this._drawingPhase === "started" && blockLen > 300) {
      // 内容已输出 300+ 字符 → 进入"细节"阶段
      this._drawingPhase = "detail";
      this.send("status", { content: "正在添加细节...", phase: "responding" });
    }
  }

  /** 处理用户输入，执行 Agent 循环 */
  async handleUserInput(
    input: string,
    model?: string,
    images?: string[],
    provider?: string,
    userMeta?: { displayText?: string; attachedFiles?: { name: string; size: number }[]; replyStyle?: string; userSegments?: unknown[] },
  ): Promise<void> {
    this.turnCount++;
    // 动态切换模型和 provider
    if (model && model !== this.model) {
      this.model = model;
    }
    if (provider && provider !== this.provider) {
      this.provider = provider;
    }
    // 更新回复风格（会话级，影响后续所有请求）
    if (userMeta?.replyStyle) {
      this.replyStyle = userMeta.replyStyle;
    }

    // 保存本轮用户输入（压缩迁移时需要在新会话中重放）
    this.lastUserInput = { content: input, model, images, provider, userMeta: userMeta as Record<string, unknown> | undefined };

    const client = getClient(this.provider, this.model);
    const strategy = getStrategy(this.provider, this.model);
    const turnStartTime = Date.now();
    this.abortController = new AbortController();
    this.cancelled = false; // 新一轮用户输入，重置取消标志
    this.lastSubAgentTokens = 0; // 新一轮用户输入，重置本轮 subagent 用量统计
    this.lastTurnOutputTokens = 0; // 新一轮用户输入，重置本轮输出 token 累计
    this.turnStartCumulative = this.cumulativeTokens; // 取消时用差值复原本轮消耗
    // 记录本轮开始前的消息条数（此刻 messages 仅含 system + 之前会话，尚未 push 本轮用户消息）。
    // 用它在收尾时切出"本轮新增的消息"（用户消息 + 工具结果），据此估算"本次输入"。
    this.turnStartMsgCount = this.messages.length;
    this.relayAdvancedThisTurn = false; // 新一轮用户输入，重置 Relay 阶段推进闸（确认门：一轮最多推进一个阶段）

    // 附件元数据（文件名/大小）挂到消息上，用于历史展示。displayText 为 UI 展示正文（不含拼接的文件内容）
    const userExtra: Record<string, unknown> = {};
    if (userMeta?.displayText !== undefined) userExtra.displayText = userMeta.displayText;
    if (userMeta?.attachedFiles && userMeta.attachedFiles.length > 0) userExtra.attachedFiles = userMeta.attachedFiles;
    if (userMeta?.userSegments && userMeta.userSegments.length > 0) userExtra.userSegments = userMeta.userSegments;

    // 构建用户消息（支持多模态：文字 + 图片）
    if (images && images.length > 0) {
      const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
      if (input) {
        content.push({ type: "text", text: input });
      }
      for (const img of images) {
        content.push({ type: "image_url", image_url: { url: img } });
      }
      this.messages.push({ role: "user", content: content as any, timestamp: Date.now(), ...userExtra } as any);
    } else {
      this.messages.push({ role: "user", content: input, timestamp: Date.now(), ...userExtra } as any);
    }

    // 用户消息立即落盘：即便随后切走会话/连接断开，这条提问也不会丢
    this.persistMessages();

    // 自动压缩（溢出强制无感 / 达 75% 阈值询问用户）；用户选择迁移到新会话时本轮中止
    if (await this.maybeAutoCompactBeforeTurn(client)) return;

    this.send("status", { content: "思考中...", phase: "thinking" });

    // 预取 IDE 上下文 / skill / power / MCP —— 它们之间无依赖，并行拉取以缩短首字延迟
    const [ideCtx, skillsPrompt, powersPrompt] = await Promise.all([
      this.promptBuilder.buildIdeContextPrompt().catch((e) => { console.warn("[ide-ctx] 预取失败（忽略）:", (e as Error).message); return null; }),
      this.skillRegistry.buildSkillsPrompt().catch((e) => { console.warn("[skill] 发现 skill 失败（忽略）:", (e as Error).message); return null; }),
      this.powerRegistry ? this.powerRegistry.buildPowersPrompt().catch((e) => { console.warn("[power] 发现 power 失败（忽略）:", (e as Error).message); return null; }) : Promise.resolve(null),
    ]);
    this.ideContextCache = ideCtx;
    this.skillsPromptCache = skillsPrompt;
    this.powersPromptCache = powersPrompt;

    // 预取 MCP 工具：解析配置 → 连接 server → 拉工具清单，并入本轮工具集（失败不阻塞）
    await this.prefetchMcpTools();

    // Agent 循环：总轮数上限只作极端兜底（正常任务很难碰到），真正防死循环靠"相同调用重复检测"
    let rounds = 0;
    const policy = policyForModel(this.model);
    const MAX_ROUNDS = policy.maxRounds;
    // 防失控守卫：重复调用指纹、文件重复读、连续失败计数、reasoning 续写计数统一收敛到 LoopGuard，
    // 与子 agent 共用同一实现，阈值随模型族而定
    const guard = new LoopGuard(policy);
    // 完成前自检：本轮跨回合可变状态（实质改动/已自检/空回复已重试/已诊断），
    // 收敛到一个对象，便于整体传给"无工具调用收尾处理"方法。
    const ts: TurnState = { didMutate: false, didSelfCheck: false, emptyRetried: false, didDiagnose: false };
    // 记录本轮改动过的文件路径（用于正常收尾前自动跑 diagnostics）
    const mutatedFiles = new Set<string>();

    // 双总结抑制已移除：之前在流式输出时做前缀去重会导致中间内容丢失（前缀匹配到的部分
    // 被吞掉不推前端，但持久化的 messages 里有完整内容，reload 后才显示——体验不一致）。
    // 改为纯靠提示词约束（自检引导里"不要重复上面的内容"），不在流式层面吞字。

    // 追踪当前轮已流式输出的文字（用于取消时持久化已产出内容，不丢失）
    let streamedContentThisRound = "";

    try {
    while (rounds < MAX_ROUNDS) {
      rounds++;
      streamedContentThisRound = ""; // 每轮重置
      this._drawingPhase = "none"; // 重置绘图状态追踪

      // 每轮开始检查取消：用户点取消后立即停止，不再调 LLM
      if (this.cancelled) {
        this.stampCancelledTurnStats(turnStartTime, streamedContentThisRound);
        return;
      }

      // 通过策略执行一个回合（策略负责调 API + 解析流式响应，产出标准化结果）
      // 每轮独立：本轮是否已发 stream_start（控制打字机启动）
      let turnStreamStarted = false;
      let reasoningStarted = false;
      let reasoningChars = 0;
      const callbacks: LLMStreamCallbacks = {
        onReasoningDelta: (text) => {
          // 思考过程：推送给前端展示，不持久化到消息历史
          // Quest 模式且未开启「思考」开关时，不转发 reasoning（前端也就不展示思考过程）
          if (this.mode === "quest" && !this.questThink) return;
          // 细化状态提示：首次 reasoning chunk → "深度思考中..."；累计一定量后若含图形关键词 → "正在构思图形..."
          if (!reasoningStarted) {
            reasoningStarted = true;
            this.send("status", { content: "深度思考中...", phase: "thinking" });
          }
          reasoningChars += text.length;
          if (reasoningChars > 200 && reasoningChars - text.length <= 200) {
            // 超过 200 字符的长思考，检测是否在构思图形/代码
            const snippet = text.toLowerCase();
            if (/svg|mermaid|graph|diagram|flowchart|画|图/.test(snippet)) {
              this.send("status", { content: "正在构思图形...", phase: "thinking" });
            }
          }
          this.send("reasoning_delta", { content: text });
        },
        onTextDelta: (text) => {
          if (!turnStreamStarted) {
            console.log("[stream] 首个 chunk 到达，耗时:", Date.now() - turnStartTime, "ms");
            this.send("stream_start", {});
            this.send("status", { content: "正在回复...", phase: "responding" });
            turnStreamStarted = true;
          }
          streamedContentThisRound += text;
          // 增强渲染代码块进度提示：根据已输出内容动态细化状态
          this.updateDrawingStatus(streamedContentThisRound);
          this.send("stream_delta", { content: text });
        },
        onToolCallDetected: (name, id) => {
          console.log(`[stream] tool detected: ${name} id=${id}`);
          // ⚠️ 不在这里发 tool_call(pending)！
          // onToolCallDetected 在流式输出阶段被调用，此时 LLM 可能一次返回多个 tool_calls，
          // 每个都会触发此回调。如果在这里全发 pending 卡片，用户会同时看到 N 张"准备执行"卡片，
          // 而后端实际还在串行执行第一个。pending 卡片改到串行执行循环中按序发送。
          // delegate_task / parallel_execute / parallel_research 有专门的 sub_agent 卡片，也跳过。
          if (name === "delegate_task" || name === "parallel_execute" || name === "parallel_research") return;
          // 仅记录检测到工具，不发事件（pending 事件在执行循环中发）
        },
      };

      const turn = await strategy.runTurn({
        model: this.model,
        messages: this.promptBuilder.buildRequestMessages(),
        tools: this.getToolDefs(),
        signal: this.abortController?.signal,
        callbacks,
        temperature: 0.2,
      });

      let contentBuffer = turn.content;
      const toolCalls = turn.toolCalls;
      const finishReason = turn.finishReason;

      // ── 循环诊断日志 ──（排查"不收尾/空转"：每轮打印一行摘要，复现一次即可看清卡在哪）
      console.debug(
        `[agent-loop] round=${rounds}/${MAX_ROUNDS} model=${this.model} ` +
        `toolCalls=${toolCalls.length}${toolCalls.length ? "(" + toolCalls.map((t) => t.name).join(",") + ")" : ""} ` +
        `finish=${finishReason} contentLen=${(contentBuffer || "").length} ` +
        `didMutate=${ts.didMutate} didSelfCheck=${ts.didSelfCheck} didDiagnose=${ts.didDiagnose} ` +
        `failures=${guard.failures} pendingManual=${this.host.edits.getMode() === "manual" && this.host.edits.hasPending()}` +
        ((contentBuffer || "").length ? ` head=${JSON.stringify((contentBuffer || "").slice(0, 60))}` : ""),
      );

      // 记录本回合 API 返回的真实 token 用量（用于精确驱动压缩与进度条）
      this.recordTurnUsage(turn.usage);

      // 推送 token 用量
      if (contentBuffer) {
        this.updateAndSendTokenUsage();
      }

      // 无工具调用 → 候选最终回复。交由专门方法处理（截断续写 / 内心 OS 重试 / 空回复兜底 /
      // 自动诊断 / 正常收尾），返回 "continue"=进入下一轮，"done"=本轮结束。
      if (toolCalls.length === 0) {
        const outcome = await this.handleNoToolCallTurn(contentBuffer, finishReason, guard, ts, mutatedFiles, turnStartTime, streamedContentThisRound, rounds);
        if (outcome === "done") return;
        continue;
      }

      // 有工具调用 → 如果之前有流式文字，先发 stream_pause 告知前端文字暂停
      if (turnStreamStarted && contentBuffer) {
        // 先无条件通知前端 flush 打字机 buffer（避免前端丢字），
        // 然后再判断是否为 reasoning 泄露（决定是否持久化）。
        this.send("stream_pause", {});
        if (looksLikeIncompleteReply(contentBuffer)) {
          console.debug("[agent] 过滤工具调用间的 reasoning 泄露:", JSON.stringify(contentBuffer.slice(0, 60)));
          contentBuffer = "";
        }
      }

      // 记录 assistant 消息并执行工具
      const assistantMsg = {
        role: "assistant" as const,
        content: contentBuffer || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
      this.messages.push(assistantMsg);

      for (const toolCall of toolCalls) {
        const toolName = toolCall.name;
        // 多工具串行执行时，让前端有时间渲染上一个工具的终态卡片。
        // 不加间隔时，多个 tool_call/tool_result 事件在同一 microtask batch 到达前端，
        // React 批量 setState 导致多个卡片"同时弹出"，用户无法看清顺序。
        // setTimeout(0) 让事件循环刷新一次，确保前端的 postMessage 已被处理。
        if (toolCalls.length > 1) {
          await new Promise<void>((r) => setTimeout(r, 0));
        }
        // 健壮解析参数：模型偶尔生成非法 JSON（如未转义的 Windows 路径反斜杠），
        // 不能让整轮崩掉。解析失败时当作"该工具调用失败"，反馈给模型重写。
        let toolArgs: Record<string, unknown>;
        try {
          toolArgs = parseToolArguments(toolCall.arguments);
        } catch (parseErr) {
          let errMsg = (parseErr as Error).message;
          // 如果 create_file / str_replace 连续 JSON 解析失败（同名工具第 2 次以上），
          // 在错误消息里附带降级引导——让模型改用 execute_command 写文件，绕开
          // "把长 HTML/代码完美序列化进 JSON 字符串"这个它做不到的事。
          const jsonFailKey = `json_fail:${toolName}`;
          const jsonFailCount = ((this as any).__jsonFailCounts ??= new Map<string, number>());
          jsonFailCount.set(jsonFailKey, (jsonFailCount.get(jsonFailKey) || 0) + 1);
          if (jsonFailCount.get(jsonFailKey)! >= 2 && (toolName === "create_file" || toolName === "str_replace")) {
            errMsg += `\n\n⚠️ 你已经连续 ${jsonFailCount.get(jsonFailKey)} 次因 JSON 格式问题无法调用 ${toolName}。` +
              `这通常是因为文件内容太长/含大量引号嵌套，你无法在 JSON 字符串里完美序列化它。` +
              `请立即换手段：用 execute_command 执行一个 Node 脚本或 PowerShell 命令来写文件` +
              `（如 node -e "require('fs').writeFileSync('path', content)" 或写临时 .mjs 脚本再执行），` +
              `不要再尝试 ${toolName}——它会继续失败。`;
          }
          this.send("tool_call", { id: toolCall.id, name: toolName, args: {}, cwd: this.cwd, status: ToolCallStatus.Executing });
          this.send("tool_result", { id: toolCall.id, name: toolName, args: {}, result: errMsg, status: ToolCallStatus.Error });
          this.messages.push({ role: "tool", tool_call_id: toolCall.id, _toolName: toolName, content: errMsg, status: "error" } as any);
          guard.recordToolResult(false, true);
          continue;
        }

        // 防御：模型有时生成空参数对象（流式截断/幻觉），直接执行会因缺参数而失败。
        // 提前拦截，反馈给模型重写，比让 executeToolCall 报"缺少必填参数 path"更友好。
        if (this.toolRequiresArguments(toolName) && Object.keys(toolArgs).length === 0) {
          const hint = typeof toolCall.arguments === "string" && toolCall.arguments.trim()
            ? `收到参数原文 "${toolCall.arguments.slice(0, 200)}"`
            : "未收到任何参数（流式输出可能被截断）";
          const errMsg = `${toolName}: 参数为空。${hint}，请重新生成这次调用。`;
          this.send("tool_call", { id: toolCall.id, name: toolName, args: {}, cwd: this.cwd, status: ToolCallStatus.Executing });
          this.send("tool_result", { id: toolCall.id, name: toolName, args: {}, result: errMsg, status: ToolCallStatus.Error, userMessage: "参数缺失" });
          this.messages.push({ role: "tool", tool_call_id: toolCall.id, _toolName: toolName, content: errMsg, status: "error" } as any);
          guard.recordToolResult(false, true);
          continue;
        }

        // 命令类工具：显式 cwd → 解析为绝对路径（AI 可能传相对路径如 "."），否则用会话主工作区
        const displayCwd = (() => {
          if (toolName !== "execute_command" && toolName !== "start_process") return "";
          const argCwd = typeof (toolArgs as { cwd?: unknown }).cwd === "string" && (toolArgs as { cwd: string }).cwd.trim();
          return argCwd ? resolve(this.cwd, argCwd) : this.cwd;
        })();
        // 前 2 次软失败不发 tool_call（不闪卡片），直接发带 hidden 的 tool_result。
        // 第 3 次还是失败才展示，此时发 tool_call + tool_result。
        // 易软失败工具（str_replace/apply_patch/read_file）由 tools/catalog 的 SOFT_FAIL_TOOLS 统一定义。
        if (!SOFT_FAIL_TOOLS.has(toolName)) {
          // 先发 pending（卡片出现），再立即发 executing（更新参数）。
          // 这样卡片严格在串行执行到该工具时才出现，不会提前 N 个同时弹出。
          this.send("tool_call", { id: toolCall.id, name: toolName, args: {}, cwd: displayCwd, status: ToolCallStatus.Pending, ...this.mcpMetaFor(toolName) });
          this.send("tool_call", { id: toolCall.id, name: toolName, args: toolArgs, cwd: displayCwd, status: ToolCallStatus.Executing, ...this.mcpMetaFor(toolName) });
        }

        // 推送细化状态（给前端展示具体动作）
        const toolStatus = statusForTool(toolName);
        this.send("status", toolStatus);

        // 相同调用重复检测：同名工具 + 完全相同参数
        const verdict = guard.checkToolCall(toolName, toolCall.arguments);

        const meta: ToolMeta = { editId: toolCall.id };
        // execute_command：挂上"等待输入"回调——终端检测到静默时通知前端给卡片加呼吸灯
        if (toolName === "execute_command") {
          meta.onWaitingInput = () => this.send("tool_waiting_input", { toolCallId: toolCall.id });
        }
        // 按工具类型分发执行（重复拦截 / 子 Agent / 并行 / Relay / 命令门 / MCP / 通用），meta 按引用被填充
        const dispatched = await this.dispatchToolCall(toolName, toolArgs, toolCall.id, verdict, meta, guard);
        const result = dispatched.result;
        const status = dispatched.status;
        const commandWasEdited = dispatched.commandWasEdited;
        toolArgs = dispatched.toolArgs; // 命令可能被用户编辑过，用实际执行的参数继续后续展示/落盘

        // 记录工具结果：软失败/编辑落盘控制、改动追踪、发事件、写入历史（mutatedFiles 就地填充）
        const rec = this.recordToolOutcome(toolCall.id, toolName, toolArgs, result, status, commandWasEdited, meta, displayCwd, guard, mutatedFiles);
        ts.didMutate = ts.didMutate || rec.mutated;
        ts.didDiagnose = ts.didDiagnose || rec.diagnosed;
      }

      // 所有 tool 结果 push 完毕后,统一追加本轮收集到的截图 user 消息。
      // 必须在 tool 消息全部就位之后——中间插 user 会违反 API "tool_calls → tool messages" 连续性要求导致 400。
      const pendingScreenshots: string[] | undefined = (this as any).__pendingScreenshots;
      if (pendingScreenshots && pendingScreenshots.length > 0) {
        for (const dataUrl of pendingScreenshots) {
          this.messages.push({
            role: "user",
            content: [
              { type: "text", text: "（这是 screenshot_page 截取的当前页面渲染效果，请据此判断布局/样式/内容是否符合预期）" },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
            _screenshotInjection: true,
          } as any);
        }
        (this as any).__pendingScreenshots = [];
      }

      // 工具执行后更新 token 用量（tools 部分会增加）
      this.updateAndSendTokenUsage();
      // 本轮工具结果已并入 messages，增量落盘：即便此刻切走，已完成的工具轮次也不丢
      this.persistMessages();

      // 取消检查：如果用户在工具执行期间取消了（如子 agent 被 abort），主 agent 也应立即停止
      if (this.cancelled) {
        this.stampCancelledTurnStats(turnStartTime, streamedContentThisRound);
        return;
      }

      // 卡住升级阶梯：反思·换路 → 摘要重启 → 投降。在硬投降前，先给模型"理清思路、换条路重来"的机会。
      if (guard.isStuck()) {
        const stuck = guard.getStuckTarget();
        if (guard.canReflect()) {
          console.debug(`[agent] 卡住（${stuck?.key ?? "连续失败"}）→ 反思·换路`);
          await this.injectReflection(stuck, guard);
          continue;
        }
        if (guard.canSummaryRestart()) {
          console.debug(`[agent] 反思仍无效（${stuck?.key ?? "连续失败"}）→ 摘要重启`);
          await this.injectSummaryRestart(stuck, guard, client);
          continue;
        }
        // 阶梯耗尽仍卡住 → 强制收尾投降，让模型如实向用户说明
        console.debug(`[agent] 升级阶梯耗尽，强制中断`);
        this.messages.push({
          role: "system",
          content:
            `你已经多次尝试（包括重新理清思路、换路重来）仍未能完成。请立即停止重试，` +
            `用文字向用户如实说明：你想做什么、卡在哪里、失败的原因，以及你的判断和建议。不要再调用任何工具。`,
        });
        // 让模型基于这条引导生成一段总结性回复
        await this.streamFinalSummary(turnStartTime);
        return;
      }
    }

    // 超过最大轮次：不要静默中断（前端收不到 assistant_message）。
    // 注入引导，让模型基于已收集的信息用文字给出当前结论/下一步，正常收尾。
    if (rounds >= MAX_ROUNDS) {
      console.log(`[agent] 达到最大轮次 ${MAX_ROUNDS}，注入引导收尾`);
      this.messages.push({
        role: "system",
        content:
          `你已经连续调用了 ${MAX_ROUNDS} 轮工具仍未结束。请立即停止调用工具，` +
          `基于目前已经收集到的信息，用中文给用户一个完整的回答：` +
          `说明你已经查到了什么、得出的结论，如果任务尚未彻底完成，说明还差哪一步、建议怎么做。不要再调用任何工具。`,
      } as any);
      await this.streamFinalSummary(turnStartTime);
      return;
    }
    } catch (err) {
      const error = err as Error;
      if (error.name === "AbortError" || error.message?.includes("aborted") || this.cancelled) {
        this.stampCancelledTurnStats(turnStartTime, streamedContentThisRound);
        throw err; // 继续上抛让外层 persistOnCancel 处理
      }
      // 非取消异常（LLM 403/网络错误等）：推送错误到前端——确保 stream_start 先于 stream_delta，
      // 否则前端会因缺少 stream_start 而丢弃 stream_delta，导致用户看不到错误
      const errMsg = `❌ 出错了: ${error.message}`;
      this.messages.push({ role: "assistant", content: errMsg } as any);
      if (!streamedContentThisRound) {
        this.send("stream_start", {});
      }
      this.send("stream_delta", { content: errMsg });
      const model = (this as any)._lastSentModel || this.model;
      this.send("stream_end", { elapsed: Date.now() - turnStartTime, tokens: this.lastTotalTokens, model } as any);
      throw err; // 继续上抛让 sessionHub 做清理（runningSessions.delete 等）
    }
  }

  /**
   * 流式生成一段总结性回复（不提供工具，强制模型用文字收尾）。
   * 用于连续失败保护被触发后，让模型向用户说明情况。
   */
  private async streamFinalSummary(turnStartTime: number): Promise<void> {
    let contentBuffer = "";
    let started = false;
    try {
      const strategy = getStrategy(this.provider, this.model);
      const turn = await strategy.runTurn({
        model: this.model,
        messages: this.promptBuilder.buildRequestMessages(),
        tools: [], // 不提供工具，强制用文字收尾
        signal: this.abortController?.signal,
        callbacks: {
          onReasoningDelta: () => { /* 收尾阶段忽略思考过程 */ },
          onTextDelta: (text) => {
            if (!started) {
              this.send("stream_start", {});
              started = true;
            }
            this.send("stream_delta", { content: text });
          },
          onToolCallDetected: () => { /* 无工具 */ },
        },
        temperature: 0.2,
      });
      contentBuffer = turn.content;
      this.recordTurnUsage(turn.usage);
    } catch (err) {
      console.error("[agent] streamFinalSummary 失败:", err);
    }

    // 兜底：模型没产出任何文字时给一句默认说明
    if (!contentBuffer) {
      const fallback = "多次尝试均未成功，我先停下来。请检查相关文件或环境后再让我继续。";
      this.send("stream_start", {});
      this.send("stream_delta", { content: fallback });
      contentBuffer = fallback;
    }

    this.messages.push({ role: "assistant", content: contentBuffer });
    this.persistMessages();
    this.updateAndSendTokenUsage();
    const summaryTokens = this.lastTurnTokens || contentBuffer.length;
    // 摘要 turn：prompt 主要是被压缩的历史 → 归到记忆段
    const summaryBreakdown = {
      memoryTokens: this.lastPromptTokens || Math.round(summaryTokens * 0.7),
      systemTokens: 0,
      questionTokens: 0,
      outputTokens: this.lastCompletionTokens || Math.round(summaryTokens * 0.3),
    };
    const summaryCredits = calculateCredits(this.model, summaryBreakdown);
    const summaryCreditDetail = buildCreditDetail(this.model, summaryBreakdown);
    this.send("stream_end", { elapsed: Date.now() - turnStartTime, tokens: summaryTokens, model: this.model, credits: summaryCredits, creditDetail: summaryCreditDetail });
  }
}

/** 一次 handleUserInput 内跨回合共享的可变标志（收敛传递，便于拆分收尾逻辑）。 */
interface TurnState {
  /** 本轮是否有过实质文件改动（str_replace/create_file/apply_patch 成功） */
  didMutate: boolean;
  /** 是否已做过收尾自检（当前自检轮已关闭，恒置 true 跳过） */
  didSelfCheck: boolean;
  /** 空回复兜底是否已重试过（最多 1 次，防无限循环） */
  emptyRetried: boolean;
  /** 本轮是否已跑过 check_diagnostics（主动或自动），避免重复诊断 */
  didDiagnose: boolean;
}

/**
 * 从工具参数中提取即将被修改的文件绝对路径（用于快照）。
 * 只处理写文件类工具，其他工具返回空数组。
 */
async function extractTargetFiles(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  host: AgentHost,
  workspaces?: string[],
): Promise<string[]> {
  const { resolveInWorkspaces } = await import("./tools/search.js");
  switch (toolName) {
    case "str_replace":
    case "create_file": {
      const p = args.path as string;
      if (!p) return [];
      try {
        const resolved = await resolveInWorkspaces(p, cwd, host, workspaces);
        return [resolved];
      } catch { return []; }
    }
    case "apply_patch": {
      const patch = args.patch as string;
      if (!patch) return [];
      // 从 patch 文本中提取文件路径
      const paths: string[] = [];
      const fileHeaders = patch.match(/\*\*\* (?:Update File|Add File): (.+)/g);
      if (fileHeaders) {
        for (const h of fileHeaders) {
          const p = h.replace(/\*\*\* (?:Update File|Add File): /, "").trim();
          try {
            const resolved = await resolveInWorkspaces(p, cwd, host, workspaces);
            paths.push(resolved);
          } catch { /* skip */ }
        }
      }
      return paths;
    }
    default:
      return [];
  }
}

