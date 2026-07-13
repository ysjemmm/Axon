
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { MODELS, findModel, getModels, useModels } from "@/components/ModelSelector";
import type { ToolStatus } from "@/components/ToolCallItem";
import { listRelays, type RelayData } from "@/lib/apiClient";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import type { AttachedFile, ChatMessage, CreditDetail, TextSegment, UserSegment } from "./types";
import type { CommandDecision } from "./commandApprovalContext";
import { STORAGE, TIMEOUT, CONTROL_CMD } from "@/lib/constants";
// 拆分后的模块
// 鎷嗗垎鍚庣殑妯″潡
import { createEventHandler } from "./eventHandlers";
import type { EventHandlerCtx } from "./eventHandlers/types";
import { useTypewriter } from "./useTypewriter";
import { useToolCallQueue } from "./useToolCallQueue";

const DEFAULT_MODEL_ID = "glm-4-flash";

export interface SubmitPayload {
  /** 加入聊天时间线的用户气泡 */
  userBubble: { content: string; images?: string[]; attachedFiles?: AttachedFile[]; segments?: UserSegment[] };
  send: {
    content: string;
    displayText: string;
    attachedFiles?: { name: string; size: number }[];
    userSegments?: unknown[];
    model: string;
    provider?: string;
    images?: string[];
    workspace?: string;
    workspaces?: string[];
    replyStyle: string;
    /** 会话模式 */
    mode?: "agent" | "quest";
    /** Quest 模式选项 */
    quest?: { think?: boolean; webSearch?: boolean };
  };
}

export interface CommandApproval {
  requestId: string;
  command: string;
  options: { choice: "exact" | "partial" | "prefix" | "all"; pattern: string; label: string }[];
}

interface UseChatSessionOptions {
  clientId: string;
  sessionId: string | null;
  mode: "agent" | "quest";
  connected: boolean;
  send: (cmd: Record<string, unknown>) => void;
  onSessionCreated: (id: string) => void;
  onCompactionMigrated?: (newSessionId: string) => void;
  onStreamingChange?: (streaming: boolean) => void;
}

export function useChatSession(opts: UseChatSessionOptions) {
  const { clientId, sessionId, mode, connected, send: baseSend, onSessionCreated, onCompactionMigrated, onStreamingChange } = opts;
  const models = useModels();

  // ── 会话状态 ──────────────────────────────────────────────────────────
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingSession, setIsLoadingSession] = useState(!!sessionId);
  const [tokenUsage, setTokenUsage] = useState<{ used: number; max: number; cumulative: number }>(() => {
    let savedModel = DEFAULT_MODEL_ID;
    try { savedModel = localStorage.getItem(STORAGE.LAST_MODEL) || DEFAULT_MODEL_ID; } catch { /* ignore */ }
    const currentModel = findModel(savedModel) || MODELS.find((m) => m.id === savedModel);
    return { used: 0, max: currentModel?.contextWindow || TIMEOUT.DEFAULT_CONTEXT_WINDOW, cumulative: 0 };
  });
  const [model, setModelState] = useState(() => {
    try { return localStorage.getItem(STORAGE.LAST_MODEL) || DEFAULT_MODEL_ID; } catch { return DEFAULT_MODEL_ID; }
  });
  const [providerState, setProviderState] = useState<string | undefined>(() => {
    try { return localStorage.getItem(STORAGE.LAST_PROVIDER) || undefined; } catch { return undefined; }
  });
  const setModel = useCallback((newModel: string, providerName?: string) => {
    setModelState(newModel);
    setProviderState(providerName);
    try {
      localStorage.setItem(STORAGE.LAST_MODEL, newModel);
      if (providerName) localStorage.setItem(STORAGE.LAST_PROVIDER, providerName);
      else localStorage.removeItem(STORAGE.LAST_PROVIDER);
    } catch { /* ignore */ }
    const targetModel = providerName
      ? getModels().find((m) => m.id === newModel && m.provider === providerName)
      : findModel(newModel);
    if (targetModel) setTokenUsage((prev) => ({ ...prev, max: targetModel.contextWindow > 0 ? targetModel.contextWindow : prev.max }));
  }, []);
  const [workspace, setWorkspace] = useState<string>("");
  const [workspaces, setWorkspacesState] = useState<string[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const setWorkspaces = useCallback((ws: string[]) => {
    setWorkspacesState(ws);
    setWorkspacesLoaded(true);
  }, []);
  const [currentGroupId, setCurrentGroupId] = useState<string | null>(null);
  const [, setLiveRelay] = useState<RelayData | null>(null);
  const [, setFocusRelayId] = useState<string | null>(null);
  const [, setDeletedRelayId] = useState<string | null>(null);
  const [hasRelay, setHasRelay] = useState(false);
  const [editMode, setEditMode] = useState<"auto" | "manual">(() => {
    try { return (localStorage.getItem(STORAGE.EDIT_MODE) as "auto" | "manual") || "manual"; } catch { return "manual"; }
  });
  // Quest 模式开关：思考过程 / 联网搜索（持久化）
  const [questThink, setQuestThinkState] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE.QUEST_THINK) === "1"; } catch { return false; }
  });
  const [questWebSearch, setQuestWebSearchState] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE.QUEST_WEBSEARCH) === "1"; } catch { return false; }
  });
  const setQuestThink = useCallback((v: boolean) => {
    setQuestThinkState(v);
    try { localStorage.setItem(STORAGE.QUEST_THINK, v ? "1" : "0"); } catch { /* ignore */ }
  }, []);
  const setQuestWebSearch = useCallback((v: boolean) => {
    setQuestWebSearchState(v);
    try { localStorage.setItem(STORAGE.QUEST_WEBSEARCH, v ? "1" : "0"); } catch { /* ignore */ }
  }, []);
  const [reasoning, setReasoning] = useState<string>("");
  const [statusText, setStatusText] = useState("思考中...");
  const [statusPhase, setStatusPhase] = useState<string>("thinking");
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactingMessage, setCompactingMessage] = useState<string | null>(null);
  const [compactionNeeded, setCompactionNeeded] = useState<{ currentTokens: number; maxTokens: number; percent: number } | null>(null);
  const [compactionMigrated, setCompactionMigrated] = useState<{ newSessionId: string; parentSessionId?: string } | null>(null);
  const compactionMigratedRef = useRef<{ newSessionId: string; parentSessionId?: string } | null>(null);
  compactionMigratedRef.current = compactionMigrated;
  /** Credits 预算门硬暂停触发时后端暂停等待用户选择（继续/停止） */
  const [creditBudgetPaused, setCreditBudgetPaused] = useState<{ spent: number; threshold: number } | null>(null);
  const [pendingPaths, setPendingPaths] = useState<string[]>([]);
  const [pendingDiffs, setPendingDiffs] = useState<Record<string, { oldContent: string; newContent: string }>>({});
  const [pendingExpanded, setPendingExpanded] = useState(false);
  /** 撤销失败的轻提示（自动消失） */
  const [undoNotice, setUndoNotice] = useState<{ id: number; text: string } | null>(null);
  const [toolConfirm, setToolConfirm] = useState<{ toolName: string; title: string; kind?: string } | null>(null);
  const [waitingInputIds, setWaitingInputIds] = useState<Set<string>>(new Set());
  const [commandApprovals, setCommandApprovals] = useState<Record<string, CommandApproval>>({});
  const [commandBlocked, setCommandBlocked] = useState<{ requestId?: string; command: string; reason: string; dangerous?: boolean } | null>(null);
  const [messageQueue, setMessageQueue] = useState<Array<{ id: string; payload: SubmitPayload }>>([]);

  // ── refs ───────────────────────────────────────────────────────────
  const cancelled = useRef(false);
  const cancelledTurnMsgId = useRef<string | null>(null);
  const turnStartTime = useRef<number>(0);
  const turnGeneration = useRef(0);
  const modelRef = useRef(model); modelRef.current = model;
  const statusPhaseRef = useRef(statusPhase); statusPhaseRef.current = statusPhase;
  const editModeRef = useRef(editMode); editModeRef.current = editMode;
  const toolResultResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reasoningParts = useRef<Map<string, string>>(new Map());
  const typewriter = useTypewriter();
  // ── tool_call 渲染队列 hook（卡片按序逐个入场） ──
  const toolCallQueueApi = useToolCallQueue();
  const commandApprovalsRef = useRef<Record<string, CommandApproval>>({}); commandApprovalsRef.current = commandApprovals;
  const onSessionCreatedRef = useRef(onSessionCreated); onSessionCreatedRef.current = onSessionCreated;
  const onCompactionMigratedRef = useRef(onCompactionMigrated); onCompactionMigratedRef.current = onCompactionMigrated;
  const ownedSessionId = useRef<string | null>(null);
  const lastLoadedSessionId = useRef<string | null>(null);
  const hasEverConnected = useRef(false);

  const MIN_LOADING_MS = 400;
  const finishLoading = useCallback(() => {
    const elapsed = Date.now() - (turnStartTime.current || Date.now());
    const remaining = Math.max(0, MIN_LOADING_MS - elapsed);
    if (remaining > 0) {
      setTimeout(() => setIsLoading(false), remaining);
    } else {
      setIsLoading(false);
    }
  }, []);

  /** 带本面板 clientId 的发送 */
  const send = useCallback((cmd: Record<string, unknown>) => {
    baseSend({ ...cmd, clientId });
  }, [baseSend, clientId]);

  useEffect(() => {
    const currentModel = models.find((m) => m.id === model);
    if (!currentModel?.contextWindow) return;
    setTokenUsage((prev) => (prev.max === currentModel.contextWindow ? prev : { ...prev, max: currentModel.contextWindow }));
  }, [model, models]);

  // ── 通知上层流式状态变化（供 SessionContainer 决定保活/卸载） ──
  useEffect(() => { onStreamingChange?.(isLoading); }, [isLoading, onStreamingChange]);

  // ── Agent 事件处理（稳定 handler，按 clientId 订阅） ────────────────────
  // ── 构建 EventHandlerCtx ──
  const ctx: EventHandlerCtx = {
    setChatHistory, setStatusText, setStatusPhase, setIsLoading,
    setIsLoadingSession, setTokenUsage, setReasoning, setWorkspace, setWorkspaces,
    setCurrentGroupId, setLiveRelay, setFocusRelayId, setDeletedRelayId, setHasRelay,
    setEditMode, setIsCompacting, setCompactingMessage, setCompactionNeeded, setCompactionMigrated,
    setCreditBudgetPaused,
    setPendingPaths, setPendingDiffs, setPendingExpanded, setUndoNotice,
    setToolConfirm, setWaitingInputIds, setCommandApprovals, setCommandBlocked,
    cancelled, cancelledTurnMsgId, turnGeneration,
    modelRef, statusPhaseRef, toolResultResetTimer,
    compactionMigratedRef, onSessionCreatedRef, onCompactionMigratedRef,
    ownedSessionId, reasoningParts,
    typewriter: {
      buffer: typewriter.buffer,
      raf: typewriter.raf,
      streamEnding: typewriter.streamEnding,
      start: typewriter.start,
      flush: typewriter.flush,
      cancel: typewriter.cancel,
      pause: typewriter.pause,
      reset: typewriter.reset,
    },
    clientId, send, finishLoading,
  };

  const handleEvent = useMemo(
    () => createEventHandler(ctx),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── tool_call 渲染队列包裹器 ──
  const queuedHandleEvent = useMemo(
    () => toolCallQueueApi.wrap(handleEvent, ctx),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handleEvent],
  );

  useSessionEvents(clientId, queuedHandleEvent);

  // ── 连接成功 / sessionId 变化时加载会话 ────────────────────────────────
  const prevConnectedRef = useRef(false);
  useEffect(() => {
    if (!connected) {
      prevConnectedRef.current = false;
      return;
    }
    const reconnected = hasEverConnected.current && !prevConnectedRef.current;
    prevConnectedRef.current = true;
    hasEverConnected.current = true;

    if (sessionId) {
      if (sessionId === ownedSessionId.current && !reconnected) {
        send({ type: CONTROL_CMD.SET_EDIT_MODE, mode: editModeRef.current });
        return;
      }
      if (sessionId === lastLoadedSessionId.current && !reconnected) {
        ownedSessionId.current = sessionId;
        send({ type: CONTROL_CMD.SET_EDIT_MODE, mode: editModeRef.current });
        return;
      }
      // 切到既有会话 / 重连：清空 UI、进入加载态、拉历史
      ownedSessionId.current = sessionId;
      lastLoadedSessionId.current = sessionId;
      setIsLoadingSession(true);
      setChatHistory([]);
      setIsLoading(false);
      setWorkspacesLoaded(false);  // 加载历史会话期间也重置，等后端返回工作区后再判断
      typewriter.cancel();
      send({ type: "load_session", sessionId });
    } else {
      ownedSessionId.current = null;
      lastLoadedSessionId.current = null;
      setChatHistory([]);
      setIsLoadingSession(false);
      setWorkspacesLoaded(false);  // 新开 session 时重置加载标志，等后端返回工作区列表后再判断
      send({ type: "reset_session" });
    }
    send({ type: CONTROL_CMD.SET_EDIT_MODE, mode: editModeRef.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, sessionId]);

  useEffect(() => {
    if (!workspace) return;
    let cancelledQuery = false;
    (async () => {
      try {
        const { relays } = await listRelays(workspace);
        const hasActive = relays.some((r) => r.phase !== "done");
        if (!cancelledQuery && hasActive) setHasRelay(true);
      } catch { /* 查询失败忽略 */ }
    })();
    return () => { cancelledQuery = true; };
  }, [workspace]);

  useEffect(() => {
    if (!connected && isLoading) {
      finishLoading();
      setStatusText("");
      setStatusPhase("");
      // 取消打字机（避免 RAF 空转 + streamEnding 残留）
      typewriter.cancel();
      setChatHistory((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant" && last.streaming) {
          updated[updated.length - 1] = { ...last, streaming: false };
        }
        return updated;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const consumingQueue = useRef(false);
  useEffect(() => {
    if (!isLoading && messageQueue.length > 0 && !consumingQueue.current) {
      consumingQueue.current = true;
      const [next, ...rest] = messageQueue;
      setMessageQueue(rest);
      setTimeout(() => {
        sendNow(next.payload);
        consumingQueue.current = false;
      }, 50);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, messageQueue]);

  // ── 发送动作 ────────────────────────────────────────────────────────

  const sendNow = useCallback((payload: SubmitPayload) => {
    const gen = ++turnGeneration.current;
    const userMessageId = `user-${Date.now()}`;
    cancelled.current = false;
    setChatHistory((prev) => [
      ...prev,
      {
        id: userMessageId,
        role: "user",
        timestamp: Date.now(),
        content: payload.userBubble.content,
        images: payload.userBubble.images && payload.userBubble.images.length > 0 ? [...payload.userBubble.images] : undefined,
        attachedFiles: payload.userBubble.attachedFiles && payload.userBubble.attachedFiles.length > 0 ? payload.userBubble.attachedFiles : undefined,
        userSegments: payload.userBubble.segments && payload.userBubble.segments.length > 0 ? payload.userBubble.segments : undefined,
        turnGen: gen,
      },
    ]);
    // 回退到 session 级的 providerState（来自 setModel）
    const finalProvider = payload.send.provider ?? providerState;
    console.log("[axon-send] provider 璺熻釜", {
      payloadProvider: payload.send.provider,
      sessionProviderState: providerState,
      finalProvider,
      model: payload.send.model,
    });
    send({ type: CONTROL_CMD.USER_MESSAGE, ...payload.send, clientMessageId: userMessageId, provider: finalProvider });
    setIsLoading(true);
    setReasoning(""); // 新一轮开始：清空上一轮残留的思考过程
    setStatusText("思考中...");
    setStatusPhase("thinking");
    turnStartTime.current = Date.now();
  }, [send, providerState]);

  const submit = useCallback((payload: SubmitPayload): boolean => {
    if (isLoading || isCompacting) {
      setMessageQueue((prev) => [...prev, { id: `q-${Date.now()}`, payload }]);
      return true;
    }
    sendNow(payload);
    return false;
  }, [isLoading, isCompacting, sendNow]);

  /**
   * 手动压缩上下文。带上当前选中的 model/provider——用户可能刚切换了模型选择器
   * 但还没发送消息，此时后端会话内部的 model/provider 仍是上一条消息用的旧值，
   * 需要显式同步，避免多 provider 同名模型场景下用错端点压缩。
   */
  const compactSession = useCallback(() => {
    send({ type: "compact_session", model, provider: providerState });
  }, [send, model, providerState]);

  /** 用户对压缩方式做出选择 */
  const chooseCompaction = useCallback((choice: "continue" | "new_session") => {
    send({ type: "compaction_choice", choice });
    setCompactionNeeded(null);
  }, [send]);

  /** 用户对 Credits 预算暂停做出选择（继续本轮任务 / 停止） */
  const chooseCreditBudget = useCallback((choice: "continue" | "stop") => {
    send({ type: "credit_budget_choice", choice });
    setCreditBudgetPaused(null);
  }, [send]);

  /** 导航到迁移目标新会话（父组件负责切 tab） */
  const navigateToMigratedSession = useCallback((newSessionId: string) => {
    const vscode = (window as any).__axonVSCode;
    if (vscode) vscode.postMessage({ type: "open_session", sessionId: newSessionId });
  }, []);

  /** 从队列中移除指定消息 */
  const removeFromQueue = useCallback((id: string) => {
    setMessageQueue((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const cancelTurn = useCallback((currentModel: string) => {
    if (isCompacting) return;
    send({ type: "cancel" });
    if (toolConfirm) {
      send({ type: "confirm_tool", confirmed: false });
      setToolConfirm(null);
    }
    // 取消时把所有未决命令授权按“拒绝”回传，避免后端 gate（含并发子 Agent）永久阻塞
    const pendingApprovals = commandApprovalsRef.current;
    if (Object.keys(pendingApprovals).length > 0) {
      for (const entry of Object.values(pendingApprovals)) {
        send({ type: "confirm_command", requestId: entry.requestId, choice: "reject" });
      }
      setCommandApprovals({});
    }
    cancelled.current = true;
    typewriter.cancel();
    setWaitingInputIds(new Set()); // 取消时清除所有呼吸灯
    setChatHistory((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last?.role === "assistant" && last.streaming) {
        cancelledTurnMsgId.current = last.id;
        const elapsed = turnStartTime.current ? Date.now() - turnStartTime.current : 0;
        const tokens = (last.segments || [])
          .filter((s): s is TextSegment => s.type === "text")
          .reduce((sum, s) => sum + s.content.length, 0);
        const estInputTokens = Math.round(tokenUsage.used * 0.7);
        const estOutputTokens = Math.round(tokens * 0.4);
        const cancelCredits = estInputTokens > 0 || estOutputTokens > 0
          ? Math.max(0.5, Math.round(((estInputTokens / 1000) * 0.14 + (estOutputTokens / 1000) * 0.44) * 100) / 100)
          : 0;
        const estSystemTokens = Math.min(estInputTokens, 10000); // 系统提示 + 工具定义最少也有几千 token
        const estQuestionTokens = Math.min(estInputTokens - estSystemTokens, last.content ? Math.round(last.content.length * 0.35) : 0);
        const cancelCreditDetail: CreditDetail = {
          inputTokens: estInputTokens,
          outputTokens: estOutputTokens,
          cachedInputTokens: 0,
          inputRate: 0.14,
          outputRate: 0.44,
          tier: "估算",
          memoryTokens: Math.max(0, estInputTokens - estSystemTokens - estQuestionTokens),
          systemTokens: estSystemTokens,
          questionTokens: estQuestionTokens,
        };
        const segments = (last.segments || []).map((seg) => {
          if (seg.type === "subagent" && seg.status === "running") {
            const inner = seg.inner.map((s) =>
              s.type === "tool" && s.status === "pending" ? { ...s, status: "error" as ToolStatus } : s);
            return { ...seg, status: "done" as const, innerStreaming: false, inner };
          }
          if (seg.type === "tool" && seg.status === "pending") {
            return { ...seg, status: "error" as ToolStatus };
          }
          return seg;
        });
        updated[updated.length - 1] = {
          ...last,
          segments,
          streaming: false,
          turnStatus: "cancelled",
          turnStats: { elapsed, tokens, credits: cancelCredits, model: currentModel, creditDetail: cancelCreditDetail },
        };
      }
      return updated;
    });
    finishLoading();
    setReasoning("");
  }, [send, toolConfirm, tokenUsage.used, finishLoading]);

  /** 切换编辑模式 */
  const toggleEditMode = useCallback(() => {
    const next = editMode === "manual" ? "auto" : "manual";
    setEditMode(next);
    send({ type: CONTROL_CMD.SET_EDIT_MODE, mode: next });
    try { localStorage.setItem(STORAGE.EDIT_MODE, next); } catch { /* ignore */ }
    if (next === "auto" && pendingPaths.length > 0) {
      send({ type: "accept_edits" });
    }
  }, [editMode, send, pendingPaths.length]);

  const acceptEdits = useCallback((path?: string) => send({ type: "accept_edits", path }), [send]);
  const rejectEdits = useCallback((path?: string) => send({ type: "reject_edits", path }), [send]);
  const undoEdits = useCallback((path: string) => send({ type: "undo_edits", path }), [send]);
  const editUserMessage = useCallback((messageId: string, content: string, images?: string[], attachedFiles?: AttachedFile[]) => {
    const userIndex = chatHistory.filter((msg) => msg.role === "user").findIndex((msg) => msg.id === messageId);
    setChatHistory((prev) => prev.map((msg) => (
      msg.role === "user" && msg.id === messageId
        ? { ...msg, content, images: images && images.length > 0 ? images : undefined, attachedFiles: attachedFiles && attachedFiles.length > 0 ? attachedFiles : undefined, userSegments: undefined }
        : msg
    )));
    send({ type: "edit_user_message", messageId, content, userIndex, images, attachedFiles: attachedFiles?.map((f) => ({ name: f.name, size: f.size })) });
  }, [send, chatHistory]);

  const confirmTool = useCallback((confirmed: boolean) => {
    setToolConfirm(null);
    send({ type: "confirm_tool", confirmed });
  }, [send]);

  const approveCommand = useCallback((toolCallId: string, decision: CommandDecision) => {
    const entry = commandApprovalsRef.current[toolCallId];
    if (!entry) return;
    send({ type: "confirm_command", requestId: entry.requestId, choice: decision.choice, pattern: decision.pattern, target: decision.target, editedCommand: decision.editedCommand });
    setCommandApprovals((m) => {
      const next = { ...m };
      delete next[toolCallId];
      return next;
    });
    if (decision.editedCommand) {
      setChatHistory((prev) => prev.map((msg) => {
        if (msg.role !== "assistant" || !msg.segments) return msg;
        let changed = false;
        const segments = msg.segments.map((seg) => {
          if (seg.type === "tool" && seg.id === toolCallId && seg.name === "execute_command") {
            changed = true;
            return { ...seg, command: decision.editedCommand };
          }
          return seg;
        });
        return changed ? { ...msg, segments } : msg;
      }));
    }
  }, [send]);

  const respondToDangerousCommand = useCallback((requestId: string, executeAnyway: boolean) => {
    setCommandBlocked(null);
    send({ type: "confirm_command", requestId, choice: executeAnyway ? "once" : "reject" });
  }, [send]);

  /** 单纯关闭危险提示（无 requestId 的旧版硬拦） */
  const dismissCommandBlocked = useCallback(() => setCommandBlocked(null), []);

  /** 选择模型：持久化 + 更新 token 上下文窗口 */
  const selectWorkspace = useCallback((path: string) => {
    setWorkspace(path);
    setWorkspaces([path]);
    setCurrentGroupId(null);
    send({ type: "set_workspace", workspace: path });
  }, [send]);

  const selectGroup = useCallback((group: { id: string; paths: string[] }) => {
    send({ type: "set_workspace_group", groupId: group.id });
    setWorkspace(group.paths[0]);
    setWorkspaces(group.paths);
    setCurrentGroupId(group.id);
  }, [send]);

  const groupUpdated = useCallback((group: { id: string; paths: string[] }) => {
    if (group.id !== currentGroupId) return;
    send({ type: "set_workspace_group", groupId: group.id });
    setWorkspace(group.paths[0]);
    setWorkspaces(group.paths);
  }, [send, currentGroupId]);

  return {
    // 状态
    chatHistory, isLoading, isLoadingSession,
    tokenUsage, reasoning, statusText,
    isCompacting, compactingMessage, compactSession, compactionNeeded, compactionMigrated, chooseCompaction, navigateToMigratedSession,
    creditBudgetPaused, chooseCreditBudget,
    pendingPaths, pendingDiffs, pendingExpanded, setPendingExpanded,
    messageQueue, toolConfirm,
    waitingInputIds,
    commandApprovals, commandBlocked,
    editMode, workspace, workspaces, workspacesLoaded, currentGroupId, hasRelay, model, provider: providerState,
    // 撤销轻提示
    undoNotice, setUndoNotice,
    // Quest
    mode, questThink, questWebSearch, setQuestThink, setQuestWebSearch,
    // 动作
    submit, removeFromQueue, cancelTurn,
    toggleEditMode, acceptEdits, rejectEdits, undoEdits, editUserMessage, confirmTool,
    approveCommand, dismissCommandBlocked, respondToDangerousCommand,
    setModel, selectWorkspace, selectGroup, groupUpdated,
    listSnapshots: () => send({ type: "list_snapshots" }),
    restoreSnapshot: (id: string) => send({ type: "restore_snapshot", snapshotId: id }),
  };
}
