/**
 * Agent Session - 每个 WebSocket 连接一个实例
 *
 * 复用 cli 的核心逻辑，但通过 WS 推送中间状态给前端。
 */

import { coerceToolArgs, schemaForTool } from "./tools/argCoercion.js";
import { preNormalizeArgs } from "./tools/argPreNormalize.js";
import { formatWaitResult, waitForProcesses, waitTimeoutMs } from "./tools/processWait.js";
import { ANY_PATH, normalizePermissionMode, skipsApproval, writesAnywhere, type PermissionMode } from "./session/permissionMode.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { isAbsolute, resolve } from "node:path";
import { ToolCallStatus, type ToolMeta, type WebCapability, type ApprovalDecision, type TrustRule, type GateOutcome } from "./tools/index.js";
import { calculateCredits, buildCreditDetail } from "./credits.js";
import type { AgentHost } from "./host/index.js";
import type { AgentChannel, AgentEvent } from "./channel/index.js";
import { isSummaryMessage, isCompactionAck, DEFAULT_COMPACTION_CONFIG, setPruneKeepChars, autoCompactThreshold } from "./compactor.js";
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
import { LoopGuard, policyForModel, type StuckTarget, type LoopGuardSnapshot } from "./agentGuards.js";
import { McpRegistry } from "./mcp/mcpRegistry.js";
import { modelContextWindow } from "./llm/modelContext.js";
import { SYSTEM_PROMPT, QUEST_SYSTEM_PROMPT, isAxonSystemPrompt } from "./systemPrompt.js";
import { getStrategy, findProviderForModel, declaredThinkingFor, declaredEffortValuesFor, declaredCacheControlFor, declaredVisionFor, getVisionFallbackModel, getModelDisplayName, getProviderDisplayName, getProviderPricing } from "./providers.js";
import { resolveTurnBilling, type TurnBilling } from "./billing.js";
import { PromptBuilder, isRealUserMessage } from "./session/promptBuilder.js";
import {
  createHumanizedStatusState,
  describeAction,
  generateIntent,
  generatePhase,
  shouldGeneratePhase,
  type HumanizedStatusState,
} from "./session/humanizedStatus.js";
import { CoworkSnapshotter } from "./cowork/snapshotter.js";
import { parseChecks, checksResult } from "./cowork/checks.js";
import { BackgroundTaskTracker } from "./session/backgroundTasks.js";
import { ToolLoadout, loadToolsResult } from "./session/toolLoadout.js";
import { resolveArtifactDir } from "./session/artifactDir.js";
import { artifactExtension, parseArtifactArgs, parseGenerateImageArgs, parseRenderMediaArgs, pickVersionedPath, sanitizeStem } from "./session/artifactFile.js";
/**
 * 单轮最多登记的产出文件数。
 * 防止某个批量生成脚本让模型报上来几百个文件把界面刷爆。
 */
const MAX_REPORTED_OUTPUTS = 12;
import { flattenToolHistory } from "./messageSanitizer.js";
import {
  CommandToolExecutor,
  RelayToolExecutor,
  DelegatedToolExecutor,
  McpToolExecutor,
  GenericToolExecutor,
  ToolOutcomeRecorder,
  SessionTraceWriter,
  truncateForTrace,
  projectTraceDir,
  type TraceConfig,
  TurnFinalizer,
  ToolOutcomeStateResolver,
  ToolOutcomePostSync,
  NoToolTurnDecider,
  ErrorTurnHandler,
  ReflectionHandler,
  ToolCallExecutor,
  type TurnState,
} from "./session/index.js";
import { TokenAccountant, type ContextBreakdown } from "./session/tokenAccountant.js";
import { parseTaskArgs, taskUpdateResult, latestTasksFromMessages, formatTasksForModel, type TaskItem } from "./session/taskList.js";
import { ToolDefBuilder } from "./session/toolDefBuilder.js";
import { McpController } from "./session/mcpController.js";
import { buildToolTurnAssistantMessage } from "./session/toolTurnMessage.js";
import { editArtifact, readArtifact, readSkillFile } from "./session/artifactTools.js";
import { ToolGroupTracker, generateToolGroupSummary, isVisibleProse, type ClosedToolGroup } from "./session/toolGroupSummary.js";
import { DelegateRunner } from "./session/delegateRunner.js";
import { RelayToolRunner } from "./session/relayToolRunner.js";
import { AskUserToolExecutor, type AskUserQuestion, type AskUserAnswer } from "./session/askUserToolExecutor.js";
import { FormToolExecutor } from "./session/formToolExecutor.js";
import type { FormSpec, FormSubmitPayload } from "./session/formSchema.js";
import { CommandGateController } from "./session/commandGateController.js";
import { resolveInWorkspaces } from "./tools/search.js";
import { CommandGate } from "./tools/index.js";
import { EditController } from "./session/editController.js";
import { CompactionController } from "./session/compactionController.js";
import { applyMemoryUpdates, mergeMemoryMarkdown, parseMemoryMarkdown, parseMemoryUpdates, threeWayMergeMemory, type MemoryUpdate } from "./session/memoryStore.js";
import type { MemorySource, MemoryVersion } from "./storage/types.js";
import { initializeWorkspaceAxon, inspectWorkspacesAxon, loadWorkspaceAxonConfig, type WorkspaceAxonStatus } from "./session/workspaceConfig.js";
import { CreditBudgetGate } from "./session/creditBudgetGate.js";
import { RelayStore } from "./relay/relayStore.js";
import { WikiStore, wikiRecallSignature, type WikiRecall } from "./wiki/wikiStore.js";
import { WikiController, resolveWikiModel, type WikiGenerationResult, type WikiGenerationOptions } from "./wiki/wikiController.js";
import { SubAgentRunner } from "./skills/subAgentRunner.js";
import { deriveSubAgentHost } from "./host/derive.js";
import { SnapshotManager } from "./snapshot/index.js";
import type { McpCapability } from "./mcp/types.js";


/** 回复进行中用户追加的一条消息（插话） */
export interface SteerMessage {
  clientMessageId: string;
  /** 给模型的正文（带附件内容 / 图片时为多段） */
  content: string | Array<Record<string, unknown>>;
  /** 界面上显示的原话 */
  displayText: string;
  attachedFiles?: unknown[];
  userSegments?: unknown[];
  /** 这一轮来不及插入时，用它原样开新一轮 */
  command: Record<string, unknown>;
}

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
  /**
   * 回复进行中用户追加的消息（插话）。不开新一轮：在下一次请求模型之前插进对话（见 absorbSteers），
   * 模型能看到，手上的动作照常继续。这一轮已经没有下一次请求了（正在写最终回答、或被停止），
   * 就由 SessionHub 在这一轮结束后拿它们开新一轮。
   */
  /** @internal */ pendingSteers: SteerMessage[] = [];
  /** 工具按需加载状态（哪些不常用的工具组已加载） */
  /** @internal */ readonly toolLoadout = new ToolLoadout();
  /** 后台任务（start_process 启动的进程）；宿主不支持后台进程时为 null */
  backgroundTasks: BackgroundTaskTracker | null = null;
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
  /** Relay 工具执行协作者（create/saveDoc/advance/updateTask/reviewTask，解耦自本类） */
  private readonly relayToolRunner: RelayToolRunner;
  /** 对话轮次计数（用于快照 id） */
  /** @internal */ turnCount = 0;
  /** @internal */ lastTotalTokens = 0;
  /**
   * 会话记忆（Markdown）——本次会话里「值得跨会话带走」的结论的浓缩。
   *
   * 刻意不放进 messages：它不参与对话轮次，只作为一条按轮注入每轮发一次，
   * 因此不污染历史与存档，内容变化时也不会打断历史那一段的前缀缓存。
   * 落盘在 SessionData.memory，由 update_memory 工具或用户导入 .md 维护。
   */
  /** @internal */ memory = "";
  /**
   * 记忆的历史版本：每次记忆被改写前，把旧内容存一份（最多 MEMORY_HISTORY_LIMIT 份）。
   * 后台整理、模型写入、用户保存、导入都可能改写记忆；有了历史，任何一次改坏都能在面板里恢复。
   */
  /** @internal */ memoryHistory: MemoryVersion[] = [];
  /** 本次会话里记忆被改过（包括清空）：持久化时据此决定要不要写 memory 字段 */
  private memoryTouched = false;
  private static readonly MEMORY_HISTORY_LIMIT = 20;
  /** @internal */ lastPromptTokens = 0;
  /** @internal */ lastCompletionTokens = 0;
  /**
   * 端点实报 prompt_tokens ÷ 本地估算（最近一次请求反推得出）。1 = 尚未校准。
   *
   * 为什么需要：本地字符估算对代码密集内容系统性偏低——实测 deepseek 会话偏低 17%
   * （估算 418k，端点实收 481k），于是界面上"已用上下文"长期低于后台实收值，两处对不上。
   * 端点每轮都会返回真实 prompt_tokens，用它反推一个系数去校正本地估算，
   * 既保留估算的稳定性（不随端点口径跳变），又让显示与端点实收一致。
   */
  /** @internal */ promptCalibration = 1;
  /** 该校准系数对应的模型：换模型后 tokenizer 不同，系数作废 */
  /** @internal */ promptCalibrationModel = "";
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
  /** 本轮所有请求端点实报的输入 token 合计（含缓存命中），turn 开始时清零；用于花费估算 */
  /** @internal */ turnInputTokens = 0;
  /** 本轮所有请求端点实报的缓存命中 token 合计 */
  /** @internal */ turnCachedTokens = 0;
  /** 本轮请求模型的次数（端点报了 usage 的） */
  /** @internal */ turnRequestCount = 0;
  /** 本轮开始前的消息条数快照（push 本轮用户消息之前记录）。
   *  收尾时 messages[turnStartMsgCount..] 即本轮新增内容（用户消息 + 工具结果 + 中间 assistant 回填）。 */
  /** @internal */ turnStartMsgCount = 0;
  private abortController: AbortController | null = null;
  /** @internal */ get abortSignal(): AbortSignal | undefined { return this.abortController?.signal; }
  // 取消标志：cancel() 时置 true，agent loop 各处据此立即停止。
  // 独立于 abortController（后者 abort 后会被置 null，无法再判断状态）
  private cancelled = false;
  /** @internal */ get isCancelled(): boolean { return this.cancelled; }
  // 本轮思考强度实际值（来自当前模型 Provider 配置）；undefined = 关闭
  /** @internal */ effort: string | undefined;
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
  // 工作区 .axon 指令 / rules / memory 的本轮快照
  /** @internal */ workspaceAxonPromptCache: string | null = null;
  // 本轮请求的 IDE 上下文提示（仅 IDE 形态有 host.ideContext 时；handleUserInput 开头预取）。
  // 活动文件/选区是同步可得，git diff 是异步，统一在预取阶段拼好，buildRequestMessages 同步注入。
  /** @internal */ ideContextCache: string | null = null;
  // 子 agent 委托计数器：为每次 delegate_task 生成唯一 delegateId
  /** @internal */ delegateSeq = 0;
  // Relay 长任务工作流存储（落盘在主工作区 .axon/relays/）
  /** @internal */ relayStore: RelayStore;
  // Wiki 项目知识文档存储：读全部工作区（wiki 是 per-repo 资产），写入落主工作区
  /** @internal */ wikiStore: WikiStore;
  // 本轮请求的 Wiki 索引提示。无 wiki 时恒为 null —— 此时完全不注入，未用 Wiki 的项目零成本。
  /** @internal */ wikiPromptCache: string | null = null;
  // 上一次推给前端的召回集合签名（见 wikiRecallSignature）。用于「只在变化时提示」，
  // 稳定期保持静默；null 表示尚无基准（首次必然不同，故会提示）。
  private lastWikiRecallSignature: string | null = null;
  // 生成中标志：挡住重复触发。并发生成会互相破坏，理由见 generateWiki 的注释。
  /** @internal */ wikiGenerating = false;
  // 工具确认门：relay_create 等需要用户确认的操作，await 此 Promise 阻塞直到用户响应
  private toolConfirmResolve: ((confirmed: boolean) => void) | null = null;
  // 选项问答门（ask_user）：await 此 Promise 阻塞直到用户作答。
  // **刻意不设超时**——提问本就是要等用户，超时替用户做决定比不答更糟。仅会话取消时解除（返回 null）。
  private askUserResolve: ((answers: AskUserAnswer[] | null) => void) | null = null;
  /** 当前正在等待作答的工具调用 id：用于校验回传答案是否对应本次提问（旧卡片/失效会话直接忽略）。 */
  private askUserPendingToolCallId: string | null = null;
  // 表单门（ask_form）：与问答门同构——不设超时（表单就是要等用户填完），仅会话取消时解除。
  private formSubmitResolve: ((payload: FormSubmitPayload | null) => void) | null = null;
  /** 当前正在等待提交的表单对应工具调用 id：用于校验回传是否属于本次表单（旧卡片/失效会话直接忽略）。 */
  private formPendingToolCallId: string | null = null;
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
  /** @internal */ readonly askUserToolExecutor: AskUserToolExecutor;
  /** @internal */ readonly formToolExecutor: FormToolExecutor;
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
  /**
   * 本轮用户消息的 id（前端在 user_message 里给的 clientMessageId）。
   *
   * 每轮在 handleUserInput 里**无条件**刷新（本轮没有该字段则置 null）。
   * 用途：让收尾类事件带上"这是哪一轮"的标识，前端据此精确归属，不必再靠时间线推断 —— 详见 send()。
   */
  /** @internal */ currentTurnClientMessageId: string | null = null;
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
  /**
   * 是否允许 AI 生成动画 / 视频（render_media）。
   *
   * 默认关闭：这个能力要在本机下载一份 ffmpeg（约 160MB）并驱动无头浏览器渲染，
   * 属于"重资产"能力，不该在用户没表态时占用磁盘和带宽。
   * 由设置项 axon.media.enabled 控制，开启时宿主会立即开始下载组件。
   *
   * 关闭时工具根本不注入 —— 模型看不到它，就不会反复尝试一个不可用的能力。
   */
  /** @internal */ mediaEnabled = false;

  /**
   * 是否允许 AI 生成图片（generate_image，文生图）。
   *
   * 与 mediaEnabled 不同：这个能力不下载任何本机组件，但它必须有外部生图服务
   * （需要用户配置服务地址、密钥、模型）。用户没配置时宿主不提供 imageGenerator，
   * 工具同样不注入 —— 模型看不到就不会反复尝试一个必然失败的能力。
   * 由设置项 axon.image.enabled 控制。
   */
  /** @internal */ imageEnabled = false;

  /**
   * 办公化状态文案（Cowork 面板）。
   *
   * 开启后，每轮开始不再发那句通用的「思考中...」，而是用当前模型即时生成一句
   * 贴合本轮任务的意图摘要（如「核对两份台账的金额差异」）。
   *
   * 为什么做成开关而不是默认行为：Chat/Code 那侧配合工具卡片一起看，「思考中…」
   * 配上卡片里的工具名和参数已经够用；而 Cowork 刻意不展示工具调用，整轮就只剩
   * 这一句，不给出具体意图的话用户完全不知道在干什么。
   *
   * 由 sessionHub 按 cowork 轮设置 —— AgentSession 的 mode 已把 cowork 降级为
   * agent（见 normalizeMode），所以运行时无法自己判断，必须显式告知。
   */
  /** @internal */ humanizedStatus = false;
  /** 办公化文案的本轮生成状态（节流 + 去重）。每轮用户输入时重置。 */
  private humanizedState: HumanizedStatusState = createHumanizedStatusState();
  /**
   * 产出目录（Cowork）。
   *
   * 只用于拼进提示词告诉模型"东西往这儿放"；产出清单由模型调 report_outputs
   * 主动登记，不靠扫这个目录推断。
   */
  private outputDir = "";
  /**
   * Chat 产物目录（用户在 + 菜单里设置的绝对路径）。
   * 空串 = 未设置，取默认位置，见 getArtifactDir()。每轮由 sessionHub 注入，
   * 用户中途改目录下一轮即生效。
   */
  private artifactDir = "";
  /** Cowork 附件快照器：用户文件被改写前留原稿副本（查看改动/恢复原稿的依据） */
  private coworkSnapshotter: CoworkSnapshotter | null = null;
  /** 本轮 Cowork 快照目录；轮结束登记产出时随结果一起落盘 */
  private currentCoworkSnapshotDir = "";
  /** 本轮完成快照的附件路径（用于判断产出是否可恢复原稿） */
  private snapshotPaths: string[] = [];
  /** 本轮已生成的意图文案：作为阶段文案的上下文，让两者对得上同一个目标。 */
  private humanizedIntent = "";
  /** 本轮连续工具调用的分组追踪：一组结束时用当前模型生成一句话摘要（见 toolGroupSummary） */
  private toolGroupTracker = new ToolGroupTracker();

  constructor(cwd: string, channel: AgentChannel, host: AgentHost, existingMessages?: ChatCompletionMessageParam[], workspaces?: string[], homeDir?: string, web?: WebCapability, mode: "agent" | "quest" = "agent", mcp?: McpCapability, commandGate?: CommandGate) {
    this.mode = mode;
    this.model = "";
    this.provider = "";
    const systemPrompt = mode === "quest" ? QUEST_SYSTEM_PROMPT : SYSTEM_PROMPT;
    this.messages = existingMessages && existingMessages.length > 0
      ? existingMessages
      : [{ role: "system", content: systemPrompt }];
    // 旧会话落盘的是当时那版系统提示：换成当前版本，提示词的改进对旧会话同样生效。
    // 代价是这个会话下一次请求的前缀缓存从头失效一次，之后照常命中。
    const head = this.messages[0];
    if (head?.role === "system" && isAxonSystemPrompt(head.content) && head.content !== systemPrompt) {
      this.messages[0] = { ...head, content: systemPrompt };
    }
    this.cwd = cwd;
    this.terminalCwd = cwd;
    this.workspaces = workspaces && workspaces.length > 0 ? workspaces : [cwd];
    this.channel = channel;
    this.host = host;
    // 后台任务追踪：记住哪些进程要求结束时通知（见 session/backgroundTasks.ts）
    if (host.processes) {
      this.backgroundTasks = new BackgroundTaskTracker(host.processes);
      this.host = { ...host, processes: this.backgroundTasks.wrap() };
    }
    this.homeDir = homeDir ?? "";
    this.web = web;
    const powerRegistry = new PowerRegistry(this.workspaces, this.host, this.homeDir);
    this.powerRegistry = powerRegistry;
    // 让 skill 发现链路也扫「Power 捆绑的 skills」。此前这条链路缺失（getActiveSkillDirs 无调用方），
    // 结果是 activate_power 把捆绑 skill 的名字报给模型、模型再去 use_skill 却加载不到。
    // 传回调而非数组：Power 的启用状态在运行期可变，每次 discover 都要取当时的值。
    // 闭包捕获局部变量而非 this.powerRegistry —— 后者声明为可选，直接访问会被判 possibly null；
    // 而这里刚构造完，这个引用本身是确定的。
    this.skillRegistry = new SkillRegistry(
      this.workspaces,
      this.host,
      this.homeDir,
      () => powerRegistry.getActiveSkillDirs(),
    );
    this.mcp = mcp;
    this.mcpRegistry = new McpRegistry(this.workspaces, this.host, this.homeDir, this.powerRegistry);
    // 写入落会话工作区；同时把主目录作为回退根，兼容历史遗留产物
    this.relayStore = new RelayStore([this.cwd, this.homeDir], this.host);
    // Wiki 与 Relay 不同：它是仓库自身的长期资产（应随 git 提交共享），不是本机痕迹，
    // 因此【不】把 homeDir 作为回退根 —— 那会让不相干的用户级目录混进项目列表。
    // 读全部工作区（多根下各自可能都有 wiki），写入落主工作区。
    this.wikiStore = new WikiStore([this.cwd, ...this.workspaces], this.host);
    this.snapshotMgr = new SnapshotManager(this.host, this.cwd);
    this.promptBuilder = new PromptBuilder(this);
    this.tokenAccountant = new TokenAccountant(this);
    this.toolDefBuilder = new ToolDefBuilder(this);
    this.mcpController = new McpController(this);
    this.delegateRunner = new DelegateRunner(this);
    this.relayToolRunner = new RelayToolRunner(this);
    this.commandGateController = new CommandGateController(this, commandGate ?? new CommandGate());
    this.editController = new EditController(this);
    this.compactionController = new CompactionController(this);
    this.creditBudgetGate = new CreditBudgetGate(this);
    // trace 落到用户目录下的项目分区（~/.axon/projects/<项目>/traces），**不写进工作区**。
    // 它是"本机跑过什么"的痕迹，对仓库、对下一个 clone 的人都没有价值；早先写在
    // <cwd>/.axon/traces，导致每个执行过/读过的项目都留下一个 .axon 目录（还会进 git status）。
    // homeDir 缺失时（极少数形态）干脆不记 —— 宁可不记，也不退回去污染工作区。
    this.traceWriter = new SessionTraceWriter({
      host: this.host,
      rootDir: this.homeDir ? projectTraceDir(this.homeDir, this.cwd) : "",
    });
    this.delegatedToolExecutor = new DelegatedToolExecutor({
      runDelegateTask: (args, id) => this.runDelegateTask(args, id),
    });
    this.relayToolExecutor = new RelayToolExecutor({
      waitForToolConfirmation: (name, args, kind, label) => this.waitForToolConfirmation(name, args, kind, label),
      runRelayCreate: (args) => this.runRelayCreate(args),
      runRelaySaveDoc: (args) => this.runRelaySaveDoc(args),
      runRelayAdvance: (args) => this.runRelayAdvance(args),
      runRelayUpdateTask: (args) => this.runRelayUpdateTask(args),
      runRelayReviewTask: (args) => this.runRelayReviewTask(args),
    });
    this.askUserToolExecutor = new AskUserToolExecutor({
      waitForUserAnswer: (toolCallId, questions) => this.waitForUserAnswer(toolCallId, questions),
    });
    this.formToolExecutor = new FormToolExecutor({
      waitForFormSubmit: (toolCallId, spec) => this.waitForFormSubmit(toolCallId, spec),
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
      // 用户自己挑的产物目录 / 产出目录也是「允许写」的地方：他明确指定了 AI 的成品放哪，
      // 写进去却撞工作区边界是不合理的。取函数而非快照值——两者都是每轮注入的。
      writeRoots: () => this.permissionWriteRoots(),
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

  /**
   * 设置 trace 记录配置（等级 / 体积上限 / 保留份数）。
   * 由呈现端在启动时与配置变更时调用；改等级后无需重开会话，下一次写入即生效。
   */
  setTraceConfig(cfg: Partial<TraceConfig>): void {
    this.traceWriter.setConfig(cfg);
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
  /** 被压缩换成摘要的原始消息（只给界面展示，见 SessionData.archivedMessages） */
  private archivedMessages: ChatCompletionMessageParam[] = [];

  getArchivedMessages(): ChatCompletionMessageParam[] {
    return this.archivedMessages;
  }

  /** 从磁盘回填压缩存档 */
  hydrateArchived(list?: ChatCompletionMessageParam[]): void {
    if (Array.isArray(list)) this.archivedMessages = list;
  }

  /**
   * 压缩结果生效：把被摘要替换掉的原始消息移进存档（界面照常显示），再替换模型上下文。
   *
   * snapshot 是开始压缩时的消息列表。压缩要调一次模型、耗时几秒到几十秒，这期间
   * 对话可能还在往后追加（后台滚动摘要时用户发了新消息、回复还在写）：
   * 追加的部分接到压缩结果后面，一条不丢；若这期间历史被改写过（编辑消息、另一次压缩），
   * 这次结果作废，返回 false。
   */
  /** @internal */ applyCompaction(snapshot: ChatCompletionMessageParam[], next: ChatCompletionMessageParam[]): boolean {
    const current = this.messages;
    if (current.length < snapshot.length || snapshot.some((m, i) => current[i] !== m)) return false;
    const appended = current.slice(snapshot.length);
    const kept = new Set(next);
    const isContext = (m: ChatCompletionMessageParam) => m.role === "system" || isSummaryMessage(m) || isCompactionAck(m) || !!(m as { _ephemeralInjected?: boolean })._ephemeralInjected;
    const removed = snapshot.filter((m) => !kept.has(m) && !isContext(m));
    // 当前请求被钉在摘要之后（回答进行中压缩、且本轮自己就很大）：它后面的工具步骤进了存档，
    // 存档里补一份它的副本放在这些步骤前面，原消息标记为「已在存档中显示」，界面不再重复显示
    const lastRemoved = removed.length ? snapshot.indexOf(removed[removed.length - 1]) : -1;
    const archive: ChatCompletionMessageParam[] = [];
    for (let i = 0; i <= lastRemoved; i++) {
      const m = snapshot[i];
      if (isContext(m)) continue;
      if (!kept.has(m)) { archive.push(m); continue; }
      if (m.role === "user" && !(m as { _shownInArchive?: boolean })._shownInArchive) {
        archive.push({ ...m } as ChatCompletionMessageParam);
        (m as { _shownInArchive?: boolean })._shownInArchive = true;
      }
    }
    this.archivedMessages = [...this.archivedMessages, ...archive];
    this.messages = [...next, ...appended];
    return true;
  }

  getMessages(): ChatCompletionMessageParam[] {
    return this.messages;
  }

  /** 编辑历史用户消息（同步影响后续上下文与持久化）。 */
  editUserMessage(messageId: string, content: string, userIndex?: number, images?: string[], attachedFiles?: unknown[]): boolean {
    const normalized = content ?? "";
    let seen = -1;
    let totalUserMsgs = 0;
    for (const m of this.messages as any[]) {
      if (m.role === "user" && !m._screenshotInjection && !isSummaryMessage(m)) totalUserMsgs++;
    }
    console.log(`[edit_user_message] messageId=${messageId} userIndex=${userIndex} totalUserMsgs=${totalUserMsgs} images=${images?.length ?? 0} files=${attachedFiles?.length ?? 0}`);
    for (const m of this.messages as any[]) {
      // 跳过压缩摘要（前端显示成分隔行）和已在压缩存档里显示过的当前请求：都不计入用户消息序号
      if (m.role !== "user" || m._screenshotInjection || m._shownInArchive || isSummaryMessage(m)) continue;
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

  /** 当前会话记忆（Markdown）；供按轮注入与前端读取 */
  getMemory(): string {
    return this.memory;
  }

  /** 从持久化快照回填会话记忆与历史版本（会话从磁盘恢复时由宿主调用） */
  hydrateMemory(memory?: string, history?: MemoryVersion[]): void {
    if (typeof memory === "string" && memory.trim()) this.memory = memory;
    if (Array.isArray(history)) {
      this.memoryHistory = history
        .filter((v) => v && typeof v.content === "string" && typeof v.at === "number")
        .slice(-AgentSession.MEMORY_HISTORY_LIMIT);
    }
  }

  /** 记忆的历史版本（新的在后） */
  getMemoryHistory(): MemoryVersion[] {
    return this.memoryHistory;
  }

  /** 记忆是否在本次会话里被改过（含清空）；没改过时持久化不碰 memory 字段 */
  isMemoryTouched(): boolean {
    return this.memoryTouched;
  }

  /**
   * 写入会话记忆（所有改写入口最终都走这里），立即落盘并推给前端。
   * @param source 这次改写的来源，记在被替换掉的旧版本上，面板据此显示「被谁改写前的版本」
   */
  setMemory(content: string, source: MemorySource = "user"): void {
    const next = typeof content === "string" ? content : "";
    if (next === this.memory) {
      // 内容没变也回推一次：前端保存后在等这条事件确认
      this.send("session_memory", { memory: this.memory, historyCount: this.memoryHistory.length });
      return;
    }
    if (this.memory.trim()) {
      this.memoryHistory.push({ at: Date.now(), source, content: this.memory });
      if (this.memoryHistory.length > AgentSession.MEMORY_HISTORY_LIMIT) {
        this.memoryHistory = this.memoryHistory.slice(-AgentSession.MEMORY_HISTORY_LIMIT);
      }
    }
    this.memory = next;
    this.memoryTouched = true;
    this.persistMessages();
    this.send("session_memory", { memory: this.memory, historyCount: this.memoryHistory.length });
  }

  /** 增量更新会话记忆：按 key 合并知识块，仍以完整 Markdown 对外持久化。 */
  applyMemoryUpdates(updates: MemoryUpdate[], source: MemorySource = "auto"): void {
    const next = applyMemoryUpdates(this.memory, updates);
    if (!next || next === this.memory) return;
    this.setMemory(next, source);
  }

  /**
   * 用户在面板里保存 / 导入记忆。
   *
   * · mode=merge（导入 .md、从别的会话导入）：合并进当前记忆，不整份替换——早先导入会把
   *   本会话已有的记忆整个冲掉。
   * · mode=replace（编辑后保存）：带上开始编辑时的 base。编辑期间后台可能又整理过记忆，
   *   base 与当前内容不一致时做三方合并，用户的改动和后台新写的块都保留。
   */
  saveMemoryFromUser(content: string, opts: { base?: string; mode?: "replace" | "merge" } = {}): void {
    const incoming = typeof content === "string" ? content : "";
    if (opts.mode === "merge") {
      this.setMemory(mergeMemoryMarkdown(this.memory, incoming), "import");
      return;
    }
    const merged = typeof opts.base === "string" ? threeWayMergeMemory(opts.base, this.memory, incoming) : incoming;
    this.setMemory(merged, "user");
  }

  /** 恢复到某个历史版本（当前内容也会先存成一个版本，恢复本身可以再撤回） */
  restoreMemoryVersion(at: number): boolean {
    const version = this.memoryHistory.find((v) => v.at === at);
    if (!version) return false;
    this.setMemory(version.content, "restore");
    return true;
  }

  /** 最新的任务清单（update_tasks）；null = 本会话还没建过，或尚未从历史恢复 */
  private taskList: TaskItem[] | null = null;

  /** update_tasks 工具实现：整份替换清单（见 session/taskList.ts） */
  /** @internal */ updateTasks(toolArgs: Record<string, unknown>): { result: string; status: "success" | "error" } {
    const parsed = parseTaskArgs(toolArgs);
    if (!parsed.tasks) return { result: parsed.error || "任务清单无效", status: "error" };
    this.taskList = parsed.tasks;
    return { result: taskUpdateResult(parsed.tasks), status: "success" };
  }

  /**
   * 历史被压缩、看不到 update_tasks 调用时，把未完成的清单重新注入给模型。
   * 历史里还在时返回 null：模型能直接看到自己最新的那次调用，重复注入只是占上下文。
   */
  /** @internal */ getTaskListNotice(): string | null {
    const inHistory = latestTasksFromMessages(this.messages);
    if (inHistory) {
      this.taskList = inHistory;
      return null;
    }
    return this.taskList ? formatTasksForModel(this.taskList) : null;
  }

  /**
   * update_memory 工具实现：优先按知识块增量维护记忆，兼容旧版完整 Markdown 替换。
   *
   * 记忆的正式落点仍是 SessionData.memory；结构化块只负责合并，最终持久化与前端协议继续
   * 使用完整 Markdown，因此旧快照、导入导出和会话分叉都不需要迁移格式。
   */
  /** @internal */ updateMemory(toolArgs: Record<string, unknown>): { result: string; status: "success" | "error" } {
    const content = typeof toolArgs.content === "string" ? toolArgs.content.trim() : "";
    const updatesValue = toolArgs.updates;
    const updates: MemoryUpdate[] = Array.isArray(updatesValue)
      ? updatesValue.filter((item): item is MemoryUpdate => !!item && typeof item === "object" && typeof (item as any).key === "string")
      : typeof updatesValue === "string" ? parseMemoryUpdates(updatesValue) : [];
    let note = "";
    if (updates.length > 0) {
      this.applyMemoryUpdates(updates, "model");
    } else if (content) {
      // 兼容旧模型/旧提示：content 表示完整 Markdown 替换。但模型常常只写了「这次的新内容」，
      // 整份替换就把其余的块冲掉了：新内容明显比现有记忆短、又丢了已有的章节时，改为合并。
      const currentTitles = parseMemoryMarkdown(this.memory).map((b) => b.title);
      const nextTitles = new Set(parseMemoryMarkdown(content).map((b) => b.title));
      const dropsSections = currentTitles.some((t) => !nextTitles.has(t));
      if (dropsSections && content.length < this.memory.trim().length * 0.5) {
        this.setMemory(mergeMemoryMarkdown(this.memory, content), "model");
        note = "传入的内容比现有记忆短得多且缺少已有章节，已按合并处理以免丢失；要删除过时内容请用 updates 的 delete。";
      } else {
        this.setMemory(content, "model");
      }
    } else {
      return { result: "updates/content 为空，没有任何内容被写入。请提供增量 updates，或传入完整 Markdown content。", status: "error" };
    }
    // 主动更新已经拿到了模型最新的完整记忆，清掉后台节流计数，避免紧接着重复生成一次。
    this.compactionController.markMemoryUpdated();
    return {
      result: `会话记忆已更新（${this.memory.length} 字符，${updates.length > 0 ? `合并 ${updates.length} 个增量块` : note ? "合并" : "完整替换"}）。${note}它会随后续每次请求自动注入，不必在回复里复述。`,
      status: "success",
    };
  }

  /**
   * create_artifact 工具实现：把模型交付的一份独立成品写进产物目录，并通知前端渲染卡片。
   *
   * ── 为什么由后端写盘，而不是让模型 create_file 后再登记 ──
   * 1) Quest（纯问答）模式没有任何写文件工具，靠 create_file 那条路根本出不了产物；
   * 2) 路径和文件名由后端定：模型给的标题不可信（可能带 ../、Windows 非法字符），
   *    统一经 sanitizeStem 清洗后拼进产物目录，写不出目录之外；
   * 3) 一次调用就拿到确定的路径、类型、版本，不用事后扫目录去猜哪个文件算产物。
   *
   * 失败时 result 是给模型看的，要说清楚原因和怎么改，否则它会原样重试。
   */
  /** @internal */ async createArtifact(
    toolArgs: Record<string, unknown>,
    meta?: ToolMeta,
  ): Promise<{ result: string; status: "success" | "error" }> {
    // result 是给模型看的（含字段名和纠错步骤），meta.userMessage 才是给用户看的：
    // 前端失败卡片优先展示后者，所以每条失败路径都要单独填一句不带内部字段名的人话。
    const parsed = parseArtifactArgs(toolArgs);
    if (!parsed.ok) {
      if (meta) meta.userMessage = "产物内容不完整或格式有误，未能保存";
      return { result: parsed.error, status: "error" };
    }

    const dir = this.getArtifactDir();
    if (!dir) {
      if (meta) meta.userMessage = "暂时无法确定产物保存位置";
      return {
        result: "当前无法确定产物保存位置（会话尚未建立）。请直接在回复里用代码块给出内容，稍后再试。",
        status: "error",
      };
    }

    try {
      await this.host.fs.mkdirp(dir);
      const stem = sanitizeStem(parsed.title);
      const ext = artifactExtension(parsed.type, parsed.language);
      const absPath = await pickVersionedPath(dir, stem, ext, async (p) => !!(await this.host.fs.stat(p)));
      await this.host.fs.write(absPath, parsed.content);

      // 版本号从最终文件名反推：report.html → 1，report-v3.html → 3
      const versionMatch = /-v(\d+)\.[^.]+$/.exec(absPath);
      const version = versionMatch ? Number(versionMatch[1]) : 1;
      const size = Buffer.byteLength(parsed.content, "utf8");
      const artifact = {
        path: absPath,
        title: parsed.title,
        type: parsed.type,
        ...(parsed.language ? { language: parsed.language } : {}),
        size,
        version,
      };

      // 先填 meta（随工具结果落盘，历史恢复靠它），再发实时事件（当前这一轮立刻渲染卡片）
      if (meta) meta.artifact = artifact;
      this.send("artifact_created", artifact);

      return {
        result:
          `产物已保存：${absPath}（${size} 字节${version > 1 ? `，同名已存在，保存为第 ${version} 版` : ""}）。` +
          `界面已显示为可预览的卡片，回复里不必再贴一遍完整内容，简短说明它是什么、怎么用即可。`,
        status: "success",
      };
    } catch (err) {
      if (meta) meta.userMessage = "保存产物失败，请检查产物目录是否可写";
      return { result: `保存产物失败：${(err as Error).message}`, status: "error" };
    }
  }

  /**
   * edit_artifact / read_artifact / read_skill_file 的实现（见 session/artifactTools.ts）。
   * 都只在产物目录、技能 / Power 目录里操作，碰不到用户仓库，问答模式同样可用。
   */
  /** @internal */ async runArtifactTool(
    toolName: string,
    toolArgs: Record<string, unknown>,
    meta?: ToolMeta,
  ): Promise<{ result: string; status: "success" | "error" }> {
    const deps = { host: this.host, artifactDir: this.getArtifactDir() };
    try {
      if (toolName === "edit_artifact") {
        const out = await editArtifact(deps, toolArgs);
        if (!out.ok) {
          if (meta) meta.userMessage = out.userMessage;
          return { result: out.result, status: "error" };
        }
        // 与 create_artifact 同一套协议：meta 随工具结果落盘（历史恢复），事件让当前这一轮立刻出卡片
        if (meta) meta.artifact = out.artifact;
        this.send("artifact_created", { ...out.artifact });
        return { result: out.result, status: "success" };
      }
      if (toolName === "read_artifact") {
        const out = await readArtifact(deps, toolArgs);
        return { result: out.result, status: out.ok ? "success" : "error" };
      }
      // read_skill_file：已发现的技能与 Power 目录都可读（读取前不要求先 use_skill）
      const [skills, powers] = await Promise.all([
        this.skillRegistry.discover().catch(() => []),
        this.powerRegistry ? this.powerRegistry.discover().catch(() => []) : Promise.resolve([]),
      ]);
      const roots = [...skills.map((s) => s.dir), ...powers.map((p) => p.dir), this.lastLoadedSkillDir];
      const out = await readSkillFile(this.host, roots, toolArgs, this.lastLoadedSkillDir || undefined);
      return { result: out.result, status: out.ok ? "success" : "error" };
    } catch (err) {
      if (meta) meta.userMessage = "操作产物失败";
      return { result: `操作失败：${(err as Error).message}`, status: "error" };
    }
  }

  /**
   * render_media 工具实现：把模型写的 HTML 动画在后端离屏渲染成 GIF / MP4，落到产物目录。
   *
   * ── 与 createArtifact 的分工 ──
   * createArtifact 收的是模型给出的文本；这里收的是 HTML + 参数，成片由 host.mediaRenderer
   * （无头浏览器截帧 + ffmpeg 编码 + 本机语音旁白）生成。模型全程拿不到 shell。
   *
   * 成功后沿用同一套产物协议（meta.artifact + artifact_created），前端卡片、历史恢复无需另起一套。
   * 失败时 result 给模型看（说清原因和出路），meta.userMessage 给用户看（不含内部字段名与本机路径）。
   */
  /** @internal */ async renderMedia(
    toolArgs: Record<string, unknown>,
    meta?: ToolMeta,
  ): Promise<{ result: string; status: "success" | "error" }> {
    const renderer = this.host.mediaRenderer;
    if (!renderer) {
      if (meta) meta.userMessage = "当前环境暂不支持渲染动画";
      return {
        result: "当前运行环境不支持媒体渲染。请改用 create_artifact 交付 type=html 的动画页面，让用户在预览里观看。",
        status: "error",
      };
    }

    const parsed = parseRenderMediaArgs(toolArgs);
    if (!parsed.ok) {
      if (meta) meta.userMessage = "动画参数不完整或格式有误，未能渲染";
      return { result: parsed.error, status: "error" };
    }

    const env = await renderer.checkEnv();
    if (!env.ok) {
      if (meta) meta.userMessage = "缺少渲染动画所需的组件";
      return { result: env.problem || "渲染环境不可用", status: "error" };
    }

    const dir = this.getArtifactDir();
    if (!dir) {
      if (meta) meta.userMessage = "暂时无法确定成片保存位置";
      return { result: "当前无法确定产物保存位置（会话尚未建立），请稍后再试。", status: "error" };
    }

    try {
      await this.host.fs.mkdirp(dir);
      const stem = sanitizeStem(parsed.title);
      const ext = artifactExtension(parsed.format);
      const absPath = await pickVersionedPath(dir, stem, ext, async (p) => !!(await this.host.fs.stat(p)));

      // 进度：渲染要几十秒，没有反馈用户会以为卡死。节流到 500ms 一条，别刷爆事件通道。
      let lastSentAt = 0;
      const phaseText = {
        provision: "正在准备渲染组件（首次使用需自动下载，请稍候）",
        narration: "正在合成旁白",
        frames: "正在渲染画面",
        encoding: "正在编码成片",
      } as const;
      const out = await renderer.render({
        html: parsed.html,
        format: parsed.format,
        durationSec: parsed.durationSec,
        fps: parsed.fps,
        width: parsed.width,
        height: parsed.height,
        narration: parsed.narration,
        outputPath: absPath,
        signal: this.abortSignal,
        onProgress: ({ phase, done, total }) => {
          const now = Date.now();
          if (now - lastSentAt < 500 && done < total) return;
          lastSentAt = now;
          const suffix =
            phase === "frames" && total > 0
              ? `（${done}/${total} 帧）`
              : phase === "provision" && total > 0
                ? ` ${Math.floor((done / total) * 100)}%`
                : "";
          this.send("status", { content: `${phaseText[phase]}${suffix}...`, phase: "running" });
        },
      });

      const versionMatch = /-v(\d+)\.[^.]+$/.exec(absPath);
      const version = versionMatch ? Number(versionMatch[1]) : 1;
      const artifact = { path: absPath, title: parsed.title, type: parsed.format, size: out.size, version };
      if (meta) meta.artifact = artifact;
      this.send("artifact_created", artifact);

      const lines = [
        `成片已保存：${absPath}（${parsed.format.toUpperCase()}，${out.durationSec.toFixed(1)} 秒，${out.frameCount} 帧，` +
          `${parsed.width}x${parsed.height}，${out.size} 字节${version > 1 ? `，同名已存在，保存为第 ${version} 版` : ""}）。`,
        out.hasAudio
          ? out.hasSoundtrack && parsed.narration
            ? "成片带旁白与音效音轨。"
            : out.hasSoundtrack
              ? "成片带音效音轨（无旁白）。"
              : "成片带旁白音轨。"
          : parsed.format === "mp4" ? "成片没有音轨（无声）。" : "GIF 无声。",
      ];
      if (parsed.notes.length) lines.push(`参数调整：${parsed.notes.join("；")}。`);
      if (out.warnings.length) lines.push(`注意：${out.warnings.join("；")}。请如实告诉用户，不要假装成片是完整的。`);
      lines.push("界面已显示为可播放的卡片，回复里不必再贴 HTML，简短说明成片内容即可。");
      return { result: lines.join("\n"), status: "success" };
    } catch (err) {
      if (this.abortSignal?.aborted) {
        if (meta) meta.userMessage = "已取消渲染";
        return { result: "渲染已被用户取消。", status: "error" };
      }
      if (meta) meta.userMessage = "动画渲染失败，可换种写法重试";
      return { result: `渲染失败：${(err as Error).message}`, status: "error" };
    }
  }

  /**
   * generate_image 工具实现：提示词 → 外部生图服务 → PNG 落盘。
   *
   * 与 renderMedia 的分界：那边画面由模型写的 HTML 决定（本机渲染、可复现、免费）；
   * 这边画面由服务商决定（写实感更强，但不可精确控制、要花额度）。
   * 所以这里只做「校验 → 调宿主 → 上报产物」，不碰任何生成细节。
   */
  /** @internal */ async generateImage(
    toolArgs: Record<string, unknown>,
    meta?: ToolMeta,
  ): Promise<{ result: string; status: "success" | "error" }> {
    const generator = this.host.imageGenerator;
    if (!generator) {
      if (meta) meta.userMessage = "当前环境暂不支持生成图片";
      return {
        result: "当前运行环境没有生图能力。需要图形时改用 svg 产物，或提示用户去设置里开启并配置图片生成服务。",
        status: "error",
      };
    }

    const parsed = parseGenerateImageArgs(toolArgs);
    if (!parsed.ok) {
      if (meta) meta.userMessage = "生图参数不完整或格式有误";
      return { result: parsed.error, status: "error" };
    }

    const env = await generator.checkEnv();
    if (!env.ok) {
      if (meta) meta.userMessage = "生图服务还没配置好";
      return {
        result:
          `生图服务不可用：${env.problem ?? "未配置"}。` +
          "请提示用户到「设置 → Axon → 图片生成」里填写服务地址、密钥与模型后再试；当前不要反复重试。",
        status: "error",
      };
    }

    const dir = this.getArtifactDir();
    if (!dir) {
      if (meta) meta.userMessage = "暂时无法确定图片保存位置";
      return { result: "当前无法确定产物保存位置（会话尚未建立），请稍后再试。", status: "error" };
    }

    try {
      await this.host.fs.mkdirp(dir);
      const stem = sanitizeStem(parsed.title);

      // 生图通常几秒到十几秒，没有反馈用户会以为卡死；节流到 500ms 一条。
      let lastSentAt = 0;
      const out = await generator.generate({
        prompt: parsed.prompt,
        negativePrompt: parsed.negativePrompt,
        width: parsed.width,
        height: parsed.height,
        count: parsed.count,
        outputDir: dir,
        stem,
        signal: this.abortSignal,
        onProgress: ({ phase, done, total }) => {
          const now = Date.now();
          if (now - lastSentAt < 500 && done < total) return;
          lastSentAt = now;
          const text = phase === "requesting" ? "正在生成图片" : `正在保存图片（${done}/${total}）`;
          this.send("status", { content: `${text}...`, phase: "running" });
        },
      });

      // 每张图单独上报一条产物，界面按卡片逐个展示（和连续渲染多条成片的行为一致）
      out.files.forEach((f, i) => {
        const versionMatch = /-v(\d+)\.png$/i.exec(f.path);
        const artifact = {
          path: f.path,
          title: out.files.length > 1 ? `${parsed.title} ${i + 1}` : parsed.title,
          type: "png" as const,
          size: f.size,
          version: versionMatch ? Number(versionMatch[1]) : 1,
        };
        if (meta && i === 0) meta.artifact = artifact;
        this.send("artifact_created", artifact);
      });

      const lines = [`已生成 ${out.files.length} 张图片：`];
      for (const f of out.files) lines.push(`- ${f.path}（${f.size} 字节）`);
      if (parsed.notes.length) lines.push(`参数调整：${parsed.notes.join("；")}。`);
      if (out.warnings.length) lines.push(`注意：${out.warnings.join("；")}。请如实告诉用户，不要假装全部成功。`);
      lines.push("图片已作为产物显示在界面里，回复里不必粘贴图片数据，简短说明画了什么即可。");
      return { result: lines.join("\n"), status: "success" };
    } catch (err) {
      if (this.abortSignal?.aborted) {
        if (meta) meta.userMessage = "已取消生图";
        return { result: "生图已被用户取消。", status: "error" };
      }
      if (meta) meta.userMessage = "生成图片失败，可调整描述后重试";
      return { result: `生成失败：${(err as Error).message}`, status: "error" };
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
    this.powerRegistry?.setWorkspaces(this.workspaces);
    this.mcpRegistry?.setWorkspaces(this.workspaces);
    this.relayStore?.setRoots([this.cwd, this.homeDir]);
    this.wikiStore?.setRoots([this.cwd, ...this.workspaces]);
  }

  /** 设置多工作区路径（工作区组绑定时调用） */
  setWorkspaces(dirs: string[]): void {
    this.workspaces = dirs.length > 0 ? dirs : [this.cwd];
    this.cwd = this.workspaces[0]; // 主工作区为第一个
    this.terminalCwd = this.cwd;
    this.skillRegistry?.setWorkspaces(this.workspaces);
    this.powerRegistry?.setWorkspaces(this.workspaces);
    this.mcpRegistry?.setWorkspaces(this.workspaces);
    this.relayStore?.setRoots([this.cwd, this.homeDir]);
    this.wikiStore?.setRoots([this.cwd, ...this.workspaces]);
  }

  /** 用户明确确认后的工作区初始化；普通打开/切换工作区不写 .axon。 */
  async initializeWorkspaceAxon(workspace: string, axonContent?: string) {
    return initializeWorkspaceAxon(this.host, workspace, axonContent);
  }

  /** 只读探测各工作区的 .axon 现状；不创建目录、不写文件。 */
  async inspectWorkspacesAxon(): Promise<WorkspaceAxonStatus[]> {
    return inspectWorkspacesAxon(this.host, this.workspaces);
  }

  /** 只读分析工作区，生成 AXON.md 草案；不写入任何文件。 */
  async proposeWorkspaceAxon(workspace: string): Promise<string> {
    const base = await this.resolveExecutingModel();
    const strategy = getStrategy(base.provider, base.model);
    const runner = new SubAgentRunner({
      strategy,
      model: base.model,
      cwd: workspace,
      workspaces: this.workspaces,
      host: deriveSubAgentHost(this.host),
      signal: this.abortSignal,
      emit: () => {},
      skillLoader: this.loadSkillForTool,
      web: this.web,
      think: this.think,
      modelSupportsThinking: declaredThinkingFor(base.model, base.provider),
      readOnly: true,
    });
    const result = await runner.run(
      "请只读分析这个工作区，生成一份 AXON.md 草案。\n" +
      "必须包含：项目结构、主要模块、构建/测试命令、长期开发约定、验证方式和明显的架构边界。\n" +
      "不要修改任何文件，不要运行写操作，不要读取或引用 CLAUDE.md、.claude/、AGENTS.md。\n" +
      "最终只输出完整 Markdown 正文，不要输出解释、代码围栏或前后套话。",
      null,
    );
    return result.text.trim();
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
    this.editModePreference = mode;
    // 自动 / 完全访问下改动一律直接落盘；用户的「自动应用」偏好留着，切回安全模式时恢复
    this.host.edits.setMode(skipsApproval(this.permissionMode) ? "auto" : mode);
  }

  /** 后台任务（没人盯着）：不提问、不等用户（见 session/agentTasks.ts） */
  /** @internal */ unattended = false;

  /** 权限模式（安全 / 自动 / 完全访问，逐层包含，见 permissionMode.ts） */
  /** @internal */ permissionMode: PermissionMode = "safe";
  private editModePreference: "auto" | "manual" = "manual";

  /** 切换权限模式；切到自动 / 完全访问时把暂存的改动一并落盘 */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = normalizePermissionMode(mode);
    if (skipsApproval(this.permissionMode)) {
      if (this.host.edits.hasPending()) await this.acceptEdits();
      // 正在等的工具确认（MCP 写操作 / Relay）直接放行
      if (this.toolConfirmResolve) {
        const resolve = this.toolConfirmResolve;
        this.toolConfirmResolve = null;
        resolve(true);
      }
    }
    this.host.edits.setMode(skipsApproval(this.permissionMode) ? "auto" : this.editModePreference);
  }

  /** 允许写入的工作区外目录：产物 / 产出目录；完全访问时不限 */
  /** @internal */ permissionWriteRoots(): string[] {
    const roots = [this.getArtifactDir(), this.outputDir].filter((p): p is string => typeof p === "string" && p.trim() !== "");
    return writesAnywhere(this.permissionMode) ? [...roots, ANY_PATH] : roots;
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

  /** 获取最近一次的累计 token 数（委托 TokenAccountant） */
  getLastTotalTokens(): number {
    return this.tokenAccountant.getLastTotalTokens();
  }

  /** 会话还没有模型时（刚从磁盘恢复、尚未发过消息）补上；已有模型不覆盖——那是正在用的 */
  adoptModelIfUnset(model?: string, provider?: string): void {
    if (this.model || !model) return;
    this.model = model;
    if (provider && !this.provider) this.provider = provider;
  }

  /** 自动压缩线（token）：按窗口留余量算，用户可在设置里选更早压缩（见 autoCompactThreshold） */
  getAutoCompactAt(): number {
    return autoCompactThreshold(this.getContextWindow(), this.compactionConfig.autoCompactAt);
  }

  /** 当前上下文的来源拆分（上下文面板明细）；拆分失败返回 undefined，只少一块明细 */
  getContextBreakdown(): ContextBreakdown | undefined {
    try { return this.tokenAccountant.buildContextBreakdown(); } catch { return undefined; }
  }

  /** 从持久化快照回填上下文 token 统计（委托 TokenAccountant） */
  hydrateTokenUsage(totalTokens?: number): void {
    this.tokenAccountant.hydrateTokenUsage(totalTokens);
  }

  /**
   * 只重算当前上下文占用、**不推送 UI**（委托 TokenAccountant）。
   * 给"内部需要最新占用、但不该改动界面数字"的场景用（判定手动压缩阈值前的那次重算）。
   */
  recomputeTokenUsage(): number {
    return this.tokenAccountant.recomputeTokenUsage();
  }

  /** 取消当前进行中的请求。压缩进行中时忽略——中断会破坏消息完整性。 */
  cancel(): void {
    if (this.isCompacting) return;
    this.cancelled = true;
    // 解除问答门：ask_user 刻意不设超时，若不在此解除，等用户作答的 agent loop 会一直挂着。
    if (this.askUserResolve) {
      const resolveAsk = this.askUserResolve;
      this.askUserResolve = null;
      this.askUserPendingToolCallId = null;
      resolveAsk(null);
    }
    // 表单门同样不设超时，必须一起解除，否则等提交的 agent loop 会一直挂着。
    if (this.formSubmitResolve) {
      const resolveForm = this.formSubmitResolve;
      this.formSubmitResolve = null;
      this.formPendingToolCallId = null;
      resolveForm(null);
    }
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

  /** 外部 resolve 问答门（由 SessionHub.dispatch answer_user_question 调用）。 */
  resolveUserAnswer(toolCallId: string, answers: AskUserAnswer[] | null): void {
    // 只接受"当前这次提问"的答案：旧卡片、失效会话（reload 后）回传的答案一律忽略。
    if (this.askUserPendingToolCallId !== toolCallId || !this.askUserResolve) return;
    const resolve = this.askUserResolve;
    this.askUserResolve = null;
    this.askUserPendingToolCallId = null;
    resolve(answers);
  }

  /**
   * 等待用户对一次提问的作答（ask_user 工具，可含多个问题）：发 ask_user_request 后【无限阻塞】。
   * 不设超时（提问就是要等用户）；仅当会话被取消时由 cancel() 解除，返回 null 让 agent loop 收敛。
   */
  /** @internal */ waitForUserAnswer(
    toolCallId: string,
    questions: AskUserQuestion[],
  ): Promise<AskUserAnswer[] | null> {
    this.send("ask_user_request", { toolCallId, questions });
    this.askUserPendingToolCallId = toolCallId;
    return new Promise<AskUserAnswer[] | null>((resolve) => {
      this.askUserResolve = resolve;
    });
  }

  /** 外部 resolve 表单门（由 SessionHub.dispatch submit_form 调用）。 */
  resolveFormSubmit(toolCallId: string, payload: FormSubmitPayload | null): void {
    // 与问答门同一道校验：只接受"当前这张表单"的提交；旧卡片、失效会话（reload 后）回传的一律忽略。
    if (this.formPendingToolCallId !== toolCallId || !this.formSubmitResolve) return;
    const resolve = this.formSubmitResolve;
    this.formSubmitResolve = null;
    this.formPendingToolCallId = null;
    resolve(payload);
  }

  /**
   * 等待用户提交一次表单（ask_form 工具）：发 form_request 后【无限阻塞】。
   * 不设超时（表单就是要等用户填完）；仅当会话被取消时由 cancel() 解除，返回 null 让 agent loop 收敛。
   */
  /** @internal */ waitForFormSubmit(toolCallId: string, spec: FormSpec): Promise<FormSubmitPayload | null> {
    this.send("form_request", { toolCallId, form: spec as unknown as Record<string, unknown> });
    this.formPendingToolCallId = toolCallId;
    return new Promise<FormSubmitPayload | null>((resolve) => {
      this.formSubmitResolve = resolve;
    });
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
    // 自动 / 完全访问：不弹确认，直接执行
    if (skipsApproval(this.permissionMode)) return Promise.resolve(true);
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
   * 解析子 Agent 执行阶段（delegate_task）应使用的 provider + model。
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
    // ── 收尾类事件统一带上「本轮的轮次标识」──
    // 一次取消在后端会发出**不止一条**收尾事件：cancel() 的兜底（elapsed 恒为 0）+ agent loop 解栈时补的
    // 那条（elapsed 真实），取消与"正常完成"赛跑时还会有正常的 stream_end。这些事件的 payload 里没有任何
    // 轮次信息，前端只能靠 elapsed 去猜它属于哪一轮 —— 猜不准就会把**新一轮**的状态抹掉：
    // 表现为「排队消息已经发出去了、对话区却没开始」，或「两条排队消息并发跑」。
    //
    // 这里把前端发起本轮时给的 clientMessageId 原样带回（它在 channel/commands.ts 里已有定义，
    // sessionHub 也已透传给 handleUserInput），前端就能确定性归属，不必再推断。
    // 只在终态事件上注入：它们才是"某一轮结束了"的宣告。
    // 向后兼容：老前端忽略这个多出来的字段，行为不变。
    if (this.currentTurnClientMessageId && (type === "stream_end" || type === "turn_cancelled")) {
      data = { ...data, clientMessageId: this.currentTurnClientMessageId };
    }
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
      case "command_risk_notice":
        this.trace("command.risk_notice", data, this.turnCount || undefined);
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

  /**
   * 记忆召回提示 —— 把「本轮注入了哪些 Wiki 页面」推给前端。
   *
   * ── 为什么按签名去重，而不是每轮都发 ──
   * 召回每轮都在发生，但内容绝大多数时候不变。逐轮推送的结果是一串完全相同的卡片，
   * 真正的变化（新增一页、某页转陈旧）反而淹没其中。签名相同就完全静默 ——
   * 于是「卡片出现」本身就意味着「记忆变了」，这才有信息量。
   * 这与视图徽标只在有待复核页时才亮，是同一条原则。
   *
   * 失败不上报：这是提示性信息，不该因为它出错而打断本轮对话。
   */
  private announceWikiRecall(recall: WikiRecall | null): void {
    // 没有召回内容：清空基准，使页面重新出现时能再次提示
    // （而不是与一个早已失效的旧签名比较，从而被误判成「没变化」）
    if (!recall) {
      this.lastWikiRecallSignature = null;
      return;
    }
    const sig = wikiRecallSignature(recall);
    if (sig === this.lastWikiRecallSignature) return;
    this.lastWikiRecallSignature = sig;
    this.send("wiki_recall", { total: recall.total, pages: recall.pages });
  }

  /** 工具定义装配（委托 ToolDefBuilder） */
  /** @internal */ getToolDefs(): ToolDef[] {
    return this.toolDefBuilder.getToolDefs();
  }

  /** 回复进行中追加一条消息（插话） */
  enqueueSteer(steer: SteerMessage): void {
    this.pendingSteers.push(steer);
  }

  /** 撤回还没被模型看到的插话；已经插进对话的撤不回，返回 false */
  cancelSteer(clientMessageId: string): boolean {
    const before = this.pendingSteers.length;
    this.pendingSteers = this.pendingSteers.filter((s) => s.clientMessageId !== clientMessageId);
    return this.pendingSteers.length < before;
  }

  /** 取走所有未插入的插话（这一轮结束后由 SessionHub 开新一轮） */
  takeSteers(): SteerMessage[] {
    const steers = this.pendingSteers;
    this.pendingSteers = [];
    return steers;
  }

  /**
   * 把插话作为用户消息插进对话：每次请求模型之前调用。
   * 正文前加一句说明，让模型知道这是做到一半时用户补充的——优先照顾，但别把手上的事丢掉，除非用户就是要它停。
   */
  private absorbSteers(): void {
    if (this.pendingSteers.length === 0) return;
    const steers = this.takeSteers();
    const preface = "【用户在你工作过程中发来的消息】请结合它调整接下来的做法；除非用户要求停下或换方向，已经在做的事继续完成。\n\n";
    for (const steer of steers) {
      const content = typeof steer.content === "string"
        ? preface + steer.content
        : [{ type: "text", text: preface }, ...steer.content];
      this.messages.push({
        role: "user",
        content,
        displayText: steer.displayText,
        clientMessageId: steer.clientMessageId,
        ...(steer.attachedFiles?.length ? { attachedFiles: steer.attachedFiles } : {}),
        ...(steer.userSegments?.length ? { userSegments: steer.userSegments } : {}),
        _steer: true,
      } as unknown as ChatCompletionMessageParam);
    }
    this.send("steer_absorbed", { clientMessageIds: steers.map((s) => s.clientMessageId) });
    this.persistMessages();
  }

  /**
   * wait_process：在本次回复里等后台任务跑完。不传 terminalId 就等所有设了 notify、还在跑的任务。
   * 用户插话时提前返回（插话在下一次请求前并入对话），取消时立即返回。
   */
  /** @internal */ async waitProcesses(toolArgs: Record<string, unknown>): Promise<{ result: string; status: "success" | "error" }> {
    const tracker = this.backgroundTasks;
    if (!tracker) return { result: "当前环境不支持后台进程。", status: "error" };
    const wanted = typeof toolArgs.terminalId === "string" && toolArgs.terminalId.trim() ? [toolArgs.terminalId.trim()] : tracker.awaitedIds();
    if (wanted.length === 0) return { result: "没有在跑、需要等待的后台任务。", status: "success" };
    const labels = new Map((await tracker.list()).map((t) => [t.terminalId, t.command]));
    tracker.beginWait(wanted);
    let out: Awaited<ReturnType<typeof waitForProcesses>>;
    try {
      out = await waitForProcesses(this.host.processes!, wanted, {
        timeoutMs: waitTimeoutMs(toolArgs.timeoutMinutes),
        signal: this.abortSignal,
        interrupt: () => this.pendingSteers.length > 0,
      });
    } finally {
      tracker.endWait(wanted);
    }
    return { result: formatWaitResult(out, labels), status: "success" };
  }

  /**
   * 执行前把模型给的参数摆正：先纠正个别工具的整体结构（ask_user / ask_form…），再按工具定义纠正类型和参数名、检查必填。
   * 返回 error 时不执行，把原因交还给模型。
   */
  /** @internal */ prepareToolArgs(toolName: string, args: Record<string, unknown>): { args: Record<string, unknown>; error?: string } {
    const pre = preNormalizeArgs(toolName, args);
    const schema = schemaForTool(this.toolDefBuilder.getAllToolDefs() as never, toolName);
    const out = coerceToolArgs(toolName, pre, schema);
    if (out.fixes.length) console.debug(`[tool-args] ${toolName} 参数已纠正：${out.fixes.join("；")}`);
    return { args: out.args, error: out.error };
  }

  /** load_tools 工具实现：按组名加载不常用的工具组，下一次请求起生效 */
  /** @internal */ loadTools(toolArgs: Record<string, unknown>): { result: string; status: "success" | "error" } {
    const groups = this.toolDefBuilder.toolGroups();
    return loadToolsResult(this.toolLoadout.load(toolArgs, groups), groups.filter((g) => !this.toolLoadout.isLoaded(g.id)));
  }

  /** 模型直接调用了未加载组里的工具：照常执行，并把整组加载上 */
  /** @internal */ noteToolUsed(toolName: string): void {
    this.toolLoadout.noteToolUsed(toolName, this.toolDefBuilder.toolGroups());
  }

  /** 设置思考开关（每轮用户输入前由 SessionHub 注入，agent / quest 两种模式都生效） */
  setThink(think: boolean): void {
    this.think = think;
  }

  /** 设置 Quest 模式选项（每轮用户输入前由 SessionHub 注入） */
  setQuestOptions(opts: { webSearch?: boolean }): void {
    if (typeof opts.webSearch === "boolean") this.questWebSearch = opts.webSearch;
  }

  /** 设置动画生成能力开关（建会话时注入 + 设置变更时热更新） */
  setMediaEnabled(enabled: boolean): void {
    this.mediaEnabled = enabled === true;
  }

  /** 设置文生图能力开关（建会话时注入 + 设置变更时热更新） */
  setImageEnabled(enabled: boolean): void {
    this.imageEnabled = enabled === true;
  }

  /**
   * 为指定工作区生成 / 续跑 Wiki。
   *
   * workspace 必须由调用方（UI）显式给出：生成是写操作，而多工作区下会话 cwd 未必是
   * 用户想生成的那个仓库。写错会把一批文件塞进不相干的仓库，而且它们还会被提交上去 ——
   * 读可以猜，写不能猜。
   *
   * 编排逻辑在 WikiController 里，本方法只负责把会话侧的能力（模型、宿主、skill 加载器、
   * 中断信号）接上去。这样编排可以脱离真实模型单测，而生成质量交给 skill 与子 Agent。
   */
  /** 设置产出目录（Cowork 每轮注入） */
  /** @internal */ setOutputDir(dir: string): void {
    this.outputDir = dir || "";
  }

  /** 设置 Chat 产物目录（每轮注入；空串表示用默认位置） */
  /** @internal */ setArtifactDir(dir: string): void {
    this.artifactDir = typeof dir === "string" ? dir.trim() : "";
  }

  /**
   * 当前生效的产物目录（绝对路径）。
   *
   * 用户设置过就用用户的；没设置则落到 ~/.axon/artifacts/<会话id>/。
   * 默认位置放用户目录而不是工作区：产物是交付物，不该混进项目源码、污染 git。
   * 按会话分子目录，是为了不同会话里同名产物（report.html）互不覆盖。
   *
   * 相对路径一律按工作区解析，与其他工具的路径语义一致。
   * 会话 id 还没建立（极早期）或没有 homeDir 时返回空串，调用方应据此判定「无法落盘」，
   * 而不是悄悄写到进程工作目录。
   */
  getArtifactDir(): string {
    return resolveArtifactDir({
      configured: this.artifactDir,
      cwd: this.cwd,
      homeDir: this.homeDir,
      sessionId: this.getSessionId(),
    });
  }

  /**
   * 开启 Cowork 附件快照（Cowork 面板每轮注入）。
   *
   * 幂等：同一会话重复调用只更新 sessionId 归属，不重复建目录。
   */
  /** @internal */ enableCoworkSnapshots(sessionId: string): void {
    if (!this.homeDir) return;
    if (this.coworkSnapshotter && this.coworkSnapshotter.sessionId === sessionId) return;
    this.coworkSnapshotter = new CoworkSnapshotter(this.host, this.homeDir, sessionId);
  }

  /**
   * report_outputs 工具实现（Cowork）：Agent 主动登记本轮做出的交付物。
   *
   * ── 为什么改成让 Agent 报，而不是我们扫目录 ──
   * 扫目录每一步都在猜：猜扫哪几个根（用户未必设过产出目录）、猜哪些文件算产出
   * （Agent 为处理 Excel 写的临时 .py 不算）、靠 mtime diff 猜新旧。三层猜测叠起来
   * 失准是必然的，实际就踩到了：产出卡片空着，而状态行说"6 个文件"。
   * Agent 自己清楚哪个是最终交付物、哪个只是中间脚本，直接问它要最准。
   *
   * 仍然做存在性校验：模型可能凭记忆拼路径、或把计划中要写的文件提前报上来。
   * 过滤掉磁盘上不存在的项，并把结果如实告诉模型（它可以据此补写或改口），
   * 而不是静默丢弃 —— 静默丢弃会让它以为交付成功了。
   */
  /** @internal */ async reportOutputs(
    toolArgs: Record<string, unknown>,
    meta?: ToolMeta,
  ): Promise<{ result: string; status: "success" | "error" }> {
    const raw = Array.isArray(toolArgs.files) ? toolArgs.files : [];
    if (raw.length === 0) {
      return { result: "files 为空。没有产出文件时不要调用本工具。", status: "error" };
    }

    const accepted: { path: string; kind?: "created" | "edited"; note?: string }[] = [];
    const missing: string[] = [];
    const seen = new Set<string>();

    for (const item of raw.slice(0, MAX_REPORTED_OUTPUTS)) {
      const entry = (item || {}) as { path?: unknown; kind?: unknown; note?: unknown };
      const p = typeof entry.path === "string" ? entry.path.trim() : "";
      if (!p) continue;
      // 去重：模型偶尔会把同一个文件报两次（分别作为"生成"和"改写"）
      const key = p.replace(/\\/g, "/").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      // 相对路径解析到工作区，与其他工具的路径语义保持一致
      const abs = isAbsolute(p) ? p : resolve(this.cwd, p);
      try {
        const info = await this.host.fs.stat(abs);
        if (info?.isFile) {
          accepted.push({
            path: abs,
            ...(entry.kind === "created" || entry.kind === "edited" ? { kind: entry.kind } : {}),
            ...(typeof entry.note === "string" && entry.note ? { note: entry.note } : {}),
          });
        } else {
          missing.push(p);
        }
      } catch {
        missing.push(p);
      }
    }

    if (accepted.length > 0) {
      const paths = accepted.map((f) => f.path);
      if (meta) {
        meta.reportedOutputs = paths;
        meta.reportedOutputItems = accepted.map(({ path, kind }) => ({
          path,
          kind,
          // 有原稿快照的 edited 文件才标记可恢复；created 没有原稿可回
          ...(kind === "edited" && this.currentCoworkSnapshotDir
            && this.snapshotPaths.includes(path) ? { snapshotDir: this.currentCoworkSnapshotDir } : {}),
        }));
      }
      this.send("cowork_outputs", { paths, files: accepted.map(({ path, kind }) => ({ path, kind })) });
    }

    if (missing.length > 0) {
      const hint = `以下路径在磁盘上不存在，未登记：\n${missing.map((m) => `- ${m}`).join("\n")}\n`
        + `请确认文件确实已写入（必要时用 list_dir 核对），再重新登记这些文件。`;
      return {
        result: accepted.length > 0
          ? `已登记 ${accepted.length} 个产出文件。${hint}`
          : hint,
        status: accepted.length > 0 ? "success" : "error",
      };
    }

    return { result: `已登记 ${accepted.length} 个产出文件，已显示给用户。`, status: "success" };
  }

  /** report_checks 工具实现（Cowork）：把自查结果推给前端，并随工具结果落盘供历史恢复 */
  /** @internal */ reportChecks(toolArgs: Record<string, unknown>, meta?: ToolMeta): { result: string; status: "success" | "error" } {
    const checks = parseChecks(toolArgs);
    if (checks.length === 0) return { result: "checks 为空：每条需要 label、status（pass/warn/fail）和 detail。没有可核对的内容时不要调用。", status: "error" };
    if (meta) meta.reportedChecks = checks;
    this.send("cowork_checks", { checks });
    return { result: checksResult(checks), status: "success" };
  }

  /**
   * 生成并推送本轮意图文案（Cowork）。
   *
   * 全程吞异常：这是纯展示增强，失败时前端仍有规则兜底的文案，不该因为它让一轮
   * 办公任务报错。也不复用 this.abortController 之外的信号 —— 用户点停止时这条
   * 请求要跟着一起断，否则会在任务已取消后又推一条状态上来。
   */
  /**
   * 为已结束的工具分组生成一句话摘要，推给前端并落盘到组内第一条工具轮消息上。
   *
   * 只对 Chat Completions 协议的模型生成（DeepSeek / Qwen / GLM 等）；Cowork 不展示工具调用，
   * 不需要。fire-and-forget：失败、超时、用户取消都直接放弃，前端照常只显示统计。
   */
  /** 进行中的分组攒够 3~5 个工具：生成一条「正在…」的阶段摘要推给前端（不落盘，分组结束后的标题才落盘） */
  private summarizeToolGroupProgress(strategy: LLMStrategy): void {
    const group = this.toolGroupTracker.takeProgress();
    if (!group || strategy.name !== "chat_completions" || this.humanizedStatus) return;
    const request = this.lastUserInput?.content ?? "";
    void generateToolGroupSummary({
      strategy, model: this.model, request, actions: group.actions.slice(-8), live: true,
      modelSupportsThinking: declaredThinkingFor(this.model, this.provider), signal: this.abortController?.signal,
    }).then((summary) => {
      if (summary) this.send("tool_group_progress", { toolCallId: group.anchorToolCallId, summary });
    }).catch(() => { /* 锦上添花，失败不影响主流程 */ });
  }

  private summarizeToolGroups(strategy: LLMStrategy, groups: ClosedToolGroup[]): void {
    if (groups.length === 0 || strategy.name !== "chat_completions" || this.humanizedStatus) return;
    const model = this.model;
    const modelSupportsThinking = declaredThinkingFor(this.model, this.provider);
    const request = this.lastUserInput?.content ?? "";
    const signal = this.abortController?.signal;
    for (const group of groups) {
      void (async () => {
        try {
          const summary = await generateToolGroupSummary({
            strategy, model, request, actions: group.actions, modelSupportsThinking, signal,
          });
          if (!summary) return;
          const toolCallId = group.anchorToolCallId;
          this.send("tool_group_summary", { toolCallId, summary });
          // 落盘：重开会话时前端从这里还原折叠行标题。消息已被压缩掉就不必再记。
          const owner = this.messages.find((m) => {
            const calls = (m as { tool_calls?: Array<{ id: string }> }).tool_calls;
            return m.role === "assistant" && Array.isArray(calls) && calls.some((tc) => tc.id === toolCallId);
          });
          if (owner) {
            (owner as any).displayGroupSummary = { toolCallId, text: summary };
            this.persistMessages();
          }
        } catch {
          // 摘要只是锦上添花：任何失败都不影响主流程
        }
      })();
    }
  }

  private async emitHumanizedIntent(
    strategy: ReturnType<typeof getStrategy>,
    input: string,
    attachedFiles?: { name: string; size: number }[],
  ): Promise<void> {
    try {
      const text = await generateIntent({
        strategy,
        model: this.model,
        request: input,
        fileNames: (attachedFiles || []).map((f) => f.name),
        signal: this.abortController?.signal,
      });
      // 取消后不再推：那会让已停止的任务又冒出一行"正在…"
      if (!text || this.cancelled) return;
      this.humanizedIntent = text;
      this.send("status", { content: text, phase: "thinking", humanized: true });
    } catch {
      // 静默：保留前端的兜底文案
    }
  }

  /**
   * 生成并推送阶段文案（Cowork）。
   *
   * 由工具调用处触发，经 shouldGeneratePhase 的节流与去重后才真正发请求 ——
   * 一轮里连着十几次 read_file 不该打十几次模型请求。
   */
  /** @internal */ async emitHumanizedPhase(toolName: string, args: Record<string, unknown>): Promise<void> {
    if (!this.humanizedStatus) return;
    const action = describeAction(toolName, args);
    if (!shouldGeneratePhase(this.humanizedState, action)) return;
    try {
      const text = await generatePhase({
        strategy: getStrategy(this.provider, this.model),
        model: this.model,
        intent: this.humanizedIntent,
        action,
        signal: this.abortController?.signal,
      });
      if (!text || this.cancelled) return;
      this.send("status", { content: text, phase: "acting", humanized: true });
    } catch {
      // 静默：状态行会退回按工具规则生成的文案
    }
  }

  /** @internal */ async generateWiki(workspace: string, opts: WikiGenerationOptions = {}): Promise<WikiGenerationResult> {
    // 防重入：两次并发生成会互相破坏 ——
    // 第二次 startJob 会把第一次那个【仍在活跃】的作业标成 interrupted
    // （startJob 的语义是「新作业开始时旧进程必然已死」，同进程并发下该假定不成立），
    // 而两边又同时往同一个 .axon/wiki/ 写。结果是进度错乱、状态互相覆盖。
    // 触发路径很平常：手快连点两次，或点完忘了、过一会儿又点一次。
    if (this.wikiGenerating) {
      return {
        ok: false,
        done: 0,
        total: 0,
        failed: [],
        resumed: false,
        message: "已有 Wiki 生成在进行中。请等它结束，或先取消再重试。",
      };
    }
    this.wikiGenerating = true;
    try {
      return await this.doGenerateWiki(workspace, opts);
    } finally {
      // 无论成功 / 失败 / 取消都要复位，否则一次失败会把功能永久锁死
      this.wikiGenerating = false;
    }
  }

  /** generateWiki 的实际实现。已被防重入守卫包裹，不要直接调用。 */
  private async doGenerateWiki(workspace: string, opts: WikiGenerationOptions = {}): Promise<WikiGenerationResult> {
    // 模型解析：显式配置优先 → 回退到会话所用（含 Relay 执行阶段的模型覆盖）。
    //
    // 为什么给 Wiki 留一个独立的模型开关：它是本项目里最贵的单个操作，
    // 而「聊天的便宜模型」与「读懂架构所需的模型」往往不是同一个。
    // 默认仍跟随会话 —— 跑得少、要读懂代码，沿用用户已认可的选择最稳妥。
    // 解析逻辑抽到 resolveWikiModel（纯函数，可单测）：
    // 显式配置优先 → 回退到会话所用（base 已含 Relay 执行阶段的模型覆盖）。
    const base = await this.resolveExecutingModel();
    const { provider, model } = resolveWikiModel(base, opts);
    const strategy = getStrategy(provider, model);

    const controller = new WikiController({
      host: this.host,
      workspaces: this.workspaces,
      store: this.wikiStore,
      model,
      maxPages: opts.maxPages,
      sessionId: this.getSessionId(),
      signal: this.abortSignal,
      emit: (event) => this.send("wiki_generation", { event }),
      runSubAgent: async (req) => {
        const runner = new SubAgentRunner({
          strategy,
          model,
          // cwd 用目标工作区：子 Agent 的相对路径解析、目录预览都应以它为根
          cwd: workspace,
          workspaces: this.workspaces,
          // 派生独立 host：子 Agent 的 edits 暂存区独立，不与父会话互相干扰
          host: deriveSubAgentHost(this.host),
          signal: this.abortSignal,
          // 子 Agent 的内部过程**刻意不转发**到前端。
          //
          // 一是会让聊天界面被十几张卡片灌满（用户明确担心过"污染会话"），
          // 二是没有对应的 sub_agent_start，前端会把事件路由到不存在的卡片上。
          // 进度改由 wiki_generation 事件承载（带「共几页、已完成几页」），
          // 由呈现端渲染成状态栏提示与列表刷新 —— 那才是这种长任务合适的展示位。
          emit: () => { /* 见上：不转发子 Agent 内部过程 */ },
          skillLoader: this.loadSkillForTool,
          web: this.web,
          // 思考开关跟随父会话；wiki 工具按阶段注入（plan / save）
          think: this.think,
          modelSupportsThinking: declaredThinkingFor(model, provider),
          readOnly: req.readOnly,
          wiki: req.wiki,
        });
        const res = await runner.run(req.prompt, req.skill);
        return { ok: res.ok, text: res.text };
      },
    });

    return controller.generate(workspace);
  }

  /** use_skill 工具的 skill 加载器（绑定 this，传给 executeToolCall） */
  /** @internal */ loadSkillForTool = async (name: string): Promise<{ name: string; dir: string; body: string } | null> => {
    const skill = await this.skillRegistry.load(name);
    // 记下最近加载的技能目录：read_skill_file 的相对路径按它解析
    if (skill?.dir) this.lastLoadedSkillDir = skill.dir;
    return skill ? { name: skill.name, dir: skill.dir, body: skill.body } : null;
  };
  /** 最近一次 use_skill 加载的技能目录（read_skill_file 相对路径的基准） */
  private lastLoadedSkillDir = "";

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

  /** 根据当前模型返回上下文窗口大小（统一来源 modelContextWindow） */
  /** @internal */ getContextWindow(): number {
    return modelContextWindow(this.model);
  }

  /** 推送当前上下文 token 占用给前端（委托 TokenAccountant） */
  /** @internal */ updateAndSendTokenUsage(): void {
    this.tokenAccountant.updateAndSendTokenUsage();
  }

  /**
   * 本轮用量展示（花费 / Token 数 / 官方 Credits，见 billing.ts）。
   * 端点没报 usage 时用本地估算的 prompt 规模兜底，并标记 estimated。
   */
  /** @internal */ buildTurnBilling(estimatedOutput?: number): TurnBilling {
    const reported = this.turnInputTokens > 0;
    const output = this.lastTurnOutputTokens || estimatedOutput || this.lastCompletionTokens || 0;
    let input = this.turnInputTokens;
    if (!reported) {
      const b = this.buildTokenBreakdown();
      input = b.memoryTokens + b.systemTokens + b.questionTokens;
    }
    const usage = { input, cached: reported ? this.turnCachedTokens : 0, output, ...(reported ? { requests: this.turnRequestCount } : { estimated: true }) };
    return resolveTurnBilling(this.provider, getProviderPricing(this.provider), this.model, usage);
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
  private async finalizeAssistantReply(contentBuffer: string, turnStartTime: number, streamedContentThisRound: string, rounds: number, anthropicThinkingBlocks?: { thinking: string; signature?: string }[], reasoningContent?: string): Promise<void> {
    const out = this.turnFinalizer.finalize({
      contentBuffer,
      anthropicThinkingBlocks,
      reasoningContent,
      streamedContentThisRound,
      turnStartTime,
      model: this.model,
      providerName: getProviderDisplayName(this.provider),
      effort: this.effort,
      messages: this.messages,
      lastTurnTokens: this.lastTurnTokens,
      lastTurnOutputTokens: this.lastTurnOutputTokens,
      lastCompletionTokens: this.lastCompletionTokens,
      buildTokenBreakdown: () => this.buildTokenBreakdown(),
      buildTurnBilling: (estimatedOutput) => this.buildTurnBilling(estimatedOutput),
      rollingSummaryAccumulated: this.rollingSummaryAccumulated,
      triggerTokens: this.compactionConfig.triggerTokens,
    });
    this.messages = out.messages;
    this.persistMessages(); // 最终回复落盘，切走也保留
    this.send("stream_end", { elapsed: out.elapsed, tokens: out.turnTokens, model: this.model, modelName: getModelDisplayName(this.model, this.provider), providerName: getProviderDisplayName(this.provider), effort: this.effort, credits: out.credits, creditDetail: out.creditDetail, ...out.billing });
    this.rollingSummaryAccumulated = out.nextRollingSummaryAccumulated;
    if (out.shouldTriggerRollingSummary) this.maybeRollingSummary();
    // 混合记忆策略：每轮都登记；若滚动压缩已启动，入口会等待它完成后再决定是否后台更新，
    // 否则按轮数/token 节流合并。整个过程不 await，不阻塞用户继续发送下一条消息。
    void this.compactionController.maybeRefreshMemoryAfterTurn(out.turnTokens);
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
          effort: this.effort,
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
          reasoningContent: draft.reasoningContent,
          anthropicThinkingBlocks: draft.anthropicThinkingBlocks,
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
    anthropicThinkingBlocks?: { thinking: string; signature?: string }[],
    reasoningContent?: string,
  ): Promise<"continue" | "done"> {
    const decision = this.noToolTurnDecider.decide({ contentBuffer, finishReason, guard, ts });

    // provider/网关级失败不能按正常 stop 收尾。
    if (decision.action === "abort_error") {
      // ⚠️ 这条路径必须自己把错误"显示"出来：stampAbortedTurnStats 只负责把本轮标成 error
      // 并落盘，它一条文案都不发。于是当上游失败、又一个字都没流出来时，界面上只剩一个
      // 空气泡 + 一个 (?)，用户看不出这是请求失败了，只会以为模型"没话可说"。
      // 口径与 emitTransientError 一致：只做一次性展示，不写进 messages（避免污染上下文）。
      if (!streamedContentThisRound && !contentBuffer) {
        this.send("stream_start", {});
      }
      this.send("stream_delta", {
        content:
          "❌ 出错了：本轮请求没有成功完成（上游返回 error，未产生任何内容）。可以重试；" +
          "若持续出现，请检查该 Provider 的协议兼容性，或换一个模型试试。详细信息见输出面板日志。",
      });
      if (contentBuffer) {
        this.messages.push({
          role: "assistant",
          content: contentBuffer,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        });
      }
      this.stampAbortedTurnStats(turnStartTime, streamedContentThisRound || contentBuffer, "error");
      return "done";
    }

    // 输出被截断（truncated，对应 max_tokens）→ 让模型接着写，而不是把半截内容当成最终答案
    if (decision.action === "continue_truncated") {
      console.log("[agent] 输出被截断（length），注入续写引导");
      commitPendingText();
      this.messages.push({
        role: "assistant",
        content: contentBuffer,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      });
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
        this.messages.push({
          role: "assistant",
          content: contentBuffer,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        });
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
      this.messages.push({
        role: "assistant",
        content: contentBuffer,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
      });
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

    // 连续两次空回复不是一次成功响应：上游虽然给了 finish=stop/complete，却没有返回
    // 正文、思考或工具调用。旧逻辑会 finalizeAssistantReply("")，于是界面只剩 Credits
    // 和一个空白 Axon 消息。改为展示明确的临时错误回复，并正常结束本轮。
    if (decision.action === "abort_empty") {
      this.emitTransientError(
        "上游模型连续返回空响应。请重试；若持续出现，请检查该 Provider 的 Chat 协议兼容性或切换为其原生协议。",
        turnStartTime,
        streamedContentThisRound,
      );
      this.trace("turn.end", { finishReason, emptyResponse: true }, this.turnCount);
      return "done";
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
    await this.finalizeAssistantReply(finalContent, turnStartTime, streamedContentThisRound, rounds, anthropicThinkingBlocks, reasoningContent);
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
    // mermaid 不带 axon-render 也会渲染成图（前端按内容判断），这里同样算「在画图」
    const openMatch = content.match(/```(mermaid)[^\n`]*\n/i) ?? content.match(/```(svg|html)(?:[^\n`]*\s)?axon-render[^\n`]*\n/i);
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
    userMeta?: { displayText?: string; attachedFiles?: { name: string; size: number }[]; effort?: string; userSegments?: unknown[]; clientMessageId?: string; backgroundNotice?: Record<string, unknown> },
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
    // 只接受当前模型 Provider 明确配置的值。伪造值 / 旧模型残留直接按关闭处理，
    // 避免把端点不认识的 effort 原样发出去导致 400 或断流。
    const requestedEffort = userMeta?.effort?.trim();
    const allowedEfforts = declaredEffortValuesFor(this.model, this.provider);
    this.effort = requestedEffort && allowedEfforts.includes(requestedEffort) ? requestedEffort : undefined;

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
    this.turnInputTokens = 0;
    this.turnCachedTokens = 0;
    this.turnRequestCount = 0;
    // 新一轮用户输入，重置「单轮探索预算」（read_file / search / list_dir 的本轮累计上限）。
    // 放在这里而不是别处：用户再次发消息就是新的对话边界，预算必须跟着重置，
    // 否则它会跨轮累积、把后续每一轮都限死。
    this.toolOutcomeRecorder.resetTurnBudget();
    this.turnStartCumulative = this.cumulativeTokens; // 取消时用差值复原本轮消耗
    // 记录本轮开始前的消息条数（此刻 messages 仅含 system + 之前会话，尚未 push 本轮用户消息）。
    // 用它在收尾时切出"本轮新增的消息"（用户消息 + 工具结果），据此估算"本次输入"。
    this.turnStartMsgCount = this.messages.length;
    this.relayAdvancedThisTurn = false; // 新一轮用户输入，重置 Relay 阶段推进闸（确认门：一轮最多推进一个阶段）

    // 附件元数据（文件名/大小）挂到消息上，用于历史展示。displayText 为 UI 展示正文（不含拼接的文件内容）
    const userExtra: Record<string, unknown> = {};
    if (userMeta?.displayText !== undefined) userExtra.displayText = userMeta.displayText;
    if (userMeta?.clientMessageId) userExtra.clientMessageId = userMeta.clientMessageId;
    // 无条件刷新（不是"有才设"）：本轮没有标识时必须清掉上一轮的残留值，
    // 否则收尾事件会带着上一轮的 id 发出去 —— 那比不携带更糟：前端会"精确地归属错"。
    this.currentTurnClientMessageId = userMeta?.clientMessageId ?? null;
    if (userMeta?.attachedFiles && userMeta.attachedFiles.length > 0) userExtra.attachedFiles = userMeta.attachedFiles;
    if (userMeta?.userSegments && userMeta.userSegments.length > 0) userExtra.userSegments = userMeta.userSegments;
    // 后台任务结束通知发起的一轮：前端据此把这条「用户消息」画成一行系统通知
    if (userMeta?.backgroundNotice) userExtra.backgroundNotice = userMeta.backgroundNotice;
    if (this.effort) userExtra.effort = this.effort;

    // Cowork：轮开始时对本轮附件做原稿快照。失败不阻塞任务（快照是保障能力，
    // 不是前置条件）；重开会话后 sessionId 不变，历史登记里的 snapshotDir 仍有效。
    if (this.coworkSnapshotter && userMeta?.attachedFiles && userMeta.attachedFiles.length > 0) {
      const turnId = `turn-${Date.now()}`;
      const paths = userMeta.attachedFiles.map((f) => (f as { path?: string }).path).filter((p): p is string => !!p);
      if (paths.length > 0) {
        try {
          const result = await this.coworkSnapshotter.snapshot(turnId, paths);
          this.currentCoworkSnapshotDir = result.snapshotDir;
          this.snapshotPaths = result.snapshotPaths;
        } catch {
          this.currentCoworkSnapshotDir = "";
          this.snapshotPaths = [];
        }
      }
    }

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

    // 先按当前消息重算一次占用并推给界面：下面的自动压缩判定、本轮的使用率提醒都读它。
    // 不重算的话读到的是上一轮结束时、甚至从磁盘恢复的旧值——压缩、换模型、编辑消息之后
    // 界面显示 10%，判定和提醒却还按旧的 80% 走。
    this.updateAndSendTokenUsage();

    // 自动压缩（溢出强制无感 / 达自动压缩线询问用户）；用户选择迁移到新会话时本轮中止
    if (await this.maybeAutoCompactBeforeTurn(strategy)) return;

    // 每轮状态文案。
    //
    // Cowork（humanizedStatus=true）：先发一句保底，再异步用当前模型生成贴合本轮
    // 任务的意图文案覆盖掉。两段式是必须的 —— 状态行在用户按下发送那一刻就得有
    // 内容，而生成要等一次模型往返；等它回来再显示，开头那几秒就是空白。
    //
    // Chat/Code：保持原样的「思考中...」。那侧有工具卡片兜着信息量，没必要为每轮
    // 多打一次模型请求。
    this.send("status", { content: "思考中...", phase: "thinking" });
    this.humanizedState = createHumanizedStatusState();
    this.humanizedIntent = "";
    this.toolGroupTracker = new ToolGroupTracker();
    if (this.humanizedStatus) {
      // 不 await：生成失败/超时都不该挡住主流程，用户宁可看到保底文案也不要干等。
      void this.emitHumanizedIntent(strategy, input, userMeta?.attachedFiles);
    }



    // 预取 IDE 上下文 / skill / power / MCP / Wiki 索引 —— 它们之间无依赖，并行拉取以缩短首字延迟
    const [ideCtx, skillsPrompt, powersPrompt, wikiRecall, axonConfig] = await Promise.all([
      this.promptBuilder.buildIdeContextPrompt(false).catch((e: unknown) => { console.warn("[ide-ctx] 预取失败（忽略）:", (e as Error).message); return null; }),
      // Quest 没有 delegate_task，清单文案里的"两种使用方式"要收敛成一种（见 buildSkillsPrompt 的 allowDelegate）
      this.skillRegistry.buildSkillsPrompt({ allowDelegate: this.mode !== "quest" }).catch((e: unknown) => { console.warn("[skill] 发现 skill 失败（忽略）:", (e as Error).message); return null; }),
      this.powerRegistry ? this.powerRegistry.buildPowersPrompt().catch((e: unknown) => { console.warn("[power] 发现 power 失败（忽略）:", (e as Error).message); return null; }) : Promise.resolve(null),
      // Wiki 召回：一次取回注入文本 + 页面清单（同一次 summary，保证两者同一份快照）。
      // 无页面时返回 null，注入侧据此完全跳过 —— 未使用 Wiki 的项目零成本
      //
      // ⚠️ Quest（纯问答）模式不召回记忆：
      // 该模式的定位就是"不绑定工作区语义"（见上面 mode 字段的说明），
      // 把工作区的 wiki 记忆注入进去与这个定位相悖。
      // 在这里返 null 即可同时关掉两个消费端 —— wikiPromptCache（进系统提示）与
      // announceWikiRecall（发前端渲染「记忆召回」卡片）；只关一处会留下半吊子状态。
      this.mode === "quest"
        ? Promise.resolve(null)
        : this.wikiStore.buildRecall().catch((e: unknown) => { console.warn("[wiki] 索引构建失败（忽略）:", (e as Error).message); return null; }),
      this.mode === "quest"
        ? Promise.resolve(null)
        : loadWorkspaceAxonConfig(this.host, this.workspaces, this.homeDir).catch((e: unknown) => { console.warn("[axon] 工作区配置加载失败（忽略）:", (e as Error).message); return null; }),
      this.prefetchMcpTools(),  // ← 之前串行 await，现在并入并行
    ]);
    // 按需工具：用户这句话命中关键词就先把对应组加载上（MCP 组要等上面的预取完成才知道有哪些）
    this.toolLoadout.preload(input, this.toolDefBuilder.toolGroups());
    this.ideContextCache = ideCtx;
    this.skillsPromptCache = skillsPrompt;
    this.powersPromptCache = powersPrompt;
    this.workspaceAxonPromptCache = axonConfig?.prompt ?? null;
    this.wikiPromptCache = wikiRecall?.prompt ?? null;
    // 定格本轮的易变注入（终端 cwd / 工作区聚焦）：一轮之内 system 前缀逐字节不变，
    // 否则 Anthropic / Responses 链路每次命令换目录都会整段断缓存（见 PromptBuilder.beginTurn）
    this.promptBuilder.beginTurn();
    // 本轮上下文注入定格成快照挂在用户消息上：请求组装把它展开在这条消息之前，
    // 而不是每次工具调用后都追加到历史末尾（见 PromptBuilder.buildRequestMessages）
    // 已有快照（同一条消息重跑）时不覆盖：改写已发过的历史会断前缀缓存。
    const turnUserMsg = [...this.messages].reverse().find(isRealUserMessage) as any;
    if (turnUserMsg && !turnUserMsg._contextInjections) {
      turnUserMsg._contextInjections = this.promptBuilder.snapshotContextInjections();
    }
    // 再显式挡一次：不依赖 announceWikiRecall 自己对 null 的处理（那是它的实现细节，
    // 万一它把 null 当成"本轮没有召回"而渲染一张空卡片，Quest 模式就会冒出一块莫名其妙的东西）
    if (this.mode !== "quest") this.announceWikiRecall(wikiRecall);

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
    // 本轮已自动等待后台任务的次数（防止任务一直不结束时反复等）
    let autoWaits = 0;
    const MAX_AUTO_WAITS = 3;

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

      // 用户在回复进行中追加的消息：在这次请求模型之前插进对话
      this.absorbSteers();

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
          // 可见正文一出现，前端的折叠组就到此结束：立刻生成摘要，不等这一轮输出完——
          // 这段正文若是最终回复，等它写完摘要要晚出来十几秒。之后的 onRound 再遇到
          // 这段正文时分组已关闭，不会重复生成。
          if (isVisibleProse(streamedContentThisRound)) {
            this.summarizeToolGroups(strategy, this.toolGroupTracker.close());
          }
          },
        onToolCallDetected: (name, id) => {
          this.trace("tool.detected", { name, id }, this.turnCount);
          // delegate_task 有专门的 sub_agent 卡片，跳过。
          if (name === "delegate_task") return;
          // 这个回调在流式阶段就会触发（工具名已定、参数还在逐 chunk 累加），是卡片能出现的
          // 最早时机。而工具参数体往往就是模型输出的主体（create_file 的 content、str_replace
          // 的 new_str，几百到几千 token），等整条流消费完再发卡，用户要盯着空白等好几秒。
          //
          // 所有工具都提前发卡，前端 useToolCallQueue 的 80ms 间隔确保不会"同时弹出 N 张"。
          // 此刻拿不到参数，卡片先以占位文案出现（前端在 shortName 为空时会显示
          // "修改文件中..."/"创建文件中..."）；执行循环发出带 args 的 executing 事件后按 id 回填。
          if (!id) return; // 没拿到调用 id 就没法与后续 executing 事件配对，宁可不发
          // status=queued 而非 pending：此刻宿主还没开始跑这个工具。发 pending 会让前端把
          // "尚未执行"画成"正在执行"——多工具轮里几张卡一起
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
        // ⚠️ 必须先判取消，再进收尾决策：用户取消会 abort 流，上游来不及给 finish_reason，
        // 归一化层把"未知结束原因"保守判成 error，收尾决策据此走 abort_error 分支，
        // 界面上就变成"❌ 上游返回 error，未产生任何内容"——用户明明是自己点的取消。
        // 与下面"有工具调用"分支（工具执行前查 cancelled）保持同一口径。
        if (this.cancelled) {
          this.stampCancelledTurnStats(turnStartTime, streamedContentThisRound);
          return;
        }
        // 模型想收尾，但它本轮启动的长任务（start_process notify=true）还没跑完：
        // 本轮不结束，替它调一次 wait_process，结果出来交还给它接着做——结果在同一次回复里给到用户，
        // 而不是先说「在后台跑，结束后汇报」再另起一轮。用户插话 / 取消会让等待提前返回。
        if (this.backgroundTasks && this.backgroundTasks.awaitedIds().length > 0 && autoWaits < MAX_AUTO_WAITS && this.pendingSteers.length === 0) {
          autoWaits++;
          if (turnStreamStarted) this.send("stream_pause", {});
          const waitCall: NormalizedToolCall = { id: `auto_wait_${Date.now()}`, name: "wait_process", arguments: "{}" };
          this.messages.push(buildToolTurnAssistantMessage({ text: contentBuffer, toolCalls: [waitCall], reasoningContent: turn.reasoningContent, anthropicThinkingBlocks: turn.anthropicThinkingBlocks }));
          this.summarizeToolGroups(strategy, this.toolGroupTracker.onRound(contentBuffer, [waitCall]));
          await this.runToolDispatch([waitCall], guard, ts, mutatedFiles);
          continue;
        }
        // 出现可见正文 = 前端的折叠组到此结束（空回复 / 弱内容不切断，与前端口径一致）
        this.summarizeToolGroups(strategy, this.toolGroupTracker.onRound(contentBuffer, []));
        const outcome = await this.handleNoToolCallTurn(contentBuffer, finishReason, guard, ts, mutatedFiles, turnStartTime, streamedContentThisRound, rounds, commitPendingText, turn.anthropicThinkingBlocks, turn.reasoningContent);
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
      //
      // ⚠️ 工具轮的正文「不进模型上下文，但必须进展示层」。
      //
      // 曾经的写法是 `content: contentBuffer`，并注释"保留原文让模型下轮能看到自己说过什么，
      // 减少重复叙述倾向"。实测效果完全相反：历史里累积的"用户选择了X，我先摸清Y再动手"
      // 这类过渡叙述成了少样本范例，模型下一轮看到自己上轮这么开头，就照抄同一句式，
      // 于是每轮开头都是一句几乎一字不差的重述。
      //
      // 这不是猜测。promptBuilder.ts 里记录过同一机制的另一处实例：注入说明一旦被写进可见回复，
      // 之后每轮都会照演一遍（推理不持久化，但可见回复会）。
      //
      // 真正有信息量的是 tool_calls（模型能看到自己调过什么）与最终回复，
      // 过渡叙述对后续决策没有价值，只贡献重复。
      //
      // ⚠️ 但「model 不看的」不等于「用户不该看到」。早先在这里把 displayContent 也一并置 null，
      // 注释理由是"历史展示走 displayContent（本来就是 null）"——那句是错的：用户当时看到的
      // 那几段文字走的是内存态的 stream_delta，重启 IDE 就没了；唯一能撑过重启的是 displayContent。
      // 结果就是工具之间夹杂的正文在重启后全部消失。
      // 现在由 buildToolTurnAssistantMessage 统一负责这三个字段的分工（见该文件头注释）。
      const assistantMsg = buildToolTurnAssistantMessage({
        text: contentBuffer,
        toolCalls,
        reasoningContent: turn.reasoningContent,
        anthropicThinkingBlocks: turn.anthropicThinkingBlocks,
      });
      this.messages.push(assistantMsg);
      this.summarizeToolGroups(strategy, this.toolGroupTracker.onRound(contentBuffer, toolCalls));
      this.summarizeToolGroupProgress(strategy);

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

      // 回答进行中越过自动压缩线 → 无感压缩（保留当前请求原文），再发下一次请求。
      // 回合开始前那道门只查一次，一次长回答足以从 80% 涨过窗口上限。
      if (!this.cancelled) await this.compactionController.maybeCompactMidTurn(strategy);

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
        effort: this.effort,
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
    this.send("stream_end", { elapsed: Date.now() - turnStartTime, tokens: summaryTokens, model: this.model, modelName: getModelDisplayName(this.model, this.provider), providerName: getProviderDisplayName(this.provider), effort: this.effort, credits: summaryCredits, creditDetail: summaryCreditDetail, ...this.buildTurnBilling(summaryBreakdown.outputTokens) });
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
        // 与执行时同口径：create_file 是新建，不按文件名去别处找
        const resolved = await resolveInWorkspaces(p, cwd, host, workspaces, { create: toolName === "create_file" });
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
          const isAdd = h.startsWith("*** Add File");
          const p = h.replace(/\*\*\* (?:Update File|Add File): /, "").trim();
          try {
            const resolved = await resolveInWorkspaces(p, cwd, host, workspaces, { create: isAdd });
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


