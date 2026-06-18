/**
 * Agent Session - 每个 WebSocket 连接一个实例
 *
 * 复用 cli 的核心逻辑，但通过 WS 推送中间状态给前端。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type OpenAI from "openai";
import { resolve } from "node:path";
import { executeToolCall, getToolDefinitions, toolContentLimit, ToolError, CommandGate, type ToolMeta, type SkillLoaderFn, type WebCapability, type ApprovalDecision, type TrustRule, type GateOutcome } from "./tools/index.js";
import { calculateCredits, buildCreditDetail } from "./credits.js";
import type { AgentHost, FileEdit } from "./host/index.js";
import { deriveSubAgentHost } from "./host/index.js";
import type { AgentChannel, AgentEvent } from "./channel/index.js";
import { needsCompaction, compactMessages, reflectiveCompact } from "./compactor.js";
import type { SerializedPendingEdit } from "./storage/types.js";
import type { LLMStreamCallbacks, ToolDef } from "./llm/types.js";
import { SkillRegistry, type LoadedSkill } from "./skills/skillLoader.js";
import { PowerRegistry } from "./powers/powerLoader.js";
import { SubAgentRunner, type SubAgentResult } from "./skills/subAgentRunner.js";
import { looksLikeIncompleteReply, parseToolArguments, LoopGuard, policyForModel, isSoftToolFailure, buildReflectionPrompt, buildSummaryRestartPrompt, type StuckTarget } from "./agentGuards.js";
import { McpRegistry } from "./mcp/mcpRegistry.js";
import { encodeMcpToolName, MCP_TOOL_PREFIX, type McpCapability } from "./mcp/types.js";
import { modelContextWindow } from "./llm/modelContext.js";
import { SYSTEM_PROMPT, QUEST_SYSTEM_PROMPT } from "./systemPrompt.js";
import { getClient, getStrategy, ESIGN_PROVIDER } from "./providers.js";
import { sanitizeToolPairing } from "./messageSanitizer.js";
import { RelayStore } from "./relay/relayStore.js";
import type { RelayPhase, RelayQualityConfig } from "./relay/types.js";
import { nextPhase, PHASE_DOC_FILE } from "./relay/types.js";
import { runParallelResearch, aggregateResearchResults, type ResearchTask } from "./relay/parallelResearch.js";
import { runTwoStageReview, buildReviewFeedback, type ReviewContext } from "./relay/reviewAgent.js";
import type { SubAgentEmit } from "./skills/subAgentRunner.js";


export class AgentSession {
  private model: string;
  private provider: string;
  private messages: ChatCompletionMessageParam[];
  private cwd: string; // 主工作区（第一个路径，命令执行的默认目录）
  private terminalCwd: string; // 终端实际工作目录（cd 后可能不同于主工作区）
  private workspaces: string[]; // 所有工作区路径列表
  private channel: AgentChannel;
  private host: AgentHost;
  private homeDir: string;
  private web?: WebCapability;
  // MCP（Model Context Protocol）：可选注入的运行时能力（host 实现连接/调用），注入方式同 web。
  // mcpRegistry 解析三来源配置，mcp 负责连接与调用；本轮工具定义与「模型名→真实目标」映射预取缓存。
  private mcp?: McpCapability;
  private mcpRegistry: McpRegistry;
  private mcpToolDefsCache: ToolDef[] = [];
  private mcpToolMap = new Map<string, { serverId: string; toolName: string; serverName: string; autoApprove: boolean }>();
  private lastTotalTokens = 0;
  private lastPromptTokens = 0;
  private lastCompletionTokens = 0;
  private lastCachedTokens = 0;
  private cumulativeTokens = 0;
  private lastTurnTokens = 0;
  /** 本轮开始前的累计 token 快照（取消时用差值复原本轮消耗） */
  private turnStartCumulative = 0;
  /** 本轮（最近一次用户输入）调用的子 Agent 累计 token，turn 开始时清零 */
  private lastSubAgentTokens = 0;
  /** 本轮（最近一次用户输入）所有回合的输出 token 累加，turn 开始时清零。
   *  注意：一次用户输入可能触发多回合（每次工具调用都是一回合），
   *  lastCompletionTokens 只保留最后一回合，会漏掉中间回合生成 tool_call 的输出。 */
  private lastTurnOutputTokens = 0;
  /** 本轮开始前的消息条数快照（push 本轮用户消息之前记录）。
   *  收尾时 messages[turnStartMsgCount..] 即本轮新增内容（用户消息 + 工具结果 + 中间 assistant 回填）。 */
  private turnStartMsgCount = 0;
  private abortController: AbortController | null = null;
  // 取消标志：cancel() 时置 true，agent loop 各处据此立即停止。
  // 独立于 abortController（后者 abort 后会被置 null，无法再判断状态）
  private cancelled = false;
  // 回复风格（concise/default/detailed），影响每次请求时注入的风格指令
  private replyStyle = "default";
  // 编辑模式与暂存区：manual 模式下文件改动暂存不落盘，等用户确认
  // 持久化回调：pendingEdits 变动时通知外部存储
  private onPendingChanged?: () => void;
  // 持久化回调：messages 发生实质变更（追加用户消息/assistant 回复/工具结果）时通知外部增量落盘。
  // 与 ws 连接解耦——即便前端切走、连接断开，回复仍能持续落盘，切回来不丢。
  private onMessagesChanged?: () => void;
  // Skill 注册表：发现并加载全局/工作区两级 skill（渐进式披露）
  private skillRegistry: SkillRegistry;
  // Power 注册表：发现并加载全局/工作区两级 power
  private powerRegistry: PowerRegistry | null = null;
  // 本轮请求的 skill 清单提示（handleUserInput 开头异步预取，buildRequestMessages 同步注入）
  private skillsPromptCache: string | null = null;
  // 本轮请求的 Power 清单提示
  private powersPromptCache: string | null = null;
  // 本轮请求的 IDE 上下文提示（仅 IDE 形态有 host.ideContext 时；handleUserInput 开头预取）。
  // 活动文件/选区是同步可得，git diff 是异步，统一在预取阶段拼好，buildRequestMessages 同步注入。
  private ideContextCache: string | null = null;
  // 子 agent 委托计数器：为每次 delegate_task 生成唯一 delegateId
  private delegateSeq = 0;
  // Relay 长任务工作流存储（落盘在主工作区 .axon/relays/）
  private relayStore: RelayStore;
  // 并行调研委托计数器：为每次 parallel_research 生成唯一 batchId
  private researchSeq = 0;
  // 工具确认门：relay_create 等需要用户确认的操作，await 此 Promise 阻塞直到用户响应
  private toolConfirmResolve: ((confirmed: boolean) => void) | null = null;
  // 命令信任门：execute_command 的"灾难硬拦 + 白名单 + 人工授权"，逻辑收敛在 CommandGate
  private readonly commandGate = new CommandGate();
  // 命令审批门：按 requestId 多路挂起 resolver。并发安全——parallel_research / 多个子 Agent
  // 可能同时请求授权，各自的等待用独立 requestId 路由，互不覆盖。
  private commandApprovalResolvers = new Map<string, (d: ApprovalDecision) => void>();
  // 审批请求自增序号，与时间戳一起保证 requestId 在并发下唯一
  private approvalSeq = 0;
  // 新批准信任规则的持久化回调（host 注入：写 VS Code 设置 / JSON 存储）
  private onCommandTrustApproved?: (rule: TrustRule, target?: "user" | "workspace") => void;
  // 当前会话 id（用于把 relay 关联到会话；由外部 index.ts 注入）
  private currentRelaySessionId?: string;
  /** 正在执行上下文压缩时为 true。此期间不允许取消，避免压缩中断导致消息状态不完整。 */
  isCompacting = false;
  // 执行中的 relay 任务上下文：记录当前正在执行哪个 relay/任务，及该任务改动过的文件（供评审定位）
  private activeRelayTask: { relayId: string; taskId: string; changedFiles: Set<string> } | null = null;
  // 本轮用户输入内是否已推进过一次 Relay 阶段。确认门铁律：一条用户消息最多推进一个文档阶段，
  // 防止模型在同一回合里自己写完文档又自己 advance、连续跨多个阶段（无视用户确认）。
  private relayAdvancedThisTurn = false;

  // ── Quest（纯问答）模式 ──────────────────────────────────────────────────
  // mode=quest 时：不绑定工作区语义、禁用所有读写/执行工具（仅在开启联网时放行 web 工具）、
  // 使用问答系统提示。think 控制是否把 reasoning_delta 转发给前端。
  private readonly mode: "agent" | "quest";
  private questThink = false;
  private questWebSearch = false;

  constructor(cwd: string, channel: AgentChannel, host: AgentHost, existingMessages?: ChatCompletionMessageParam[], workspaces?: string[], homeDir?: string, web?: WebCapability, mode: "agent" | "quest" = "agent", mcp?: McpCapability) {
    this.mode = mode;
    this.model = process.env.DEFAULT_MODEL || "gpt-5.5";
    this.provider = process.env.DEFAULT_PROVIDER || ESIGN_PROVIDER;
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
  private persistMessages(): void {
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
  private trackTerminalCwd(toolName: string, args: Record<string, unknown>): void {
    if (toolName !== "execute_command" && toolName !== "start_process") return;
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
  private sendEditsUpdated(rejected?: string[]): void {
    this.send("edits_updated", {
      pending: this.getPendingPaths(),
      diffs: this.getPendingDiffs(),
      rejected: rejected || [],
      undoable: this.getUndoablePaths(),
      pendingEditIds: this.host.edits.getPendingEditIds(),
      undoableEditIds: this.host.edits.getUndoableEditIds(),
    });
  }

  /**
   * 接受待确认改动并落盘。path 省略时接受全部。
   * 接受后注入系统消息让 AI 感知，并通知前端。
   */
  async acceptEdits(path?: string): Promise<void> {
    // 直接用前端回传的 path（即 getPendingPaths() 原值）匹配，不再 resolve(cwd, path)：
    // resolveInWorkspaces 解析出的 absPath 在 basename 兜底 / 多根工作区下常与 resolve(cwd,path) 不等，
    // 重解析会匹配不到 pending 条目，导致接受/拒绝静默失效。
    const acceptedPaths = await this.host.edits.accept(path);
    if (acceptedPaths.length > 0) {
      this.messages.push({
        role: "system",
        content: `用户已接受并保存对以下文件的改动：${acceptedPaths.join("、")}。这些改动现已写入磁盘。`,
      } as any);
    }
    this.sendEditsUpdated();
    this.onPendingChanged?.();
  }

  /**
   * 拒绝待确认改动并丢弃（文件保持原样，从未落盘）。path 省略时拒绝全部。
   * 拒绝后注入系统消息让 AI 感知。
   */
  async rejectEdits(path?: string): Promise<void> {
    // 同 acceptEdits：直接用前端回传的相对 path / editId 匹配。
    const beforeIds = new Set(this.host.edits.getPendingEditIds());
    const rejectedPaths = await this.host.edits.reject(path);
    if (rejectedPaths.length > 0) {
      this.messages.push({
        role: "system",
        content: `用户拒绝了对以下文件的改动：${rejectedPaths.join("、")}。这些文件保持原样（未被修改）。如果用户的目标仍未达成，请重新考虑实现方式，不要简单重复同样的改动。`,
      } as any);
    }
    // 指定单元拒绝但未成功（与后续改动重叠、指纹定位不到）→ 轻提示，文件保持不动
    if (path && rejectedPaths.length === 0 && beforeIds.has(path)) {
      this.send("edit_undo_result", { path, ok: false, reason: "该改动与后续改动重叠，无法单独拒绝这一次，请整体处理" });
    }
    this.sendEditsUpdated(rejectedPaths);
    this.onPendingChanged?.();
  }

  /**
   * 撤销一笔已接受的文件改动（反向应用，保守失败不破坏文件）。
   * 成功：注入系统消息让 AI 感知，推送前端更新并发撤销结果（用于轻提示）。
   * 失败：仅发撤销结果（含 reason），文件保持不动。
   * @param path 已接受改动的相对路径（前端从 undoable 列表回传）
   */
  async undoEdits(path: string): Promise<void> {
    const result = await this.host.edits.undo(path);
    if (result.ok) {
      this.messages.push({
        role: "system",
        content: `用户撤销了对文件 ${result.path || path} 的改动，该文件已恢复到这次改动被接受之前的状态。如果用户的目标因此改变，请据此调整后续行为。`,
      } as any);
      this.sendEditsUpdated();
      this.onPendingChanged?.();
    }
    // 无论成功失败都通知前端撤销结果：成功→更新卡片为已撤销；失败→轻提示
    this.send("edit_undo_result", { path, ok: result.ok, reason: result.reason });
  }

  /** 获取最近一次的累计 token 数 */
  getLastTotalTokens(): number {
    return this.lastTotalTokens;
  }

  /**
   * 从持久化快照回填上下文 token 统计。
   * 会话从磁盘恢复（刷新/切回历史会话）时调用：让 getLastTotalTokens() 立即返回上次落盘的值，
   * 而非默认的 0。否则在拿到本进程第一次真实 usage 之前，任何触发持久化的操作（如追加用户消息、
   * 失败回合）都会用 0 回写、覆盖磁盘上已有的有效 token 统计。
   */
  hydrateTokenUsage(totalTokens?: number): void {
    if (typeof totalTokens === "number" && totalTokens > 0 && this.lastTotalTokens <= 0) {
      this.lastTotalTokens = totalTokens;
    }
  }

  /** 取消当前进行中的请求。压缩进行中时忽略——中断会破坏消息完整性。 */
  cancel(): void {
    if (this.isCompacting) return;
    this.cancelled = true;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /** 手动触发上下文压缩（供前端"压缩上下文"按钮调用）。需超过当前模型窗口 50% 才允许。 */
  async compactSession(): Promise<void> {
    if (this.isCompacting) return;
    const ctxWindow = this.getContextWindow();
    if (!needsCompaction(this.lastTotalTokens, ctxWindow)) {
      this.send("compacting_end", { success: false, message: "当前上下文未超过模型窗口的 50%，无需压缩" });
      return;
    }
    this.isCompacting = true;
    this.send("compacting_start", {});
    try {
      const client = getClient(this.provider);
      this.send("status", { content: "整理上下文..." });
      this.messages = await compactMessages(this.messages, client, this.model);
      this.isCompacting = false;
      this.send("compacting_end", { success: true, message: "上下文已手动压缩" });
      this.persistMessages();
      this.updateAndSendTokenUsage();
    } catch (err) {
      this.isCompacting = false;
      this.send("compacting_end", { success: false, message: `压缩失败：${(err as Error).message}` });
    }
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
    // 取消时 lastTurnTokens 可能为 0（LLM 调用尚未结束），用 cumulative 差值兜底
    const turnTokens = this.lastTurnTokens || (this.turnStartCumulative > 0 ? this.cumulativeTokens - this.turnStartCumulative : 0);
    const breakdown = { ...this.buildTokenBreakdown(), outputTokens: this.lastTurnOutputTokens || this.lastCompletionTokens || 0 };
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

  /**
   * 等待用户确认工具执行。发送 confirm_tool_request 事件给前端，
   * 阻塞直到用户确认或拒绝。若 120 秒内无响应（webview 未就绪等），自动拒绝以免永久死锁。
   */
  private waitForToolConfirmation(toolName: string, args: Record<string, unknown>, kind: "relay" | "mcp" = "relay", label?: string): Promise<boolean> {
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

  /** 注入持久化的命令信任白名单（host 从 VS Code 设置/JSON 存储读出后调用） */
  setTrustedCommands(patterns: string[]): void {
    this.commandGate.setTrustedPatterns(patterns);
  }

  /** 注册"新批准规则"持久化回调（host 据此写回设置/存储） */
  setOnCommandTrustApproved(cb: (rule: TrustRule, target?: "user" | "workspace") => void): void {
    this.onCommandTrustApproved = cb;
  }

  /** 当前命令信任白名单（供管理面板展示） */
  listTrustedCommands(): TrustRule[] {
    return this.commandGate.listRules();
  }

  /** 外部 resolve 命令审批门（由 SessionHub.dispatch confirm_command 调用） */
  resolveCommandApproval(requestId: string, decision: ApprovalDecision): void {
    const resolve = this.commandApprovalResolvers.get(requestId);
    if (resolve) {
      this.commandApprovalResolvers.delete(requestId);
      resolve(decision);
    }
  }

  /** 弹出命令审批请求并阻塞，等待用户三档决策（exact/prefix/all/once/reject） */
  private requestCommandApproval(
    command: string,
    options: { choice: "exact" | "prefix" | "all"; pattern: string; label: string }[],
    toolCallId?: string,
  ): Promise<ApprovalDecision> {
    const requestId = `cmd_${Date.now()}_${this.approvalSeq++}`;
    // 带上 toolCallId：前端据此把审批按钮内联到对应的命令卡片上（无感模式），而非弹独立模态框
    this.send("confirm_command_request", { requestId, command, options, id: toolCallId });
    return new Promise<ApprovalDecision>((resolve) => {
      this.commandApprovalResolvers.set(requestId, resolve);
    });
  }

  /**
   * 命令信任门（共享）：主循环与子 Agent 的 execute_command 都走这一个 gate，
   * 保证白名单、灾难硬拦、人工授权三层语义一致，且批准结果在父子间共享。
   * @param toolCallId 触发该命令的工具调用 id，透传给前端做内联审批定位
   */
  private gateCommand(command: string, toolCallId?: string): Promise<GateOutcome> {
    return this.commandGate.gate(command, {
      requestApproval: (cmd, options) => this.requestCommandApproval(cmd, options, toolCallId),
      emitBlocked: (cmd, reason) => this.send("command_blocked", { command: cmd, reason }),
      persist: (rule, target) => this.onCommandTrustApproved?.(rule, target),
    });
  }

  /** 设置当前会话 id（relay 关联用，由 index.ts 在加载/创建会话时调用） */
  setSessionId(id: string): void {
    this.currentRelaySessionId = id;
  }

  /** 获取当前会话 id（持久化时绑定到正确的会话文件，避免切换会话后串写） */
  getSessionId(): string {
    return this.currentRelaySessionId || "";
  }

  /** 把 OpenAI Chat 工具定义转成策略层的 ToolDef（主 agent 额外带 delegate_task + relay 工具集） */
  private getToolDefs(): ToolDef[] {
    // Quest 模式：禁用所有工具；仅在开启联网时放行 web_search / web_fetch
    if (this.mode === "quest") {
      if (!this.questWebSearch) return [];
      const base = getToolDefinitions() as unknown as ToolDef[];
      return base.filter((t) => {
        const name = (t as { function?: { name?: string } }).function?.name;
        return name === "web_search" || name === "web_fetch";
      });
    }
    const base = getToolDefinitions() as unknown as ToolDef[];
    return [...base, this.getDelegateToolDef(), ...this.getRelayToolDefs(), ...this.mcpToolDefsCache];
  }

  /** 设置 Quest 模式选项（每轮用户输入前由 SessionHub 注入） */
  setQuestOptions(opts: { think?: boolean; webSearch?: boolean }): void {
    if (typeof opts.think === "boolean") this.questThink = opts.think;
    if (typeof opts.webSearch === "boolean") this.questWebSearch = opts.webSearch;
  }

  /**
   * delegate_task 工具定义：主 agent 专用，把任务委托给隔离的子 agent 执行。
   * 故意不放进 tools.ts 通用工具集，这样子 agent 拿不到它 → 限制递归只有 1 层。
   */
  private getDelegateToolDef(): ToolDef {
    return {
      type: "function",
      function: {
        name: "delegate_task",
        description:
          "把一个具体任务委托给独立的子 Agent 执行。子 Agent 在隔离上下文中运行（看不到主对话历史），" +
          "完成后只把最终结论返回给你。\n\n" +
          "⚠️ 子 Agent 看不到当前对话历史，也不如你了解上下文。因此【强依赖当前对话/项目上下文的任务不要委托】，" +
          "尤其是分析、总结、解读类（如\"分析这个项目\"\"总结刚才的改动\"）——这类请改用 use_skill 由你自己执行，效果明显更好。\n\n" +
          "【触发优先级】\n" +
          "1. 用户显式要求用 subagent/子 Agent 执行 → 无条件委托，不管任务大小\n" +
          "2. 任务相对独立、可自包含描述、且匹配某个可用 skill → 委托并传入 skill 参数\n" +
          "3. 任务复杂度达到下面的标准 → 委托\n\n" +
          "【该委托】\n" +
          "- 大范围、可并行的独立检索/调研：结论能压缩成摘要，且不依赖当前对话已有的细节\n" +
          "- 相对独立、自包含的子任务（剥离出去仍能说清，给子 Agent 一段 prompt 就够）\n\n" +
          "【不该委托（自己直接做，或用 use_skill）】\n" +
          "- 分析/总结/解读类，尤其依赖当前项目或对话上下文的 → 用 use_skill 自己做\n" +
          "- 一两步就能完成的：读一个文件、改一行代码、跑一条命令（委托开销反而更慢）\n" +
          "- 需要和用户来回确认的交互式任务\n" +
          "- 与主对话上下文强耦合、脱离上下文就说不清的任务\n\n" +
          "委托前请把任务描述写清楚、自包含（子 Agent 只能看到你给的 prompt，看不到主对话）。",
        parameters: {
          type: "object",
          properties: {
            intent: { type: "string", description: "一句话说明本次委托的目的，展示给用户（如\"按用户要求，使用 subagent 计算数学问题\"）" },
            prompt: { type: "string", description: "交给子 Agent 完成的完整任务描述。必须自包含，包含所有必要的上下文、输入和期望输出" },
            skill: { type: "string", description: "可选。要加载的 skill 名称（来自系统提示中列出的可用技能）。匹配到 skill 时务必传入，子 Agent 会加载该 skill 的完整说明执行" },
          },
          required: ["intent", "prompt"],
        },
      },
    };
  }

  /**
   * Relay 长任务工作流的工具集（主 Agent 专用）。
   * 让主 Agent 能把大需求结构化为「需求→设计→计划→执行」的可控流程，
   * 每阶段产出文档落盘、经用户确认门后推进，执行阶段可逐项勾选。
   */
  private getRelayToolDefs(): ToolDef[] {
    return [
      {
        type: "function",
        function: {
          name: "relay_create",
          description:
            "为一个【大任务/复杂需求】启动 Relay 长任务工作流。\n\n" +
            "【何时用】用户的需求工作量大、需要分阶段推进、涉及多文件或多步骤（如\"实现一个完整功能\"\"重构某模块\"\"搭建子系统\"）时，" +
            "先用它建立工作流，而不是直接闷头改代码。简单的一两步小任务不要用 Relay（直接做即可）。\n\n" +
            "创建后进入 brainstorm（需求澄清）阶段。你应当先与用户澄清需求要点，再用 relay_save_doc 写入需求文档。",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", description: "任务标题（简短，作为 relay 标识，如\"用户登录功能\"）" },
              summary: { type: "string", description: "一句话目标摘要" },
              tdd: { type: "boolean", description: "是否强制 TDD（先写失败测试→实现→测试通过）。默认 false。用户明确要求测试驱动时设 true" },
              review: { type: "boolean", description: "是否启用两阶段评审（规格符合性+代码质量）。默认 true，强烈建议保持开启" },
            },
            required: ["title", "summary"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "relay_save_doc",
          description:
            "把当前阶段的产出文档写入 Relay。phase 取值：\n" +
            "- brainstorm → 写 requirements.md（需求文档：用户故事、验收标准、范围边界）\n" +
            "- design → 写 design.md（设计文档：架构、模块划分、关键决策、数据流）\n" +
            "- plan → 写 plan.md（任务计划：必须用 Markdown 复选框清单，每项带层级编号、涉及文件、验证方式）\n\n" +
            "⚠️ plan.md 的任务清单格式（会被解析成可勾选任务，务必遵守）：\n" +
            "- [ ] 1. 顶层任务标题\n" +
            "  - [ ] 1.1 子任务，说明涉及哪些文件、怎么验证\n" +
            "- [ ] 2. 下一个任务\n\n" +
            "写完文档后【停下来】把要点分段呈现给用户，等用户确认后再用 relay_advance 推进。不要自己直接推进。",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "relay id（relay_create 返回）" },
              phase: { type: "string", enum: ["brainstorm", "design", "plan"], description: "产出文档对应的阶段" },
              content: { type: "string", description: "完整的 Markdown 文档正文" },
            },
            required: ["id", "phase", "content"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "relay_advance",
          description:
            "在用户【明确确认】当前阶段产物后，把 Relay 推进到下一阶段（这是确认门 checkpoint）。\n" +
            "阶段流转：brainstorm → design → plan → executing → done。\n" +
            "⚠️ 必须等用户表达了认可（如\"可以\"\"通过\"\"继续\"）才调用，不要自作主张跨阶段推进。",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "relay id" },
              phase: { type: "string", enum: ["brainstorm", "design", "plan", "executing"], description: "用户已确认通过的当前阶段" },
            },
            required: ["id", "phase"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "relay_update_task",
          description:
            "更新 Relay 执行阶段中某个任务的状态（开始执行设 in_progress，完成设 completed）。\n" +
            "会自动回写 plan.md 的复选框并同步前端进度。一次只推进一个任务：开始前设 in_progress，" +
            "做完并验证后设 completed，再进入下一个任务。全部完成后 relay 自动进入 done。",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "relay id" },
              taskId: { type: "string", description: "任务编号（如 \"1\"、\"1.2\"，与 plan.md 复选框前缀一致）" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "新状态" },
            },
            required: ["id", "taskId", "status"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "relay_review_task",
          description:
            "对一个刚完成实现的 Relay 任务发起【两阶段评审】（仅在 relay 启用了 review 时用）：\n" +
            "- 第一阶段规格符合性：改动是否真的满足任务卡 + 需求/设计，有没有跑偏/漏做/假实现\n" +
            "- 第二阶段代码质量：坏味道、重复、边界处理、是否破坏现有逻辑\n\n" +
            "评审由独立的【只读】子 Agent 执行。任一阶段发现 critical 问题会判定不通过，" +
            "此时你要按返回的反馈【修复代码】后再次调用本工具重审，不要带病把任务标记完成。\n" +
            "评审通过后再用 relay_update_task 把任务标记 completed。\n\n" +
            "调用时机：你完成某个任务的代码实现、自测通过后，标记 completed【之前】调用。",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "relay id" },
              taskId: { type: "string", description: "刚完成实现的任务编号" },
            },
            required: ["id", "taskId"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "parallel_research",
          description:
            "把一个大调研拆成若干【相互独立】的子问题，同时派发多个【只读】子 Agent 并发探索，最后汇总结论。\n\n" +
            "【何时用】需要在大范围内并行检索/调研、且各子问题互不依赖时（如\"分别摸清前端路由、后端鉴权、数据库schema三块的现状\"）。" +
            "尤其适合 Relay 的 brainstorm/design 阶段快速摸清现状。\n\n" +
            "【限制】子 Agent 只读：只能读文件/搜索/列目录/联网，不能改文件或执行命令。需要动手改代码用 delegate_task 或自己做。\n\n" +
            "【不要用】子问题之间有依赖、需要顺序推进的，或只有一个调研点的（那直接自己查或用 delegate_task）。",
          parameters: {
            type: "object",
            properties: {
              intent: { type: "string", description: "一句话说明本次并行调研的总目的，展示给用户" },
              tasks: {
                type: "array",
                description: "并行调研的子任务列表（2~5 个为宜，每个互相独立）",
                items: {
                  type: "object",
                  properties: {
                    intent: { type: "string", description: "该子任务的一句话目的" },
                    prompt: { type: "string", description: "交给只读子 Agent 的完整调研描述，必须自包含" },
                  },
                  required: ["intent", "prompt"],
                },
              },
            },
            required: ["intent", "tasks"],
          },
        },
      },
    ];
  }

  /** use_skill 工具的 skill 加载器（绑定 this，传给 executeToolCall） */
  private loadSkillForTool = async (name: string): Promise<{ name: string; dir: string; body: string } | null> => {
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
   * 执行 delegate_task：加载 skill（若指定）→ 启动隔离子 agent → 实时转发事件 → 返回最终结论。
   * 子 agent 的所有中间事件用 sub_agent_event 包装（带 delegateId），前端路由进对应折叠卡片。
   */
  private async runDelegateTask(
    args: Record<string, unknown>,
    toolCallId: string,
  ): Promise<string> {
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    const intent = typeof args.intent === "string" ? args.intent : "";
    const skillName = typeof args.skill === "string" ? args.skill.trim() : "";
    if (!prompt.trim()) {
      throw new Error("delegate_task 需要非空的 prompt");
    }

    // 为本次委托生成唯一 id，关联前端折叠卡片与内部事件流
    const delegateId = `delegate-${Date.now()}-${++this.delegateSeq}`;

    // 加载 skill（可选）
    let skill: LoadedSkill | null = null;
    if (skillName) {
      skill = await this.skillRegistry.load(skillName);
      if (!skill) {
        console.warn(`[skill] 未找到 skill "${skillName}"，子 Agent 将以通用任务模式执行`);
      }
    }

    // 通知前端：委托开始（携带 delegateId、skill、prompt，供卡片展开展示）
    this.send("sub_agent_start", {
      delegateId,
      toolCallId,
      intent,
      skill: skill?.name || skillName || null,
      prompt,
    });

    // 子 agent 事件回调：包装成 sub_agent_event 转发给前端
    const emit = (type: string, data: Record<string, unknown>): void => {
      this.send("sub_agent_event", { delegateId, event: { type, ...data } });
    };

    const runner = new SubAgentRunner({
      strategy: getStrategy(this.provider, this.model),
      model: this.model,
      cwd: this.cwd,
      workspaces: this.workspaces,
      host: deriveSubAgentHost(this.host),
      signal: this.abortController?.signal,
      emit,
      skillLoader: this.loadSkillForTool,
      web: this.web,
      // 子 Agent 也共享父会话的 LLM client，用于卡住时的"摘要重启"
      client: getClient(this.provider),
      // 子 Agent 的 execute_command 复用父会话的信任门：灾难硬拦 + 白名单 + 冒泡到用户审批
      gateCommand: (command, toolCallId) => this.gateCommand(command, toolCallId),
    });

    let result: SubAgentResult;
    try {
      result = await runner.run(prompt, skill);
    } catch (err) {
      // 子 agent 被取消/抛错：累加它中断前已消耗的 token（不漏算），再通知前端结束
      this.addSubAgentTokens(runner.getTokensUsed());
      const aborted = `（子 Agent 已${this.cancelled ? "取消" : "中断"}）`;
      this.send("sub_agent_end", { delegateId, result: aborted });
      throw err; // 继续上抛，由主循环的取消检查处理
    }

    // 通知前端：委托结束（携带最终文本）
    this.send("sub_agent_end", { delegateId, result: result.text });
    // 子 Agent 消耗的 token 累加到本会话总量
    this.addSubAgentTokens(result.tokens);

    const skillNote = skill ? `（已使用 skill：${skill.name}）` : "";

    // 成功与失败区别回填，避免主 agent 把失败结论当权威结果、被错误框架带偏
    if (result.ok) {
      // 成功：这是可信结论，要求主 agent 完整呈现
      return (
        `子 Agent 已完成任务${skillNote}。以下是子 Agent 的完整结论，请直接呈现给用户` +
        `（可适当排版，但不要丢失内容，不要只写一句"已完成"）：\n\n${result.text}`
      );
    }
    // 失败：明确标注这不是结论，要求主 agent 抛开子 agent 的猜测、用自己的上下文重新独立完成
    return (
      `子 Agent 未能完成本次委托${skillNote}，下面是它的尝试过程与失败说明（仅供参考，不是可信结论）：\n\n` +
      `${result.text}\n\n` +
      `⚠️ 重要：不要把上面的内容当作答案呈现给用户，也不要沿用其中的猜测、假设或文件路径。` +
      `请基于你自己已有的上下文，从头独立完成这个任务（亲自用 read_file/search 等工具核实），` +
      `不要被子 Agent 的失败框架带偏。`
    );
  }

  /**
   * 执行 relay_create：创建一个新的 Relay 长任务工作流，通知前端打开/刷新面板。
   */
  private async runRelayCreate(args: Record<string, unknown>): Promise<string> {
    const title = typeof args.title === "string" ? args.title.trim() : "";
    const summary = typeof args.summary === "string" ? args.summary.trim() : "";
    if (!title) throw new Error("relay_create 需要非空的 title");
    const quality: RelayQualityConfig = {
      tdd: args.tdd === true,
      review: args.review !== false, // 默认开启评审
    };
    const relay = await this.relayStore.create({ title, summary, sessionId: this.currentRelaySessionId, quality });
    this.send("relay_updated", { relay });
    const qualityNote = `质量门：评审${quality.review ? "开启" : "关闭"}，TDD ${quality.tdd ? "强制" : "不强制"}。`;
    return (
      `已创建 Relay 长任务工作流「${relay.title}」（id: ${relay.id}），当前处于需求澄清（brainstorm）阶段。${qualityNote}\n` +
      `接下来请与用户澄清需求要点（目标、范围、验收标准），然后用 relay_save_doc(phase="brainstorm") 写入需求文档，` +
      `分段呈现给用户确认。不要跳过澄清直接写文档。`
    );
  }

  /** 执行 relay_save_doc：写入某阶段文档，通知前端刷新。 */
  private async runRelaySaveDoc(args: Record<string, unknown>): Promise<string> {
    const id = typeof args.id === "string" ? args.id : "";
    const phase = args.phase as RelayPhase;
    const content = typeof args.content === "string" ? args.content : "";
    if (!id) throw new Error("relay_save_doc 需要 id");
    if (!PHASE_DOC_FILE[phase]) throw new Error(`relay_save_doc 的 phase 非法：${String(args.phase)}`);
    if (!content.trim()) throw new Error("relay_save_doc 需要非空的 content");
    const relay = await this.relayStore.saveDoc(id, phase, content);
    if (!relay) throw new Error(`未找到 relay：${id}`);
    this.send("relay_updated", { relay });
    const fileName = PHASE_DOC_FILE[phase];
    const taskNote = phase === "plan" ? `已解析出 ${relay.tasks.length} 个任务。` : "";
    return (
      `已写入 ${fileName}。${taskNote}\n` +
      `现在请把这份${phase === "brainstorm" ? "需求" : phase === "design" ? "设计" : "计划"}的要点分段、简洁地呈现给用户，` +
      `请用户确认。用户认可后再调用 relay_advance(phase="${phase}") 推进到下一阶段。不要自己直接推进。`
    );
  }

  /** 执行 relay_advance：用户确认后推进阶段（确认门）。 */
  private async runRelayAdvance(args: Record<string, unknown>): Promise<string> {
    const id = typeof args.id === "string" ? args.id : "";
    const phase = args.phase as RelayPhase;
    if (!id) throw new Error("relay_advance 需要 id");

    // 硬门：推进前校验当前阶段的产出文档确实已写入（防止跳过阶段、未出文档就推进）
    const cur = await this.relayStore.get(id);
    if (!cur) throw new Error(`未找到 relay：${id}`);
    const docMap: Partial<Record<RelayPhase, string>> = {
      brainstorm: cur.requirements,
      design: cur.design,
      plan: cur.plan,
    };
    if (phase in docMap && !(docMap[phase] || "").trim()) {
      throw new Error(
        `当前阶段 ${phase} 的文档还没写，不能推进。请先用 relay_save_doc(phase="${phase}") 写好文档、` +
        `呈现给用户并获得明确确认后，再推进。`,
      );
    }

    // 确认门铁律（硬门）：一条用户消息最多推进一个文档阶段。若本轮已经推进过，拒绝再次推进——
    // 强制模型把文档呈现给用户、等用户【下一条消息】明确确认后才能继续。这从根上杜绝
    // "一次确认被模型连跨需求→设计→计划多个阶段"。
    if (this.relayAdvancedThisTurn) {
      throw new Error(
        `本轮已经推进过一个阶段了。Relay 确认门要求：每个阶段的产出必须分别经过用户确认。` +
        `请先把当前阶段的文档要点呈现给用户，停下来等用户在【下一条消息】里明确认可后，再推进下一阶段。` +
        `不要在同一回合里连续跨多个阶段。`,
      );
    }
    this.relayAdvancedThisTurn = true;

    const to = nextPhase(phase);
    const relay = await this.relayStore.advancePhase(id, phase, to);
    if (!relay) throw new Error(`未找到 relay：${id}`);
    this.send("relay_updated", { relay });
    if (to === "executing") {
      return (
        `阶段已推进到执行（executing）。计划共 ${relay.tasks.length} 个任务。\n` +
        `请开始逐项执行：每个任务开始前用 relay_update_task 设为 in_progress，完成并验证后设为 completed，再做下一个。`
      );
    }
    if (to === "done") {
      return `Relay「${relay.title}」已全部完成。`;
    }
    return `阶段已推进到 ${to}。请产出该阶段的文档（relay_save_doc），再次分段呈现给用户确认。`;
  }

  /** 执行 relay_update_task：更新任务状态并回写 plan.md 复选框。 */
  private async runRelayUpdateTask(args: Record<string, unknown>): Promise<string> {
    const id = typeof args.id === "string" ? args.id : "";
    const taskId = typeof args.taskId === "string" ? args.taskId : "";
    const status = args.status as "pending" | "in_progress" | "completed";
    if (!id || !taskId) throw new Error("relay_update_task 需要 id 和 taskId");

    // 开始执行某任务：建立活动任务上下文，开始记录该任务改动的文件（供评审定位）
    if (status === "in_progress") {
      this.activeRelayTask = { relayId: id, taskId, changedFiles: new Set() };
    }

    // 标记完成时：若启用了评审且该任务还没评审通过，【拒绝】标记完成（硬门，不再是软提醒）
    if (status === "completed") {
      const cur = await this.relayStore.get(id);
      const task = cur?.tasks.find((t) => t.id === taskId);
      const reviewEnabled = cur?.quality?.review !== false;
      // 仅对叶子任务做评审门：父任务（有子任务）不作为执行/评审单元，完成与否由子任务决定
      const isParent = !!cur?.tasks.some((t) => t.id !== taskId && t.id.startsWith(taskId + "."));
      if (reviewEnabled && !isParent && task && task.reviewStatus !== "passed") {
        throw new Error(
          `任务 ${taskId} 尚未通过两阶段评审，不能标记完成。请先调用 relay_review_task(id="${id}", taskId="${taskId}") 评审，` +
          `通过后再标记 completed；若评审打回，按反馈修复后重审。`,
        );
      }
    }

    const relay = await this.relayStore.setTaskStatus(id, taskId, status);
    if (!relay) throw new Error(`未找到 relay：${id}`);
    if (status === "completed" && this.activeRelayTask?.taskId === taskId) {
      this.activeRelayTask = null;
    }

    this.send("relay_updated", { relay });
    const done = relay.tasks.filter((t) => t.status === "completed").length;
    if (relay.phase === "done") {
      return `任务 ${taskId} 已标记 ${status}。所有任务完成，Relay「${relay.title}」进入 done。`;
    }
    return `任务 ${taskId} 已标记 ${status}（进度 ${done}/${relay.tasks.length}）。继续下一个任务。`;
  }

  /**
   * 执行 relay_review_task：对指定任务跑两阶段只读评审，结果落盘并回填给主 Agent。
   * 评审子 Agent 的事件用 sub_agent_event 包装（带独立 reviewId），前端各自渲染卡片。
   */
  private async runRelayReviewTask(args: Record<string, unknown>): Promise<string> {
    const id = typeof args.id === "string" ? args.id : "";
    const taskId = typeof args.taskId === "string" ? args.taskId : "";
    if (!id || !taskId) throw new Error("relay_review_task 需要 id 和 taskId");

    const relay = await this.relayStore.get(id);
    if (!relay) throw new Error(`未找到 relay：${id}`);
    if (relay.quality?.review === false) {
      return `该 Relay 未启用评审（review=false），无需评审。可直接 relay_update_task 标记完成。`;
    }
    const task = relay.tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`未找到任务：${taskId}`);

    // 标记评审中
    await this.relayStore.setTaskReview(id, taskId, "reviewing");
    this.send("relay_updated", { relay: await this.relayStore.get(id) });

    // 收集该任务改动过的文件（活动任务上下文里记录的）
    const changedFiles = this.activeRelayTask?.relayId === id && this.activeRelayTask.taskId === taskId
      ? [...this.activeRelayTask.changedFiles]
      : [];

    const ctx: ReviewContext = {
      relayTitle: relay.title,
      taskId,
      taskTitle: task.title,
      taskDetails: task.details,
      requirements: relay.requirements,
      design: relay.design,
      changedFiles,
    };

    const emitFor = (reviewId: string) => {
      return (type: string, data: Record<string, unknown>) =>
        this.send("sub_agent_event", { delegateId: reviewId, event: { type, ...data } });
    };

    // 通知前端：评审开始
    const reviewBatchId = `review-${id}-${taskId}-${Date.now()}`;
    this.send("relay_review_start", { batchId: reviewBatchId, relayId: id, taskId });

    const { tokens: reviewTokens, ...review } = await runTwoStageReview(ctx, {
      strategy: getStrategy(this.provider, this.model),
      model: this.model,
      cwd: this.cwd,
      workspaces: this.workspaces,
      host: deriveSubAgentHost(this.host),
      signal: this.abortController?.signal,
      skillLoader: this.loadSkillForTool,
      web: this.web,
      emitFor,
    });
    // 评审子 Agent 消耗的 token 累加到会话总量
    this.addSubAgentTokens(reviewTokens);

    const reviewStatus = review.passed ? "passed" : "changes_requested";
    await this.relayStore.setTaskReview(id, taskId, reviewStatus, review);
    this.send("relay_updated", { relay: await this.relayStore.get(id) });
    this.send("relay_review_end", { batchId: reviewBatchId, relayId: id, taskId, passed: review.passed });

    if (review.passed) {
      return (
        `✅ 任务 ${taskId} 两阶段评审通过（规格符合性 + 代码质量）。\n` +
        `现在可以用 relay_update_task(status="completed") 把它标记完成，继续下一个任务。`
      );
    }
    const feedback = buildReviewFeedback(review);
    return (
      `❌ 任务 ${taskId} 评审未通过，需要修复后重审。评审反馈如下：\n\n${feedback}\n\n` +
      `请逐条修复上述问题（尤其 critical），改完后再次调用 relay_review_task 重审。不要带病推进。`
    );
  }

  /**
   * 执行 parallel_research：派发多个只读子 Agent 并发调研，聚合结论回填。
   * 每路子 Agent 的事件用 sub_agent_event 包装（带独立 delegateId），前端各自渲染卡片。
   */
  private async runParallelResearch(args: Record<string, unknown>, toolCallId: string): Promise<string> {
    const intent = typeof args.intent === "string" ? args.intent : "";
    const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
    if (rawTasks.length === 0) throw new Error("parallel_research 需要至少一个调研子任务");

    const batchId = `research-${Date.now()}-${++this.researchSeq}`;
    const tasks: ResearchTask[] = rawTasks.map((t, i) => {
      const obj = (t || {}) as Record<string, unknown>;
      return {
        id: `${batchId}-${i + 1}`,
        intent: typeof obj.intent === "string" ? obj.intent : `调研 ${i + 1}`,
        prompt: typeof obj.prompt === "string" ? obj.prompt : "",
      };
    }).filter((t) => t.prompt.trim());
    if (tasks.length === 0) throw new Error("parallel_research 的子任务都缺少 prompt");

    // 通知前端：并行调研开始（携带各子任务的 delegateId 与 intent，供渲染并列卡片）
    this.send("parallel_research_start", {
      batchId,
      toolCallId,
      intent,
      tasks: tasks.map((t) => ({ delegateId: t.id, intent: t.intent, prompt: t.prompt })),
    });

    // 为每个子任务生成绑定其 delegateId 的事件发射器
    const emitFor = (taskId: string): SubAgentEmit => {
      return (type, data) => this.send("sub_agent_event", { delegateId: taskId, event: { type, ...data } });
    };

    const results = await runParallelResearch(tasks, {
      strategy: getStrategy(this.provider, this.model),
      model: this.model,
      cwd: this.cwd,
      workspaces: this.workspaces,
      host: deriveSubAgentHost(this.host),
      signal: this.abortController?.signal,
      skillLoader: this.loadSkillForTool,
      web: this.web,
      emitFor,
      client: getClient(this.provider),
      maxConcurrency: 3,
    });

    // 通知前端：各路调研结束
    for (const r of results) {
      this.send("sub_agent_end", { delegateId: r.id, result: r.text });
    }
    // 累加所有调研子 Agent 的 token 到会话总量
    this.addSubAgentTokens(results.reduce((sum, r) => sum + (r.tokens || 0), 0));
    this.send("parallel_research_end", { batchId, results: results.map((r) => ({ delegateId: r.id, ok: r.ok })) });

    return aggregateResearchResults(results);
  }

  /** 发消息给前端 */
  private send(type: string, data: Record<string, unknown> = {}): void {
    this.channel.emit({ type, ...data } as AgentEvent);
  }

  /** 根据当前模型返回上下文窗口大小（统一来源 modelContextWindow） */
  private getContextWindow(): number {
    return modelContextWindow(this.model);
  }

  /**
   * 推送当前上下文 token 占用给前端。
   * 优先用 API 返回的真实 prompt token（lastPromptTokens）；尚未拿到时回退到字符数粗估。
   */
  private updateAndSendTokenUsage(): void {
    let total = this.lastPromptTokens;
    if (total <= 0) {
      // 尚未拿到 API 真实 usage：用字符数粗估（约 0.4 token/字符）兜底
      let chars = 0;
      for (const m of this.messages) {
        if (!m) continue;
        if (typeof m.content === "string") chars += m.content.length;
        else if (Array.isArray(m.content)) {
          for (const part of m.content as any[]) if (part.type === "text") chars += (part.text || "").length;
        }
      }
      total = Math.ceil(chars * 0.4);
    }

    this.lastTotalTokens = total;
    this.send("token_usage", {
      used: total,
      max: this.getContextWindow(),
      cumulative: this.cumulativeTokens, // 本任务累计消耗（含子 Agent），与 used（当前上下文占用）区分
    });
  }

  /** 记录某回合 API 返回的真实 token 用量（来自 LLMTurnResult.usage） */
  private recordTurnUsage(usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number }): void {
    if (usage && usage.promptTokens > 0) {
      this.lastPromptTokens = usage.promptTokens;
    }
    if (usage && usage.completionTokens > 0) {
      this.lastCompletionTokens = usage.completionTokens;
      this.lastTurnOutputTokens += usage.completionTokens; // 跨回合累加：每轮工具调用生成的输出都计入本轮输出
    }
    // 缓存命中 token：每轮独立记录（用于本轮 credits 计算的折扣）
    this.lastCachedTokens = usage?.cachedTokens ?? 0;
    if (usage) {
      const turnTotal = usage.totalTokens || (usage.promptTokens + usage.completionTokens);
      if (turnTotal > 0) {
        this.cumulativeTokens += turnTotal;
        this.lastTurnTokens = turnTotal;
      }
    }
  }

  /** 累加子 Agent 消耗的 token 到本会话累计量 */
  private addSubAgentTokens(tokens: number): void {
    if (tokens > 0) {
      this.cumulativeTokens += tokens;
      this.lastSubAgentTokens += tokens; // 本轮 subagent 用量（计入 tooltip 的"本次问题"）
    }
  }

  /** 获取本会话累计 token 消耗（含子 Agent） */
  getCumulativeTokens(): number {
    return this.cumulativeTokens;
  }

  /** 根据当前 replyStyle 返回要注入的风格指令文本（default 不注入） */
  private getStyleInstruction(): string | null {
    switch (this.replyStyle) {
      case "concise":
        return "本次回复风格：简洁。直奔结论，能一句说清就别展开，省略非必要的背景和过程描述。";
      case "detailed":
        return "本次回复风格：详细。可以展开讲解，补充背景、原理和注意事项，但仍要遵守'禁止双总结/禁止分割线/不主动给规划'等格式约束。";
      default:
        return null;
    }
  }

  /**
   * 模型冗长度校准：GPT 系模型默认输出比 GLM/Claude 啰嗦得多，需要额外约束才能拉回相近颗粒度。
   * 仅对 GPT 系生效，且当用户显式选了"详细"风格时不压制（尊重用户意图）。
   */
  private getVerbosityCalibration(): string | null {
    const isGpt = /^gpt/i.test(this.model);
    if (!isGpt || this.replyStyle === "detailed") return null;
    return (
      "输出长度校准（重要）：你的回答要克制、信息密度高，向【够用即可】靠拢——\n" +
      "- 结论先行，直接说重点；不要长篇铺垫、不要复述用户问题、不要逐条罗列你做过的每一步\n" +
      "- 能用一句说清就不要展开成一段；能用一段就不要拆成多个小标题\n" +
      "- 只在用户明确问【为什么/原理/细节】时才展开背景与推理，否则默认给精炼版\n" +
      "- 实现类任务的收尾总结控制在 5 句以内（用户能看到工具卡片，无需复述过程）\n" +
      "- 不要用大量分级标题、编号清单把短答案撑长；段落和要点都从简"
    );
  }

  /** 构造发给 LLM 的消息：在 system prompt 之后插入风格指令和工作区信息（不污染持久化的 this.messages） */
  /**
   * 构造 IDE 上下文提示（仅当 host 提供 ideContext，即 IDE 形态）。
   * 包含活动文件、选区/选中文本、其它打开的文件、git diff 概览——让 Agent 像 IDE 内助手一样
   * 感知用户"正在看什么、改了什么"。非 IDE 形态（host.ideContext 为空）返回 null，不注入。
   */
  private async buildIdeContextPrompt(): Promise<string | null> {
    const ide = this.host.ideContext;
    if (!ide) return null;
    try {
      const parts: string[] = [];

      const active = ide.activeEditor();
      if (active) {
        let line = `- 当前活动文件：${active.path}`;
        if (active.selection) {
          const s = active.selection;
          // 选区行号转 1-indexed 展示
          line += `（选区：第 ${s.startLine + 1} 行第 ${s.startCharacter + 1} 列 ~ 第 ${s.endLine + 1} 行第 ${s.endCharacter + 1} 列）`;
        }
        parts.push(line);
        if (active.selectedText && active.selectedText.trim()) {
          const snippet = active.selectedText.length > 2000
            ? active.selectedText.slice(0, 2000) + "\n…（选中内容过长已截断）"
            : active.selectedText;
          parts.push(`- 用户选中的代码：\n\`\`\`\n${snippet}\n\`\`\``);
        }
      }

      const openFiles = ide.openFiles().filter((p) => !active || p !== active.path);
      if (openFiles.length > 0) {
        const shown = openFiles.slice(0, 20);
        parts.push(`- 其它已打开的文件：\n${shown.map((p) => `  · ${p}`).join("\n")}`);
      }

      const diff = await ide.gitDiff();
      if (diff && diff.trim()) {
        const shown = diff.length > 4000 ? diff.slice(0, 4000) + "\n…（diff 过长已截断）" : diff;
        parts.push(`- 当前工作区 git diff（未提交改动）：\n\`\`\`diff\n${shown}\n\`\`\``);
      }

      if (parts.length === 0) return null;

      return (
        `【IDE 上下文】以下是用户当前在编辑器里的实时状态，供你理解"用户正在关注/操作什么"。\n` +
        `当用户说"这个文件""这里""当前选中的"等指代时，优先据此理解；但不要凭空假设用户的意图，必要时仍以工具核实为准。\n\n` +
        parts.join("\n")
      );
    } catch (err) {
      console.warn("[ide-context] 获取 IDE 上下文失败（忽略）:", (err as Error).message);
      return null;
    }
  }

  /** 当前轮次不需要保留到下一轮的"瞬态"工具：其结果只在当轮有意义，跨轮重复只会污染上下文。 */
  private static readonly TRANSIENT_TOOLS = new Set(["search", "list_dir", "web_search", "web_fetch"]);

  private buildRequestMessages(): ChatCompletionMessageParam[] {
    const injections = this.buildInjections();

    // 先移除跨轮瞬态工具结果（search/list_dir/web_search/web_fetch），
    // 必须在 sanitizeToolPairing 之前执行：先删掉不需要的工具结果，
    // 再让 sanitizer 把关联的孤儿 tool_calls 一并清理，避免产生
    // "assistant(tool_calls) 后缺少 tool 结果" 的消息序列导致 API 400。
    const preFiltered = this.messages.filter((m) => {
      if ((m as any).role !== "tool") return true;
      const toolName = (m as any)._toolName as string | undefined;
      if (!toolName || !AgentSession.TRANSIENT_TOOLS.has(toolName)) return true;
      // 只保留当前轮次的瞬态结果（在原始数组上的下标与 turnStartMsgCount 对齐）
      const idx = this.messages.indexOf(m);
      return idx >= this.turnStartMsgCount;
    });

    // 发送前清洗：移除孤儿 tool_calls / 孤儿 tool 结果（含上一步因瞬态过滤
    // 而产生的孤儿），避免历史损坏导致 API 400
    const cleaned = sanitizeToolPairing(preFiltered);

    if (injections.length === 0) return cleaned;
    if (cleaned.length === 0) return injections; // 防御：cleaned 为空时至少返回 injections，避免 systemMsg 为 undefined
    const [systemMsg, ...rest] = cleaned;
    return [systemMsg, ...injections, ...rest];
  }

  /** 构建本轮要注入的 system 消息（风格/验证/多工作区/IDE/skill/power），供请求组装与 token 估算复用 */
  private buildInjections(): ChatCompletionMessageParam[] {
    const injections: ChatCompletionMessageParam[] = [];

    // 模型差异校准：GPT 系（gpt-5.5 等）默认输出明显比 GLM/Claude 更冗长，
    // 同样的格式约束它遵守得更松。这里对 GPT 系额外注入一条"控长"指令，把它拉回与其他模型
    // 接近的颗粒度。仅在用户未显式选择"详细"风格时生效（detailed 时尊重用户意图，不压制）。
    const verbosityCalibration = this.getVerbosityCalibration();
    if (verbosityCalibration) {
      injections.push({ role: "system", content: verbosityCalibration });
    }

    // 风格指令
    const instruction = this.getStyleInstruction();
    if (instruction) {
      injections.push({ role: "system", content: instruction });
    }

    // 行为验证提醒（每轮注入，强化模型对验证义务的注意力——系统提示里写了但模型容易忽略，
    // 放在动态注入里每轮可见，遵守度更高）
    injections.push({
      role: "system",
      content:
        "行为验证义务提醒：如果本轮你新增或修改了有明确输入输出的函数/逻辑，" +
        "交付前必须自己用 execute_command 跑验证（临时脚本或 node -e），确认行为正确。" +
        "只做 check_diagnostics 不够。没跑验证就给最终回答 = 不合格交付。",
    });

    // 多工作区信息（让 AI 感知所有可操作的根路径）
    if (this.workspaces.length > 1) {
      const wsInfo = this.workspaces.map((p, i) => `  ${i + 1}. ${p}`).join("\n");
      injections.push({
        role: "system",
        content:
          `当前会话绑定了多个工作区：\n${wsInfo}\n\n` +
          `主工作区（命令执行的默认目录、相对路径的基准）：${this.cwd}\n\n` +
          `重要规则：\n` +
          `- 访问非主工作区的文件时，必须使用该文件的完整绝对路径（如上面列出的路径开头）\n` +
          `- 不要用 ../、../../ 等相对路径去猜测其他工作区的位置\n` +
          `- 例如要读取第 2 个工作区的文件，path 应写为 "${this.workspaces[1]}\\xxx" 而不是 "../xxx"\n` +
          `- search 工具的 path 参数：搜索某个工作区时直接传该工作区的绝对路径`,
      });
    }

    // 终端工作目录提示：cd 后可能与主工作区不同
    if (this.terminalCwd !== this.cwd) {
      injections.push({
        role: "system",
        content: `⚠️ 注意：Axon 终端当前工作目录为 \`${this.terminalCwd}\`，与主工作区不同。execute_command 不传 cwd 时将在此目录执行。`,
      });
    }

    // IDE 上下文（仅 IDE 形态：活动文件/选区/打开文件/git diff，本轮开头预取）
    if (this.ideContextCache) {
      injections.push({ role: "system", content: this.ideContextCache });
    }

    // Skill 清单（渐进式披露的轻量层，本轮开头预取）
    if (this.skillsPromptCache) {
      injections.push({ role: "system", content: this.skillsPromptCache });
    }

    // Power 清单（轻量层，本轮开头预取）
    if (this.powersPromptCache) {
      injections.push({ role: "system", content: this.powersPromptCache });
    }

    return injections;
  }

  /** 取一条消息的纯文本内容（兼容 string 与多模态 parts） */
  private messageText(m: ChatCompletionMessageParam): string {
    if (!m) return "";
    const c = (m as { content?: unknown }).content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return (c as Array<{ type?: string; text?: string }>).map((p) => (p.type === "text" ? p.text || "" : "")).join("");
    return "";
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
      thisTurnChars += this.messageText(this.messages[i]).length;
    }
    let memoryChars = 0;
    if (this.turnStartMsgCount > 1) {
      for (let i = 1; i < this.turnStartMsgCount; i++) memoryChars += this.messageText(this.messages[i]).length;
    }

    // system 直接估算（最稳定可知：系统提示文本 + 注入 + 工具定义 JSON）。
    // 自然文本约 0.4 token/字符；工具定义是结构化 JSON,token 密度更高,约 0.75。
    let systemChars = this.messages[0] ? this.messageText(this.messages[0]).length : 0;
    for (const inj of this.buildInjections()) systemChars += this.messageText(inj).length;
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
  private async prefetchMcpTools(): Promise<void> {
    this.mcpToolDefsCache = [];
    this.mcpToolMap.clear();
    if (!this.mcp || this.mode === "quest") return;
    try {
      const specs = await this.mcpRegistry.resolve();
      await this.mcp.syncServers(specs);
      const tools = await this.mcp.listTools();
      for (const t of tools) {
        let modelName = encodeMcpToolName(t.serverId, t.name);
        // 编码不可逆且可能冲突：撞名时加后缀保唯一，映射表才是权威解析依据
        if (this.mcpToolMap.has(modelName)) modelName = `${modelName}_${this.mcpToolMap.size}`;
        this.mcpToolMap.set(modelName, { serverId: t.serverId, toolName: t.name, serverName: t.serverName, autoApprove: t.autoApprove });
        this.mcpToolDefsCache.push({
          type: "function",
          function: {
            name: modelName,
            description: `[MCP·${t.serverName}] ${t.description || t.name}`,
            parameters: (t.inputSchema as Record<string, unknown>) || { type: "object", properties: {} },
          },
        } as ToolDef);
      }
      if (tools.length > 0) console.log(`[mcp] 已加载 ${tools.length} 个 MCP 工具（${specs.length} 个 server）`);
    } catch (err) {
      console.warn("[mcp] 预取 MCP 工具失败（忽略，不影响其它工具）:", (err as Error).message);
      this.mcpToolDefsCache = [];
      this.mcpToolMap.clear();
    }
  }

  /** 若是 MCP 工具，返回其真实 server 名与工具名（供前端卡片展示）。
   * 不在 mcpToolMap（已禁用/移除）时，从编码名尽力还原，至少让卡片能标出 server/tool 名。 */
  private mcpMetaFor(toolName: string): { mcpServer?: string; mcpTool?: string } {
    const t = this.mcpToolMap.get(toolName);
    if (t) return { mcpServer: t.serverName, mcpTool: t.toolName };
    if (toolName.startsWith(MCP_TOOL_PREFIX)) {
      const inner = toolName.slice(MCP_TOOL_PREFIX.length);
      const sep = inner.lastIndexOf("__");
      if (sep > 0) {
        // 去掉来源前缀（user_/workspace_/power_），下划线还原为空格
        const server = inner.slice(0, sep).replace(/^(user|workspace|power)_/, "").replace(/_/g, " ");
        return { mcpServer: server || "MCP", mcpTool: inner.slice(sep + 2) };
      }
    }
    return {};
  }

  /**
   * 执行一次 MCP 工具调用：autoApprove 命中直接放行，否则走确认门请用户批准本次调用。
   * 返回 result（给 AI，详细+含指令）+ userMessage（给前端卡片，简短）+ status。
   */
  private async runMcpTool(modelToolName: string, args: Record<string, unknown>): Promise<{ result: string; status: "success" | "error"; userMessage?: string }> {
    const target = this.mcpToolMap.get(modelToolName);
    if (!target || !this.mcp) {
      return {
        result:
          `MCP 工具「${modelToolName}」当前不可用——它可能已被【禁用】、移除，或所属 server 未启用/未连接。` +
          `这不是连接抖动，请【不要重试该工具】，也不要推测是"连接不稳定/超时"。` +
          `如确实需要，请提示用户在 MCP 管理里启用对应 server；否则改用其它可用工具或直接回答。`,
        status: "error",
        userMessage: "该 MCP 工具已被禁用或不可用",
      };
    }
    if (!target.autoApprove) {
      const approved = await this.waitForToolConfirmation(target.toolName, args, "mcp", `${target.serverName} · ${target.toolName}`);
      if (!approved) {
        return {
          result: `用户拒绝了对 MCP 工具「${target.serverName}·${target.toolName}」的调用。不要重试，可改用其它方式或先询问用户。`,
          status: "error",
          userMessage: `已拒绝调用 ${target.serverName}·${target.toolName}`,
        };
      }
    }
    try {
      const res = await this.mcp.callTool(target.serverId, target.toolName, args);
      return { result: res.text, status: res.isError ? "error" : "success" };
    } catch (err) {
      return {
        result: `MCP 工具调用失败（${target.serverName}·${target.toolName}）：${(err as Error).message}`,
        status: "error",
        userMessage: `${target.serverName}·${target.toolName} 调用失败`,
      };
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

    const client = getClient(this.provider);
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

    // 无感压缩：token 超过阈值时自动压缩历史（按当前模型真实窗口判定）
    // 模型切换导致消息量超过新窗口时也强制压缩
    const ctxWindow = this.getContextWindow();
    const overflowing = this.lastTotalTokens > ctxWindow;
    if ((this.lastTotalTokens > 0 && needsCompaction(this.lastTotalTokens, ctxWindow)) || overflowing) {
      this.isCompacting = true;
      this.send("compacting_start", {});
      try {
        this.send("status", { content: "整理上下文..." });
        this.messages = await compactMessages(this.messages, client, this.model);
        this.isCompacting = false;
        this.send("compacting_end", { success: true, message: overflowing ? "切换模型后上下文已自动压缩" : "上下文已自动压缩" });
      } catch (err) {
        this.isCompacting = false;
        this.send("compacting_end", { success: false, message: `压缩失败：${(err as Error).message}` });
      }
    }

    this.send("status", { content: "思考中...", phase: "thinking" });

    // 预取 IDE 上下文（仅 IDE 形态有 host.ideContext；git diff 异步，统一在此拼好）
    this.ideContextCache = await this.buildIdeContextPrompt();

    // 预取 skill 清单（渐进式披露的轻量层），供 buildRequestMessages 同步注入
    try {
      this.skillsPromptCache = await this.skillRegistry.buildSkillsPrompt();
    } catch (err) {
      console.warn("[skill] 发现 skill 失败（忽略）:", (err as Error).message);
      this.skillsPromptCache = null;
    }

    // 预取 Power 清单，供 buildRequestMessages 同步注入
    try {
      this.powersPromptCache = this.powerRegistry ? await this.powerRegistry.buildPowersPrompt() : null;
    } catch (err) {
      console.warn("[power] 发现 power 失败（忽略）:", (err as Error).message);
      this.powersPromptCache = null;
    }

    // 预取 MCP 工具：解析配置 → 连接 server → 拉工具清单，并入本轮工具集（失败不阻塞）
    await this.prefetchMcpTools();

    // Agent 循环：总轮数上限只作极端兜底（正常任务很难碰到），真正防死循环靠"相同调用重复检测"
    let rounds = 0;
    const policy = policyForModel(this.model);
    const MAX_ROUNDS = policy.maxRounds;
    // 防失控守卫：重复调用指纹、文件重复读、连续失败计数、reasoning 续写计数统一收敛到 LoopGuard，
    // 与子 agent 共用同一实现，阈值随模型族而定
    const guard = new LoopGuard(policy);
    // 完成前自检：本轮是否有过实质动作（改文件/跑命令）、是否已经做过收尾自检
    let didMutate = false;
    let didSelfCheck = false;
    let emptyRetried = false;
    let didDiagnose = false; // 模型是否已主动做过 check_diagnostics
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

      // 每轮开始检查取消：用户点取消后立即停止，不再调 LLM
      if (this.cancelled) {
        this.stampCancelledTurnStats(turnStartTime, streamedContentThisRound);
        return;
      }

      // 通过策略执行一个回合（策略负责调 API + 解析流式响应，产出标准化结果）
      // 每轮独立：本轮是否已发 stream_start（控制打字机启动）
      let turnStreamStarted = false;
      const callbacks: LLMStreamCallbacks = {
        onReasoningDelta: (text) => {
          // 思考过程：推送给前端展示，不持久化到消息历史
          // Quest 模式且未开启「思考」开关时，不转发 reasoning（前端也就不展示思考过程）
          if (this.mode === "quest" && !this.questThink) return;
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
          this.send("stream_delta", { content: text });
        },
        onToolCallDetected: (name, id) => {
          console.log(`[stream] tool detected: ${name} id=${id}`);
          // 立即推送 pending 卡片：大文件 str_replace/create_file 的参数（整份新内容）要流式很久，
          // 若等到执行阶段才显示，用户几十秒看不到任何反馈、卡片一出来就是 ✓。
          // 前端按 id 关联，执行阶段的 executing / tool_result 会更新同一张卡，不会重复。
          // delegate_task 有专门的 sub_agent 卡片，跳过。
          if (name === "delegate_task") return;
          this.send("tool_call", { id: id || "", name, args: {}, cwd: this.cwd, status: "pending", ...this.mcpMetaFor(name) });
        },
      };

      const turn = await strategy.runTurn({
        model: this.model,
        messages: this.buildRequestMessages(),
        tools: this.getToolDefs(),
        signal: this.abortController?.signal,
        callbacks,
        temperature: 0.2,
      });

      let contentBuffer = turn.content;
      const toolCalls = turn.toolCalls;
      const finishReason = turn.finishReason;

      // ── 循环诊断日志 ──（排查"不收尾/空转"：每轮打印一行摘要，复现一次即可看清卡在哪）
      console.log(
        `[agent-loop] round=${rounds}/${MAX_ROUNDS} model=${this.model} ` +
        `toolCalls=${toolCalls.length}${toolCalls.length ? "(" + toolCalls.map((t) => t.name).join(",") + ")" : ""} ` +
        `finish=${finishReason} contentLen=${(contentBuffer || "").length} ` +
        `didMutate=${didMutate} didSelfCheck=${didSelfCheck} didDiagnose=${didDiagnose} ` +
        `failures=${guard.failures} pendingManual=${this.host.edits.getMode() === "manual" && this.host.edits.hasPending()}` +
        ((contentBuffer || "").length ? ` head=${JSON.stringify((contentBuffer || "").slice(0, 60))}` : ""),
      );

      // 记录本回合 API 返回的真实 token 用量（用于精确驱动压缩与进度条）
      this.recordTurnUsage(turn.usage);

      // 推送 token 用量
      if (contentBuffer) {
        this.updateAndSendTokenUsage();
      }

      // 无工具调用 → 候选最终回复。但要先检测是否是"未完成的内心 OS"
      // （模型有时会在高负载下输出英文短句如 "Need more files" 然后忘了调工具，导致 turn 异常结束）
      if (toolCalls.length === 0) {
        // 根源处理 1：输出被 max_tokens 截断（finish_reason=length）→ 让模型接着写，而不是把半截内容当成最终答案
        if (finishReason === "length" && contentBuffer) {
          console.log("[agent] 输出被截断（length），注入续写引导");
          this.messages.push({ role: "assistant", content: contentBuffer });
          this.messages.push({
            role: "system",
            content: "你上一段输出因长度限制被截断了。请直接接着把剩余内容补完，不要重复已经说过的部分，也不要重新开头。",
          });
          continue;
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
            continue;
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
          // 进入下一轮循环（不发 stream_end），让模型重新生成
          continue;
        }
        // 完成前自检：已关闭（速度优先，避免 DeepSeek 等模型多跑一轮验证）。
        // 如需恢复：将下面 didSelfCheck = true 改回 false，并取消注释自检块。
        didSelfCheck = true; // 跳过自检轮
        // 空回复兜底：模型声称结束（finish=stop、无工具调用）但内容为空，
        // 这通常是 API 侧偶发的 SSE 异常（output item 未产出）。不要给用户显示空白——
        // 注入引导让模型重新生成一次回复。最多重试 1 次，防无限循环。
        if (!contentBuffer && !emptyRetried) {
          console.log(`[agent-loop] round=${rounds} 空回复兜底：content 为空但 finish=stop，注入重说引导`);
          emptyRetried = true;
          this.messages.push({
            role: "system",
            content: "你上一轮的回复内容为空（可能是网络波动）。请直接给出你的中文回答，不要调工具。",
          });
          continue;
        }
        // 自动语法检查：改了文件且模型没主动调过 check_diagnostics → 代码层自动跑一次。
        // 有错误时注入系统消息让模型修复（不收尾），无错误则正常收尾。
        // 这样不靠模型"记得调 check"，代码确保每次改文件后都有语法检查。
        if (didMutate && !didDiagnose && mutatedFiles.size > 0) {
          didDiagnose = true; // 只跑一次
          const { resolve } = require("node:path");
          const absPaths = [...mutatedFiles].map((p) => resolve(this.cwd, p));
          try {
            const diagResults = await this.host.diagnostics.check(this.cwd, absPaths);
            const hasErrors = diagResults.some((r) => !r.ok);
            if (hasErrors) {
              // 有语法/类型错误：把结果告诉模型，让它修复后再给最终回复
              const errSummary = diagResults
                .filter((r) => !r.ok)
                .map((r) => `${r.path}: ${r.details || `${r.errorCount} 个错误`}`)
                .join("\n");
              console.log(`[agent-loop] 自动 diagnostics 发现错误，注入修复引导`);
              this.messages.push({ role: "assistant", content: contentBuffer });
              this.messages.push({
                role: "system",
                content:
                  `你刚才改动的文件有语法/类型错误（自动检测到的，不是用户报告的）：\n${errSummary}\n\n` +
                  `请立即修复这些错误（用 str_replace），修好后再给最终回答。不要把有错误的代码交给用户。`,
              });
              continue;
            }
          } catch {
            // diagnostics 执行失败（如文件已删除），不阻塞正常收尾
          }
        }
        const elapsed = Date.now() - turnStartTime;
        const turnTokens = this.lastTurnTokens || contentBuffer.length;
        // Credits 计算：请求级四段加权（记忆/system/本次输入/输出），见 credits.ts
        const breakdown = { ...this.buildTokenBreakdown(), outputTokens: this.lastTurnOutputTokens || this.lastCompletionTokens || 0 };
        const credits = calculateCredits(this.model, breakdown);
        const creditDetail = buildCreditDetail(this.model, breakdown);
        this.messages.push({ role: "assistant", content: contentBuffer, turnStats: { elapsed, tokens: turnTokens, model: this.model, credits, creditDetail } } as any);
        this.persistMessages(); // 最终回复落盘，切走也保留
        console.log("[stream] Turn 结束，总耗时:", elapsed, "ms");
        console.log(`[agent-loop] round=${rounds} 分支=正常收尾（stream_end，本轮结束对话）`);
        // 本轮真实 token（拿不到 usage 时回退到字符数估算）
        this.send("stream_end", { elapsed, tokens: turnTokens, model: this.model, credits, creditDetail });
        return;
      }

      // 有工具调用 → 如果之前有流式文字，先发 stream_pause 告知前端文字暂停
      if (turnStreamStarted && contentBuffer) {
        // 过滤掉工具调用间夹带的英文内心 OS（如 "Need rest."、"Need save/add methods."）
        if (looksLikeIncompleteReply(contentBuffer)) {
          console.log("[agent] 过滤工具调用间的 reasoning 泄露:", JSON.stringify(contentBuffer.slice(0, 60)));
          contentBuffer = "";
        } else {
          this.send("stream_pause", {});
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
          this.send("tool_call", { id: toolCall.id, name: toolName, args: {}, cwd: this.cwd, status: "executing" });
          this.send("tool_result", { id: toolCall.id, name: toolName, args: {}, result: errMsg, status: "error" });
          this.messages.push({ role: "tool", tool_call_id: toolCall.id, _toolName: toolName, content: errMsg, status: "error" } as any);
          guard.recordToolResult(false, true);
          continue;
        }

        // 命令类工具：显式 cwd → 解析为绝对路径（AI 可能传相对路径如 "."），否则用终端实际工作目录
        const displayCwd = (() => {
          if (toolName !== "execute_command" && toolName !== "start_process") return "";
          const argCwd = typeof (toolArgs as { cwd?: unknown }).cwd === "string" && (toolArgs as { cwd: string }).cwd.trim();
          return argCwd ? resolve(this.cwd, argCwd) : this.terminalCwd;
        })();
        this.send("tool_call", { id: toolCall.id, name: toolName, args: toolArgs, cwd: displayCwd, status: "executing", ...this.mcpMetaFor(toolName) });

        // 推送细化状态（给前端展示具体动作）
        const statusMap: Record<string, { content: string; phase: string }> = {
          read_file: { content: "正在读取文件...", phase: "reading" },
          search: { content: "正在搜索...", phase: "searching" },
          list_dir: { content: "正在浏览目录...", phase: "searching" },
          str_replace: { content: "正在修改文件...", phase: "editing" },
          create_file: { content: "正在创建文件...", phase: "editing" },
          execute_command: { content: "正在执行命令...", phase: "running" },
          start_process: { content: "正在启动后台进程...", phase: "running" },
          get_process_output: { content: "正在读取进程输出...", phase: "running" },
          stop_process: { content: "正在停止后台进程...", phase: "running" },
          list_processes: { content: "正在列出后台进程...", phase: "running" },
          open_browser: { content: "正在打开浏览器...", phase: "running" },
          get_browser_logs: { content: "正在读取控制台/报错...", phase: "checking" },
          screenshot_page: { content: "正在截图页面...", phase: "running" },
          close_browser: { content: "正在关闭浏览器...", phase: "running" },
          browser_click: { content: "正在点击页面元素...", phase: "running" },
          browser_type: { content: "正在输入文本...", phase: "running" },
          browser_press: { content: "正在按键...", phase: "running" },
          browser_select: { content: "正在选择...", phase: "running" },
          browser_scroll: { content: "正在滚动页面...", phase: "running" },
          browser_reload: { content: "正在刷新页面...", phase: "running" },
          get_browser_network: { content: "正在读取网络请求...", phase: "checking" },
          get_browser_storage: { content: "正在读取存储数据...", phase: "checking" },
          browser_eval: { content: "正在执行 JS...", phase: "running" },
          browser_hover: { content: "正在悬停...", phase: "running" },
          browser_wait: { content: "正在等待...", phase: "running" },
          browser_get_html: { content: "正在读取 HTML...", phase: "checking" },
          browser_set_viewport: { content: "正在设置视口...", phase: "running" },
          browser_back: { content: "正在后退...", phase: "running" },
          browser_forward: { content: "正在前进...", phase: "running" },
          check_diagnostics: { content: "正在检查语法...", phase: "checking" },
          web_search: { content: "正在搜索网络...", phase: "searching" },
          web_fetch: { content: "正在获取网页...", phase: "searching" },
          delegate_task: { content: "正在委托子 Agent...", phase: "delegating" },
          use_skill: { content: "正在加载 Skill...", phase: "thinking" },
          relay_create: { content: "正在创建工作流...", phase: "planning" },
        };
        const toolStatus = statusMap[toolName] || { content: `正在执行 ${toolName}...`, phase: "executing" };
        this.send("status", toolStatus);

        // 相同调用重复检测：同名工具 + 完全相同参数
        const verdict = guard.checkToolCall(toolName, toolCall.arguments);

        let result: string;
        let status: "success" | "error" = "success";
        const meta: ToolMeta = { editId: toolCall.id };
        // execute_command：挂上"等待输入"回调——终端检测到静默时通知前端给卡片加呼吸灯
        if (toolName === "execute_command") {
          meta.onWaitingInput = () => this.send("tool_waiting_input", { toolCallId: toolCall.id });
        }
        let commandWasEdited: string | undefined; // execute_command 专用：用户编辑后的命令（仅注入 AI 上下文，不渲染给前端）

        if (!verdict.allowed) {
          // 检测到鬼打墙：拿一模一样的参数反复调同一个工具。不再执行，直接回引导
          result = verdict.message || "调用被拦截。";
          status = "error";
        } else if (toolName === "delegate_task") {
          // 委托子 agent：不走通用 executeToolCall，由 AgentSession 特殊处理（隔离执行 + 事件包装）
          try {
            result = await this.runDelegateTask(toolArgs, toolCall.id);
          } catch (err) {
            result = `委托子 Agent 失败: ${(err as Error).message}`;
            status = "error";
          }
        } else if (toolName === "parallel_research") {
          // 并行调研：派发多个只读子 agent 并发执行，聚合结论
          try {
            result = await this.runParallelResearch(toolArgs, toolCall.id);
          } catch (err) {
            result = `并行调研失败: ${(err as Error).message}`;
            status = "error";
          }
        } else if (toolName === "relay_create" || toolName === "relay_save_doc" || toolName === "relay_advance" || toolName === "relay_update_task" || toolName === "relay_review_task") {
          // Relay 工作流工具：由 AgentSession 管理状态机与落盘
          try {
            if (toolName === "relay_create") {
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
            else if (toolName === "relay_save_doc") result = await this.runRelaySaveDoc(toolArgs);
            else if (toolName === "relay_advance") result = await this.runRelayAdvance(toolArgs);
            else if (toolName === "relay_update_task") result = await this.runRelayUpdateTask(toolArgs);
            else result = await this.runRelayReviewTask(toolArgs);
          } catch (err) {
            result = `Relay 操作失败: ${(err as Error).message}`;
            status = "error";
          }
        } else if (toolName === "execute_command" || toolName === "start_process") {
          // 命令信任门：灾难硬拦 → 白名单 → 未信任则弹三档授权（execute_command 与 start_process 共用同一 gate）
          const command = String((toolArgs as { command?: unknown }).command ?? "");
          const outcome = await this.gateCommand(command, toolCall.id);
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
              result = await executeToolCall(toolName, execArgs, this.cwd, this.host, meta, this.workspaces, this.loadSkillForTool, this.web, this.loadPowerForTool);
              // 同步终端工作目录（后续命令不传 cwd 时默认在此执行）
              this.trackTerminalCwd(toolName, execArgs);
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
          try {
            result = await executeToolCall(toolName, toolArgs, this.cwd, this.host, meta, this.workspaces, this.loadSkillForTool, this.web, this.loadPowerForTool);
            this.trackTerminalCwd(toolName, toolArgs);
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

        // 连续失败计数：失败累加，成功归零。str_replace 未匹配/参数非法等"软失败"不计入
        // （错误返回里带了实际内容/行号，模型据此重试是正常纠错，不应被过早掐断）
        const softFail = status === "error" && isSoftToolFailure(toolName, result);
        guard.recordToolResult(status !== "error", softFail, { toolName, args: toolArgs });

        // 手动模式下文件改动是否进入了暂存（待确认）
        const isPending = this.host.edits.getMode() === "manual" && (toolName === "str_replace" || toolName === "create_file" || toolName === "apply_patch") && status === "success";
        // 记录本轮是否有过实质文件改动（仅 str_replace/create_file 成功才算）。
        // execute_command 不计入——跑命令看输出是验证/查看行为，不是"改动"。
        // 自检只对"改了文件"的任务有意义，验证命令本身不该触发自检。
        if (status === "success" && (toolName === "str_replace" || toolName === "create_file" || toolName === "apply_patch")) {
          didMutate = true;
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
        if (status === "success" && toolName === "check_diagnostics") {
          didDiagnose = true;
        }
        this.send("tool_result", { id: toolCall.id, name: toolName, args: toolArgs, result: result.slice(0, 500), status, fileDiff: meta.fileDiff, fileDiffs: meta.fileDiffs, readRange: meta.readRange, diagnostics: meta.diagnostics, searchResults: (meta as any).searchResults, fetchResult: (meta as any).fetchResult, powerActivated: (meta as any).powerActivated, pending: isPending, userMessage: meta.userMessage, hidden: meta.hidden, resolvedPath: (meta as any).resolvedPath, ...this.mcpMetaFor(toolName) });
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
        this.messages.push({ role: "tool", tool_call_id: toolCall.id, _toolName: toolName, content: storedResult, displayContent: commandWasEdited ? result : undefined, displayCommand: commandWasEdited || undefined, status, fileDiff: meta.fileDiff, fileDiffs: meta.fileDiffs, readRange: meta.readRange, diagnostics: meta.diagnostics, searchResults: (meta as any).searchResults, fetchResult: (meta as any).fetchResult, powerActivated: (meta as any).powerActivated, pending: isPending, userMessage: meta.userMessage, ...this.mcpMetaFor(toolName) } as any);
        // screenshot_page：收集截图 URL,等所有 tool 结果都 push 完后再统一追加 user 图片消息
        // （不能在 tool 结果中间插 user——会违反 "tool_calls must be immediately followed by tool messages" 规则导致 400）
        if (meta.screenshotDataUrl) {
          ((this as any).__pendingScreenshots ??= []).push(meta.screenshotDataUrl);
        }
        // 同步当前待确认列表给前端
        if (isPending) {
          this.sendEditsUpdated();
          this.onPendingChanged?.();
        }
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
          console.log(`[agent] 卡住（${stuck?.key ?? "连续失败"}）→ 反思·换路`);
          await this.injectReflection(stuck, guard);
          continue;
        }
        if (guard.canSummaryRestart()) {
          console.log(`[agent] 反思仍无效（${stuck?.key ?? "连续失败"}）→ 摘要重启`);
          await this.injectSummaryRestart(stuck, guard, client);
          continue;
        }
        // 阶梯耗尽仍卡住 → 强制收尾投降，让模型如实向用户说明
        console.log(`[agent] 升级阶梯耗尽，强制中断`);
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
      // AbortError（用户取消）：持久化已输出的内容，不丢失
      const error = err as Error;
      if (error.name === "AbortError" || error.message?.includes("aborted") || this.cancelled) {
        this.stampCancelledTurnStats(turnStartTime, streamedContentThisRound);
        throw err; // 继续上抛让外层 persistOnCancel 处理
      }
      throw err; // 非取消异常继续上抛
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
        messages: this.buildRequestMessages(),
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

