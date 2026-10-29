/**
 * SessionHub —— 与传输无关的会话生命周期编排器（多会话并发版）
 *
 * 核心设计（方案 B：按 clientId 寻址）：
 * - 每个 session 独立存活，切换会话不中断正在执行的 session。
 * - 事件实时转发：每个 session 的代理 channel 给事件打上 `sessionId` + `clientId` 标签后
 *   立即转发，不再缓冲/重放。前端事件总线按 `clientId` 把事件路由到对应的面板（ChatPanel），
 *   后台并发会话的流式输出因此能精确送达其面板——切走不中断、切回无缝衔接。
 * - 指令按面板寻址：维护 `clientSessions`（clientId → sessionId）映射，取代全局单一
 *   currentSessionId。每条入站指令携带发出它的面板 clientId，Hub 据此定位目标会话，
 *   多个面板可并发各自操作自己的会话而互不串台。
 *
 * 一个 SessionHub 实例对应一条 UI 连接（一个 webview / 一个 ws）；一条连接下可有多个面板。
 */

import { normalizePermissionMode, type PermissionMode } from "./permissionMode.js";
import { uniqueAutoTitle, uniqueSessionTitle, PLACEHOLDER_TITLE } from "./sessionTitle.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { AgentSession } from "../agentSession.js";
import { CommandGate } from "../tools/index.js";
import { RelayStore } from "../relay/relayStore.js";
import { SnapshotManager } from "../snapshot/snapshotManager.js";
import type { Snapshot } from "../snapshot/types.js";
import type { ControlCommand, UserMessageCommand } from "../channel/index.js";
import type { AgentChannel, AgentEvent } from "../channel/index.js";
import type { AgentHost } from "../host/index.js";
import type { SessionStorage } from "../storage/types.js";
import type { SessionHubDeps } from "./types.js";
import { filterPersistableMessages, filterTransientMessages, slimDiffBodies, findDiffBody } from "./persistable.js";
import { buildForkMessages } from "./forkHistory.js";
import { CoworkFlowStore, generateFlowDraft, generateFlowDraftFromDescription } from "../cowork/flows.js";
import { ConnectorStore, type ConnectorDraft } from "../connectors/store.js";
import { connectorCatalog, getConnectorTemplate } from "../connectors/catalog.js";
import { githubLogin, pollGithubDeviceToken, startGithubDeviceFlow } from "../connectors/githubDevice.js";
import { getStrategy } from "../providers.js";
import { AGENT_TASK_PREFACE, AgentTaskStore, stepFromEvent, type AgentTask } from "./agentTasks.js";
import { backgroundNoticeLabel, formatBackgroundNotice, type BackgroundTaskInfo, type BackgroundTaskNotice } from "./backgroundTasks.js";

/**
 * 每个 session 的代理 channel：拦截该 session emit 的所有事件，
 * 打上 `sessionId`（恒有）与 `clientId`（当前拥有该会话的面板，可变）标签后实时转发。
 *
 * 后台 session 的 agent loop 完全不感知自己处于后台——它照常 emit，
 * 事件被打标后直达真实 channel，由前端总线按 clientId 分发到对应面板。
 */
class SessionChannel implements AgentChannel {
  /** 当前拥有（展示）该会话的面板标识。**只由 load_session / 新建会话显式设置**，
      绝不能在"顺手发一条事件"时被改写（见 emitTo）。 */
  clientId: string | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly realChannel: AgentChannel,
  ) {}

  private tag(event: AgentEvent, clientId: string | null): AgentEvent {
    const tagged: AgentEvent = { ...event, sessionId: this.sessionId };
    if (clientId) tagged.clientId = clientId;
    return tagged;
  }

  /** 旁听本会话的事件（后台任务用它更新「正在做什么」） */
  onEvent?: (event: AgentEvent) => void;

  emit(event: AgentEvent): void {
    this.onEvent?.(event);
    this.realChannel.emit(this.tag(event, this.clientId));
  }

  /**
   * 定向投递一条事件到指定面板，**不改变会话归属**。
   *
   * 必须与 emit 分开：sendTo 只是"把这条事件发出去"，它携带的 clientId 表示
   * "这一次送给谁"，而不是"从此这条会话归谁"。早先两者共用 getOrCreateSessionChannel
   * 的赋值副作用，于是一条发给会话 X 的事件就能把 X 的归属改写成另一个面板；
   * 若那个面板是【新开的空面板】（clientId 尚未注册，其指令会被 resolveSessionId
   * 兜底解析到 X），X 正在进行的流式输出就会整体改投到空面板，原面板再也收不到。
   */
  emitTo(clientId: string | undefined, event: AgentEvent): void {
    this.realChannel.emit(this.tag(event, clientId ?? this.clientId));
  }
}

export class SessionHub {
  private storage: SessionStorage;
  private channel: AgentChannel;
  private deps: SessionHubDeps;

  /**
   * 所有活跃的 session 实例。key = sessionId。
   * 切换会话时旧 session 不从 map 中移除，保留其执行状态。
   */
  private readonly activeSessions = new Map<string, AgentSession>();

  /** 每个 session 对应的代理 channel（负责事件打标转发） */
  private readonly sessionChannels = new Map<string, SessionChannel>();

  /**
   * 正在执行 agent loop 的 session ID 集合。
   */
  private readonly runningSessions = new Set<string>();

  /** 面板 → 会话映射（clientId → sessionId）。取代全局单一 currentSessionId。 */
  private readonly clientSessions = new Map<string, string>();

  /**
   * 最近一次被用户使用的会话 id。
   *
   * 侧栏树按钮、命令面板等【不属于任何聊天面板】的入口发起的指令不带 clientId
   * （clientId 是 webview tab 的标识），但这类全局操作仍需知道「作用于哪个会话」——
   * 取用户最近活跃的那个，它决定了用哪个 Provider / 模型来执行。
   */
  private lastActiveSessionId: string | null = null;

  /**
   * 面板 → 期望的编辑模式（clientId → auto/manual）。
   * 编辑模式是客户端 UI 偏好（前端持久化于 localStorage，连接时重发 set_edit_mode），
   * 不随会话落盘。reload 后后端是全新 hub，且 set_edit_mode 与 load_session 到达顺序不定——
   * 若 set_edit_mode 先到、会话尚未建好会被静默丢弃（旧 bug：UI 显示自动确认但实际仍是 manual）。
   * 这里按 clientId 记住期望模式，会话创建时统一回填，与消息顺序解耦。
   */
  private readonly clientEditModes = new Map<string, "auto" | "manual">();
  /** 每个面板选的权限模式（同 clientEditModes：前端持久化、连接时重发，会话创建时回填） */
  private readonly clientPermissionModes = new Map<string, PermissionMode>();

  /** 面板在会话创建前收到 set_workspace_group 时，按 clientId 暂存的 workspaces */
  private readonly pendingWorkspaces = new Map<string, string[]>();

  /** 全局唯一的命令信任 trie：所有会话共享同一份白名单（并发读安全，写仅在审批时串行发生） */
  private readonly sharedCommandGate = new CommandGate();

  constructor(deps: SessionHubDeps) {
    this.deps = deps;
    this.storage = deps.storage;
    this.channel = deps.channel;
    // 注入同步磁盘重载回调：gate() 在 isTrusted=false 时会调一次它再检查，
    // 解决 reload 后 VS Code 配置未就绪、wireCommandTrust 加载到空数组的时序竞态。
    this.sharedCommandGate.setReloadFn(() => {
      try {
        return this.deps.commandTrust?.load(this.deps.defaultWorkspace) ?? [];
      } catch {
        return [];
      }
    });
  }

  // ---- 内部工具 ----

  /** 广播一个无路由标签的事件给 UI（前端总线会广播给所有面板） */
  private send(type: string, data: Record<string, unknown> = {}): void {
    this.channel.emit({ type, ...data } as Parameters<AgentChannel["emit"]>[0]);
  }

  /**
   * 向指定会话对应的面板推送事件（经该会话的代理 channel，自动打上 sessionId + clientId 标签）。
   * 用于 Hub 层（非 AgentSession 内部）产生的会话级事件，如 session_loaded / session_created /
   * workspace_set / session_title_updated。
   */
  private sendTo(sessionId: string, clientId: string | undefined, event: AgentEvent): void {
    this.getOrCreateSessionChannel(sessionId).emitTo(clientId, event);
  }

  /** 向指定面板推送事件（仅打 clientId 标签，用于会话尚未创建时的定向响应） */
  private sendToClient(clientId: string, event: AgentEvent): void {
    this.channel.emit({ ...event, clientId });
  }

  /**
   * 按目标定向推送：有会话则经会话 channel；否则有 clientId 则按面板定向；都没有则广播。
   * 保证「面板专属响应（如本面板工作区/编辑模式）」不会误广播给其它面板。
   */
  private emitResult(sessionId: string | null, clientId: string | undefined, event: AgentEvent): void {
    if (sessionId) this.sendTo(sessionId, clientId, event);
    else if (clientId) this.sendToClient(clientId, event);
    else this.channel.emit(event);
  }

  /**
   * 解析指令的目标会话：clientId 映射 → 指令显式 sessionId → 最近活跃会话。
   *
   * 最后那层回退是给【不属于任何聊天面板】的入口准备的：侧栏树按钮、命令面板等发起的指令
   * 天然不带 clientId（那是 webview 面板的标识）。早先这里直接返回 null，调用方
   * `if (!session) return` 就把指令静默吞掉了 —— 用户点了按钮什么都没发生，
   * 既看不到失败原因，也无从判断是「没触发」还是「触发了没反应」。
   */
  private resolveSessionId(cmd: ControlCommand): string | null {
    const cid = cmd.clientId;
    if (cid) {
      // 面板指令以它自己的映射为准。映射缺失说明这个面板还没有会话（例如刚新开的空 tab），
      // 此时只认指令显式携带的 sessionId（cancel 等场景），**绝不外溢到 lastActiveSessionId**——
      // 那是别的面板的会话，抢过来会把它的展示归属一并改写，使其流式输出改投到这个新面板。
      return this.clientSessions.get(cid) ?? cmd.sessionId ?? null;
    }
    if (cmd.sessionId) return cmd.sessionId;
    return this.lastActiveSessionId;
  }

  /** 取活跃会话实例（不存在返回 null） */
  private getActiveSession(sessionId: string | null): AgentSession | null {
    if (!sessionId) return null;
    return this.activeSessions.get(sessionId) ?? null;
  }

  /**
   * 重载命令信任白名单。直接更新全局唯一的 CommandGate trie，
   * 所有会话自动生效——不需要遍历 activeSessions 逐个同步。
   */
  reloadTrustedCommands(): void {
    const store = this.deps.commandTrust;
    if (!store) return;
    const workspace = this.deps.defaultWorkspace;
    try {
      const patterns = store.load(workspace);
      this.sharedCommandGate.setTrustedPatterns(patterns);
    } catch (err) {
      console.warn("[trust] 实时同步命令白名单失败:", (err as Error).message);
    }
  }

  /**
   * 热更新滚动压缩配置到所有活跃会话。
   * 在 VS Code 设置变化时由 host 调用，保证配置实时生效——无需重载窗口。
   */
  reloadCompactionConfig(): void {
    if (!this.deps.getCompactionConfig) return;
    try {
      const cfg = this.deps.getCompactionConfig();
      for (const session of this.activeSessions.values()) {
        session.setCompactionConfig(cfg);
      }
      console.debug("[compaction] 压缩配置已热更新到所有活跃会话");
    } catch (err) {
      console.warn("[compaction] 同步压缩配置失败:", (err as Error).message);
    }
  }

  /**
   * 热更新 Credits 预算门配置到所有活跃会话。
   * 在 VS Code 设置变化时由 host 调用，保证配置实时生效——无需重载窗口。
   */
  reloadCreditBudgetConfig(): void {
    if (!this.deps.getCreditBudgetConfig) return;
    try {
      const cfg = this.deps.getCreditBudgetConfig();
      for (const session of this.activeSessions.values()) {
        session.setCreditBudgetConfig(cfg);
      }
      console.debug("[credit-budget] 预算门配置已热更新到所有活跃会话");
    } catch (err) {
      console.warn("[credit-budget] 同步预算门配置失败:", (err as Error).message);
    }
  }

  /**
   * 热更新 trace 记录配置到所有活跃会话。
   * 调高等级（如排障时切到 full）无需重开窗口，下一次写入即生效。
   */
  reloadTraceConfig(): void {
    if (!this.deps.getTraceConfig) return;
    try {
      const cfg = this.deps.getTraceConfig();
      for (const session of this.activeSessions.values()) {
        session.setTraceConfig(cfg);
      }
    } catch (err) {
      console.warn("[trace] 同步 trace 配置失败:", (err as Error).message);
    }
  }

  /**
   * 热更新动画生成开关到所有活跃会话。
   *
   * 开启后下一轮工具集里就会出现 render_media；关闭后立刻消失。
   * 正在跑的那一轮不受影响（工具集是每轮组装时读取的）。
   */
  reloadMediaEnabled(): void {
    if (!this.deps.getMediaEnabled) return;
    try {
      const enabled = this.deps.getMediaEnabled();
      for (const session of this.activeSessions.values()) {
        session.setMediaEnabled(enabled);
      }
    } catch (err) {
      console.warn("[media] 同步动画开关失败:", (err as Error).message);
    }
  }

  /**
   * 热更新文生图开关到所有活跃会话。
   *
   * 与动画开关同理：开启后下一轮工具集里就会出现 generate_image，关闭后立刻消失。
   * 但真正能不能出图还取决于宿主是否配置了生图服务（imageGenerator.checkEnv）。
   */
  reloadImageEnabled(): void {
    if (!this.deps.getImageEnabled) return;
    try {
      const enabled = this.deps.getImageEnabled();
      for (const session of this.activeSessions.values()) {
        session.setImageEnabled(enabled);
      }
    } catch (err) {
      console.warn("[image] 同步生图开关失败:", (err as Error).message);
    }
  }

  /** 获取或创建一个 session 的代理 channel。【纯查找/创建，不改归属】 */
  private getOrCreateSessionChannel(sessionId: string): SessionChannel {
    let ch = this.sessionChannels.get(sessionId);
    if (!ch) {
      ch = new SessionChannel(sessionId, this.channel);
      this.sessionChannels.set(sessionId, ch);
    }
    return ch;
  }

  /**
   * 显式设置会话的展示归属面板。
   * 只有"用户确实切到了这条会话"的路径（load_session / 新建会话）才允许调用，
   * 不能让普通事件投递顺带改写它。
   */
  private setSessionOwner(sessionId: string, clientId?: string): void {
    if (!clientId) return;
    this.getOrCreateSessionChannel(sessionId).clientId = clientId;
  }

  /**
   * 归一化入站 mode。
   *
   * 返回两个值刻意分开：
   * · persisted —— 落盘用，保留 cowork，让历史列表能把办公会话单独列出；
   * · runtime   —— 给 AgentSession 用，cowork 降级为 agent。
   *
   * cowork 不是第三套运行时：它的工具集、系统提示与 agent 完全一致，差异化靠
   * document-forge Power 和任务描述本身达成。若把 cowork 传进 AgentSession，
   * toolDefBuilder / mcpController 里那些 `mode === "quest"` 的分支虽然不会误判，
   * 但等于凭空多出一个没人实现的模式，后续每加一处判断都要多想一遍。
   */
  private normalizeMode(raw: unknown): { persisted: "agent" | "quest" | "cowork"; runtime: "agent" | "quest" } {
    if (raw === "quest") return { persisted: "quest", runtime: "quest" };
    if (raw === "cowork") return { persisted: "cowork", runtime: "agent" };
    return { persisted: "agent", runtime: "agent" };
  }

  /** 创建一个 AgentSession，使用代理 channel 而非真实 channel */
  private createSession(
    sessionId: string,
    cwd: string,
    existingMessages: ChatCompletionMessageParam[] | undefined,
    workspaces: string[] | undefined,
    clientId?: string,
    mode: "agent" | "quest" = "agent",
  ): AgentSession {
    const host: AgentHost = this.deps.createHost();
    const proxyChannel = this.getOrCreateSessionChannel(sessionId);
    // 创建会话即认领归属：创建它的面板从此接收这条会话的全部事件
    if (clientId) proxyChannel.clientId = clientId;
    const session = new AgentSession(
      cwd,
      proxyChannel,
      host,
      existingMessages,
      workspaces,
      this.deps.homeDir,
      this.deps.web,
      mode,
      this.deps.mcp,
      this.sharedCommandGate,
    );
    this.wireCommandTrust(session, workspaces?.[0] ?? cwd);
    // 后台任务：结束通知交给 hub 调度（会话忙就等这一轮结束），列表变化广播给所有面板
    if (session.backgroundTasks) {
      session.backgroundTasks.onNotice = (notice) => this.queueBackgroundNotice(sessionId, notice);
      session.backgroundTasks.onChange = () => { void this.emitBackgroundTasks(); };
    }
    // 回填该面板期望的编辑模式（auto/manual）：解决 reload 后 set_edit_mode 与会话创建的时序竞态
    if (clientId) {
      const desiredMode = this.clientEditModes.get(clientId);
      if (desiredMode) session.setEditMode(desiredMode);
      const permission = this.clientPermissionModes.get(clientId);
      if (permission) void session.setPermissionMode(permission);
    }
    // 注入滚动压缩配置
    if (this.deps.getCompactionConfig) {
      session.setCompactionConfig(this.deps.getCompactionConfig());
    }
    // 注入 Credits 预算门配置
    if (this.deps.getCreditBudgetConfig) {
      session.setCreditBudgetConfig(this.deps.getCreditBudgetConfig());
    }
    // 注入 trace 记录配置（等级 / 上限 / 保留份数）
    if (this.deps.getTraceConfig) {
      session.setTraceConfig(this.deps.getTraceConfig());
    }
    // 注入动画生成开关（默认关闭；关闭时不注入 render_media 工具、不下载组件）
    if (this.deps.getMediaEnabled) {
      session.setMediaEnabled(this.deps.getMediaEnabled());
    }
    // 注入文生图开关（同上：关闭时不注入 generate_image 工具）
    if (this.deps.getImageEnabled) {
      session.setImageEnabled(this.deps.getImageEnabled());
    }
    return session;
  }

  /** 接线命令信任白名单：首次加载到共享 gate + 注册持久化回调 */
  private wireCommandTrust(session: AgentSession, workspace: string): void {
    const store = this.deps.commandTrust;
    if (!store) return;
    // 只在第一个 session 创建时加载一次到共享 gate；后续 session 复用同一份 trie。
    if (this.activeSessions.size === 1) {
      const loadAndSet = () => {
        try {
          const patterns = store.load(workspace);
          this.sharedCommandGate.setTrustedPatterns(patterns);
          // 如果加载结果为空，可能是 VS Code 配置还没完全就绪，延迟重试一次
          if (patterns.length === 0) {
            setTimeout(() => {
              const retryPatterns = store.load(workspace);
              if (retryPatterns.length > 0) {
                this.sharedCommandGate.setTrustedPatterns(retryPatterns);
              }
            }, 2000);
          }
        } catch (err) {
          console.warn("[trust] 载入命令白名单失败（用内置默认）:", (err as Error).message);
        }
      };
      loadAndSet();
    }
    // 每个 session 都注册持久化回调（确保即使不是第一个 session 也能写回）
    session.setOnCommandTrustApproved((rule, target) => {
      try {
        store.save(workspace, rule, target);
      } catch (err) {
        console.warn("[trust] 持久化新信任规则失败:", (err as Error).message);
      }
    });
  }

  /**
   * 为一个 session 注册持久化回调。sid 捕获为常量——
   * 即使用户切到别的会话，增量落盘始终写到正确的 session。
   */
  private registerPersistence(s: AgentSession, sid: string): void {
    // 改动记录（pendingEdits 等）只维护在内存，不落盘——重启后改动面板不堆历史文件
    s.setOnMessagesChanged(async () => {
      const total = s.getLastTotalTokens();
      const allMessages = s.getMessages();
      const persistable = this.filterPersistable(allMessages);
      const archived = s.getArchivedMessages();
      await this.storage.updateSession(sid, {
        messages: persistable,
        // 压缩存档只增不减：有内容才写，免得空数组抹掉磁盘上已有的
        ...(archived.length > 0 ? { archivedMessages: this.filterPersistable(archived) } : {}),
        // 仅在有有效值时写入 totalTokens：避免尚未拿到真实 usage 时用 0 覆盖磁盘已有统计。
        ...(total > 0 ? { totalTokens: total } : {}),
        // 会话记忆：非空时写；本次会话里改过（包括用户清空）时也写——否则清空永远存不下来，
        // 重开会话旧记忆又回来了。从没碰过记忆的会话不写，免得一条空串抹掉磁盘上已攒下的。
        ...(s.getMemory().trim() || s.isMemoryTouched() ? { memory: s.getMemory() } : {}),
        ...(s.getMemoryHistory().length > 0 ? { memoryHistory: s.getMemoryHistory() } : {}),
      }).catch(() => {});
    });
  }

  /**
   * 获取或恢复一个 session 实例（从 cache 或 storage 加载）
   */
  private async getOrLoadSession(
    sid: string,
    primaryWorkspace: string,
    clientId?: string,
  ): Promise<{ session: AgentSession; savedSession: Awaited<ReturnType<SessionStorage["getSession"]>> }> {
    const cached = this.activeSessions.get(sid);
    if (cached) {
      // 更新该会话的归属面板，确保后续事件路由到当前面板
      this.setSessionOwner(sid, clientId);
      const savedSession = await this.storage.getSession(sid);
      return { session: cached, savedSession };
    }

    const savedSession = await this.storage.getSession(sid);
    const ws_dir = savedSession?.workspace || primaryWorkspace;
    const ws_dirs = (this.deps.workspaces && this.deps.workspaces.length > 0)
      ? this.deps.workspaces
      : (savedSession?.workspaces && savedSession.workspaces.length > 0 ? savedSession.workspaces : [ws_dir]);

    // 落盘的 mode 可能是 cowork，运行时要降级成 agent（见 normalizeMode 的说明）
    const session = this.createSession(sid, ws_dir, savedSession?.messages ? this.filterPersistable(savedSession.messages) : undefined, ws_dirs, clientId, this.normalizeMode(savedSession?.mode).runtime);
    session.setSessionId(sid);
    // 回填上次落盘的 token 统计，避免新实例 getLastTotalTokens()=0 在首次真实 usage 前
    // 被持久化回写、覆盖磁盘上的有效值（刷新后上下文显示为 0 的根因）。
    session.hydrateTokenUsage(savedSession?.totalTokens);
    session.hydrateMemory(savedSession?.memory, savedSession?.memoryHistory);
    session.hydrateArchived(savedSession?.archivedMessages);
    this.registerPersistence(session, sid);
    this.activeSessions.set(sid, session);

    return { session, savedSession };
  }

  /** 计算当前连接的工作区列表（多根工作区场景） */
  private resolveWorkspaces(): { all: string[]; primary: string } {
    const all = this.deps.workspaces && this.deps.workspaces.length > 0
      ? this.deps.workspaces
      : [this.deps.defaultWorkspace];
    return { all, primary: all[0] };
  }

  // ---- 公共 API ----

  /** 分发一条控制指令 */
  async dispatch(cmd: ControlCommand): Promise<void> {
    const { all: allWorkspaces, primary: primaryWorkspace } = this.resolveWorkspaces();
    const clientId = cmd.clientId;

    switch (cmd.type) {
      case "load_session":
        return this.handleLoadSession(cmd.sessionId, clientId, primaryWorkspace, cmd.model, cmd.provider);
      case "get_diff_content":
        return this.handleGetDiffContent(cmd, clientId);
      case "set_workspace":
        return this.handleSetWorkspace(cmd, clientId);
      case "set_workspace_group":
        return this.handleSetWorkspaceGroup(cmd, clientId, primaryWorkspace);
      case "initialize_workspace":
        return this.handleInitializeWorkspace(cmd, clientId);
      case "propose_workspace_axon":
        return this.handleProposeWorkspaceAxon(cmd, clientId);
      case "inspect_workspace_axon":
        return this.handleInspectWorkspaceAxon(cmd, clientId);
      case "reset_session":
        if (clientId) {
          this.clientSessions.delete(clientId);
          this.pendingWorkspaces.delete(clientId);
        }
        return;
      case "new_session":
        return this.handleNewSession(cmd, clientId, allWorkspaces, primaryWorkspace);
      case "fork_session":
        return this.handleForkSession(cmd, clientId, allWorkspaces, primaryWorkspace);
      case "cancel":
        this.getActiveSession(this.resolveSessionId(cmd))?.cancel();
        return;
      case "edit_user_message": {
        const sid = this.resolveSessionId(cmd);
        const s = this.getActiveSession(sid);
        if (!s) return;
        s.editUserMessage(cmd.messageId, cmd.content, cmd.userIndex, cmd.images, cmd.attachedFiles);
        if (sid) await this.storage.updateSession(sid, { messages: this.filterPersistable(s.getMessages()) });
        return;
      }
      case "compact_session": {
        const sid = this.resolveSessionId(cmd);
        const session = this.getActiveSession(sid);
        if (!session) return;
        // 回复过程中禁止手动压缩。理由不是"界面别乱动"，而是会真的压坏：
        // 压缩会把 messages 整体换成摘要版，而正在跑的 agent loop 还要继续往这个数组里 push
        // 本轮的 assistant / tool 结果 —— 中途替换会让这一轮的 tool_call 与 tool 结果配不上，
        // 下一轮请求直接 400。所以这里挡掉并说明原因，而不是让它压到一半留下残缺历史。
        // 判定复用 runningSessions：它本来就在维护"哪些会话正在跑一轮"（两条入口都会登记）。
        if (sid && this.runningSessions.has(sid)) {
          this.sendTo(sid, cmd.clientId, {
            type: "compacting_end",
            success: false,
            message: "AI 正在回复中，回复结束后再压缩上下文",
          } as AgentEvent);
          return;
        }
        session.compactSession(cmd.model, cmd.provider);
        return;
      }
      case "force_compact_session":
        this.getActiveSession(this.resolveSessionId(cmd))?.forceCompactSession((cmd as any).model, (cmd as any).provider);
        return;
      case "wiki_generate": {
        const session = this.getActiveSession(this.resolveSessionId(cmd));
        // 找不到会话就明确报错，绝不静默返回：这条路是用户主动点按钮触发的，
        // 无声失败会让人完全无法判断发生了什么（点到了吗？跑了吗？坏了？）。
        // 抛出后由呈现端接住并提示 —— 扩展侧对 dispatch 有 .catch 弹错误框，
        // server 侧的 ws 处理器也会把异常转成 error 事件发给前端。
        if (!session) {
          throw new Error(
            "找不到可用的会话，无法生成 Wiki。请先在 Axon 对话面板中新建或打开一个会话，再重试。",
          );
        }
        // 生成是长任务（十几页 × 每页多次工具调用），这里 await 到底。
        // 进度不靠返回值传递，而是由会话发出的 wiki_generation 事件承载 ——
        // 这样呈现端不必持有这个 Promise 也能显示进度。
        // 模型 / 页数上限来自呈现端读出的设置，原样透传；解析（哪个 provider 提供该模型）
        // 留在 core，因为它与形态无关、且能被单测覆盖。
        await session.generateWiki(cmd.workspace, {
          provider: cmd.provider,
          model: cmd.model,
          maxPages: cmd.maxPages,
        });
        return;
      }
      case "compaction_choice": {
        const sid = this.resolveSessionId(cmd);
        const session = this.getActiveSession(sid);
        if (!session || !sid) return;
        await session.handleCompactionChoice(cmd.choice);
        // "new_session" 选择：创建新会话并继承压缩记忆
        if (cmd.choice === "new_session") {
          const migrateData = session.getCompactionMigrationData();
          if (migrateData) {
            await this.handleCompactionMigration(sid, migrateData, cmd.clientId);
          }
        }
        return;
      }
      case "credit_budget_choice": {
        const session = this.getActiveSession(this.resolveSessionId(cmd));
        session?.handleCreditBudgetChoice(cmd.choice);
        return;
      }
      case "cowork_list_flows":
        return this.emitFlows(clientId);
      case "cowork_save_flow": {
        try {
          const flow = await this.flowStore().save(cmd.flow);
          this.emitResult(null, clientId, { type: "cowork_flow_saved", requestId: cmd.requestId, flow } as AgentEvent);
        } catch (err) {
          this.emitResult(null, clientId, { type: "cowork_flow_saved", requestId: cmd.requestId, error: (err as Error).message } as AgentEvent);
          return;
        }
        return this.emitFlows(clientId);
      }
      case "cowork_delete_flow":
        await this.flowStore().remove(String(cmd.id || ""));
        return this.emitFlows(clientId);
      case "cowork_draft_flow":
        return this.handleDraftFlow(cmd, clientId);
      case "connectors_list":
        return this.emitConnectors(clientId);
      case "connector_save": {
        try {
          const connector = await this.connectorStore().save(cmd.connector as ConnectorDraft);
          this.emitResult(null, clientId, { type: "connector_saved", requestId: cmd.requestId, connector } as AgentEvent);
        } catch (err) {
          this.emitResult(null, clientId, { type: "connector_saved", requestId: cmd.requestId, error: (err as Error).message } as AgentEvent);
          return;
        }
        return this.emitConnectors(clientId);
      }
      case "connector_set_enabled":
        await this.connectorStore().setEnabled(String(cmd.id || ""), cmd.enabled === true);
        return this.emitConnectors(clientId);
      case "connector_delete":
        await this.connectorStore().remove(String(cmd.id || ""));
        this.deps.mcp?.signOut?.(String(cmd.id || ""));
        return this.emitConnectors(clientId);
      case "connector_connect":
        return this.handleConnectorConnect(cmd.connector as ConnectorDraft, cmd.requestId, clientId);
      case "connector_connect_cancel":
        this.connectAborts.get(cmd.requestId ?? "")?.abort();
        return;
      case "connector_sign_out":
        this.deps.mcp?.signOut?.(String(cmd.id || ""));
        return this.emitConnectors(clientId);
      case "connector_app_settings":
        await this.connectorStore().setAppSettings({ githubClientId: cmd.githubClientId });
        return this.emitConnectors(clientId);
      case "connector_test":
        return this.handleConnectorTest(cmd.connector as ConnectorDraft, cmd.requestId, clientId);
      case "list_background_tasks":
        return this.emitBackgroundTasks(clientId);
      case "get_background_task_output": {
        const tracker = this.activeSessions.get(cmd.sessionId)?.backgroundTasks;
        const out = tracker ? await tracker.getOutput(cmd.terminalId, 400) : null;
        this.emitResult(null, clientId, {
          type: "background_task_output",
          requestId: cmd.requestId,
          sessionId: cmd.sessionId,
          terminalId: cmd.terminalId,
          output: out?.output ?? "",
          status: out?.status ?? "stopped",
          exitCode: out?.exitCode ?? null,
        } as AgentEvent);
        return;
      }
      case "stop_background_task":
        await this.activeSessions.get(cmd.sessionId)?.backgroundTasks?.stop(cmd.terminalId);
        return this.emitBackgroundTasks(clientId);
      case "focus_browser": {
        // 聚焦浏览器：无 clientId 也能用——对所有活跃会话尝试聚焦（通常只有一个浏览器）
        const sid = this.resolveSessionId(cmd);
        const target = this.getActiveSession(sid);
        if (target) { void target.focusBrowser(); }
        else { for (const s of this.activeSessions.values()) void s.focusBrowser(); }
        return;
      }
      case "delete_relay":
        return this.handleDeleteRelay(cmd, clientId, primaryWorkspace);
      case "confirm_tool":
        this.getActiveSession(this.resolveSessionId(cmd))?.resolveToolConfirmation(cmd.confirmed, (cmd as any).mode);
        return;
      case "submit_form":
        this.getActiveSession(this.resolveSessionId(cmd))?.resolveFormSubmit(cmd.toolCallId ?? "", {
          action: cmd.action,
          values: cmd.values ?? {},
          selectedRows: cmd.selectedRows,
        });
        return;
      case "answer_user_question":
        this.getActiveSession(this.resolveSessionId(cmd))?.resolveUserAnswer(
          cmd.toolCallId,
          Array.isArray(cmd.answers) ? cmd.answers : [],
        );
        return;
      case "flatten_tool_history": {
        const s = this.getActiveSession(this.resolveSessionId(cmd));
        if (s) {
          s.flattenToolHistory();
          const sid = this.resolveSessionId(cmd);
          if (sid) await this.storage.updateSession(sid, { messages: this.filterPersistable(s.getMessages()) });
        }
        return;
      }
      case "confirm_command":
        this.getActiveSession(this.resolveSessionId(cmd))?.resolveCommandApproval(cmd.requestId, { choice: cmd.choice, pattern: cmd.pattern, target: cmd.target, editedCommand: cmd.editedCommand });
        return;
      case "set_edit_mode":
        return this.handleSetEditMode(cmd, clientId);
      case "agent_task_start":
        return this.handleAgentTaskStart(cmd, clientId);
      case "agent_tasks_list":
        await this.agentTaskStore().list();
        this.emitAgentTasks(clientId);
        return;
      case "agent_task_stop": {
        this.getActiveSession(cmd.taskId)?.cancel();
        return;
      }
      case "agent_task_remove":
        await this.agentTaskStore().remove(cmd.taskId);
        this.emitAgentTasks();
        return;
      case "agent_task_seen":
        if (this.agentTaskStore().get(cmd.taskId)?.unread) {
          this.agentTaskStore().update(cmd.taskId, { unread: false });
          this.emitAgentTasks();
        }
        return;
      case "set_permission_mode": {
        const mode = normalizePermissionMode(cmd.mode);
        if (clientId) this.clientPermissionModes.set(clientId, mode);
        const sid = this.resolveSessionId(cmd);
        await this.getActiveSession(sid)?.setPermissionMode(mode);
        this.emitResult(sid, clientId, { type: "permission_mode_set", mode } as AgentEvent);
        return;
      }
      case "accept_edits": {
        const sid = this.resolveSessionId(cmd);
        const s = this.getActiveSession(sid);
        await s?.acceptEdits(typeof cmd.path === "string" ? cmd.path : undefined);
        if (sid && s) await this.storage.updateSession(sid, { messages: this.filterPersistable(s.getMessages()) });
        return;
      }
      case "reject_edits": {
        const sid = this.resolveSessionId(cmd);
        const s = this.getActiveSession(sid);
        await s?.rejectEdits(typeof cmd.path === "string" ? cmd.path : undefined);
        if (sid && s) await this.storage.updateSession(sid, { messages: this.filterPersistable(s.getMessages()) });
        return;
      }
      case "undo_edits": {
        const sid = this.resolveSessionId(cmd);
        const s = this.getActiveSession(sid);
        if (typeof cmd.path === "string" && cmd.path) await s?.undoEdits(cmd.path);
        if (sid && s) await this.storage.updateSession(sid, { messages: this.filterPersistable(s.getMessages()) });
        return;
      }
      case "list_snapshots": {
        const sid = this.resolveSessionId(cmd);
        const s = sid ? this.getActiveSession(sid) : null;
        let snapshots: Snapshot[] | undefined;
        if (s) {
          snapshots = await s.listSnapshots();
          console.log(`[hub] list_snapshots via session: sid=${sid} count=${snapshots?.length}`);
        } else {
          // session 未就绪（reload 时序竞态）：直接用 workspace 级 SnapshotManager 列 git ref
          // 注：问答模式的 session 在 listSnapshots() 中已返回空数组；
          //     这里是 session 对象不存在（时序竞态）的兜底路径，仍列出可用快照。
          const tmpMgr = new SnapshotManager(this.deps.createHost(), this.deps.defaultWorkspace);
          // 兜底路径也要按 session 隔离，避免跨会话看到彼此的快照
          if (sid) tmpMgr.setSessionId(sid);
          snapshots = await tmpMgr.list().catch(() => []);
          console.log(`[hub] list_snapshots via fallback: sid=${sid} defaultWs=${this.deps.defaultWorkspace} count=${snapshots?.length}`);
        }
        if (clientId) this.sendToClient(clientId, { type: "snapshots_listed", snapshots: snapshots || [] });
        else console.warn(`[hub] list_snapshots: no clientId!`);
        return;
      }
      case "set_memory": {
        // 早先这条命令没有任何分支处理：面板里保存、导入的内容既没落盘也没注入给模型，
        // 下次后台整理推回来的记忆还会把面板上的内容盖掉。
        const sid = this.resolveSessionId(cmd);
        const s = sid ? this.getActiveSession(sid) : null;
        s?.saveMemoryFromUser(cmd.memory, { base: cmd.base, mode: cmd.mode });
        return;
      }
      case "get_memory_history": {
        const sid = this.resolveSessionId(cmd);
        const s = sid ? this.getActiveSession(sid) : null;
        const versions = (s?.getMemoryHistory() ?? []).slice().reverse();
        if (clientId) this.sendToClient(clientId, { type: "memory_history", versions });
        return;
      }
      case "restore_memory_version": {
        const sid = this.resolveSessionId(cmd);
        const s = sid ? this.getActiveSession(sid) : null;
        s?.restoreMemoryVersion(cmd.at);
        return;
      }
      case "restore_snapshot": {
        const sid = this.resolveSessionId(cmd);
        const s = sid ? this.getActiveSession(sid) : null;
        const ok = await s?.restoreSnapshot(cmd.snapshotId);
        if (clientId) this.sendToClient(clientId, { type: "snapshot_restored", snapshotId: cmd.snapshotId, ok: !!ok });
        return;
      }
      case "user_message":
        if (cmd.content || cmd.images) await this.handleUserMessage(cmd, clientId);
        return;
      case "steer_message":
        return this.handleSteer(cmd, clientId);
      case "steer_cancel": {
        const sid = this.resolveSessionId(cmd);
        const ok = this.getActiveSession(sid)?.cancelSteer(cmd.clientMessageId) ?? false;
        this.emitResult(sid, clientId, { type: "steer_cancelled", clientMessageId: cmd.clientMessageId, ok } as AgentEvent);
        return;
      }
    }
  }

  /** 加载/切换会话：发送 session_loaded 快照（实时事件由代理 channel 直达，无需缓冲重放） */
  private async handleLoadSession(sid: string, clientId: string | undefined, primaryWorkspace: string, model?: string, provider?: string): Promise<void> {
    if (clientId) this.clientSessions.set(clientId, sid);
    this.lastActiveSessionId = sid;

    const { session, savedSession } = await this.getOrLoadSession(sid, primaryWorkspace, clientId);
    // 刚从磁盘恢复的会话还没有模型（模型平时随每条消息下发）：按前端当前选中的、退而用落盘时的模型补上。
    // 否则窗口按兜底 128k 算——重启 IDE 后 1M 的模型显示「337k / 128k、已到自动压缩线」。
    session.adoptModelIfUnset(model || savedSession?.model, provider || savedSession?.provider);

    const ws_dir = savedSession?.workspace || primaryWorkspace;
    const ws_dirs = (this.deps.workspaces && this.deps.workspaces.length > 0)
      ? this.deps.workspaces
      : (savedSession?.workspaces && savedSession.workspaces.length > 0 ? savedSession.workspaces : [ws_dir]);

    this.sendTo(sid, clientId, {
      type: "session_loaded",
      sessionId: sid,
      workspace: ws_dir,
      workspaces: ws_dirs,
      workspaceGroupId: savedSession?.workspaceGroupId || null,
      // 只过滤瞬态、不剥离改动字段：运行中重连/切回时本会话的改动照常展示（重启后内存来自盘，天然干净）。
      // 改动前后全文不随快照下发（slimDiffBodies），前端打开 diff 时经 get_diff_content 按需取。
      // 完整聊天记录 = 压缩存档（标 _archived，只展示）+ 当前上下文：压缩只缩模型上下文，用户看到的历史一条不少
      messages: slimDiffBodies([
        ...filterTransientMessages(session.getArchivedMessages().length > 0 ? session.getArchivedMessages() : savedSession?.archivedMessages || [])
          .map((m) => ({ ...m, _archived: true }) as unknown as typeof m),
        ...(session.getMessages().length > 0 ? filterTransientMessages(session.getMessages()) : filterTransientMessages(savedSession?.messages || [])),
      ]),
      totalTokens: session.getLastTotalTokens() || savedSession?.totalTokens || 0,
      // 上下文面板的明细与权威窗口随会话一起下发：否则要等下一轮 token_usage 才有明细
      // 仍不知道模型时不下发：前端按自己选中的模型占位，等第一轮 token_usage
      ...(session.model ? { contextWindow: session.getContextWindow(), contextBreakdown: session.getContextBreakdown() } : {}),
      pendingPaths: session.getPendingPaths(),
      pendingDiffs: session.getPendingDiffs(),
      pendingEditIds: session.getPendingEditIds(),
      // 随会话一起回填记忆，供记忆面板显示与编辑：分叉出的会话只带记忆，
      // 不在加载时下发的话，面板会显示「空」、与后端实际注入的内容对不上。
      memory: session.getMemory() || savedSession?.memory || "",
    } as AgentEvent);
    session.appendTrace("session.loaded", {
      workspace: ws_dir,
      workspaces: ws_dirs,
      workspaceGroupId: savedSession?.workspaceGroupId || null,
      messagesCount: session.getMessages().length > 0 ? this.filterPersistable(session.getMessages()).length : (savedSession?.messages || []).length,
      totalTokens: session.getLastTotalTokens() || savedSession?.totalTokens || 0,
      pendingPaths: session.getPendingPaths(),
    });
  }

  /** 设置/切换会话工作区（带 clientId 定向；无 clientId 时为工作区文件夹变化广播，应用到全部活跃会话） */
  /**
   * 按需回填某次改动的前后全文。
   *
   * 会话快照里只带路径与 editId（见 slimDiffBodies），用户点开 diff 时才走这里。
   * 先查活跃会话的内存消息；会话不在内存（从未加载过）再读磁盘。
   * 待确认（manual 模式暂存区）的改动不在消息里，由 pendingDiffs 单独下发，不走这条路。
   */
  private async handleGetDiffContent(
    cmd: Extract<ControlCommand, { type: "get_diff_content" }>,
    clientId: string | undefined,
  ): Promise<void> {
    const sid = this.resolveSessionId(cmd);
    const query = { editId: cmd.editId, path: cmd.path };
    let body: { oldContent: string; newContent: string } | null = null;
    const live = this.getActiveSession(sid);
    if (live) body = findDiffBody(live.getMessages(), query);
    if (!body && sid) {
      const saved = await this.storage.getSession(sid);
      if (saved?.messages) body = findDiffBody(saved.messages, query);
    }
    this.emitResult(sid, clientId, {
      type: "diff_content",
      requestId: cmd.requestId,
      found: !!body,
      ...(body ?? {}),
    } as AgentEvent);
  }

  private async handleSetWorkspace(
    cmd: Extract<ControlCommand, { type: "set_workspace" }>,
    clientId: string | undefined,
  ): Promise<void> {
    const dir = typeof cmd.workspace === "string" ? cmd.workspace : "";
    const valid = dir ? await this.deps.isValidDir(dir) : false;
    const dirs: string[] = Array.isArray(cmd.workspaces) ? cmd.workspaces : [dir];
    const sid = this.resolveSessionId(cmd);

    if (!valid) {
      this.emitResult(sid, clientId, { type: "workspace_error", message: `无效的目录: ${dir}` } as AgentEvent);
      return;
    }

    const applyTo = (s: AgentSession) => {
      if (dirs.length > 1) s.setWorkspaces(dirs);
      else s.setWorkspace(dir);
    };

    if (sid) {
      const s = this.getActiveSession(sid);
      if (s) applyTo(s);
      await this.storage.updateSession(sid, { workspace: dir, workspaces: dirs }).catch(() => {});
      this.sendTo(sid, clientId, { type: "workspace_set", workspace: dir, workspaces: dirs } as AgentEvent);
      s?.appendTrace("workspace.set", { workspace: dir, workspaces: dirs });
    } else if (clientId) {
      // 面板已指定但会话未创建：定向回该面板（不广播）
      this.sendToClient(clientId, { type: "workspace_set", workspace: dir, workspaces: dirs } as AgentEvent);
    } else {
      // 工作区文件夹变化广播：应用到全部活跃会话，并广播给所有面板
      for (const s of this.activeSessions.values()) applyTo(s);
      this.send("workspace_set", { workspace: dir, workspaces: dirs });
    }
  }

  /** 用户明确确认后的显式初始化：普通工作区切换不创建任何 .axon 文件。 */
  private async handleInitializeWorkspace(
    cmd: Extract<ControlCommand, { type: "initialize_workspace" }>,
    clientId: string | undefined,
  ): Promise<void> {
    const workspace = typeof cmd.workspace === "string" ? cmd.workspace : "";
    const sid = this.resolveSessionId(cmd);
    const session = this.getActiveSession(sid);
    if (!workspace || !session || !(await this.deps.isValidDir(workspace))) {
      this.emitResult(sid, clientId, { type: "workspace_error", message: "无法初始化：工作区目录无效或会话尚未建立" } as AgentEvent);
      return;
    }
    try {
      const result = await session.initializeWorkspaceAxon(workspace, cmd.axonContent);
      this.emitResult(sid, clientId, { type: "workspace_axon_initialized", ...result } as AgentEvent);
    } catch (error) {
      this.emitResult(sid, clientId, { type: "workspace_error", message: `初始化 Axon 工作区失败：${(error as Error).message}` } as AgentEvent);
    }
  }

  /** 只读生成 AXON.md 草案，不写入工作区。 */
  private async handleProposeWorkspaceAxon(
    cmd: Extract<ControlCommand, { type: "propose_workspace_axon" }>,
    clientId: string | undefined,
  ): Promise<void> {
    const workspace = typeof cmd.workspace === "string" ? cmd.workspace : "";
    const sid = this.resolveSessionId(cmd);
    const session = this.getActiveSession(sid);
    if (!workspace || !session || !(await this.deps.isValidDir(workspace))) {
      this.emitResult(sid, clientId, { type: "workspace_error", message: "无法生成草案：工作区目录无效或会话尚未建立" } as AgentEvent);
      return;
    }
    try {
      const content = await session.proposeWorkspaceAxon(workspace);
      this.emitResult(sid, clientId, { type: "workspace_axon_proposal", workspace, content } as AgentEvent);
    } catch (error) {
      this.emitResult(sid, clientId, { type: "workspace_error", message: `生成 AXON.md 草案失败：${(error as Error).message}` } as AgentEvent);
    }
  }

  /** 只读探测各工作区 .axon 状态；不会创建任何目录或文件。 */
  private async handleInspectWorkspaceAxon(
    cmd: Extract<ControlCommand, { type: "inspect_workspace_axon" }>,
    clientId: string | undefined,
  ): Promise<void> {
    const sid = this.resolveSessionId(cmd);
    const session = this.getActiveSession(sid);
    if (!session) {
      this.emitResult(sid, clientId, { type: "workspace_error", message: "无法读取状态：会话尚未建立" } as AgentEvent);
      return;
    }
    try {
      const workspaces = await session.inspectWorkspacesAxon();
      this.emitResult(sid, clientId, { type: "workspace_axon_status", workspaces } as AgentEvent);
    } catch (error) {
      this.emitResult(sid, clientId, { type: "workspace_error", message: `读取工作区状态失败：${(error as Error).message}` } as AgentEvent);
    }
  }

  /** 绑定工作区组 */
  private async handleSetWorkspaceGroup(
    cmd: Extract<ControlCommand, { type: "set_workspace_group" }>,
    clientId: string | undefined,
    _primaryWorkspace: string,
  ): Promise<void> {
    const groupId = typeof cmd.groupId === "string" ? cmd.groupId : "";
    const group = await this.deps.resolveWorkspaceGroup(groupId);
    const sid = this.resolveSessionId(cmd);

    const sendErr = (message: string) => {
      this.emitResult(sid, clientId, { type: "workspace_error", message } as AgentEvent);
    };

    if (!group) {
      sendErr(`工作区组不存在: ${groupId}`);
      return;
    }
    for (const p of group.paths) {
      if (!(await this.deps.isValidDir(p))) {
        sendErr(`工作区组 "${group.name}" 中路径无效: ${p}`);
        return;
      }
    }

    const s = this.getActiveSession(sid);
    if (s) s.setWorkspaces(group.paths);
    if (sid) {
      await this.storage.updateSession(sid, {
        workspace: group.paths[0],
        workspaces: group.paths,
        workspaceGroupId: group.id,
      });
    }
    // 会话尚未创建：按面板暂存，待 user_message 创建会话时采用
    if (!s && clientId) this.pendingWorkspaces.set(clientId, group.paths);

    this.emitResult(sid, clientId, {
      type: "workspace_set",
      workspace: group.paths[0],
      workspaces: group.paths,
      groupId: group.id,
      groupName: group.name,
    } as AgentEvent);
    if (sid) this.getActiveSession(sid)?.appendTrace("workspace.set", {
      workspace: group.paths[0],
      workspaces: group.paths,
      groupId: group.id,
      groupName: group.name,
    });
  }

  /** 新建会话（显式指令；前端通常走「发首条消息惰性创建」路径） */
  private async handleNewSession(
    cmd: Extract<ControlCommand, { type: "new_session" }>,
    clientId: string | undefined,
    allWorkspaces: string[],
    primaryWorkspace: string,
  ): Promise<void> {
    if (!cmd.model?.trim() || !cmd.provider?.trim()) {
      throw new Error("请先选择已配置的 Provider 和模型");
    }
    const ws_dir = (typeof cmd.workspace === "string" && cmd.workspace) ? cmd.workspace : primaryWorkspace;
    const mode = this.normalizeMode(cmd.mode);
    const created = await this.storage.createSession({
      id: cmd.sessionId || "",
      title: "新对话",
      model: cmd.model,
      provider: cmd.provider,
      workspace: ws_dir,
      mode: mode.persisted,
      messages: [],
      totalTokens: 0,
    });
    if (clientId) this.clientSessions.set(clientId, created.id);
    const session = this.createSession(created.id, ws_dir, undefined, allWorkspaces, clientId, mode.runtime);
    session.setSessionId(created.id);
    this.lastActiveSessionId = created.id;
    this.registerPersistence(session, created.id);
    this.activeSessions.set(created.id, session);
    this.sendTo(created.id, clientId, {
      type: "session_created",
      sessionId: created.id,
      workspace: ws_dir,
      workspaces: allWorkspaces,
    } as AgentEvent);
    session.appendTrace("session.created", {
      workspace: ws_dir,
      workspaces: allWorkspaces,
      mode: mode.persisted,
      title: "新对话",
    });
  }

  /**
   * 会话分叉：从源会话派生一个新会话。两个入口共用本方法，差别只在是否带历史前缀：
   *
   * · 会话列表 / 顶栏「分叉」（不带截断参数）—— 只继承记忆（SessionData.memory），
   *   不复制对话历史。用户要继承的是结论，不是过程：新会话 messages 留空，交给
   *   AgentSession 构造函数按 mode 播种 system prompt；记忆随后由 hydrateMemory 回填，
   *   作为按轮注入每轮发出（见 PromptBuilder.buildInjections），于是分叉出来的会话
   *   一开口就带着此前沉淀的结论。⚠️ 这个入口的语义是既有契约，不要改。
   *
   * · 某条 AI 回复上的「从这里分叉」（带截断参数）—— 额外把截至那一轮为止的消息
   *   一并复制进新会话（含该轮的回复与工具调用），记忆照旧复制。截取规则见
   *   session/forkHistory.ts：锚点是「回合起点用户消息」，不是被点的 assistant 消息
   *   （后者在落盘数据里没有 id）。
   *
   * 与「压缩迁移」的区别：迁移要把压缩后的消息一并带过去（否则接不上正在进行的任务），
   * 分叉的历史则停在一个完整的轮末，不带 pendingEdits。源会话在两种入口下都不变。
   */
  private async handleForkSession(
    cmd: Extract<ControlCommand, { type: "fork_session" }>,
    clientId: string | undefined,
    allWorkspaces: string[],
    primaryWorkspace: string,
  ): Promise<void> {
    const sourceId = (typeof cmd.sessionId === "string" && cmd.sessionId)
      ? cmd.sessionId
      : this.resolveSessionId(cmd);
    // 读源会话：分叉是「复制一份结论」，源必须是磁盘上真实存在的会话。
    // 读不到就明确回一个可读提示，不静默返回 —— 用户点了按钮却什么都没发生最难排查。
    const source = sourceId ? await this.storage.getSession(sourceId) : null;
    if (!source) {
      this.emitResult(null, clientId, {
        type: "error",
        content: "找不到要分叉的会话，它可能已被删除。",
      } as AgentEvent);
      return;
    }

    const ws_dir = source.workspace || primaryWorkspace;
    const ws_dirs = source.workspaces && source.workspaces.length > 0 ? source.workspaces : allWorkspaces;
    // 落盘的 mode 可能是 cowork，运行时降级成 agent（见 normalizeMode 的说明）
    const mode = this.normalizeMode(source.mode);
    // 同一个会话分叉多次时与已有标题去重（「xxx · 分叉 (2)」），否则列表里分不清
    const existingTitles = (await this.storage.listSessions().catch(() => [])).map((s) => s.title);
    const title = uniqueSessionTitle(`${source.title} · 分叉`, existingTitles);

    // 有没有截断参数，决定这次分叉带不带历史前缀：
    // · 不带（会话列表 / 顶栏入口）→ 维持原语义：messages 留空，只带记忆；
    // · 带（某条 AI 回复上的「从这里分叉」）→ 复制到那一轮为止。
    // 传了锚点却定位不到时明确报错并中止，而不是悄悄降级成「只带记忆」——
    // 那样用户会得到一个看似成功、实际丢了全部历史的会话，比直接失败更难排查。
    const withHistory = (typeof cmd.upToMessageId === "string" && cmd.upToMessageId.length > 0)
      || typeof cmd.upToUserIndex === "number";
    let forkMessages: ChatCompletionMessageParam[] = [];
    if (withHistory) {
      const cut = buildForkMessages(source.messages, {
        upToMessageId: cmd.upToMessageId,
        upToUserIndex: cmd.upToUserIndex,
      });
      if (!cut.ok) {
        this.emitResult(null, clientId, {
          type: "error",
          content: `无法从这里分叉：${cut.reason}。可以改用会话列表里的「分叉」只带走记忆。`,
        } as AgentEvent);
        return;
      }
      forkMessages = cut.messages;
    }

    // totalTokens 归零、不带 pendingEdits：新会话尚未消耗上下文，也没有待确认改动。
    const created = await this.storage.createSession({
      id: "",
      title,
      model: source.model,
      provider: source.provider,
      workspace: ws_dir,
      workspaces: ws_dirs.length > 1 ? ws_dirs : undefined,
      // 连同工作区组绑定一起继承：源会话若是多根工作区组，新会话应落在同一组里（否则只剩路径、丢了组）
      workspaceGroupId: source.workspaceGroupId,
      mode: mode.persisted,
      messages: forkMessages,
      totalTokens: 0,
      memory: source.memory,
    });

    // 刻意【不】改写 clientSessions[clientId]：分叉不像压缩迁移那样冻结旧会话，
    // 前端会为新会话新开一个 tab（新 clientId），旧 tab 应继续停在源会话上。
    // 若在这里把发起面板的映射改指新会话，旧 tab 后续的指令就会串到新会话去。
    // 新 tab 挂载时会用 load_session 建立自己的映射。
    // 带历史时把同一份（已清洗的）消息交给运行实例，新会话打开就能接着聊；
    // 不带历史时仍传 undefined，让构造函数按 mode 播种 system prompt。
    const session = this.createSession(
      created.id,
      ws_dir,
      forkMessages.length > 0 ? forkMessages : undefined,
      ws_dirs,
      clientId,
      mode.runtime,
    );
    session.setSessionId(created.id);
    // 回填记忆：新实例的 memory 默认为空，不回填的话按轮注入拿不到结论，分叉就白做了。
    session.hydrateMemory(source.memory);
    this.lastActiveSessionId = created.id;
    this.registerPersistence(session, created.id);
    this.activeSessions.set(created.id, session);

    // 回推给发起请求的面板（经新会话的代理 channel）。侧栏入口不带 clientId 时会广播，
    // 由前端去重后打开新会话 tab —— 三个入口因此复用同一条事件。
    this.sendTo(created.id, clientId, {
      type: "session_forked",
      sessionId: created.id,
      sourceId,
    } as AgentEvent);
    session.appendTrace("session.created", {
      workspace: ws_dir,
      workspaces: ws_dirs,
      mode: mode.persisted,
      title,
      forkedFrom: sourceId,
      // 复制了多少条历史：0 表示「只带记忆」的老语义
      forkedMessages: forkMessages.length,
    });
  }

  /**
   * 压缩迁移：创建新会话继承压缩后的记忆，并在新会话中重放用户输入。
   * 完成后通知前端切换到新会话。
   */
  private async handleCompactionMigration(
    parentSessionId: string,
    migrateData: { messages: ChatCompletionMessageParam[]; userInput: { content: string; model?: string; images?: string[]; provider?: string; userMeta?: Record<string, unknown> } },
    clientId: string | undefined,
  ): Promise<void> {
    if (!migrateData.userInput.model?.trim() || !migrateData.userInput.provider?.trim()) {
      throw new Error("压缩迁移缺少当前 Provider 或模型");
    }
    const { all: allWorkspaces, primary: primaryWorkspace } = this.resolveWorkspaces();
    // 从父会话获取工作区和模式
    const parentSaved = await this.storage.getSession(parentSessionId);
    const ws_dir = parentSaved?.workspace || primaryWorkspace;
    const ws_dirs = parentSaved?.workspaces && parentSaved.workspaces.length > 0
      ? parentSaved.workspaces
      : allWorkspaces;
    const mode = parentSaved?.mode ?? "agent";
    const title = await uniqueAutoTitle(this.storage, migrateData.userInput.content);

    // 创建新会话并预加载压缩后的消息
    const created = await this.storage.createSession({
      id: "",
      title,
      model: migrateData.userInput.model,
      provider: migrateData.userInput.provider,
      workspace: ws_dir,
      workspaces: ws_dirs.length > 1 ? ws_dirs : undefined,
      mode,
      messages: migrateData.messages,
      totalTokens: 0,
    });

    // 建立 clientId → 新会话映射
    if (clientId) this.clientSessions.set(clientId, created.id);

    // 压缩迁移继承父会话的 mode：落盘保留 cowork（新会话仍属办公历史），运行时降级为 agent
    const session = this.createSession(created.id, ws_dir, migrateData.messages, ws_dirs, clientId, this.normalizeMode(mode).runtime);
    session.setSessionId(created.id);
    this.registerPersistence(session, created.id);
    this.activeSessions.set(created.id, session);

    // 通知前端：当前会话已迁移，新会话已创建
    this.sendTo(parentSessionId, clientId, {
      type: "compaction_migrated",
      newSessionId: created.id,
      parentSessionId,
    } as AgentEvent);
    this.sendTo(created.id, clientId, {
      type: "session_created",
      sessionId: created.id,
      workspace: ws_dir,
      workspaces: ws_dirs,
    } as AgentEvent);
    session.appendTrace("session.created", {
      workspace: ws_dir,
      workspaces: ws_dirs,
      mode,
      title,
      migratedFrom: parentSessionId,
    });

    // 在新会话中发送用户消息，触发 AI 回复
    this.runningSessions.add(created.id);
    try {
      await session.handleUserInput(
        migrateData.userInput.content,
        migrateData.userInput.model,
        migrateData.userInput.images,
        migrateData.userInput.provider,
        migrateData.userInput.userMeta as { displayText?: string; attachedFiles?: { name: string; size: number }[] } | undefined,
      );
    } catch (err) {
      const error = err as Error;
      if (error.name !== "AbortError" && !error.message?.includes("aborted")) {
        console.error(`[sessionHub] 压缩迁移 LLM 错误:`, error.message);
        const errMsg = `❌ ${error.message}`;
        session.getMessages().push({ role: "assistant", content: errMsg } as any);
        this.sendTo(created.id, clientId, { type: "stream_delta", content: errMsg } as AgentEvent);
        this.sendTo(created.id, clientId, { type: "stream_end", elapsed: 0, tokens: 0, model: migrateData.userInput.model } as AgentEvent);
      }
    } finally {
      this.runningSessions.delete(created.id);
      this.turnEndedAt.set(created.id, Date.now());
    }

    // 持久化新会话
    const messages = this.filterPersistable(session.getMessages());
    await this.storage.updateSession(created.id, {
      messages,
      title,
      totalTokens: session.getLastTotalTokens(),
    });
  }

  /**
   * 当前已知的所有工作区：宿主打开的文件夹、活跃会话的工作区、尚未建会话的面板选好的工作区组。
   * Relay 落在【会话工作区】下，而会话工作区可以是 Axon 里另选的文件夹，不一定是宿主打开的那个——
   * 列 Relay 只看宿主文件夹，就会出现「AI 说建好了、侧边栏里没有」。
   */
  getKnownWorkspaces(): string[] {
    const out = new Set<string>(this.deps.workspaces ?? []);
    for (const s of this.activeSessions.values()) {
      out.add(s.getWorkspace());
      for (const w of s.getWorkspaces()) out.add(w);
    }
    for (const paths of this.pendingWorkspaces.values()) for (const w of paths) out.add(w);
    out.delete("");
    return [...out];
  }

  /** 删除 relay */
  private async handleDeleteRelay(
    cmd: Extract<ControlCommand, { type: "delete_relay" }>,
    clientId: string | undefined,
    primaryWorkspace: string,
  ): Promise<void> {
    const relayId = typeof cmd.relayId === "string" ? cmd.relayId : "";
    if (!relayId) return;
    const sid = this.resolveSessionId(cmd);
    const s = this.getActiveSession(sid);
    if (s) {
      await s.deleteRelay(relayId);
    } else {
      const ws_dir = (typeof cmd.workspace === "string" && cmd.workspace) ? cmd.workspace : primaryWorkspace;
      // relay 可能落在工作区或主目录，跨根定位后再删
      const relayRoots = [ws_dir, ...this.getKnownWorkspaces(), this.deps.homeDir].filter((r): r is string => !!r);
      await new RelayStore(relayRoots, this.deps.createHost()).remove(relayId);
      this.emitResult(sid, clientId, { type: "relay_deleted", relayId } as AgentEvent);
    }
    if (sid && s) {
      await this.storage.updateSession(sid, { messages: this.filterPersistable(s.getMessages()) });
    }
  }

  /** 过滤掉不落盘的消息：_transient（编辑工具失败等）与 _ephemeralInjected（单轮临时注入：反思/复盘/强制收尾/预算提醒等）
   * 并剥离改动记录字段——改动/回滚记录只维护在内存，不随会话恢复堆积（实现见 persistable.ts） */
  private filterPersistable(messages: any[]): any[] {
    return filterPersistableMessages(messages);
  }

  // ── 连接器 ──

  private connectorStoreInstance: ConnectorStore | null = null;

  private connectorStore(): ConnectorStore {
    if (!this.connectorStoreInstance) this.connectorStoreInstance = new ConnectorStore(this.deps.createHost().fs, this.deps.homeDir);
    return this.connectorStoreInstance;
  }

  private async emitConnectors(clientId: string | undefined): Promise<void> {
    const list = await this.connectorStore().list();
    // OAuth 连接器带上授权状态（「已连接」/「需要授权」）
    const connectors = list.map((c) => getConnectorTemplate(c.templateId)?.auth === "oauth" && this.deps.mcp?.oauthStatus
      ? { ...c, oauth: this.deps.mcp.oauthStatus(c.id) }
      : c);
    const apps = await this.connectorStore().appSettings();
    this.emitResult(null, clientId, { type: "connectors", catalog: connectorCatalog(), connectors, apps } as AgentEvent);
  }

  /** 进行中的一键连接（按 requestId），用于取消 */
  private readonly connectAborts = new Map<string, AbortController>();

  /**
   * 一键连接：
   *   · OAuth 连接器：先保存（新建拿到 id），再打开浏览器授权，回调拿到令牌
   *   · GitHub：设备码登录，拿到令牌后存进连接器的 token 字段，名字补上 GitHub 用户名
   */
  private async handleConnectorConnect(draft: ConnectorDraft, requestId: string | undefined, clientId: string | undefined): Promise<void> {
    const progress = (data: Record<string, unknown>) =>
      this.emitResult(null, clientId, { type: "connector_connect_progress", requestId, ...data } as AgentEvent);
    const abort = new AbortController();
    if (requestId) this.connectAborts.set(requestId, abort);
    try {
      const template = getConnectorTemplate(draft.templateId);
      if (!template?.auth) throw new Error("这个连接器不支持一键连接");
      const store = this.connectorStore();

      if (template.auth === "github-device") {
        const { githubClientId } = await store.appSettings();
        if (!githubClientId) throw new Error("还没有配置 GitHub OAuth App 的 Client ID（在下方「OAuth 应用」里填写）");
        const code = await startGithubDeviceFlow(githubClientId);
        progress({ stage: "github_code", userCode: code.userCode, verificationUri: code.verificationUri, expiresIn: code.expiresIn });
        const token = await pollGithubDeviceToken(githubClientId, code, { signal: abort.signal });
        const login = await githubLogin(token);
        const saved = await store.save({
          ...draft,
          name: draft.name && draft.name !== template.name ? draft.name : login ? `GitHub（${login}）` : template.name,
          secrets: { ...(draft.secrets ?? {}), token },
        });
        progress({ stage: "done", connector: saved });
      } else {
        if (!this.deps.mcp?.authorize) throw new Error("当前环境不支持浏览器授权");
        const saved = await store.save(draft);
        const spec = await store.specFor({ ...draft, id: saved.id });
        await this.deps.mcp.authorize(spec, (url) => progress({ stage: "open_url", url }), abort.signal);
        progress({ stage: "done", connector: saved });
      }
    } catch (err) {
      progress({ stage: "error", error: (err as Error).message || "连接失败" });
    } finally {
      if (requestId) this.connectAborts.delete(requestId);
    }
    await this.emitConnectors(clientId);
  }

  /** 试连：用完即断，不影响会话里已有的 MCP 连接；保存后下一轮对话就会带上它的工具 */
  private async handleConnectorTest(draft: ConnectorDraft, requestId: string | undefined, clientId: string | undefined): Promise<void> {
    const reply = (data: Record<string, unknown>) =>
      this.emitResult(null, clientId, { type: "connector_test_result", requestId, ...data } as AgentEvent);
    try {
      if (!this.deps.mcp?.probe) throw new Error("当前环境不支持测试连接");
      const spec = await this.connectorStore().specFor(draft);
      const { tools } = await this.deps.mcp.probe(spec);
      reply({ ok: true, tools });
    } catch (err) {
      reply({ ok: false, error: (err as Error).message || "连接失败" });
    }
  }

  // ── 插话 ──

  /**
   * 回复进行中追加的消息：挂到会话上，下一次请求模型前插进对话（AgentSession.absorbSteers）。
   * 会话没在跑（刚好结束了）就直接当一条普通消息开新一轮。
   */
  private async handleSteer(cmd: Extract<ControlCommand, { type: "steer_message" }>, clientId: string | undefined): Promise<void> {
    if (!cmd.content && !cmd.images) return;
    const sid = this.resolveSessionId(cmd);
    const session = this.getActiveSession(sid);
    const command = { ...cmd, type: "user_message" } as UserMessageCommand & { clientId?: string; sessionId?: string };
    if (!sid || !session || !this.runningSessions.has(sid)) {
      if (cmd.clientMessageId) this.emitResult(sid, clientId, { type: "steer_turn", clientMessageIds: [cmd.clientMessageId] } as AgentEvent);
      await this.handleUserMessage(command, clientId);
      return;
    }
    const images = Array.isArray(cmd.images) ? (cmd.images as string[]) : [];
    const text = cmd.content || "";
    session.enqueueSteer({
      clientMessageId: cmd.clientMessageId || `steer-${Date.now()}`,
      content: images.length > 0
        ? [{ type: "text", text }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))]
        : text,
      displayText: cmd.displayText ?? text,
      attachedFiles: cmd.attachedFiles,
      userSegments: cmd.userSegments,
      command: command as unknown as Record<string, unknown>,
    });
  }

  /** 这一轮结束时还没插进去的插话：合成一条消息开新一轮 */
  private async flushSteers(sessionId: string): Promise<void> {
    if (this.runningSessions.has(sessionId)) return;
    const session = this.activeSessions.get(sessionId);
    const steers = session?.takeSteers() ?? [];
    if (steers.length === 0) return;
    const { clientId: _clientId, ...base } = steers[0].command as Record<string, unknown> & { clientId?: string };
    const commands = steers.map((s) => s.command as unknown as UserMessageCommand);
    const join = (values: (string | undefined)[]) => values.filter((v): v is string => !!v).join("\n\n");
    this.sendTo(sessionId, undefined, { type: "steer_turn", clientMessageIds: steers.map((s) => s.clientMessageId) } as AgentEvent);
    // 不带 clientId：按 sessionId 定位（面板可能已经切到别的会话）
    await this.handleUserMessage({
      ...(base as unknown as UserMessageCommand),
      type: "user_message",
      sessionId,
      content: join(commands.map((c) => c.content)),
      displayText: join(commands.map((c) => c.displayText ?? c.content)),
      images: commands.flatMap((c) => (Array.isArray(c.images) ? c.images : [])),
      attachedFiles: commands.flatMap((c) => (Array.isArray(c.attachedFiles) ? c.attachedFiles : [])),
      clientMessageId: steers[0].clientMessageId,
    } as UserMessageCommand & { sessionId: string }, undefined);
  }

  // ── 后台任务 ──

  /** 等待投递的后台任务结束通知（会话空闲时攒 500ms，几个前后脚结束的合并成一轮） */
  private readonly pendingNotices = new Map<string, BackgroundTaskNotice[]>();
  /** 各会话上一轮回复结束的时刻：在这之前就已结束的任务不再单独通知 */
  private readonly turnEndedAt = new Map<string, number>();

  /**
   * 列出所有活跃会话的后台任务。带 clientId 时只回给请求的面板，否则广播（列表变化时）。
   */
  private async emitBackgroundTasks(clientId?: string): Promise<void> {
    const tasks: (BackgroundTaskInfo & { sessionId: string; sessionTitle?: string })[] = [];
    for (const [sid, session] of this.activeSessions) {
      if (!session.backgroundTasks) continue;
      const list = await session.backgroundTasks.list().catch(() => []);
      if (list.length === 0) continue;
      const title = (await this.storage.getSession(sid).catch(() => null))?.title;
      for (const task of list) tasks.push({ ...task, sessionId: sid, ...(title ? { sessionTitle: title } : {}) });
    }
    tasks.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    const event = { type: "background_tasks", tasks } as AgentEvent;
    if (clientId) this.sendToClient(clientId, event);
    else this.channel.emit(event);
  }

  private queueBackgroundNotice(sessionId: string, notice: BackgroundTaskNotice): void {
    // AI 正在回复：结果直接并进这一轮（下一次请求模型前插入），不打断、不另起一轮
    const running = this.runningSessions.has(sessionId) ? this.activeSessions.get(sessionId) : undefined;
    if (running) {
      running.enqueueBackgroundNotice(formatBackgroundNotice(notice, { inline: true }));
      return;
    }
    // 任务其实在上一轮回复结束之前就结束了，只是结束事件晚到（要先读完输出、宿主检测有延迟）：
    // 那一轮里 AI 已经有机会看到它，回复完再弹「后台任务结束」不合理，直接丢掉。
    if (notice.endedAt && notice.endedAt <= (this.turnEndedAt.get(sessionId) ?? 0)) return;
    const list = this.pendingNotices.get(sessionId) ?? [];
    list.push(notice);
    this.pendingNotices.set(sessionId, list);
    // 稍等片刻再投递：几个任务前后脚结束时合并成一轮
    setTimeout(() => { void this.flushBackgroundNotices(sessionId); }, 500);
  }

  /**
   * 投递攒下的通知：替 Agent 发起一轮，内容是任务结果。
   * 会话正在跑就什么都不做——这一轮结束时会再调用一次（见 handleUserMessage 收尾）。
   */
  private async flushBackgroundNotices(sessionId: string): Promise<void> {
    const notices = this.pendingNotices.get(sessionId);
    const session = this.activeSessions.get(sessionId);
    if (!notices?.length || !session) return;
    this.pendingNotices.delete(sessionId);
    // 攒着的这段时间里用户发了新消息、AI 已经在回复：并进那一轮，不再单独开一轮
    if (this.runningSessions.has(sessionId)) {
      for (const n of notices) session.enqueueBackgroundNotice(formatBackgroundNotice(n, { inline: true }));
      return;
    }
    const saved = await this.storage.getSession(sessionId).catch(() => null);
    const model = session.model || saved?.model;
    const provider = session.provider || saved?.provider;
    if (!model || !provider) return;
    const label = notices.length === 1 ? backgroundNoticeLabel(notices[0]) : `${notices.length} 个后台任务结束`;
    const notice = {
      label,
      tasks: notices.map((n) => ({ terminalId: n.terminalId, command: n.command, exitCode: n.exitCode, startedAt: n.startedAt, endedAt: n.endedAt })),
    };
    const clientMessageId = `bg-notice-${Date.now()}`;
    this.sendTo(sessionId, undefined, { type: "background_turn", clientMessageId, label, notice } as AgentEvent);
    // 不带 clientId：按 sessionId 定位会话。面板此刻可能已切到别的会话，带上 clientId 会被解析到那条会话上。
    await this.handleUserMessage({
      type: "user_message",
      sessionId,
      content: notices.map((n) => formatBackgroundNotice(n)).join("\n\n---\n\n"),
      displayText: label,
      model,
      provider,
      mode: saved?.mode ?? "agent",
      clientMessageId,
      backgroundNotice: notice,
      ...(session.effort ? { effort: session.effort } : {}),
    } as UserMessageCommand & { sessionId: string }, undefined);
  }

  // ── Cowork 流程 ──

  private flowStoreInstance: CoworkFlowStore | null = null;

  private flowStore(): CoworkFlowStore {
    if (!this.flowStoreInstance) this.flowStoreInstance = new CoworkFlowStore(this.deps.createHost().fs, this.deps.homeDir);
    return this.flowStoreInstance;
  }

  private async emitFlows(clientId: string | undefined): Promise<void> {
    const flows = await this.flowStore().list();
    this.emitResult(null, clientId, { type: "cowork_flows", flows } as AgentEvent);
  }

  /** 用该会话自己的模型把它提炼成流程草稿；失败时把原因回给前端，不抛 */
  private async handleDraftFlow(cmd: Extract<ControlCommand, { type: "cowork_draft_flow" }>, clientId: string | undefined): Promise<void> {
    const reply = (data: Record<string, unknown>) =>
      this.emitResult(null, clientId, { type: "cowork_flow_draft", requestId: cmd.requestId, ...data } as AgentEvent);
    try {
      if (typeof cmd.description === "string") {
        if (!cmd.model || !cmd.provider) throw new Error("请先在下方选择一个模型");
        const draft = await generateFlowDraftFromDescription({ strategy: getStrategy(cmd.provider, cmd.model), model: cmd.model, description: cmd.description });
        reply({ draft });
        return;
      }
      const sessionId = cmd.sessionId || "";
      const active = this.activeSessions.get(sessionId);
      const saved = active ? null : await this.storage.getSession(sessionId);
      const messages = active ? active.getMessages() : (saved?.messages ?? []);
      const model = active?.model || saved?.model || "";
      const provider = active?.provider || saved?.provider || "";
      if (!model || !provider) throw new Error("找不到这个任务用的模型，请先在下方选择模型后重试");
      const draft = await generateFlowDraft({ strategy: getStrategy(provider, model), model, messages });
      reply({ draft });
    } catch (err) {
      reply({ error: (err as Error).message || "整理流程失败" });
    }
  }

  /** 设置编辑模式 */
  private async handleSetEditMode(
    cmd: Extract<ControlCommand, { type: "set_edit_mode" }>,
    clientId: string | undefined,
  ): Promise<void> {
    const mode = cmd.mode === "auto" ? "auto" : "manual";
    // 按 clientId 记住期望模式：即便此刻会话还没建好（reload 时序竞态），
    // 会话创建时也会从 clientEditModes 回填，确保 UI 的"自动确认"与后端真实落盘行为一致。
    if (clientId) this.clientEditModes.set(clientId, mode);
    const sid = this.resolveSessionId(cmd);
    const s = this.getActiveSession(sid);
    if (s) {
      // 从 manual 切到 auto：自动接受所有 pending 编辑，避免遗留暂存区与磁盘不一致
      if (mode === "auto" && s.hasPendingEdits()) {
        await s.acceptEdits();
      }
      s.setEditMode(mode);
    }
    this.emitResult(sid, clientId, { type: "edit_mode_set", mode } as AgentEvent);
  }

  // ── 后台 Agent 任务 ──

  private agentTaskStoreInstance: AgentTaskStore | null = null;

  private agentTaskStore(): AgentTaskStore {
    if (!this.agentTaskStoreInstance) this.agentTaskStoreInstance = new AgentTaskStore(this.deps.createHost().fs, this.deps.homeDir);
    return this.agentTaskStoreInstance;
  }

  private emitAgentTasks(clientId?: string): void {
    void this.agentTaskStore().list().then((tasks) => {
      const event = { type: "agent_tasks", tasks } as AgentEvent;
      if (clientId) this.sendToClient(clientId, event);
      else this.channel.emit(event);
    });
  }

  /**
   * 交给后台：新建一条会话，在自动权限下跑完整个任务。
   * 会话不归属任何面板（事件投给一个不存在的面板标识，不会串到正在聊的面板里）；
   * 用户随时可以在会话列表 / 后台任务面板里打开它，打开后流式过程照常显示。
   */
  private async handleAgentTaskStart(cmd: Extract<ControlCommand, { type: "agent_task_start" }>, clientId: string | undefined): Promise<void> {
    const content = (cmd.content || "").trim();
    if (!content) return;
    // 任务清单里显示用户写的那句话；带了附件时发给模型的 content 里还有文件内容
    const display = (cmd.displayText || "").trim() || content;
    if (!cmd.model?.trim() || !cmd.provider?.trim()) throw new Error("请先在模型菜单中选择已配置的 Provider 和模型");
    const { all: allWorkspaces, primary: primaryWorkspace } = this.resolveWorkspaces();
    const ws_dir = cmd.workspace || primaryWorkspace;
    const ws_dirs = cmd.workspaces?.length ? cmd.workspaces : allWorkspaces;
    const created = await this.storage.createSession({
      id: "",
      title: PLACEHOLDER_TITLE,
      model: cmd.model,
      provider: cmd.provider,
      workspace: ws_dir,
      workspaces: ws_dirs.length > 1 ? ws_dirs : undefined,
      mode: "agent",
      messages: [],
      totalTokens: 0,
    });
    const sid = created.id;
    const channel = this.getOrCreateSessionChannel(sid);
    channel.clientId = `agent-task:${sid}`;
    channel.onEvent = (event) => {
      const step = stepFromEvent(event as { type?: string });
      if (step && this.agentTaskStore().get(sid)?.status === "running") {
        this.agentTaskStore().update(sid, { step }, false);
        this.throttledEmitAgentTasks();
      }
    };
    const session = this.createSession(sid, ws_dir, undefined, ws_dirs, undefined, "agent");
    session.setSessionId(sid);
    session.unattended = true;
    // 没人盯着，不能卡在审批上：至少自动；用户当前是完全访问就沿用
    const mode = clientId ? this.clientPermissionModes.get(clientId) : undefined;
    await session.setPermissionMode(mode === "full" ? "full" : "auto");
    this.registerPersistence(session, sid);
    this.activeSessions.set(sid, session);

    const task: AgentTask = { id: sid, prompt: display, status: "running", startedAt: Date.now(), model: cmd.model, provider: cmd.provider, workspace: ws_dir, step: "准备开始" };
    await this.agentTaskStore().add(task);
    this.channel.emit({ type: "agent_task_started", task, ...(clientId ? { clientId } : {}) } as AgentEvent);
    this.emitAgentTasks();

    void this.handleUserMessage({
      type: "user_message",
      sessionId: sid,
      content: AGENT_TASK_PREFACE + content,
      displayText: display,
      model: cmd.model,
      provider: cmd.provider,
      mode: "agent",
      ...(cmd.effort ? { effort: cmd.effort } : {}),
    } as UserMessageCommand & { sessionId: string }, undefined).catch((err) => {
      this.agentTaskStore().update(sid, { status: "failed", endedAt: Date.now(), step: undefined, summary: (err as Error).message, unread: true });
      this.emitAgentTasks();
    });
  }

  private agentTasksEmitTimer: ReturnType<typeof setTimeout> | null = null;

  /** 进度更新很频繁（每个工具都有一条），合并成最多每秒一次 */
  private throttledEmitAgentTasks(): void {
    if (this.agentTasksEmitTimer) return;
    this.agentTasksEmitTimer = setTimeout(() => {
      this.agentTasksEmitTimer = null;
      this.emitAgentTasks();
    }, 1000);
  }

  /** 一轮跑完：后台任务据此记结果、发完成通知（还有插话 / 后台进程通知要接着跑时先不算完） */
  private async finishAgentTaskTurn(sid: string, session: AgentSession): Promise<void> {
    const store = this.agentTaskStore();
    const task = store.get(sid);
    if (!task) return;
    const saved = await this.storage.getSession(sid).catch(() => null);
    if (saved?.title && saved.title !== PLACEHOLDER_TITLE) task.title = saved.title;
    if (session.pendingSteers.length > 0 || this.pendingNotices.has(sid)) {
      store.update(sid, {});
      return;
    }
    const last = [...session.getMessages()].reverse().find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim()) as { content: string; turnStats?: { turnStatus?: string } } | undefined;
    const turnStatus = last?.turnStats?.turnStatus;
    const status: AgentTask["status"] = session.isCancelled || turnStatus === "cancelled" ? "stopped" : turnStatus === "error" ? "failed" : "done";
    const updated = store.update(sid, {
      status,
      endedAt: Date.now(),
      step: undefined,
      summary: last?.content.trim().replace(/\s+/g, " ").slice(0, 280),
      unread: true,
    });
    if (updated) this.channel.emit({ type: "agent_task_done", task: updated } as AgentEvent);
    this.emitAgentTasks();
  }

  /** 处理用户消息 */
  private async handleUserMessage(cmd: UserMessageCommand & { clientId?: string; sessionId?: string }, clientId: string | undefined): Promise<void> {
    const { all: allWorkspaces, primary: primaryWorkspace } = this.resolveWorkspaces();

    let sid = this.resolveSessionId(cmd);
    let session = this.getActiveSession(sid);
    const mode = this.normalizeMode(cmd.mode);

    if (!cmd.model?.trim() || !cmd.provider?.trim()) {
      throw new Error("请先在模型菜单中选择已配置的 Provider 和模型");
    }

    // 会话不存在：惰性创建（采用前端传入的 sessionId，若无则由存储生成）
    if (!session) {
      const ws_dir = (typeof cmd.workspace === "string" && cmd.workspace) ? cmd.workspace : primaryWorkspace;
      const ws_dirs = Array.isArray(cmd.workspaces) && cmd.workspaces.length > 0
        ? cmd.workspaces as string[]
        : (clientId ? this.pendingWorkspaces.get(clientId) : undefined) || allWorkspaces;
      const created = await this.storage.createSession({
        id: cmd.sessionId || "",
        title: "新对话",
        model: cmd.model,
        provider: cmd.provider,
        workspace: ws_dir,
        workspaces: ws_dirs.length > 1 ? ws_dirs : undefined,
        mode: mode.persisted,
        messages: [],
        totalTokens: 0,
      });
      sid = created.id;
      if (clientId) {
        this.clientSessions.set(clientId, sid);
        this.pendingWorkspaces.delete(clientId);
      }
      session = this.createSession(sid, ws_dir, undefined, ws_dirs, clientId, mode.runtime);
      session.setSessionId(sid);
      this.registerPersistence(session, sid);
      this.activeSessions.set(sid, session);
      this.sendTo(sid, clientId, { type: "session_created", sessionId: sid, workspace: ws_dir, workspaces: ws_dirs } as AgentEvent);
      session.appendTrace("session.created", {
        workspace: ws_dir,
        workspaces: ws_dirs,
        mode: mode.persisted,
        title: "新对话",
      });
    }

    // 思考开关：agent / quest 都生效，每轮注入（决定是否向模型请求思考 + 是否转发 reasoning）。
    // 缺省视为开启——老客户端不带该字段时保持原有行为。
    session.setThink(cmd.think !== false);
    // 办公化状态文案：仅 Cowork 轮开启。
    //
    // 每轮注入而不是建会话时定一次：同一条会话可能先在 Cowork 里跑、之后被 Code
    // 侧打开继续（历史列表是共享的），文案风格要跟着当前入口走，而不是跟着会话
    // 的出生地走。runtime 已把 cowork 降级成 agent，所以这里必须看 persisted。
    session.humanizedStatus = mode.persisted === "cowork";
    // 产出目录：收尾时扫它，diff 出本轮实际产出了哪些文件。
    // 用户可能中途改产出目录，所以每轮都要重新注入。
    session.setOutputDir(typeof cmd.outputDir === "string" ? cmd.outputDir : "");
    // Chat 产物目录：同样每轮注入，用户中途改了目录下一轮就生效；空串走默认位置。
    session.setArtifactDir(typeof cmd.artifactDir === "string" ? cmd.artifactDir : "");
    // Cowork 附件快照：开启后每轮对附件做原稿副本（查看改动/恢复原稿的依据）。
    // 与 humanizedStatus 同理挂在 Cowork 轮上；同会话复用同一 sessionId 的快照区。
    if (mode.persisted === "cowork" && sid) session.enableCoworkSnapshots(sid);
    // 运行流程：记一次运行（失败不影响任务本身）
    if (mode.persisted === "cowork" && sid && typeof cmd.flowId === "string" && cmd.flowId) {
      void this.flowStore().recordRun(cmd.flowId, sid).catch(() => undefined);
    }
    // Quest 模式：每轮注入联网开关（决定工具集）
    if (mode.runtime === "quest") {
      session.setQuestOptions(cmd.quest || {});
    }

    const execSessionId = sid!;
    const execSession = session!;
    // 记录最近活跃会话：供侧栏树按钮等「无 clientId」入口的指令定位目标（见 resolveSessionId）
    // 后台任务的会话不算「最近活跃」：侧栏按钮等全局入口不该作用到它上面
    await this.agentTaskStore().list();
    const agentTask = this.agentTaskStore().get(execSessionId);
    if (!agentTask) this.lastActiveSessionId = execSessionId;
    else if (agentTask.status !== "running") {
      // 用户打开已结束的后台任务接着聊：重新算作运行中
      this.agentTaskStore().update(execSessionId, { status: "running", endedAt: undefined, step: "继续处理", unread: false });
      this.emitAgentTasks();
    }
    this.runningSessions.add(execSessionId);

    const finalContent = cmd.content || "";

    try {
      await execSession.handleUserInput(finalContent, cmd.model, cmd.images as string[] | undefined, cmd.provider, {
        clientMessageId: (cmd as any).clientMessageId as string | undefined,
        displayText: cmd.displayText,
        attachedFiles: cmd.attachedFiles as { name: string; size: number }[] | undefined,
        effort: typeof cmd.effort === "string" ? cmd.effort : undefined,
        userSegments: cmd.userSegments as unknown[] | undefined,
        ...(cmd.backgroundNotice ? { backgroundNotice: cmd.backgroundNotice } : {}),
      });
    } catch (err) {
      // 非取消异常（如 LLM 403/网络错误）：agentSession 内部已经推送了完整错误信息
      // （stream_start → stream_delta → stream_end）到前端，此处只记录日志 + 清理，
      // 不向上抛——避免串台到其他正在运行的后台会话
      const error = err as Error;
      if (error.name !== "AbortError" && !error.message?.includes("aborted")) {
        console.error(`[sessionHub] ${execSessionId} LLM 错误:`, error.message);
      }
    } finally {
      this.runningSessions.delete(execSessionId);
      this.turnEndedAt.set(execSessionId, Date.now());
    }

    // 收尾持久化
    const turnSid = execSession.getSessionId();
    if (turnSid) {
      const messages = this.filterPersistable(execSession.getMessages());
      const savedSession = await this.storage.getSession(turnSid);

      let title = savedSession?.title;
      const titleSource = cmd.displayText || cmd.content;
      if (title === PLACEHOLDER_TITLE && titleSource) {
        title = await uniqueAutoTitle(this.storage, titleSource, turnSid);
      }

      await this.storage.updateSession(turnSid, {
        messages,
        model: cmd.model,
        provider: cmd.provider,
        title,
        totalTokens: execSession.getLastTotalTokens(),
        pendingEdits: execSession.serializePendingEdits(),
      });

      if (title !== savedSession?.title) {
        this.sendTo(turnSid, clientId, { type: "session_title_updated", title } as AgentEvent);
        execSession.appendTrace("session.title_updated", { title });
      }
    }

    if (this.agentTaskStore().get(execSessionId)) await this.finishAgentTaskTurn(execSessionId, execSession);

    // 这一轮结束时还有没插进去的插话（模型在写最终回答、或被停止）：用户的话优先，马上开新一轮
    if (execSession.pendingSteers.length > 0) {
      setTimeout(() => { void this.flushSteers(execSessionId); }, 0);
    }

    // 这一轮里结束、但没来得及并进回复的后台任务：丢掉。
    // 通知只给「回复结束时还在跑」的任务——回复过程中结束的，要么已并入这一轮，
    // 要么 AI 自己等到 / 读到了结果；回复完再补一轮「历史通知」只会打扰用户。
    execSession.takeBackgroundNotices();
  }

  /**
   * 处理用户取消（AbortError）后的持久化。
   */
  async persistOnCancel(cmd: UserMessageCommand & { clientId?: string; sessionId?: string }): Promise<void> {
    const clientId = cmd.clientId;
    const sid = this.resolveSessionId(cmd);
    const session = this.getActiveSession(sid);

    const tokens = session?.getCumulativeTokens() || 0;
    this.emitResult(sid, clientId, { type: "stream_end", elapsed: 0, tokens } as AgentEvent);

    if (sid && session) {
      const messages = this.filterPersistable(session.getMessages());
      const savedSession = await this.storage.getSession(sid);
      let title = savedSession?.title;
      const titleSource = cmd.displayText || cmd.content;
      if (title === PLACEHOLDER_TITLE && titleSource) {
        title = await uniqueAutoTitle(this.storage, titleSource, sid);
      }
      await this.storage.updateSession(sid, {
        messages,
        model: cmd.model,
        provider: cmd.provider,
        title,
        totalTokens: session.getLastTotalTokens(),
        pendingEdits: session.serializePendingEdits(),
      });
    }
  }
}
