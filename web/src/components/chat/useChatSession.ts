/**
 * useChatSession —— 会话控制器 hook（多会话版）
 *
 * 从原 ChatPanel.tsx 拆出：收纳一个面板（ChatPanel）的「会话与传输」全部状态与逻辑：
 * - 聊天历史、流式打字机、token 用量、思考过程、状态文案、待确认改动、消息队列、工具确认门、
 *   编辑模式、工作区、模型、Relay 呈现等会话状态。
 * - Agent 事件处理（handleEvent）：经 useSessionEvents 按 clientId 订阅本面板的事件流。
 * - 入站指令封装（submit / cancel / acceptEdits 等）：发送时自动带上本面板 clientId。
 *
 * ChatPanel 壳层只保留「输入区编排 + 视图 + 滚动/文件/图片/弹窗」，状态全部来自本 hook。
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { MODELS, findModel, useModels } from "@/components/ModelSelector";
import type { ToolStatus } from "@/components/ToolCallItem";
import { listRelays, type RelayData } from "@/lib/apiClient";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import type { AttachedFile, ChatMessage, CreditDetail, TextSegment, UserSegment } from "./types";
import type { CommandDecision } from "./commandApprovalContext";

// 拆分后的模块
import { createEventHandler } from "./eventHandlers";
import type { EventHandlerCtx } from "./eventHandlers/types";
import { useTypewriter } from "./useTypewriter";
import { useToolCallQueue } from "./useToolCallQueue";

const DEFAULT_MODEL_ID = "glm-4-flash";

/** 发送用户消息的载荷（由壳层根据输入/模型/附件计算后交给 hook） */
export interface SubmitPayload {
  /** 加入聊天时间线的用户气泡 */
  userBubble: { content: string; images?: string[]; attachedFiles?: AttachedFile[]; segments?: UserSegment[] };
  /** user_message 指令字段（type/clientId 由 hook 注入） */
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

/** 命令信任授权请求：未信任命令时后端弹出，含四档"加入白名单"选项 */
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

  // ── 会话状态 ──────────────────────────────────────────────────────────────
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingSession, setIsLoadingSession] = useState(!!sessionId);
  const [tokenUsage, setTokenUsage] = useState<{ used: number; max: number; cumulative: number }>(() => {
    let savedModel = DEFAULT_MODEL_ID;
    try { savedModel = localStorage.getItem("axon-last-model") || DEFAULT_MODEL_ID; } catch { /* ignore */ }
    const currentModel = findModel(savedModel) || MODELS.find((m) => m.id === savedModel);
    return { used: 0, max: currentModel?.contextWindow || 128000, cumulative: 0 };
  });
  const [model, setModelState] = useState(() => {
    try { return localStorage.getItem("axon-last-model") || DEFAULT_MODEL_ID; } catch { return DEFAULT_MODEL_ID; }
  });
  const [workspace, setWorkspace] = useState<string>("");
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [currentGroupId, setCurrentGroupId] = useState<string | null>(null);
  // Relay 呈现（仅 hasRelay 用于顶栏呼吸灯；其余保留以承接事件）
  const [, setLiveRelay] = useState<RelayData | null>(null);
  const [, setFocusRelayId] = useState<string | null>(null);
  const [, setDeletedRelayId] = useState<string | null>(null);
  const [hasRelay, setHasRelay] = useState(false);
  const [editMode, setEditMode] = useState<"auto" | "manual">(() => {
    try { return (localStorage.getItem("axon-edit-mode") as "auto" | "manual") || "manual"; } catch { return "manual"; }
  });
  // Quest 模式开关：思考过程 / 联网搜索（持久化）
  const [questThink, setQuestThinkState] = useState<boolean>(() => {
    try { return localStorage.getItem("axon-quest-think") === "1"; } catch { return false; }
  });
  const [questWebSearch, setQuestWebSearchState] = useState<boolean>(() => {
    try { return localStorage.getItem("axon-quest-websearch") === "1"; } catch { return false; }
  });
  const setQuestThink = useCallback((v: boolean) => {
    setQuestThinkState(v);
    try { localStorage.setItem("axon-quest-think", v ? "1" : "0"); } catch { /* ignore */ }
  }, []);
  const setQuestWebSearch = useCallback((v: boolean) => {
    setQuestWebSearchState(v);
    try { localStorage.setItem("axon-quest-websearch", v ? "1" : "0"); } catch { /* ignore */ }
  }, []);
  const [reasoning, setReasoning] = useState<string>("");
  const [statusText, setStatusText] = useState("思考中...");
  const [statusPhase, setStatusPhase] = useState<string>("thinking");
  const [isCompacting, setIsCompacting] = useState(false);
  /** 自动压缩触发时后端暂停等待用户选择（>=75% 阈值） */
  const [compactionNeeded, setCompactionNeeded] = useState<{ currentTokens: number; maxTokens: number; percent: number } | null>(null);
  /** 当前会话已被迁移到新会话（输入框禁用，展示跳转链接） */
  const [compactionMigrated, setCompactionMigrated] = useState<{ newSessionId: string; parentSessionId?: string } | null>(null);
  const compactionMigratedRef = useRef<{ newSessionId: string; parentSessionId?: string } | null>(null);
  compactionMigratedRef.current = compactionMigrated;
  const [pendingPaths, setPendingPaths] = useState<string[]>([]);
  const [pendingDiffs, setPendingDiffs] = useState<Record<string, { oldContent: string; newContent: string }>>({});
  const [pendingExpanded, setPendingExpanded] = useState(false);
  /** 撤销失败的轻提示（自动消失） */
  const [undoNotice, setUndoNotice] = useState<{ id: number; text: string } | null>(null);
  const [toolConfirm, setToolConfirm] = useState<{ toolName: string; title: string; kind?: string } | null>(null);
  // execute_command 卡片的"等待用户输入"呼吸灯：按 toolCallId 索引
  const [waitingInputIds, setWaitingInputIds] = useState<Set<string>>(new Set());
  // 命令信任授权门：未信任命令的审批改为内联在对应命令卡片上（无感模式），按 toolCallId 索引。
  // 并发安全——parallel_research / 多个子 Agent 可能同时请求，各自挂在自己的命令卡片上。
  const [commandApprovals, setCommandApprovals] = useState<Record<string, CommandApproval>>({});
  // 危险命令被硬拦时给用户的可见提示（与给 AI 的错误分开）
  const [commandBlocked, setCommandBlocked] = useState<{ requestId?: string; command: string; reason: string; dangerous?: boolean } | null>(null);
  const [messageQueue, setMessageQueue] = useState<Array<{ id: string; payload: SubmitPayload }>>([]);

  // ── refs ────────────────────────────────────────────────────────────────
  const cancelled = useRef(false);
  /** 被取消那轮 assistant 消息的 id——turn_cancelled 事件用此精确定位，
   *  避免竞态误将新启动的轮次标为 cancelled */
  const cancelledTurnMsgId = useRef<string | null>(null);
  const turnStartTime = useRef<number>(0);
  /** turn 代数计数器——每次 $sendNow$ 启动新轮时递增。所有 assistant 消息打上 turnGen，
   * 工具结果等异步事件只作用于同代 assistant，防止取消 A 后陈旧结果穿到 B。 */
  const turnGeneration = useRef(0);
  // 在稳定 handler 内读取最新值，避免把 handler 依赖这些 state（保持订阅稳定）
  const modelRef = useRef(model); modelRef.current = model;
  const statusPhaseRef = useRef(statusPhase); statusPhaseRef.current = statusPhase;
  const editModeRef = useRef(editMode); editModeRef.current = editMode;
  // tool_result 后延迟重置状态的定时器（防止连续工具调用时 "思考中" 闪烁）
  const toolResultResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ── 打字机 hook（buffer/RAF/flush 逻辑封装） ──
  const typewriter = useTypewriter();
  // ── tool_call 渲染队列 hook（卡片按序逐个入场） ──
  const toolCallQueueApi = useToolCallQueue();
  // 命令授权门请求用 ref 持有，供取消/回传时读取最新映射，避免回调依赖 state
  const commandApprovalsRef = useRef<Record<string, CommandApproval>>({}); commandApprovalsRef.current = commandApprovals;
  const onSessionCreatedRef = useRef(onSessionCreated); onSessionCreatedRef.current = onSessionCreated;
  const onCompactionMigratedRef = useRef(onCompactionMigrated); onCompactionMigratedRef.current = onCompactionMigrated;
  /**
   * 本面板已"拥有"（已加载或自己创建）的会话 id。
   * 用于区分 sessionId prop 变化的两种来源：
   * - 切到一个不同的既有会话（需要 load_session 拉历史）
   * - 自己刚创建的会话（session_created 把 tab.id 从 null 改成新 id）——此时本面板已持有实时状态，
   *   绝不能重新 load_session，否则会清空正在流式输出的对话。
   * 初始为 null：首次挂载若已有 sessionId（刷新/历史打开）仍会正常加载。
   */
  const ownedSessionId = useRef<string | null>(null);
  /**
   * 最近一次已请求 load_session 的会话 id。
   * 用来避免同一个 session 在前端重渲染/局部重挂载时重复触发 load_session，
   * 导致实时流式状态被 session_loaded 快照覆盖。
   */
  const lastLoadedSessionId = useRef<string | null>(null);
  /**
   * 标记当前这次 connected=true 是否真的是"断线后重连"。
   * 首次挂载不是重连；只有经历过 connected=false 之后再次变为 true 才算重连。
   */
  const hasEverConnected = useRef(false);

  /** 结束当前加载态（至少展示 MIN_LOADING_MS，避免极短响应让 spin 闪烁即消失） */
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

  // Provider/模型目录异步加载完成后，同步修正当前模型的最大上下文，
  // 避免重启初期先按静态兜底 MODELS（128K）显示，待用户再次手点模型才变正确。
  useEffect(() => {
    const currentModel = models.find((m) => m.id === model);
    if (!currentModel?.contextWindow) return;
    setTokenUsage((prev) => (prev.max === currentModel.contextWindow ? prev : { ...prev, max: currentModel.contextWindow }));
  }, [model, models]);

  // ── 通知上层流式状态变化（供 SessionContainer 决定保活/卸载） ──
  useEffect(() => { onStreamingChange?.(isLoading); }, [isLoading, onStreamingChange]);

  // ── Agent 事件处理（稳定 handler，按 clientId 订阅） ──────────────────────
  // ── 构建 EventHandlerCtx ──
  const ctx: EventHandlerCtx = {
    setChatHistory, setStatusText, setStatusPhase, setIsLoading,
    setIsLoadingSession, setTokenUsage, setReasoning, setWorkspace, setWorkspaces,
    setCurrentGroupId, setLiveRelay, setFocusRelayId, setDeletedRelayId, setHasRelay,
    setEditMode, setIsCompacting, setCompactionNeeded, setCompactionMigrated,
    setPendingPaths, setPendingDiffs, setPendingExpanded, setUndoNotice,
    setToolConfirm, setWaitingInputIds, setCommandApprovals, setCommandBlocked,
    cancelled, cancelledTurnMsgId, turnGeneration,
    modelRef, statusPhaseRef, toolResultResetTimer,
    compactionMigratedRef, onSessionCreatedRef, onCompactionMigratedRef,
    ownedSessionId,
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

  // ── 事件处理（稳定 handler，按 msg.type 路由到各 handler 模块） ──────────
  const handleEvent = useMemo(
    () => createEventHandler(ctx),
    // ctx 字段都是稳定引用（useState setter、useRef），不会变
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // ── tool_call 渲染队列包裹器 ──
  const queuedHandleEvent = useMemo(
    () => toolCallQueueApi.wrap(handleEvent, ctx),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handleEvent],
  );

  // 按 clientId 订阅本面板事件流
  useSessionEvents(clientId, queuedHandleEvent);

  // ── 连接成功 / sessionId 变化时加载会话 ─────────────────────────────────
  // reconnected：连接 false→true（含首次）。此时后端是全新 hub（无会话状态），
  // 即便本面板"拥有"该会话也必须重新 load_session 以重建后端状态。
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
      // 自己刚创建的会话且非重连：已持有实时状态，不重新加载（否则会清空流式输出）
      if (sessionId === ownedSessionId.current && !reconnected) {
        send({ type: "set_edit_mode", mode: editModeRef.current });
        return;
      }
      // 同一个会话在未断线重连时，避免因组件重渲染/局部重挂载再次 load_session，
      // 否则 session_loaded 会用较旧快照覆盖掉正在流式中的实时状态。
      if (sessionId === lastLoadedSessionId.current && !reconnected) {
        ownedSessionId.current = sessionId;
        send({ type: "set_edit_mode", mode: editModeRef.current });
        return;
      }
      // 切到既有会话 / 重连：清空 UI、进入加载态、拉历史
      ownedSessionId.current = sessionId;
      lastLoadedSessionId.current = sessionId;
      setIsLoadingSession(true);
      setChatHistory([]);
      setIsLoading(false);
      typewriter.cancel();
      send({ type: "load_session", sessionId });
    } else {
      ownedSessionId.current = null;
      lastLoadedSessionId.current = null;
      setChatHistory([]);
      setIsLoadingSession(false);
      send({ type: "reset_session" });
    }
    send({ type: "set_edit_mode", mode: editModeRef.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, sessionId]);

  // ── 工作区变化时查询未完成 Relay，点亮顶栏呼吸灯 ─────────────────────────
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

  // ── 连接断开时收尾 loading ───────────────────────────────────────────────
  useEffect(() => {
    if (!connected && isLoading) {
      finishLoading();
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

  // ── 队列消费：isLoading 变 false 且队列非空时取出第一条自动发送 ──────────
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

  // ── 发送动作 ──────────────────────────────────────────────────────────────

  /** 真正执行发送：追加用户气泡 + 发 user_message + 进入加载态 */
  const sendNow = useCallback((payload: SubmitPayload) => {
    // 递增代数，新一轮事件只作用于本代的 assistant 消息
    const gen = ++turnGeneration.current;
    // 清除取消标记——新一轮开始后，之前取消设的 flag 不应阻止新事件处理
    cancelled.current = false;
    setChatHistory((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        role: "user",
        timestamp: Date.now(),
        content: payload.userBubble.content,
        images: payload.userBubble.images && payload.userBubble.images.length > 0 ? [...payload.userBubble.images] : undefined,
        attachedFiles: payload.userBubble.attachedFiles && payload.userBubble.attachedFiles.length > 0 ? payload.userBubble.attachedFiles : undefined,
        userSegments: payload.userBubble.segments && payload.userBubble.segments.length > 0 ? payload.userBubble.segments : undefined,
        turnGen: gen,
      },
    ]);
    // 优先用 payload 里计算好的 provider（来自用户在模型选择器里的选择），
    // 回退到 session 级的 providerState（来自 setModel）。
    const finalProvider = payload.send.provider ?? providerState;
    console.log("[axon-send] provider 跟踪", {
      payloadProvider: payload.send.provider,
      sessionProviderState: providerState,
      finalProvider,
      model: payload.send.model,
    });
    send({ type: "user_message", ...payload.send, provider: finalProvider });
    setIsLoading(true);
    setReasoning(""); // 新一轮开始：清空上一轮残留的思考过程
    setStatusText("思考中...");
    setStatusPhase("thinking");
    turnStartTime.current = Date.now();
  }, [send]);

  /** 提交一条用户消息：AI 回复中或压缩中则排队，否则立即发送。返回是否已排队。 */
  const submit = useCallback((payload: SubmitPayload): boolean => {
    if (isLoading || isCompacting) {
      setMessageQueue((prev) => [...prev, { id: `q-${Date.now()}`, payload }]);
      return true;
    }
    sendNow(payload);
    return false;
  }, [isLoading, isCompacting, sendNow]);

  /** 手动压缩上下文 */
  const compactSession = useCallback(() => {
    send({ type: "compact_session" });
  }, [send]);

  /** 用户对压缩方式做出选择 */
  const chooseCompaction = useCallback((choice: "continue" | "new_session") => {
    send({ type: "compaction_choice", choice });
    setCompactionNeeded(null);
  }, [send]);

  /** 导航到迁移目标新会话（父组件负责切 tab） */
  const navigateToMigratedSession = useCallback((newSessionId: string) => {
    const vscode = (window as any).__axonVSCode;
    if (vscode) vscode.postMessage({ type: "open_session", sessionId: newSessionId });
  }, []);

  /** 从队列移除指定消息 */
  const removeFromQueue = useCallback((id: string) => {
    setMessageQueue((prev) => prev.filter((m) => m.id !== id));
  }, []);

  /** 取消当前轮次（model 用于估算 credits）。压缩进行中时忽略。 */
  const cancelTurn = useCallback((currentModel: string) => {
    if (isCompacting) return;
    send({ type: "cancel" });
    if (toolConfirm) {
      send({ type: "confirm_tool", confirmed: false });
      setToolConfirm(null);
    }
    // 取消时把所有未决命令授权按"拒绝"回传，避免后端 gate（含并发子 Agent）永久阻塞
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
    // 记录被取消的 assistant 消息 id，供 turn_cancelled 事件精确匹配
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
        // 乐观拆分：system/本次提问/记忆都有非零估算，不把全会话 token 全塞进"记忆"。
        // 真实值会在后端 turn_cancelled 事件到达时覆盖。
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
    send({ type: "set_edit_mode", mode: next });
    try { localStorage.setItem("axon-edit-mode", next); } catch { /* ignore */ }
    if (next === "auto" && pendingPaths.length > 0) {
      send({ type: "accept_edits" });
    }
  }, [editMode, send, pendingPaths.length]);

  const acceptEdits = useCallback((path?: string) => send({ type: "accept_edits", path }), [send]);
  const rejectEdits = useCallback((path?: string) => send({ type: "reject_edits", path }), [send]);
  const undoEdits = useCallback((path: string) => send({ type: "undo_edits", path }), [send]);

  const confirmTool = useCallback((confirmed: boolean) => {
    setToolConfirm(null);
    send({ type: "confirm_tool", confirmed });
  }, [send]);

  /** 回应命令授权门：把用户对某条命令的决策回传后端，并从待审批映射中移除 */
  const approveCommand = useCallback((toolCallId: string, decision: CommandDecision) => {
    const entry = commandApprovalsRef.current[toolCallId];
    if (!entry) return;
    send({ type: "confirm_command", requestId: entry.requestId, choice: decision.choice, pattern: decision.pattern, target: decision.target, editedCommand: decision.editedCommand });
    setCommandApprovals((m) => {
      const next = { ...m };
      delete next[toolCallId];
      return next;
    });
    // 用户编辑了命令：乐观更新对应卡片的展示命令，避免执行期间仍显示旧命令（等到 tool_result 才更新会有空窗）
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

  /** 关闭"危险命令被拦截"提示（拒绝），或仍要执行 */
  const respondToDangerousCommand = useCallback((requestId: string, executeAnyway: boolean) => {
    setCommandBlocked(null);
    send({ type: "confirm_command", requestId, choice: executeAnyway ? "once" : "reject" });
  }, [send]);

  /** 单纯关闭危险提示（无 requestId 的旧版硬拦） */
  const dismissCommandBlocked = useCallback(() => setCommandBlocked(null), []);

  /** 选择模型：持久化 + 更新 token 上下文窗口 */
  const [providerState, setProviderState] = useState<string | undefined>(() => {
    try { return localStorage.getItem("axon-last-provider") || undefined; } catch { return undefined; }
  });
  const setModel = useCallback((newModel: string, providerName?: string) => {
    setModelState(newModel);
    setProviderState(providerName);
    try {
      localStorage.setItem("axon-last-model", newModel);
      if (providerName) localStorage.setItem("axon-last-provider", providerName);
      else localStorage.removeItem("axon-last-provider");
    } catch { /* ignore */ }
    const targetModel = providerName
      ? getModels().find((m) => m.id === newModel && m.provider === providerName)
      : findModel(newModel);
    // Auto（contextWindow=0）或自定义未知窗口时不要把 max 写成 0，保留上一次的有效值；
    // 真实窗口会在收到后端 token_usage 事件后被校正为"实际选用模型"的窗口。
    if (targetModel) setTokenUsage((prev) => ({ ...prev, max: targetModel.contextWindow > 0 ? targetModel.contextWindow : prev.max }));
  }, []);

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
    isCompacting, compactSession, compactionNeeded, compactionMigrated, chooseCompaction, navigateToMigratedSession,
    pendingPaths, pendingDiffs, pendingExpanded, setPendingExpanded,
    messageQueue, toolConfirm,
    waitingInputIds,
    commandApprovals, commandBlocked,
    editMode, workspace, workspaces, currentGroupId, hasRelay, model, provider: providerState,
    // 撤销轻提示
    undoNotice, setUndoNotice,
    // Quest
    mode, questThink, questWebSearch, setQuestThink, setQuestWebSearch,
    // 动作
    submit, removeFromQueue, cancelTurn,
    toggleEditMode, acceptEdits, rejectEdits, undoEdits, confirmTool,
    approveCommand, dismissCommandBlocked, respondToDangerousCommand,
    setModel, selectWorkspace, selectGroup, groupUpdated,
    // 闪电回滚
    listSnapshots: () => send({ type: "list_snapshots" }),
    restoreSnapshot: (id: string) => send({ type: "restore_snapshot", snapshotId: id }),
  };
}
