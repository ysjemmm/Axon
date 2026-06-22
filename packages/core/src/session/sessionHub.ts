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

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { AgentSession } from "../agentSession.js";
import { ZHIPU_PROVIDER } from "../providers.js";
import { RelayStore } from "../relay/relayStore.js";
import type { ControlCommand, UserMessageCommand } from "../channel/index.js";
import type { AgentChannel, AgentEvent } from "../channel/index.js";
import type { AgentHost } from "../host/index.js";
import type { SessionStorage } from "../storage/types.js";
import type { SessionHubDeps } from "./types.js";

/**
 * 每个 session 的代理 channel：拦截该 session emit 的所有事件，
 * 打上 `sessionId`（恒有）与 `clientId`（当前拥有该会话的面板，可变）标签后实时转发。
 *
 * 后台 session 的 agent loop 完全不感知自己处于后台——它照常 emit，
 * 事件被打标后直达真实 channel，由前端总线按 clientId 分发到对应面板。
 */
class SessionChannel implements AgentChannel {
  /** 当前拥有（展示）该会话的面板标识；load_session / 新建会话时更新 */
  clientId: string | null = null;

  constructor(
    private readonly sessionId: string,
    private readonly realChannel: AgentChannel,
  ) {}

  emit(event: AgentEvent): void {
    const tagged: AgentEvent = { ...event, sessionId: this.sessionId };
    if (this.clientId) tagged.clientId = this.clientId;
    this.realChannel.emit(tagged);
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
   * 面板 → 期望的编辑模式（clientId → auto/manual）。
   * 编辑模式是客户端 UI 偏好（前端持久化于 localStorage，连接时重发 set_edit_mode），
   * 不随会话落盘。reload 后后端是全新 hub，且 set_edit_mode 与 load_session 到达顺序不定——
   * 若 set_edit_mode 先到、会话尚未建好会被静默丢弃（旧 bug：UI 显示自动确认但实际仍是 manual）。
   * 这里按 clientId 记住期望模式，会话创建时统一回填，与消息顺序解耦。
   */
  private readonly clientEditModes = new Map<string, "auto" | "manual">();

  /** 面板在会话创建前收到 set_workspace_group 时，按 clientId 暂存的 workspaces */
  private readonly pendingWorkspaces = new Map<string, string[]>();

  constructor(deps: SessionHubDeps) {
    this.deps = deps;
    this.storage = deps.storage;
    this.channel = deps.channel;
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
    this.getOrCreateSessionChannel(sessionId, clientId).emit(event);
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

  /** 解析指令的目标会话：优先按 clientId 映射，回退到指令显式 sessionId */
  private resolveSessionId(cmd: ControlCommand): string | null {
    const cid = cmd.clientId;
    if (cid && this.clientSessions.has(cid)) return this.clientSessions.get(cid)!;
    if (cmd.sessionId) return cmd.sessionId;
    return null;
  }

  /** 取活跃会话实例（不存在返回 null） */
  private getActiveSession(sessionId: string | null): AgentSession | null {
    if (!sessionId) return null;
    return this.activeSessions.get(sessionId) ?? null;
  }

  /**
   * 重载命令信任白名单到所有活跃会话。
   * 在设置变化时由 host 调用，保证 settings 里增删的规则实时生效到正在运行的 Agent——
   * 而不是等到下次创建会话才加载。
   */
  reloadTrustedCommands(): void {
    const store = this.deps.commandTrust;
    if (!store) return;
    const workspace = this.deps.defaultWorkspace;
    try {
      const patterns = store.load(workspace);
      for (const session of this.activeSessions.values()) {
        session.setTrustedCommands(patterns);
      }
    } catch (err) {
      console.warn("[trust] 实时同步命令白名单失败:", (err as Error).message);
    }
  }

  /** 获取或创建一个 session 的代理 channel；传入 clientId 时更新其归属面板 */
  private getOrCreateSessionChannel(sessionId: string, clientId?: string): SessionChannel {
    let ch = this.sessionChannels.get(sessionId);
    if (!ch) {
      ch = new SessionChannel(sessionId, this.channel);
      this.sessionChannels.set(sessionId, ch);
    }
    if (clientId) ch.clientId = clientId;
    return ch;
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
    const proxyChannel = this.getOrCreateSessionChannel(sessionId, clientId);
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
    );
    this.wireCommandTrust(session, workspaces?.[0] ?? cwd);
    // 回填该面板期望的编辑模式（auto/manual）：解决 reload 后 set_edit_mode 与会话创建的时序竞态
    if (clientId) {
      const desiredMode = this.clientEditModes.get(clientId);
      if (desiredMode) session.setEditMode(desiredMode);
    }
    return session;
  }

  /** 接线命令信任白名单：从存储载入 + 注册新批准规则的持久化回调 */
  private wireCommandTrust(session: AgentSession, workspace: string): void {
    const store = this.deps.commandTrust;
    if (!store) return;
    try {
      session.setTrustedCommands(store.load(workspace));
    } catch (err) {
      console.warn("[trust] 载入命令白名单失败（用内置默认）:", (err as Error).message);
    }
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
    s.setOnPendingChanged(async () => {
      await this.storage.updateSession(sid, { pendingEdits: s.serializePendingEdits() }).catch(() => {});
    });
    s.setOnMessagesChanged(async () => {
      const total = s.getLastTotalTokens();
      await this.storage.updateSession(sid, {
        messages: s.getMessages(),
        // 仅在有有效值时写入 totalTokens：避免尚未拿到真实 usage 时用 0 覆盖磁盘已有统计。
        ...(total > 0 ? { totalTokens: total } : {}),
        pendingEdits: s.serializePendingEdits(),
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
      this.getOrCreateSessionChannel(sid, clientId);
      const savedSession = await this.storage.getSession(sid);
      return { session: cached, savedSession };
    }

    const savedSession = await this.storage.getSession(sid);
    const ws_dir = savedSession?.workspace || primaryWorkspace;
    const ws_dirs = (this.deps.workspaces && this.deps.workspaces.length > 0)
      ? this.deps.workspaces
      : (savedSession?.workspaces && savedSession.workspaces.length > 0 ? savedSession.workspaces : [ws_dir]);

    const session = this.createSession(sid, ws_dir, savedSession?.messages, ws_dirs, clientId, savedSession?.mode ?? "agent");
    session.setSessionId(sid);
    // 回填上次落盘的 token 统计，避免新实例 getLastTotalTokens()=0 在首次真实 usage 前
    // 被持久化回写、覆盖磁盘上的有效值（刷新后上下文显示为 0 的根因）。
    session.hydrateTokenUsage(savedSession?.totalTokens);
    if (savedSession?.pendingEdits && savedSession.pendingEdits.length > 0) {
      session.restorePendingEdits(savedSession.pendingEdits);
    }
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
        return this.handleLoadSession(cmd.sessionId, clientId, primaryWorkspace);
      case "set_workspace":
        return this.handleSetWorkspace(cmd, clientId);
      case "set_workspace_group":
        return this.handleSetWorkspaceGroup(cmd, clientId, primaryWorkspace);
      case "reset_session":
        if (clientId) {
          this.clientSessions.delete(clientId);
          this.pendingWorkspaces.delete(clientId);
        }
        return;
      case "new_session":
        return this.handleNewSession(cmd, clientId, allWorkspaces, primaryWorkspace);
      case "cancel":
        this.getActiveSession(this.resolveSessionId(cmd))?.cancel();
        return;
      case "compact_session":
        this.getActiveSession(this.resolveSessionId(cmd))?.compactSession();
        return;
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
        this.getActiveSession(this.resolveSessionId(cmd))?.resolveToolConfirmation(cmd.confirmed);
        return;
      case "confirm_command":
        this.getActiveSession(this.resolveSessionId(cmd))?.resolveCommandApproval(cmd.requestId, { choice: cmd.choice, pattern: cmd.pattern, target: cmd.target, editedCommand: cmd.editedCommand });
        return;
      case "set_edit_mode":
        return this.handleSetEditMode(cmd, clientId);
      case "accept_edits": {
        const sid = this.resolveSessionId(cmd);
        const s = this.getActiveSession(sid);
        await s?.acceptEdits(typeof cmd.path === "string" ? cmd.path : undefined);
        if (sid && s) await this.storage.updateSession(sid, { messages: s.getMessages() });
        return;
      }
      case "reject_edits": {
        const sid = this.resolveSessionId(cmd);
        const s = this.getActiveSession(sid);
        await s?.rejectEdits(typeof cmd.path === "string" ? cmd.path : undefined);
        if (sid && s) await this.storage.updateSession(sid, { messages: s.getMessages() });
        return;
      }
      case "undo_edits": {
        const sid = this.resolveSessionId(cmd);
        const s = this.getActiveSession(sid);
        if (typeof cmd.path === "string" && cmd.path) await s?.undoEdits(cmd.path);
        if (sid && s) await this.storage.updateSession(sid, { messages: s.getMessages() });
        return;
      }
      case "undo_parallel_file": {
        const sid = this.resolveSessionId(cmd);
        const s = this.getActiveSession(sid);
        if (typeof cmd.path === "string" && cmd.path) await s?.undoParallelFile(cmd.path);
        return;
      }
      case "user_message":
        if (cmd.content || cmd.images) await this.handleUserMessage(cmd, clientId);
        return;
    }
  }

  /** 加载/切换会话：发送 session_loaded 快照（实时事件由代理 channel 直达，无需缓冲重放） */
  private async handleLoadSession(sid: string, clientId: string | undefined, primaryWorkspace: string): Promise<void> {
    if (clientId) this.clientSessions.set(clientId, sid);

    const { session, savedSession } = await this.getOrLoadSession(sid, primaryWorkspace, clientId);

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
      messages: session.getMessages().length > 0 ? session.getMessages() : (savedSession?.messages || []),
      totalTokens: session.getLastTotalTokens() || savedSession?.totalTokens || 0,
      pendingPaths: session.getPendingPaths(),
      pendingDiffs: session.getPendingDiffs(),
      pendingEditIds: session.getPendingEditIds(),
    } as AgentEvent);
  }

  /** 设置/切换会话工作区（带 clientId 定向；无 clientId 时为工作区文件夹变化广播，应用到全部活跃会话） */
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
    } else if (clientId) {
      // 面板已指定但会话未创建：定向回该面板（不广播）
      this.sendToClient(clientId, { type: "workspace_set", workspace: dir, workspaces: dirs } as AgentEvent);
    } else {
      // 工作区文件夹变化广播：应用到全部活跃会话，并广播给所有面板
      for (const s of this.activeSessions.values()) applyTo(s);
      this.send("workspace_set", { workspace: dir, workspaces: dirs });
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
  }

  /** 新建会话（显式指令；前端通常走「发首条消息惰性创建」路径） */
  private async handleNewSession(
    cmd: Extract<ControlCommand, { type: "new_session" }>,
    clientId: string | undefined,
    allWorkspaces: string[],
    primaryWorkspace: string,
  ): Promise<void> {
    const ws_dir = (typeof cmd.workspace === "string" && cmd.workspace) ? cmd.workspace : primaryWorkspace;
    const mode = cmd.mode === "quest" ? "quest" : "agent";
    const created = await this.storage.createSession({
      id: cmd.sessionId || "",
      title: "新对话",
      model: cmd.model || "auto",
      provider: cmd.provider || ZHIPU_PROVIDER,
      workspace: ws_dir,
      mode,
      messages: [],
      totalTokens: 0,
    });
    if (clientId) this.clientSessions.set(clientId, created.id);
    const session = this.createSession(created.id, ws_dir, undefined, allWorkspaces, clientId, mode);
    session.setSessionId(created.id);
    this.registerPersistence(session, created.id);
    this.activeSessions.set(created.id, session);
    this.sendTo(created.id, clientId, {
      type: "session_created",
      sessionId: created.id,
      workspace: ws_dir,
      workspaces: allWorkspaces,
    } as AgentEvent);
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
    const { all: allWorkspaces, primary: primaryWorkspace } = this.resolveWorkspaces();
    // 从父会话获取工作区和模式
    const parentSaved = await this.storage.getSession(parentSessionId);
    const ws_dir = parentSaved?.workspace || primaryWorkspace;
    const ws_dirs = parentSaved?.workspaces && parentSaved.workspaces.length > 0
      ? parentSaved.workspaces
      : allWorkspaces;
    const mode = parentSaved?.mode ?? "agent";
    const titleSource = migrateData.userInput.content;
    const title = titleSource.slice(0, 30) + (titleSource.length > 30 ? "..." : "");

    // 创建新会话并预加载压缩后的消息
    const created = await this.storage.createSession({
      id: "",
      title,
      model: migrateData.userInput.model || "auto",
      provider: migrateData.userInput.provider || ZHIPU_PROVIDER,
      workspace: ws_dir,
      workspaces: ws_dirs.length > 1 ? ws_dirs : undefined,
      mode,
      messages: migrateData.messages,
      totalTokens: 0,
    });

    // 建立 clientId → 新会话映射
    if (clientId) this.clientSessions.set(clientId, created.id);

    const session = this.createSession(created.id, ws_dir, migrateData.messages, ws_dirs, clientId, mode);
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

    // 在新会话中发送用户消息，触发 AI 回复
    this.runningSessions.add(created.id);
    try {
      await session.handleUserInput(
        migrateData.userInput.content,
        migrateData.userInput.model,
        migrateData.userInput.images,
        migrateData.userInput.provider,
        migrateData.userInput.userMeta as { displayText?: string; attachedFiles?: { name: string; size: number }[]; replyStyle?: string } | undefined,
      );
    } catch (err) {
      const error = err as Error;
      if (error.name !== "AbortError" && !error.message?.includes("aborted")) {
        console.error(`[sessionHub] 压缩迁移 LLM 错误:`, error.message);
        const errMsg = `❌ ${error.message}`;
        session.getMessages().push({ role: "assistant", content: errMsg } as any);
        this.sendTo(created.id, clientId, { type: "stream_delta", content: errMsg } as AgentEvent);
        this.sendTo(created.id, clientId, { type: "stream_end", elapsed: 0, tokens: 0, model: migrateData.userInput.model || "auto" } as AgentEvent);
      }
    } finally {
      this.runningSessions.delete(created.id);
    }

    // 持久化新会话
    const messages = session.getMessages();
    await this.storage.updateSession(created.id, {
      messages,
      title,
      totalTokens: session.getLastTotalTokens(),
    });
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
      await new RelayStore(ws_dir, this.deps.createHost()).remove(relayId);
      this.emitResult(sid, clientId, { type: "relay_deleted", relayId } as AgentEvent);
    }
    if (sid && s) {
      await this.storage.updateSession(sid, { messages: s.getMessages() });
    }
  }

  /** 设置编辑模式 */
  private handleSetEditMode(
    cmd: Extract<ControlCommand, { type: "set_edit_mode" }>,
    clientId: string | undefined,
  ): void {
    const mode = cmd.mode === "auto" ? "auto" : "manual";
    // 按 clientId 记住期望模式：即便此刻会话还没建好（reload 时序竞态），
    // 会话创建时也会从 clientEditModes 回填，确保 UI 的"自动确认"与后端真实落盘行为一致。
    if (clientId) this.clientEditModes.set(clientId, mode);
    const sid = this.resolveSessionId(cmd);
    const s = this.getActiveSession(sid);
    s?.setEditMode(mode);
    this.emitResult(sid, clientId, { type: "edit_mode_set", mode } as AgentEvent);
  }

  /** 处理用户消息 */
  private async handleUserMessage(cmd: UserMessageCommand & { clientId?: string; sessionId?: string }, clientId: string | undefined): Promise<void> {
    const { all: allWorkspaces, primary: primaryWorkspace } = this.resolveWorkspaces();

    let sid = this.resolveSessionId(cmd);
    let session = this.getActiveSession(sid);
    const mode = cmd.mode === "quest" ? "quest" : "agent";
    // 并行模式标记：仍走 agent 会话，但 content 前注入编排指令引导 AI 自动拆分并使用 parallel_execute
    const isParallel = cmd.mode === "parallel";

    // 会话不存在：惰性创建（采用前端传入的 sessionId，若无则由存储生成）
    if (!session) {
      const ws_dir = (typeof cmd.workspace === "string" && cmd.workspace) ? cmd.workspace : primaryWorkspace;
      const ws_dirs = Array.isArray(cmd.workspaces) && cmd.workspaces.length > 0
        ? cmd.workspaces as string[]
        : (clientId ? this.pendingWorkspaces.get(clientId) : undefined) || allWorkspaces;
      const created = await this.storage.createSession({
        id: cmd.sessionId || "",
        title: "新对话",
        model: cmd.model || "auto",
        provider: cmd.provider || ZHIPU_PROVIDER,
        workspace: ws_dir,
        workspaces: ws_dirs.length > 1 ? ws_dirs : undefined,
        mode,
        messages: [],
        totalTokens: 0,
      });
      sid = created.id;
      if (clientId) {
        this.clientSessions.set(clientId, sid);
        this.pendingWorkspaces.delete(clientId);
      }
      session = this.createSession(sid, ws_dir, undefined, ws_dirs, clientId, mode);
      session.setSessionId(sid);
      this.registerPersistence(session, sid);
      this.activeSessions.set(sid, session);
      this.sendTo(sid, clientId, { type: "session_created", sessionId: sid, workspace: ws_dir, workspaces: ws_dirs } as AgentEvent);
    }

    // Quest 模式：每轮注入思考/联网开关（决定工具集与 reasoning 转发）
    if (mode === "quest") {
      session.setQuestOptions(cmd.quest || {});
    }

    const execSessionId = sid!;
    const execSession = session!;
    this.runningSessions.add(execSessionId);

    // 并行模式：在用户原始需求前注入编排指令，引导 AI 将需求拆分为 parallel_execute 调用
    const finalContent = isParallel
      ? `【并行执行模式】请按以下步骤处理用户需求：\n\n` +
        `1. **先确认目标文件存在**：用 search 或 list_dir 快速确认用户提到的路径/文件是否真实存在于工作区。不要凭猜测假设路径。\n` +
        `2. **只对确实存在的文件拆分任务**：确认后，将需求拆分为多个互不依赖、文件作用域不重叠的子任务。\n` +
        `3. **使用 parallel_execute 派发**：每个子任务需要明确 fileScope（必须是真实存在的路径）。\n` +
        `4. **每个子任务的 prompt 必须自包含**：包含完整的背景、目标、操作步骤，子 Agent 看不到主对话历史。\n\n` +
        `【重要约束】\n` +
        `- 如果需求不适合并行（有依赖/文件重叠/目标文件不存在），直接说明原因并自己处理，不要强行拆分。\n` +
        `- 不要猜测路径。找不到的文件/目录就跳过，不要为不存在的路径创建子任务。\n\n` +
        `用户需求：${cmd.content || ""}`
      : (cmd.content || "");

    try {
      await execSession.handleUserInput(finalContent, cmd.model, cmd.images as string[] | undefined, cmd.provider, {
        displayText: cmd.displayText,
        attachedFiles: cmd.attachedFiles as { name: string; size: number }[] | undefined,
        replyStyle: cmd.replyStyle,
        userSegments: cmd.userSegments as unknown[] | undefined,
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
    }

    // 收尾持久化
    const turnSid = execSession.getSessionId();
    if (turnSid) {
      const messages = execSession.getMessages();
      const savedSession = await this.storage.getSession(turnSid);

      let title = savedSession?.title;
      const titleSource = cmd.displayText || cmd.content;
      if (title === "新对话" && titleSource) {
        title = titleSource.slice(0, 30) + (titleSource.length > 30 ? "..." : "");
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
      }
    }
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
      const messages = session.getMessages();
      const savedSession = await this.storage.getSession(sid);
      let title = savedSession?.title;
      const titleSource = cmd.displayText || cmd.content;
      if (title === "新对话" && titleSource) {
        title = titleSource.slice(0, 30) + (titleSource.length > 30 ? "..." : "");
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
