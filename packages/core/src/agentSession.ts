/**
 * Agent Session - 每个 WebSocket 连接一个实例
 *
 * 复用 cli 的核心逻辑，但通过 WS 推送中间状态给前端。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { resolve } from "node:path";
import { executeToolCall, toolContentLimit, ToolError, ToolName, ToolCallStatus, statusForTool, SOFT_FAIL_TOOLS, EDIT_PERSIST_TOOLS, type ToolMeta, type WebCapability, type ApprovalDecision, type TrustRule, type GateOutcome } from "./tools/index.js";
import { calculateCredits, buildCreditDetail } from "./credits.js";
import type { AgentHost } from "./host/index.js";
import type { AgentChannel, AgentEvent } from "./channel/index.js";
import { needsCompaction, compactMessages, pruneOldToolResults, DEFAULT_COMPACTION_CONFIG, setPruneKeepChars } from "./compactor.js";
import type { CompactionUserConfig } from "./compactor.js";
import type { CreditBudgetUserConfig } from "./credits.js";
import type { SerializedPendingEdit } from "./storage/types.js";
import type { LLMStreamCallbacks, ToolDef, LLMStrategy, LLMTurnResult, NormalizedToolCall } from "./llm/types.js";
import type { NormalizedFinishReason } from "./llm/finishReasonMapper.js";
import { StrategyTurnSource } from "./llm/strategyTurnSource.js";
import { DefaultLLMHandler } from "./llm/llmHandler.js";
import { DefaultOutputHandler } from "./llm/outputHandler.js";
import { SkillRegistry } from "./skills/skillLoader.js";
import { PowerRegistry } from "./powers/powerLoader.js";
import { looksLikeIncompleteReply, LoopGuard, policyForModel, isSoftToolFailure, buildReflectionPrompt, buildSummaryRestartPrompt, type StuckTarget, type LoopGuardSnapshot } from "./agentGuards.js";
import { McpRegistry } from "./mcp/mcpRegistry.js";
import { modelContextWindow } from "./llm/modelContext.js";
import { SYSTEM_PROMPT, QUEST_SYSTEM_PROMPT } from "./systemPrompt.js";
import { getStrategy, ZHIPU_PROVIDER, findProviderForModel, declaredThinkingFor, declaredCacheControlFor, declaredVisionFor, getVisionFallbackModel } from "./providers.js";
import { DEFAULT_MODEL_ID } from "./providerCatalog.js";
import { PromptBuilder, messageText } from "./session/promptBuilder.js";
import { flattenToolHistory } from "./messageSanitizer.js";
import {
  resolveToolDispatchRoute,
  CommandToolExecutor,
  RelayToolExecutor,
  DelegatedToolExecutor,
  McpToolExecutor,
  GenericToolExecutor,
  ToolOutcomeRecorder,
  SessionTraceWriter,
  truncateForTrace,
  TurnFinalizer,
  ToolOutcomeStateResolver,
  ToolOutcomePostSync,
  NoToolTurnDecider,
  ErrorTurnHandler,
  ReflectionHandler,
  ToolCallExecutor,
  type TurnState,
} from "./session/index.js";
import { TokenAccountant } from "./session/tokenAccountant.js";
import { ToolDefBuilder } from "./session/toolDefBuilder.js";
import { McpController } from "./session/mcpController.js";
import { DelegateRunner } from "./session/delegateRunner.js";
import { ParallelRunner } from "./session/parallelRunner.js";
import { RelayToolRunner } from "./session/relayToolRunner.js";
import { CommandGateController } from "./session/commandGateController.js";
import { resolveInWorkspaces } from "./tools/search.js";
import { CommandGate } from "./tools/index.js";
import { EditController } from "./session/editController.js";
import { CompactionController } from "./session/compactionController.js";
import { CreditBudgetGate } from "./session/creditBudgetGate.js";
import { RelayStore } from "./relay/relayStore.js";
import { SnapshotManager, SNAPSHOT_TOOLS } from "./snapshot/index.js";
import type { EditSnapshot } from "./host/scopedHost.js";
import type { McpCapability } from "./mcp/types.js";


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
  /** @internal */ readonly promptBuilder: PromptBuilder;
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
  /** @internal */ turnCount = 0;
  /** @internal */ lastTotalTokens = 0;
  /** @internal */ lastPromptTokens = 0;
  /** @internal */ lastCompletionTokens = 0;
  /** @internal */ lastCachedTokens = 0;
  /** @internal */ cumulativeTokens = 0;
  /** @internal */ lastTurnTokens = 0;
  /** 本轮开始前的累计 token 快照（取消时用差值复原本轮消耗） */
  /** @internal */ turnStartCumulative = 0;
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
  /** 每个 session 一份 JSONL trace 文件写入器（记录 turn / tool / reasoning / text 的原始时序证据）。 */
  private readonly traceWriter: SessionTraceWriter;
  /** 工具执行分支路由执行器（拆薄 dispatchToolCall 的 route 分支）。 */
  /** @internal */ readonly commandToolExecutor: CommandToolExecutor;
  /** @internal */ readonly delegatedToolExecutor: DelegatedToolExecutor;
  /** @internal */ readonly relayToolExecutor: RelayToolExecutor;
  /** @internal */ readonly mcpToolExecutor: McpToolExecutor;
  /** @internal */ readonly genericToolExecutor: GenericToolExecutor;
  /** 纯逻辑协作者：收尾 / 无工具决策 / 工具结果三段式拆分。 */
  /** @internal */ readonly turnFinalizer: TurnFinalizer;
  /** @internal */ readonly toolOutcomeStateResolver: ToolOutcomeStateResolver;
  /** @internal */ readonly toolOutcomeRecorder: ToolOutcomeRecorder;
  /** @internal */ readonly toolOutcomePostSync: ToolOutcomePostSync;
  private readonly noToolTurnDecider: NoToolTurnDecider;
  /** 异常/取消 turn 统计兜底（解耦自本类）。 */
  private readonly errorTurnHandler: ErrorTurnHandler;
  /** 反思/深度复盘（解耦自本类）。 */
  private readonly reflectionHandler: ReflectionHandler;
  /** 工具调用执行链（拆薄 dispatchToolCall/executeSingleToolCall/recordToolOutcome/runToolDispatch）。 */
  private readonly toolCallExecutor: ToolCallExecutor;
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
  /** Credits 预算门（软提醒 + 硬暂停，解耦自本类） */
  private readonly creditBudgetGate: CreditBudgetGate;
  /** 跨用户回合的 LoopGuard 快照：避免同一未解决根因每轮重新触发相同反思/摘要话术。 */
  /** @internal */ loopGuardSnapshot: LoopGuardSnapshot | null = null;
  // 执行中的 relay 任务上下文：记录当前正在执行哪个 relay/任务，及该任务改动过的文件（供评审定位）
  /** @internal */ activeRelayTask: { relayId: string; taskId: string; changedFiles: Set<string> } | null = null;
  // 本轮用户输入内是否已推进过一次 Relay 阶段。确认门铁律：一条用户消息最多推进一个文档阶段，
  // 防止模型在同一回合里自己写完文档又自己 advance、连续跨多个阶段（无视用户确认）。
  /** @internal */ relayAdvancedThisTurn = false;

  // ── Quest（纯问答）模式 ──────────────────────────────────────────────────
  // mode=quest 时：不绑定工作区语义、禁用所有读写/执行工具（仅在开启联网时放行 web 工具）、
  // 使用问答系统提示。think 控制是否把 reasoning_delta 转发给前端。
  /** @internal */ readonly mode: "agent" | "quest";
  /**
   * 是否请求模型思考（用户开关，默认开）。
   *
   * 一个开关同时管两件事：**不向模型请求思考** + **不向前端转发 reasoning**。
   * 早先这是 Quest 专属的 questThink，且只管转发——模型照样在想、照样计费，
   * 只是不给用户看，省不下任何东西。合并后关掉它是真的少花钱少等待。
   *
   * 注意方向性：关闭是安全的（不下发参数即可），强制开启不是——
   * 中转网关收到不认识的 thinking 参数会直接断流，而断流不可静默恢复
   * （那时部分正文已经流给用户了）。所以本开关只负责"允许关"，
   * "是否能开"仍由各 strategy 按模型判断。
   */
  /** @internal */ think = true;
  /** @internal */ questWebSearch = false;

  constructor(cwd: string, channel: AgentChannel, host: AgentHost, existingMessages?: ChatCompletionMessageParam[], workspaces?: string[], homeDir?: string, web?: WebCapability, mode: "agent" | "quest" = "agent", mcp?: McpCapability, commandGate?: CommandGate) {
    this.mode = mode;
    this.model = process.env.DEFAULT_MODEL || DEFAULT_MODEL_ID;
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
    this.commandGateController = new CommandGateController(this, commandGate ?? new CommandGate());
    this.editController = new EditController(this);
    this.compactionController = new CompactionController(this);
    this.creditBudgetGate = new CreditBudgetGate(this);
    this.traceWriter = new SessionTraceWriter({ host: this.host, cwd: this.cwd });
    this.delegatedToolExecutor = new DelegatedToolExecutor({
      runDelegateTask: (args, id) => this.runDelegateTask(args, id),
      runParallelResearch: (args, id) => this.runParallelResearch(args, id),
      runParallelExecution: (args, id) => this.runParallelExecution(args, id),
    });
    this.relayToolExecutor = new RelayToolExecutor({
      waitForToolConfirmation: (name, args, kind, label) => this.waitForToolConfirmation(name, args, kind, label),
      runRelayCreate: (args) => this.runRelayCreate(args),
      runRelaySaveDoc: (args) => this.runRelaySaveDoc(args),
      runRelayAdvance: (args) => this.runRelayAdvance(args),
      runRelayUpdateTask: (args) => this.runRelayUpdateTask(args),
      runRelayReviewTask: (args) => this.runRelayReviewTask(args),
    });
    this.mcpToolExecutor = new McpToolExecutor({
      runMcpTool: (name, args) => this.runMcpTool(name, args),
    });
    this.commandToolExecutor = new CommandToolExecutor({
      cwd: this.cwd,
      host: this.host,
      workspaces: this.workspaces,
      web: this.web,
      signal: this.abortController?.signal,
      skillLoader: this.loadSkillForTool,
      powerLoader: this.loadPowerForTool,
      gateCommand: (command, id) => this.gateCommand(command, id),
      trackTerminalCwd: (name, args, toolMeta) => this.trackTerminalCwd(name, args, toolMeta),
    });
    this.genericToolExecutor = new GenericToolExecutor({
      cwd: this.cwd,
      host: this.host,
      workspaces: this.workspaces,
      web: this.web,
      skillLoader: this.loadSkillForTool,
      powerLoader: this.loadPowerForTool,
      snapshotMgr: this.snapshotMgr,
      sendSnapshotsListed: (snapshots) => this.send("snapshots_listed", { snapshots }),
      trackTerminalCwd: (name, args, toolMeta) => this.trackTerminalCwd(name, args, toolMeta),
    });
    this.turnFinalizer = new TurnFinalizer();
    this.toolOutcomeStateResolver = new ToolOutcomeStateResolver();
    this.toolOutcomeRecorder = new ToolOutcomeRecorder({
      send: (type, data) => this.send(type, data),
      pushToolMessage: (msg) => this.messages.push(msg as any),
      markNextAsTransient: () => { (this as any).__markNextAsTransient = true; },
    });
    this.toolOutcomePostSync = new ToolOutcomePostSync({
      trace: (type, payload, turn) => this.appendTrace(type, payload, turn),
      markLastToolMessageTransient: () => { (this.messages[this.messages.length - 1] as any)._transient = true; },
      enqueueScreenshot: (dataUrl) => { ((this as any).__pendingScreenshots ??= []).push(dataUrl); },
      sendEditsUpdated: (rejected) => this.sendEditsUpdated(rejected),
      onPendingChanged: this.onPendingChanged,
    });
    this.noToolTurnDecider = new NoToolTurnDecider();
    this.errorTurnHandler = new ErrorTurnHandler(this);
    this.reflectionHandler = new ReflectionHandler(this);
    this.toolCallExecutor = new ToolCallExecutor(this);
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

  /** 设置 Credits 预算门配置（由呈现端在启动时 / 配置变更时调用） */
  setCreditBudgetConfig(cfg: Partial<CreditBudgetUserConfig>): void {
    this.creditBudgetGate.setConfig(cfg);
  }

  /** 获取当前 Credits 预算门配置（诊断 / UI 展示用） */
  getCreditBudgetConfig(): CreditBudgetUserConfig {
    return this.creditBudgetGate.config;
  }

  /** 获取当前完整消息列表（持久化用） */
  getMessages(): ChatCompletionMessageParam[] {
    return this.messages;
  }

  /** 编辑历史用户消息（同步影响后续上下文与持久化）。 */
  editUserMessage(messageId: string, content: string, userIndex?: number, images?: string[], attachedFiles?: unknown[]): boolean {
    const normalized = content ?? "";
    let seen = -1;
    let totalUserMsgs = 0;
    for (const m of this.messages as any[]) {
      if (m.role === "user" && !m._screenshotInjection) totalUserMsgs++;
    }
    console.log(`[edit_user_message] messageId=${messageId} userIndex=${userIndex} totalUserMsgs=${totalUserMsgs} images=${images?.length ?? 0} files=${attachedFiles?.length ?? 0}`);
    for (const m of this.messages as any[]) {
      if (m.role !== "user" || m._screenshotInjection) continue;
      seen++;
      const hitById = messageId && m.clientMessageId === messageId;
      const hitByIndex = typeof userIndex === "number" && seen === userIndex;
      if (!hitById && !hitByIndex) continue;

      console.log(`[edit_user_message] MATCHED at seen=${seen} clientMessageId=${m.clientMessageId || "(none)"} oldContentLen=${typeof m.content === "string" ? m.content.length : Array.isArray(m.content) ? `array(${m.content.length})` : "?"} -> newContentLen=${normalized.length}`);
      // 重建 content：根据是否保留图片决定 string 还是 array
      if (images && images.length > 0) {
        const parts: any[] = [];
        if (normalized) parts.push({ type: "text", text: normalized });
        for (const img of images) parts.push({ type: "image_url", image_url: { url: img } });
        m.content = parts;
      } else {
        m.content = normalized;
      }
      m.displayText = normalized;
      // 更新附件元数据
      if (attachedFiles && (attachedFiles as any[]).length > 0) {
        m.attachedFiles = attachedFiles;
      } else {
        delete m.attachedFiles;
      }
      delete m.userSegments;
      m.editedAt = Date.now();
      this.persistMessages();
      return true;
    }
    console.warn(`[edit_user_message] NO MATCH found for messageId=${messageId} userIndex=${userIndex}`);
    return false;
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

  /**
   * 压平历史里的结构化工具调用：把 assistant.tool_calls + 后续 tool 结果，合并成一条
   * 纯文本 assistant 消息（"此前调用了 X，结果…"）。
   *
   * 目的：deepseek-v4 这类模型对 OpenAI function calling 历史回放不稳定，若看到大量
   * 结构化 tool_calls/tool 消息会被带偏、开始用 DSML 等非标准格式"自由发挥"（甚至脑补
   * 出错误工具名）。压平后历史只保留纯文本对话，从干净上下文起步。
   *
   * 由用户主动触发（前端提示"压缩不兼容记忆"），不做自动压平——避免其它模型切换方向
   * 白白丢失结构化信息。
   */
  /** @internal */ flattenToolHistory(): void {
    this.messages = flattenToolHistory(this.messages);
  }

  /**
   * 用识图兜底模型把图片转成文字描述。
   * 主模型不支持图片（vision === false）时，先用兜底模型"看"图，产出文字描述供主模型消费。
   * 识图失败（网络/配置问题）不阻塞主流程，返回空串，上层降级为"图片无法描述"。
   */
  /** @internal */ async describeImagesWithFallback(images: string[]): Promise<string> {
    const fallbackModel = getVisionFallbackModel();
    if (!fallbackModel) return "";
    const provider = findProviderForModel(fallbackModel);
    if (!provider) {
      console.warn(`[vision-fallback] 兜底识图模型 "${fallbackModel}" 未在任何 provider 中找到`);
      return "";
    }
    try {
      const strategy = getStrategy(provider, fallbackModel);
      const content = images.map((img) => ({ type: "image_url" as const, image_url: { url: img } }));
      const turn = await strategy.runTurn({
        model: fallbackModel,
        messages: [
          {
            role: "system",
            content:
              "你是识图助手。请完整、详细地描述用户提供的图片：转录图中所有可见文字、代码、数字、表格，描述界面布局/结构/颜色区块，说明图片类型（截图/代码/文档/照片等）和关键信息。只输出客观描述，不要评价、不要提问、不要臆测图中没有的内容。",
          },
          { role: "user", content },
        ],
        tools: [],
        signal: this.abortSignal,
        callbacks: { onReasoningDelta: () => {}, onTextDelta: () => {}, onToolCallDetected: () => {} },
        think: false,
        modelSupportsThinking: false,
      });
      return turn.content || "";
    } catch (err) {
      console.warn("[vision-fallback] 识图兜底失败（忽略）:", (err as Error).message);
      return "";
    }
  }

  /** 序列化 pendingEdits 为可持久化数组 */
  serializePendingEdits(): SerializedPendingEdit[] {
    return this.host.edits.serialize().map((e: SerializedPendingEdit) => ({
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
    this.host.edits.restore(edits.map((e: SerializedPendingEdit) => ({
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

    /** cancel() 兜底（委托 ErrorTurnHandler）。 */
  private sendTurnCancelledFallback(): void {
    this.errorTurnHandler.sendTurnCancelledFallback();
  }


    /** 判断第三方 provider 错误（委托 ErrorTurnHandler）。 */
  private isExternalProviderError(err: Error): boolean {
    return this.errorTurnHandler.isExternalProviderError(err);
  }


    /** 展示第三方错误（委托 ErrorTurnHandler）。 */
  private emitTransientError(errMsg: string, turnStartTime: number, streamedContentThisRound: string): void {
    this.errorTurnHandler.emitTransientError(errMsg, turnStartTime, streamedContentThisRound);
  }


    /** provider/网关异常落盘（委托 ErrorTurnHandler）。 */
  private stampAbortedTurnStats(turnStartTime: number, streamedContent?: string, reason?: "cancelled" | "error"): void {
    this.errorTurnHandler.stampAbortedTurnStats(turnStartTime, streamedContent, reason);
  }


  /** 手动触发上下文压缩（供前端"压缩上下文"按钮调用）。需超过当前模型窗口 35% 才允许。 */
  /**
   * 手动触发上下文压缩（委托 CompactionController）。
   * model/provider 可选：前端切换了模型选择器但尚未发送消息时，会话内部的
   * this.model/this.provider 仍是上一条消息用的值；这里先同步再压缩，避免用
   * 旧 provider 调用摘要 LLM（多 provider 存在同名模型时会调错端点）。
   */
  async compactSession(model?: string, provider?: string): Promise<void> {
    if (model && model !== this.model) this.model = model;
    if (provider && provider !== this.provider) this.provider = provider;
    await this.compactionController.compactSession();
  }

  /** 强制压缩上下文（不检查阈值，用于上下文超限场景）。 */
  async forceCompactSession(model?: string, provider?: string): Promise<void> {
    if (model && model !== this.model) this.model = model;
    if (provider && provider !== this.provider) this.provider = provider;
    await this.compactionController.forceCompactSession();
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

    /** 取消退出时补 turnStats（委托 ErrorTurnHandler）。 */
  /** @internal */ stampCancelledTurnStats(turnStartTime: number, streamedContent?: string): void {
    this.errorTurnHandler.stampCancelledTurnStats(turnStartTime, streamedContent);
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
  resolveToolConfirmation(confirmed: boolean, mode?: "strict" | "auto"): void {
    if (mode) this.pendingRelayMode = mode;
    if (this.toolConfirmResolve) {
      this.toolConfirmResolve(confirmed);
      this.toolConfirmResolve = null;
    }
  }

  /** 用户在确认门选择的 Relay 模式（创建后清空） */
  /** @internal */ pendingRelayMode?: "strict" | "auto";

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
          this.send("tool_confirm_timeout", { toolName });
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

  /**
   * 解析子 Agent 执行阶段（delegate_task / parallel_execute）应使用的 provider + model。
   * 若当前处于某个 Relay 任务的执行上下文（this.activeRelayTask 有值）且该 Relay 配置了
   * modelOverrides.executing，且该模型能在已配置的 provider 目录中找到 → 用覆盖值；
   * 否则回退到当前会话的 provider + model（未配置模型覆盖时的默认行为）。
   */
  /** @internal */ async resolveExecutingModel(): Promise<{ provider: string; model: string }> {
    if (this.activeRelayTask) {
      try {
        const relay = await this.relayStore.get(this.activeRelayTask.relayId);
        const overrideModel = relay?.modelOverrides?.executing;
        if (overrideModel) {
          const provider = findProviderForModel(overrideModel, this.provider);
          if (provider) return { provider, model: overrideModel };
          console.warn(`[relay] 执行阶段模型覆盖 "${overrideModel}" 未在已配置的 provider 中找到（或存在多 provider 歧义），回退到当前会话模型`);
        }
      } catch { /* 读取失败不阻塞执行，回退默认 */ }
    }
    return { provider: this.provider, model: this.model };
  }

  /** 设置当前会话 id（relay 关联用，由 index.ts 在加载/创建会话时调用） */
  setSessionId(id: string): void {
    this.currentRelaySessionId = id;
    // 同步设置快照管理器的 sessionId，实现快照的 session 隔离
    this.snapshotMgr.setSessionId(id);
    // 初始化该 session 的 JSONL trace 文件（不阻塞主流程）
    void this.traceWriter.init(id);
    void this.traceWriter.append({ ts: new Date().toISOString(), sessionId: id, type: "session.id_bound", payload: { workspace: this.cwd, model: this.model, provider: this.provider } });
  }

  /** 获取当前会话 id（持久化时绑定到正确的会话文件，避免切换会话后串写） */
  getSessionId(): string {
    return this.currentRelaySessionId || "";
  }

  /** 本会话内由 AI 创建/编辑且仍需重新诊断的文件（绝对路径）。 */
  /** @internal */ readonly aiTouchedFilesNeedingDiagnostics = new Set<string>();

  /** 供 Hub/控制器追加一条 session trace 事件（结构化时序证据）。 */
  /** @internal */ appendTrace(type: string, payload?: unknown, turn?: number): void {
    this.trace(type, payload, turn);
  }

  /** 追加一条 session trace 事件（忽略 session 未初始化时的早期调用）。 */
  private trace(type: string, payload?: unknown, turn?: number): void {
    const sessionId = this.getSessionId();
    if (!sessionId) return;
    void this.traceWriter.append({ ts: new Date().toISOString(), sessionId, type, turn, payload });
  }

  /** 统一发事件给前端，并对关键事件补一份 session trace。 */
  /** @internal */ send(type: string, data: Record<string, unknown> = {}): void {
    // 先对会话级关键事件做 trace，再发给前端。这里只记高价值事件，避免把所有 stream_delta 都重复落两份。
    switch (type) {
      case "tool_call":
        this.trace("tool.call", {
          id: data.id,
          name: data.name,
          status: data.status,
          args: data.args,
          cwd: data.cwd,
          mcpServer: data.mcpServer,
          mcpTool: data.mcpTool,
        }, this.turnCount || undefined);
        break;
      case "tool_result":
        this.trace("tool.result.event", {
          id: data.id,
          name: data.name,
          status: data.status,
          userMessage: data.userMessage,
          hidden: data.hidden,
          pending: data.pending,
          result: typeof data.result === "string" ? truncateForTrace(data.result, 2000) : data.result,
        }, this.turnCount || undefined);
        break;
      case "stream_start":
      case "stream_pause":
        this.trace(type, data, this.turnCount || undefined);
        break;
      case "stream_end":
        this.trace("stream.end", data, this.turnCount || undefined);
        break;
      case "turn_cancelled":
        this.trace("turn.cancelled", data, this.turnCount || undefined);
        break;
      case "status":
        this.trace("status", data, this.turnCount || undefined);
        break;
      case "confirm_command_request":
        this.trace("command.confirm_request", {
          requestId: data.requestId,
          command: data.command,
          toolCallId: data.id,
          delegateId: data.delegateId,
        }, this.turnCount || undefined);
        break;
      case "command_blocked":
        this.trace("command.blocked", data, this.turnCount || undefined);
        break;
      case "confirm_tool_request":
        this.trace("tool.confirm_request", data, this.turnCount || undefined);
        break;
      case "session_created":
      case "session_loaded":
      case "session_title_updated":
      case "workspace_set":
      case "edits_updated":
      case "snapshots_listed":
        this.trace(type, data, this.turnCount || undefined);
        break;
      default:
        break;
    }
    this.channel.emit({ type, ...data } as AgentEvent);
  }

  /** 工具定义装配（委托 ToolDefBuilder） */
  /** @internal */ getToolDefs(): ToolDef[] {
    return this.toolDefBuilder.getToolDefs();
  }

  /** 设置思考开关（每轮用户输入前由 SessionHub 注入，agent / quest 两种模式都生效） */
  setThink(think: boolean): void {
    this.think = think;
  }

  /** 设置 Quest 模式选项（每轮用户输入前由 SessionHub 注入） */
  setQuestOptions(opts: { webSearch?: boolean }): void {
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

  /** 把 AI 本会话内改过、且尚未诊断通过的文件加入待诊断集合。 */
  /** @internal */ async markAiTouchedFiles(paths: Iterable<string>): Promise<void> {
    for (const p of paths) {
      if (!p) continue;
      try {
        const abs = await resolveInWorkspaces(p, this.cwd, this.host, this.workspaces);
        this.aiTouchedFilesNeedingDiagnostics.add(abs);
      } catch {
        this.aiTouchedFilesNeedingDiagnostics.add(resolve(this.cwd, p));
      }
    }
  }

  /** check_diagnostics 成功后，从待诊断集合中移除本次已通过检查的文件。 */
  /** @internal */ async markDiagnosedFiles(toolArgs: Record<string, unknown>, meta: ToolMeta, status: "success" | "error"): Promise<void> {
    if (status !== "success") return;
    const paths = Array.isArray((toolArgs as any).paths) ? ((toolArgs as any).paths as string[]) : [];
    const diags = Array.isArray((meta as any).diagnostics) ? ((meta as any).diagnostics as Array<{ path?: string; ok?: boolean }>) : [];
    const okRel = new Set(diags.filter((d) => d.ok && typeof d.path === "string").map((d) => d.path as string));
    for (const p of paths) {
      if (!okRel.has(p)) continue;
      try {
        const abs = await resolveInWorkspaces(p, this.cwd, this.host, this.workspaces);
        this.aiTouchedFilesNeedingDiagnostics.delete(abs);
      } catch {
        this.aiTouchedFilesNeedingDiagnostics.delete(resolve(this.cwd, p));
      }
    }
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
   * 已委托 TokenAccountant，保留 @internal 方法签名供协作者及本类调用。
   */
  /** @internal */ buildTokenBreakdown(): { memoryTokens: number; systemTokens: number; questionTokens: number } {
    return this.tokenAccountant.buildTokenBreakdown();
  }

    /** 反思·换路（委托 ReflectionHandler）。 */
  private async injectReflection(stuck: StuckTarget | null, guard: LoopGuard): Promise<void> {
    await this.reflectionHandler.injectReflection(stuck, guard);
  }


    /** 深度复盘（重量层）。不压缩上下文--注入更强的复盘引导，保留完整历史作为判断依据。 */
  private async injectSummaryRestart(stuck: StuckTarget | null, guard: LoopGuard, strategy: LLMStrategy): Promise<void> {
    await this.reflectionHandler.injectSummaryRestart(stuck, guard, strategy);
  }


    /** 重读卡住目标真实内容（委托 ReflectionHandler）。 */
  private async readStuckTargetState(stuck: StuckTarget | null): Promise<string> {
    return this.reflectionHandler.readStuckTargetState(stuck);
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

    /** 工具是否必须有参数（委托 ToolCallExecutor）。 */
  private toolRequiresArguments(toolName: string): boolean {
    return this.toolCallExecutor.requiresArguments(toolName);
  }


  /** 若是 MCP 工具，返回其真实 server 名与工具名（供前端卡片展示）。
   * 不在 mcpToolMap（已禁用/移除）时，从编码名尽力还原，至少让卡片能标出 server/tool 名。 */
  /** MCP 工具的真实 server/tool 名（委托 McpController） */
  /** @internal */ mcpMetaFor(toolName: string): { mcpServer?: string; mcpTool?: string } {
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

  /** 本轮请求前的自动压缩门（委托 CompactionController）。 */
  private async maybeAutoCompactBeforeTurn(strategy: LLMStrategy): Promise<boolean> {
    return this.compactionController.maybeAutoCompactBeforeTurn(strategy);
  }


  /** 本轮 Credits 预算门（委托 CreditBudgetGate）。 */
  private async maybeCreditBudgetGate(turnStartTime: number, streamedContentThisRound: string): Promise<boolean> {
    return this.creditBudgetGate.check(turnStartTime, streamedContentThisRound);
  }

  /** 处理用户对预算暂停的选择（委托 CreditBudgetGate）。 */
  handleCreditBudgetChoice(choice: "continue" | "stop"): void {
    this.creditBudgetGate.handleChoice(choice);
  }

    /** 按工具类型分发执行（委托 ToolCallExecutor）。 */
  private async dispatchToolCall(toolName: string, toolArgs: Record<string, unknown>, toolCallId: string, verdict: { allowed: boolean; message?: string }, meta: ToolMeta, guard: LoopGuard): Promise<{ result: string; status: "success" | "error"; commandWasEdited?: string; toolArgs: Record<string, unknown> }> {
    return this.toolCallExecutor.dispatchToolCall(toolName, toolArgs, toolCallId, verdict, meta, guard);
  }

    /** 执行单个工具调用（委托 ToolCallExecutor）。 */
  private async executeSingleToolCall(toolCall: NormalizedToolCall, toolCalls: NormalizedToolCall[], guard: LoopGuard, ts: TurnState, mutatedFiles: Set<string>): Promise<void> {
    await this.toolCallExecutor.executeSingleToolCall(toolCall, toolCalls, guard, ts, mutatedFiles);
  }


    /** 工具轮编排（委托 ToolCallExecutor）。 */
  private async runToolDispatch(toolCalls: NormalizedToolCall[], guard: LoopGuard, ts: TurnState, mutatedFiles: Set<string>): Promise<void> {
    await this.toolCallExecutor.runToolDispatch(toolCalls, guard, ts, mutatedFiles);
  }


  /**
   * 正常收尾：把最终 assistant 回复（含 turnStats）落盘、推 stream_end、裁剪旧工具结果、
   * 按阈值异步触发滚动摘要。仅在"本轮无工具调用且确定为最终回复"时调用，调用后即结束本轮。
   */
  private finalizeAssistantReply(contentBuffer: string, turnStartTime: number, streamedContentThisRound: string, rounds: number): void {
    const out = this.turnFinalizer.finalize({
      contentBuffer,
      streamedContentThisRound,
      turnStartTime,
      model: this.model,
      messages: this.messages,
      lastTurnTokens: this.lastTurnTokens,
      lastTurnOutputTokens: this.lastTurnOutputTokens,
      lastCompletionTokens: this.lastCompletionTokens,
      buildTokenBreakdown: () => this.buildTokenBreakdown(),
      compactionEnabled: this.compactionConfig.enabled,
      toolResultKeepTurns: this.compactionConfig.toolResultKeepTurns,
      rollingSummaryAccumulated: this.rollingSummaryAccumulated,
      triggerTokens: this.compactionConfig.triggerTokens,
    });
    this.messages = out.messages;
    this.persistMessages(); // 最终回复落盘，切走也保留
    this.send("stream_end", { elapsed: out.elapsed, tokens: out.turnTokens, model: this.model, credits: out.credits, creditDetail: out.creditDetail });
    this.rollingSummaryAccumulated = out.nextRollingSummaryAccumulated;
    if (out.shouldTriggerRollingSummary) {
      this.maybeRollingSummary();
    }
  }

  /**
   * 流式正文的提交门：agent 回合里 content delta 在本轮完成前语义未定，
   * 可能是最终回答，也可能只是工具调用前后的叙述。先缓冲极短片段，
   * 等它具备独立展示价值后再提交给前端，避免把 "..." 这类中间态 token
   * 提升为正式消息段。
   */
  private shouldCommitPendingAssistantText(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(trimmed)) return false;
    if (trimmed.length >= 24) return true;
    if (/\n/.test(trimmed)) return true;
    if (/[。！？.!?]\s*$/.test(trimmed) && trimmed.length >= 8) return true;
    return false;
  }

  /** 工具轮里的弱叙述：协议上是 content，但产品语义上不足以成为独立可见段。 */
  private isWeakToolNarration(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return true;
    if (!/[A-Za-z0-9\u4e00-\u9fff]/.test(trimmed)) return true;
    if (trimmed.length <= 3) return true;
    return false;
  }

    /** 记录工具结果（委托 ToolCallExecutor）。 */
  private recordToolOutcome(toolCallId: string, toolName: string, toolArgs: Record<string, unknown>, result: string, status: "success" | "error", commandWasEdited: string | undefined, meta: ToolMeta, displayCwd: string, guard: LoopGuard, mutatedFiles: Set<string>): { mutated: boolean; diagnosed: boolean } {
    return this.toolCallExecutor.recordToolOutcome(toolCallId, toolName, toolArgs, result, status, commandWasEdited, meta, displayCwd, guard, mutatedFiles);
  }


  /**
   * 回合产出：由新链路（LLMTurnSource → DefaultLLMHandler）驱动本回合的 LLM 推进。
   *
   * - 流式增量【实时转发】给前端（通过复用主循环的 callbacks），用户看到正常的打字/思考效果。
   * - 只跑一次回合，不产生双倍 token。
   *
   * 接管边界：
   * - 接管的是「回合产出 + 归一化」这一层——LLMTurnSource 执行协议、DefaultLLMHandler 归一化成统一草案。
   * - 归一化后的草案回填成主循环消费的 LLMTurnResult 形状，下游（工具执行/收尾/计费/持久化）复用同一套逻辑。
   */
  private async runPipelineTurn(
    strategy: LLMStrategy,
    requestMessages: ChatCompletionMessageParam[],
    callbacks: LLMStreamCallbacks,
  ): Promise<LLMTurnResult> {
    const MAX_RETRIES = 5;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const turnSource = new StrategyTurnSource({
          strategy,
          model: this.model,
          tools: this.getToolDefs(),
          temperature: 0.2,
          signal: this.abortController?.signal,
          think: this.think,
          modelSupportsThinking: declaredThinkingFor(this.model, this.provider),
          modelSupportsCacheControl: declaredCacheControlFor(this.model, this.provider),
          modelSupportsVision: declaredVisionFor(this.model, this.provider),
          // 关键：把新链路的流式增量实时接到主循环 callbacks 上，让前端看到正常的思考/打字效果。
          onReasoningDelta: (text, partIndex, itemId) => callbacks.onReasoningDelta(text, partIndex, itemId),
          onTextDelta: (text) => callbacks.onTextDelta(text),
          // 工具检测信号也要接上：否则主循环的 onToolCallDetected 永远收不到调用，
          // 卡片只能等整条 SSE 流消费完才发得出来（工具参数体常常就是模型输出的主体）。
          onToolCallDetected: (name, id) => callbacks.onToolCallDetected(name, id),
        });
        const handler = new DefaultLLMHandler(turnSource);
        const draft = await handler.handle({
          requestId: `req-${this.turnCount}`,
          turnId: `turn-${this.turnCount}-${Date.now()}`,
          effectiveMessages: requestMessages,
        });
        console.log(`[pipeline] 新链路驱动本回合，stage=${draft.stage}，toolDrafts=${draft.toolDrafts.length}`);

        // 把新链路草案回填成老循环消费的 LLMTurnResult 形状。
        // 工具草案 → NormalizedToolCall：id/name/arguments 与老协议一一对应，rawArgsText 即原始参数串。
        const toolCalls: NormalizedToolCall[] = draft.toolDrafts.map((td) => ({
          id: td.callId,
          name: td.toolName,
          arguments: td.rawArgsText ?? "",
        }));
        const normalized: NormalizedFinishReason = draft.finishReason ?? "complete";
        return {
          content: draft.contentDraft ?? "",
          toolCalls,
          finishReason: normalized,
          normalizedFinishReason: normalized,
          usage: draft.usage,
        };
      } catch (err) {
        const error = err as Error;
        // 取消/中止：不重试，直接上抛
        if (error.name === "AbortError" || error.message?.includes("aborted") || this.cancelled) {
          throw err;
        }
        // 判断是否为可重试的瞬态错误（网络错误、429 限流、5xx 服务端错误）
        if (!this.isRetryableError(error) || attempt >= MAX_RETRIES) {
          if (this.isRetryableError(error)) {
            // 重试耗尽
            this.send("retry", { attempt: MAX_RETRIES, maxRetries: MAX_RETRIES, error: this.formatUserFacingError(error), status: "failed" });
          }
          throw err;
        }
        lastError = error;
        // 指数退避：1s, 2s, 4s, 8s, 16s
        const delay = Math.min(1000 * Math.pow(2, attempt), 16000);
        console.warn(`[pipeline] 接口失败（${error.message}），${delay / 1000}s 后第 ${attempt + 1} 次重试...`);
        this.send("retry", { attempt: attempt + 1, maxRetries: MAX_RETRIES, error: this.formatUserFacingError(error), status: "retrying" });
        await new Promise((resolve) => setTimeout(resolve, delay));
        // 等待期间检查取消
        if (this.cancelled) {
          throw lastError;
        }
      }
    }
    // 不应到达这里（循环内已 return 或 throw），兜底上抛最后一个错误
    throw lastError!;
  }

  /** 裁剪对用户展示的错误：保留有用摘要，避免把 HTML/堆栈整段塞进 UI。 */
  private formatUserFacingError(error: Error): string {
    const raw = error.message || String(error);
    const firstLine = raw.split(/\r?\n/)[0]?.trim() || raw.trim();

    // OpenAI SDK 常见格式："401 status code (no body)" / "502 status code"
    const sdkStatus = firstLine.match(/^(\d{3})\s+status code(?:\s*\(([^)]*)\))?/i);
    if (sdkStatus) {
      const code = Number(sdkStatus[1]);
      const reason = this.httpStatusText(code);
      const noBody = /no body/i.test(sdkStatus[2] || firstLine);
      return `HTTP ${code}${reason ? ` ${reason}` : ""}${noBody ? "（无响应体）" : ""}`;
    }

    // 常见 HTTP 错误：保留到 status text 为止，例如：HTTP 502 Bad Gateway / 429 Too Many Requests
    const http = firstLine.match(/^(.*?HTTP\s+\d{3}\s+[^-:<\{\[]+)/i);
    if (http?.[1]) return http[1].trim();

    // JSON 错误体：尽量提取 error.message
    const jsonStart = raw.indexOf("{");
    if (jsonStart >= 0) {
      try {
        const obj = JSON.parse(raw.slice(jsonStart));
        const msg = obj?.error?.message || obj?.message;
        if (msg) return `${firstLine.slice(0, jsonStart).replace(/[-:\s]+$/, "").trim()} - ${String(msg).trim()}`.trim();
      } catch {
        // ignore parse failure
      }
    }

    // HTML 错误页：只保留 HTML 前的摘要
    const htmlIdx = firstLine.search(/<!DOCTYPE|<html|<body/i);
    if (htmlIdx > 0) return firstLine.slice(0, htmlIdx).replace(/[-:\s]+$/, "").trim();

    // 兜底：单行截断
    return firstLine.length > 240 ? `${firstLine.slice(0, 240)}...` : firstLine;
  }

  private httpStatusText(code: number): string {
    const map: Record<number, string> = {
      400: "Bad Request",
      401: "Unauthorized",
      403: "Forbidden",
      404: "Not Found",
      408: "Request Timeout",
      409: "Conflict",
      413: "Payload Too Large",
      422: "Unprocessable Entity",
      429: "Too Many Requests",
      500: "Internal Server Error",
      502: "Bad Gateway",
      503: "Service Unavailable",
      504: "Gateway Timeout",
    };
    return map[code] || "";
  }

  /** 判断错误是否为可重试的瞬态错误 */
  private isRetryableError(error: Error): boolean {
    const msg = error.message || "";
    // 网络错误
    if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|network|fetch failed/i.test(msg)) {
      return true;
    }
    // HTTP 状态码判断（OpenAI SDK 的错误通常包含 status code）
    const statusMatch = msg.match(/\b(\d{3})\b/);
    if (statusMatch) {
      const status = parseInt(statusMatch[1], 10);
      // 429 限流、5xx 服务端错误可重试
      if (status === 429 || (status >= 500 && status <= 599)) return true;
    }
    // 限流 / 过载
    if (/rate.?limit|too many requests|overloaded|capacity|temporarily unavailable/i.test(msg)) {
      return true;
    }
    // 服务端错误
    if (/server error|internal error|bad gateway|service unavailable|gateway timeout/i.test(msg)) {
      return true;
    }
    // 连接错误
    if (/connection.*(?:reset|refused|error)|recv failure/i.test(msg)) {
      return true;
    }
    return false;
  }

  /** 判断错误是否为上下文窗口超限 */
  private isContextOverflowError(error: Error): boolean {
    const msg = error.message || "";
    return /context.*(?:length|window|limit)|maximum.*context|token.*(?:limit|exceed)|too many tokens|exceed.*(?:context|window|token)|input.*too.*long/i.test(msg);
  }

  /**
   * 收尾判定：纯回答 turn（无工具、finishReason=complete）的最终正文由 DefaultOutputHandler 产出。
   *
   * 接管边界（最小、可回落）：
   * - 只接管"最终内容判定"这一薄层：OutputHandler 在 complete 时返回 contentDraft，与 contentBuffer 等价。
   * - 真正的持久化 / 前端 stream_end / credits 计费 / 压缩触发仍复用 finalizeAssistantReply，语义天然对齐。
   *
   * 安全：任何异常都返回 null，调用方回落 contentBuffer 收尾。
   */
  private async runPipelineOutput(contentBuffer: string, finishReason: NormalizedFinishReason): Promise<string | null> {
    try {
      const handler = new DefaultOutputHandler();
      const draft = await handler.handle({
        requestId: `req-${this.turnCount}`,
        turnId: `turn-${this.turnCount}-${Date.now()}`,
        runtimeEvents: [],
        committedEvents: [],
        toolContexts: [],
        contentDraft: contentBuffer,
        finishReason,
      });
      console.log(`[pipeline] OutputHandler 接管收尾，stage=${draft.stage}，shouldContinue=${draft.shouldContinue}`);
      // complete 时 OutputHandler 返回 contentDraft；其余情形 finalContent 为空，回落原始 contentBuffer 保底。
      return draft.finalContent ?? contentBuffer;
    } catch (err) {
      console.warn("[pipeline] OutputHandler 收尾失败（已回落原始正文）:", (err as Error).message);
      return null;
    }
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
    finishReason: NormalizedFinishReason,
    guard: LoopGuard,
    ts: TurnState,
    mutatedFiles: Set<string>,
    turnStartTime: number,
    streamedContentThisRound: string,
    rounds: number,
    commitPendingText: () => void,
  ): Promise<"continue" | "done"> {
    const decision = this.noToolTurnDecider.decide({ contentBuffer, finishReason, guard, ts });

    // provider/网关级失败不能按正常 stop 收尾。
    if (decision.action === "abort_error") {
      if (contentBuffer) this.messages.push({ role: "assistant", content: contentBuffer });
      this.stampAbortedTurnStats(turnStartTime, streamedContentThisRound || contentBuffer, "error");
      return "done";
    }

    // 输出被截断（truncated，对应 max_tokens）→ 让模型接着写，而不是把半截内容当成最终答案
    if (decision.action === "continue_truncated") {
      console.log("[agent] 输出被截断（length），注入续写引导");
      commitPendingText();
      this.messages.push({ role: "assistant", content: contentBuffer });
      // 用正向指令引导续写，避免负面措辞（"不要重复"）反而把"重复"植入模型注意力焦点
      this.messages.push({
        role: "user",
        content: "系统提示：你的上一段输出到达了长度上限。请从中断处继续，输出剩余内容。直接输出下一段，保持前后衔接。",
        _tailInjected: true,
        _ephemeralInjected: true,
      } as any);
      return "continue";
    }

    if (decision.action === "continue_incomplete") {
      // 超过重试上限：不再续写，避免模型反复吐内心 OS 陷入死循环，转为强制收尾
      if (decision.forceFinalizePrompt) {
        console.log("[agent] reasoning 泄露续写已达上限，强制收尾");
        this.messages.push({ role: "assistant", content: contentBuffer });
        this.messages.push({
          role: "system",
          content: "你已多次输出未完成的内心 OS。现在必须基于已有信息，要么调用一个具体工具继续推进，要么给出完整的中文最终回答。二选一，不要再输出任何英文思考片段。",
          _tailInjected: true,
          _ephemeralInjected: true,
        } as any);
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
        _tailInjected: true,
        _ephemeralInjected: true,
      } as any);
      return "continue";
    }

    // 空回复兜底：模型声称结束（finish=stop、无工具调用）但内容为空，最多重试 1 次。
    if (decision.action === "continue_empty_retry") {
      this.messages.push({
        role: "system",
        content:
          "你上一轮的回复内容为空（API 侧偶发的 SSE 异常，不是你的问题）。" +
          "请直接重新给出你的中文回答。不要在回复中提及<网络波动>或<回复为空>——用户看不到这些注入消息，" +
          "提到只会让用户困惑。如有必要可以重新调工具。",
        _tailInjected: true,
        _ephemeralInjected: true,
      } as any);
      return "continue";
    }

    // 自动语法检查注入：已移除。
    // 原因：diagnostics.check() 返回全量诊断（包括 @types/node 缺失、lib 配置不全等环境噪音），
    // 这些是 tsconfig 配置问题，模型永远无法通过改代码修复，注入给模型只会导致死循环。
    // 模型有 check_diagnostics 工具可以主动调用做验证，代码层不需要强制注入。
    commitPendingText();
    // 收尾正文由新链路 DefaultOutputHandler 判定（complete 时等价于 contentBuffer），失败回落 contentBuffer。
    // 其余收尾（持久化/stream_end/计费/压缩）仍复用 finalizeAssistantReply。
    const taken = await this.runPipelineOutput(contentBuffer, finishReason);
    const finalContent = taken !== null ? taken : contentBuffer;
    this.finalizeAssistantReply(finalContent, turnStartTime, streamedContentThisRound, rounds);
    this.trace("turn.end", { finishReason, finalContent: truncateForTrace(finalContent || "", 2000) }, this.turnCount);
    return "done";
  }

  /**
   * 增强渲染代码块输出时的动态进度提示。根据已输出的流式内容判断：
   * - 检测到显式增强代码块开始标记 → "正在绘制 X..."（X=流程图/序列图/SVG 图形/页面原型）
   * - 内容增长到一定量 → "正在添加细节..."
   * - 接近结束（检测到闭合标记） → 回到"正在回复..."
   * 避免每个 chunk 都发状态（节流：只在阶段切换时发一次）。
   */
  private _drawingPhase: "none" | "started" | "detail" = "none";
  private updateDrawingStatus(content: string): void {
    // 检测是否在显式 opt-in 的增强代码块内（已开始但未闭合）
    const openMatch = content.match(/```(svg|mermaid|html)(?:[^\n`]*\s)?axon-render[^\n`]*\n/i);
    if (!openMatch) {
      if (this._drawingPhase !== "none") {
        this._drawingPhase = "none";
        this.send("status", { content: "正在回复...", phase: "responding" });
      }
      return;
    }
    const lang = openMatch[1].toLowerCase();
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
    userMeta?: { displayText?: string; attachedFiles?: { name: string; size: number }[]; replyStyle?: string; userSegments?: unknown[]; clientMessageId?: string },
  ): Promise<void> {
    this.turnCount++;
    this.trace("turn.start", { input: truncateForTrace(input, 2000), model: model || this.model, provider: provider || this.provider }, this.turnCount);
    // 新一轮：重置本轮 Credits 预算门状态（软提醒标记 + 硬暂停阈值回到配置基线）
    this.creditBudgetGate.resetForTurn();
    // 失败保护状态严格限定在一次用户对话内：此前把 LoopGuard 快照跨消息 restore，
    // 会让旧问题的失败/反思配额污染新问题，导致新问题过早触发“多次尝试均未成功”。
    // 用户再次发送消息即视为一个新的对话边界，必须从干净 guard 开始。
    this.loopGuardSnapshot = null;
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

    // 新一轮用户输入开始前，清理上一轮遗留的临时诊断/纠偏注入。
    // _tailInjected 只表示“为 prompt cache 友好而放到尾部”，不代表必须跨轮删除；
    // 只有 _ephemeralInjected 才是单轮临时消息（反思、深度复盘、空回复/SSE 纠偏、预算提醒等）。
    const beforeInjectedCleanup = this.messages.length;
    this.messages = this.messages.filter((m) => !(m as any)._ephemeralInjected);
    if (this.messages.length !== beforeInjectedCleanup) {
      this.persistMessages();
    }

    // 保存本轮用户输入（压缩迁移时需要在新会话中重放）
    this.lastUserInput = { content: input, model, images, provider, userMeta: userMeta as Record<string, unknown> | undefined };

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
    if (userMeta?.clientMessageId) userExtra.clientMessageId = userMeta.clientMessageId;
    if (userMeta?.attachedFiles && userMeta.attachedFiles.length > 0) userExtra.attachedFiles = userMeta.attachedFiles;
    if (userMeta?.userSegments && userMeta.userSegments.length > 0) userExtra.userSegments = userMeta.userSegments;

    // 构建用户消息（支持多模态：文字 + 图片）
    if (images && images.length > 0) {
      // 主模型不支持图片（vision === false）时，尝试用识图兜底模型把图片转成文字描述，
      // 用文字替换图片喂给主模型——主模型不再是"瞎子"，用户也无需感知差异。
      const supportsVision = declaredVisionFor(this.model, this.provider);
      const fallbackModel = getVisionFallbackModel();
      if (supportsVision === false && fallbackModel && fallbackModel !== this.model) {
        const desc = await this.describeImagesWithFallback(images);
        const text = input
          ? `${input}\n\n[图片内容描述（由识图模型生成）]：\n${desc || "（识图失败，无法描述）"}`
          : `[图片内容描述（由识图模型生成）]：\n${desc || "（识图失败，无法描述）"}`;
        // 持久化保留原图（image_url）供前端历史恢复展示；发给主模型时由
        // chatCompletionsStrategy 的 vision 过滤剥离 image_url、只保留文字描述。
        const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
          { type: "text", text },
          ...images.map((img) => ({ type: "image_url", image_url: { url: img } })),
        ];
        this.messages.push({ role: "user", content: content as any, timestamp: Date.now(), ...userExtra } as any);
      } else {
        const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
        if (input) {
          content.push({ type: "text", text: input });
        }
        for (const img of images) {
          content.push({ type: "image_url", image_url: { url: img } });
        }
        this.messages.push({ role: "user", content: content as any, timestamp: Date.now(), ...userExtra } as any);
      }
    } else {
      this.messages.push({ role: "user", content: input, timestamp: Date.now(), ...userExtra } as any);
    }

    // 用户消息立即落盘：即便随后切走会话/连接断开，这条提问也不会丢。
    // 不 await：序列化 260K+ tokens 的消息数组 + 写磁盘可能耗时 1-2s，
    // fire-and-forget 让主流程不等磁盘 IO 直接进入 LLM 请求阶段。
    void this.persistMessages();

    // 自动压缩（溢出强制无感 / 达 75% 阈值询问用户）；用户选择迁移到新会话时本轮中止
    if (await this.maybeAutoCompactBeforeTurn(strategy)) return;

    this.send("status", { content: "思考中...", phase: "thinking" });

    // 预取 IDE 上下文 / skill / power / MCP —— 它们之间无依赖，并行拉取以缩短首字延迟
    const [ideCtx, skillsPrompt, powersPrompt] = await Promise.all([
      this.promptBuilder.buildIdeContextPrompt(false).catch((e: unknown) => { console.warn("[ide-ctx] 预取失败（忽略）:", (e as Error).message); return null; }),
      this.skillRegistry.buildSkillsPrompt().catch((e: unknown) => { console.warn("[skill] 发现 skill 失败（忽略）:", (e as Error).message); return null; }),
      this.powerRegistry ? this.powerRegistry.buildPowersPrompt().catch((e: unknown) => { console.warn("[power] 发现 power 失败（忽略）:", (e as Error).message); return null; }) : Promise.resolve(null),
      this.prefetchMcpTools(),  // ← 之前串行 await，现在并入并行
    ]);
    this.ideContextCache = ideCtx;
    this.skillsPromptCache = skillsPrompt;
    this.powersPromptCache = powersPrompt;

    // Agent 循环：总轮数上限只作极端兜底（正常任务很难碰到），真正防死循环靠"相同调用重复检测"
    let rounds = 0;
    const policy = policyForModel(this.model);
    const MAX_ROUNDS = policy.maxRounds;
    // 防失控守卫：重复调用指纹、文件重复读、连续失败计数、reasoning 续写计数统一收敛到 LoopGuard，
    // 与子 agent 共用同一实现，阈值随模型族而定
    const guard = new LoopGuard(policy);
    guard.restore(this.loopGuardSnapshot);
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
      let pendingTextBuffer = "";
      let reasoningStarted = false;
      let reasoningChars = 0;
      const commitPendingText = () => {
        if (!pendingTextBuffer) return;
        if (!turnStreamStarted) {
          console.log("[stream] 首个 chunk 到达，耗时:", Date.now() - turnStartTime, "ms");
          this.send("stream_start", {});
          this.send("status", { content: "正在回复...", phase: "responding" });
          turnStreamStarted = true;
        }
        this.updateDrawingStatus(streamedContentThisRound);
        this.send("stream_delta", { content: pendingTextBuffer });
        pendingTextBuffer = "";
      };
      const callbacks: LLMStreamCallbacks = {
        onReasoningDelta: (text, partIndex, itemId) => {
          this.trace("reasoning.delta", { text: truncateForTrace(text, 2000), partIndex, itemId }, this.turnCount);
          // 思考过程：推送给前端展示，不持久化到消息历史。
          // 思考开关关闭时不转发（此时各 strategy 也已不向模型请求思考，正常不会有增量到达；
          // 这里仍然拦一道，兜住"模型无视参数照样吐 reasoning"的中转站）。
          if (!this.think) return;
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
          // round 是"这是第几轮 LLM 调用"的唯一权威来源。
          // 协议里没有"新一轮开始"的事件——stream_start 只在本轮真的产出正文时才发，
          // 纯工具轮压根不发，所以前端无法自己推断轮边界。不带 round，前端就只能靠
          // "谁还在 streaming"这类全局可变状态猜思考块归属，一被提前到达的事件打翻
          // 就拆成多段。partIndex 是协议块号、每轮从 0 重新开始，必须与 round 组合才唯一。
          this.send("reasoning_delta", { content: text, partIndex, itemId, round: rounds });
        },
        onTextDelta: (text) => {
          this.trace("text.delta", { text: truncateForTrace(text, 2000) }, this.turnCount);
          streamedContentThisRound += text;
          pendingTextBuffer += text;
          // 实时流式发送：确保前端打字机有内容可逐帧消化。
          commitPendingText();
          },
        onToolCallDetected: (name, id) => {
          this.trace("tool.detected", { name, id }, this.turnCount);
          // delegate_task / parallel_execute / parallel_research 有专门的 sub_agent 卡片，跳过。
          if (name === "delegate_task" || name === "parallel_execute" || name === "parallel_research") return;
          // 这个回调在流式阶段就会触发（工具名已定、参数还在逐 chunk 累加），是卡片能出现的
          // 最早时机。而工具参数体往往就是模型输出的主体（create_file 的 content、str_replace
          // 的 new_str，几百到几千 token），等整条流消费完再发卡，用户要盯着空白等好几秒。
          //
          // 所有工具都提前发卡，前端 useToolCallQueue 的 80ms 间隔确保不会"同时弹出 N 张"。
          // 此刻拿不到参数，卡片先以占位文案出现（前端在 shortName 为空时会显示
          // "修改文件中..."/"创建文件中..."）；执行循环发出带 args 的 executing 事件后按 id 回填。
          if (!id) return; // 没拿到调用 id 就没法与后续 executing 事件配对，宁可不发
          // status=queued 而非 pending：此刻一个工具都还没开始跑（本轮工具由 ToolDispatchHandler
          // 串行执行）。发 pending 会让前端把"排队等待"画成"正在执行"——多工具轮里几张卡一起
          // 转圈、都写着"执行命令中..."。真正开始执行时 toolCallExecutor 会按同一个 id 发 executing。
          //
          // 注意此刻工具名刚定、**参数还在流式累加**（create_file 的 content 就是整个文件正文），
          // 所以这张卡代表的不只是"排队"，也可能是"模型正在写参数"。两者的等待原因不同、
          // 时长量级也不同，但协议上都是"还没开始执行"，前端按顺序自行区分文案
          // （见 renderSegments 的 queuedWaitingIds）——不为此加协议字段，
          // 因为多发一轮 tool_call 会被前端 80ms 卡片队列逐个限流，反而推迟真正的执行中卡片。
          this.send("tool_call", { id, name, args: {}, cwd: this.cwd, status: ToolCallStatus.Queued, ...this.mcpMetaFor(name) });
        },
      };

      const requestMessages = this.promptBuilder.buildRequestMessages();
      // 回合产出由新链路统一驱动（LLMTurnSource → LLMHandler 归一化 + 实时流式），内部仍复用 strategy。
      const turn: LLMTurnResult = await this.runPipelineTurn(strategy, requestMessages, callbacks);

      // deepseek 输出 DSML 退化：本轮检测到模型用文本协议输出工具调用（历史污染信号）。
      // 不主动压平，只发事件让前端提示用户"压缩不兼容记忆"，由用户决定是否清理历史。
      if (turn.dsmlDetected && /deepseek/i.test(this.model)) {
        this.send("tool_history_mismatch", { model: this.model });
      }

      let contentBuffer = turn.content;
      const toolCalls = turn.toolCalls;
      // 消费归一化后的产品语义结束原因（error/truncated/complete/tool_calls/cancelled）；
      // 策略层保证已填充，协议原始 finishReason 不再在本消费点直接判断。
      const finishReason: NormalizedFinishReason = turn.normalizedFinishReason;
      this.trace("turn.result", {
        finishReason,
        toolCalls: toolCalls.map((tc) => ({ id: tc.id, name: tc.name, argsPreview: truncateForTrace(tc.arguments || "", 1000) })),
        contentPreview: truncateForTrace(contentBuffer || "", 2000),
      }, this.turnCount);
      // 记录本回合 API 返回的真实 token 用量（用于精确驱动压缩与进度条）
      this.recordTurnUsage(turn.usage);

      // 推送 token 用量。
      // 不能用 contentBuffer 当门槛：纯工具轮（模型只发工具调用、没输出文字）同样消耗上下文，
      // 挡掉后圆环在整条工具链期间保持滞后，直到某轮出现文字才一次性跳一大格——看起来像"重复累加"。
      // 每轮都推，前端只是覆盖同一个数值，成本可忽略。
      this.updateAndSendTokenUsage();

      // 无工具调用 → 候选最终回复。交由专门方法处理（截断续写 / 内心 OS 重试 / 空回复兜底 /
      // 自动诊断 / 正常收尾），返回 "continue"=进入下一轮，"done"=本轮结束。
      if (toolCalls.length === 0) {
        const outcome = await this.handleNoToolCallTurn(contentBuffer, finishReason, guard, ts, mutatedFiles, turnStartTime, streamedContentThisRound, rounds, commitPendingText);
        if (outcome === "done") return;
        continue;
      }

      // Credits 预算门：即将进入下一轮工具调用前检查本轮花费（成本护栏，商业化用）。
      // 放在"有工具调用"分支：无工具调用已经在收尾，不需要在此拦截。
      if (await this.maybeCreditBudgetGate(turnStartTime, streamedContentThisRound)) return;

      // 有工具调用 → 本轮 content 是模型的工具轮叙述（thinking-aloud），不展示给用户。
      // 原因：模型在每个工具轮开头都会产出"分析性叙述"（重复描述问题/分析），
      // 展示出来像 AI 在反复说同样的话。Kiro 的做法：用户只看到工具卡片 + 最终回复。
      // runtimeContent 仍保留给模型看（减少重复倾向），但 displayContent 不展示。
      pendingTextBuffer = "";
      if (turnStreamStarted) {
        this.send("stream_pause", {});
      }

      // 工具执行前检查取消：用户在本轮 LLM 流式阶段点了取消，此时不应再执行工具、
      // 也不应把带 tool_calls 的 assistant 消息 push 进历史（否则会持久化下来，reload 后"复活"）。
      // 必须在 push assistantMsg 之前 return——一旦 push 了带 tool_calls 的消息，
      // 就必须配对 tool 结果，否则消息历史残缺。
      if (this.cancelled) {
        this.stampCancelledTurnStats(turnStartTime, streamedContentThisRound);
        return;
      }

      // 记录 assistant 消息并执行工具。
      // displayContent: null → 不展示给用户（工具轮叙述对用户无价值，只会造成重复刷屏）。
      // runtimeContent: 保留原文 → 让模型下轮能看到自己说过什么，减少重复叙述倾向。
      const assistantMsg = {
        role: "assistant" as const,
        content: contentBuffer || null,
        displayContent: null,
        runtimeContent: contentBuffer || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
      this.messages.push(assistantMsg);

      // 工具轮执行：由新链路 DefaultToolDispatchHandler 编排（驱动 plan→execute→complete 状态机），
      // 每个工具的实际执行/门控/前端事件/落盘复用已验证的 executeSingleToolCall
      // （保留确认门/子Agent/Relay/MCP/软失败等全部行为）。
      await this.runToolDispatch(toolCalls, guard, ts, mutatedFiles);

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

      // 卡住升级阶梯：反思·换路 → 深度复盘 → 投降。在硬投降前，先给模型"理清思路、换条路重来"的机会。
      if (guard.isStuck()) {
        const stuck = guard.getStuckTarget();
        if (guard.canReflect()) {
          console.debug(`[agent] 卡住（${stuck?.key ?? "连续失败"}）→ 反思·换路`);
          await this.injectReflection(stuck, guard);
          continue;
        }
        if (guard.canSummaryRestart()) {
          console.debug(`[agent] 反思仍无效（${stuck?.key ?? "连续失败"}）→ 深度复盘`);
          await this.injectSummaryRestart(stuck, guard, strategy);
          continue;
        }
        // 阶梯耗尽仍卡住 → 强制收尾投降，让模型如实向用户说明
        console.debug(`[agent] 升级阶梯耗尽，强制中断`);
        this.messages.push({
          role: "system",
          content:
            `你已经多次尝试（包括重新理清思路、换路重来）仍未能完成。请立即停止重试，` +
            `用文字向用户如实说明：你想做什么、卡在哪里、失败的原因，以及你的判断和建议。不要再调用任何工具。`,
          _ephemeralInjected: true,
        } as any);
        // 让模型基于这条引导生成一段总结性回复
        await this.streamFinalSummary(turnStartTime, true);
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
        _ephemeralInjected: true,
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
      // 非取消异常：统一只展示给用户，不写入长期消息历史。
      // 这些内容属于异常态提示，不是任务事实；写入 messages 会污染后续轮次上下文。
      const errMsg = `❌ 出错了: ${this.formatUserFacingError(error)}`;
      this.emitTransientError(errMsg, turnStartTime, streamedContentThisRound);
      // 检测上下文超限：发专门事件，让前端显示"压缩上下文"引导
      if (this.isContextOverflowError(error)) {
        this.send("context_overflow", {});
      }
      throw err; // 继续上抛让 sessionHub 做清理（runningSessions.delete 等）
    }
  }

  /**
   * 流式生成一段总结性回复（不提供工具，强制模型用文字收尾）。
   * 用于连续失败保护被触发后，让模型向用户说明情况。
   * @param ephemeral 为 true 时，这条总结回复标记为单轮临时消息（不落盘、不进入后续轮次上下文），
   * 用于"投降式收尾"——那句"我卡住了/不能再调工具"的宣言对后续 AI 没有价值，反而会污染下一轮判断。
   */
  private async streamFinalSummary(turnStartTime: number, ephemeral = false): Promise<void> {
    let contentBuffer = "";
    let started = false;
    try {
      const strategy = getStrategy(this.provider, this.model);
      const turn = await strategy.runTurn({
        model: this.model,
        messages: this.promptBuilder.buildRequestMessages(),
        tools: [], // 不提供工具，强制用文字收尾
        signal: this.abortController?.signal,
        // 跟随用户的思考开关。这里虽然不展示思考过程，但思考本身会影响收尾结论的质量，
        // 所以不强制关掉——只在用户明确关闭时才不请求。
        think: this.think,
        modelSupportsThinking: declaredThinkingFor(this.model, this.provider),
        modelSupportsCacheControl: declaredCacheControlFor(this.model, this.provider),
        callbacks: {
          onReasoningDelta: () => { /* 收尾阶段不展示思考过程，只取最终文字 */ },
          onTextDelta: (text) => {
            if (!started) {
              this.send("stream_start", {});
              started = true;
            }
            contentBuffer += text;
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

    this.messages.push(
      ephemeral
        ? ({ role: "assistant", content: contentBuffer, _ephemeralInjected: true } as any)
        : { role: "assistant", content: contentBuffer },
    );
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


