
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { findModel, getModels, useModels, normalizeStoredModelId } from "@/components/ModelSelector";
import { shouldEnableThinking } from "./useModelEffort";
import { isToolInFlight, type ToolStatus } from "@/components/ToolCallItem";
import { listRelays, type RelayData } from "@/lib/apiClient";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { registerPathBadgeRoots } from "../MarkdownRenderer";
import type { AttachedFile, ChatMessage, CreditDetail, TextSegment, UserSegment } from "./types";
import type { CommandDecision } from "./commandApprovalContext";
import type { FormSpecData, FormSubmitData } from "./formTypes";
import { STORAGE, TIMEOUT, CONTROL_CMD } from "@/lib/constants";
// 拆分后的模块
// 鎷嗗垎鍚庣殑妯″潡
import { createEventHandler } from "./eventHandlers";
import type { EventHandlerCtx, MemoryVersion } from "./eventHandlers/types";
import type { TokenUsageState } from "./types";
import { sealReasoning } from "./reasoningPlacement";
import { useTypewriter } from "./useTypewriter";
import { useToolCallQueue } from "./useToolCallQueue";
import { markTurnEnd } from "@/lib/turnEndProbe";
import { normalizePermissionMode, type PermissionMode } from "@/lib/permissionModes";

/** 读取持久化的模型选择；无记录或旧的 "auto" 都视为未选择。 */
function readStoredModelId(): string {
  try {
    return normalizeStoredModelId(localStorage.getItem(STORAGE.LAST_MODEL)) || "";
  } catch {
    return "";
  }
}

/** 已发出、还没被模型看到的插话 */
export interface PendingSteer {
  id: string;
  payload: SubmitPayload;
}

export interface SubmitPayload {
  /** 加入聊天时间线的用户气泡 */
  userBubble: { content: string; images?: string[]; attachedFiles?: AttachedFile[]; segments?: UserSegment[]; effort?: string };
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
    /** 会话模式 */
    mode?: "agent" | "quest";
    /**
     * 是否请求模型思考（agent / quest 两种模式都生效）。
     * 关掉即不下发 thinking 参数、也不转发 reasoning——省钱省延迟，不只是不展示。
     */
    think?: boolean;
    /** Provider 配置并由用户选中的实际强度值（如 high / xhigh）；关闭时不传 */
    effort?: string;
    /** Quest 模式专属选项（联网搜索；思考开关已上移到 think） */
    quest?: { webSearch?: boolean };
    /** 用户设置的产物目录（绝对路径）；缺省表示用默认位置，由后端兜底解析 */
    artifactDir?: string;
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
  /** 会话分叉完成：父组件刷新会话列表并切到新会话 */
  onSessionForked?: (newSessionId: string, sourceId?: string) => void;
  onStreamingChange?: (streaming: boolean) => void;
}

export function useChatSession(opts: UseChatSessionOptions) {
  const { clientId, sessionId, mode, connected, send: baseSend, onSessionCreated, onCompactionMigrated, onSessionForked, onStreamingChange } = opts;
  const models = useModels();

  // ── 会话状态 ──────────────────────────────────────────────────────────
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingSession, setIsLoadingSession] = useState(!!sessionId);
  const [tokenUsage, setTokenUsage] = useState<TokenUsageState>(() => {
    const savedModel = readStoredModelId();
    const currentModel = findModel(savedModel);
    return { used: 0, max: currentModel?.contextWindow || TIMEOUT.DEFAULT_CONTEXT_WINDOW, cumulative: 0 };
  });
  const [model, setModelState] = useState(() => {
    return readStoredModelId();
  });
  const [providerState, setProviderState] = useState<string | undefined>(() => {
    try { return localStorage.getItem(STORAGE.LAST_PROVIDER) || undefined; } catch { return undefined; }
  });
  // 加载会话时随指令带上当前选中的模型：重启后后端恢复的会话在发第一条消息前没有模型，
  // 只能按兜底的 128k 窗口算占用和压缩线（加载指令放在依赖不含模型的 effect 里，故走 ref）
  const selectedModelRef = useRef({ model, provider: providerState });
  selectedModelRef.current = { model, provider: providerState };
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
    // 换模型：先用注册表的窗口占位，等后端下一次 token_usage 报出它认定的窗口；
    // 旧明细按旧模型的窗口算（压缩线也是），一并清掉，免得和新分母混在一起
    if (targetModel) setTokenUsage((prev) => ({ ...prev, max: targetModel.contextWindow > 0 ? targetModel.contextWindow : prev.max, maxFromBackend: false, breakdown: undefined }));
    baseSend({ type: CONTROL_CMD.SET_ACTIVE_PROVIDER, provider: providerName, clientId });
  }, [baseSend, clientId]);
  const [workspace, setWorkspace] = useState<string>("");
  const [workspaces, setWorkspacesState] = useState<string[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const setWorkspaces = useCallback((ws: string[]) => {
    setWorkspacesState(ws);
    setWorkspacesLoaded(true);
  }, []);

  // 把工作区根登记给路径徽章判定：徽章只对落在已知工作区根之下的路径渲染。
  // 走模块级集合而非 props/context —— 不产生 React 依赖，不会换掉 computeHtml 的身份，
  // 因此不会引发额外的全量 markdown 重解析（详见 MarkdownRenderer 里该集合的注释）。
  useEffect(() => {
    registerPathBadgeRoots(workspaces);
  }, [workspaces]);
  const [currentGroupId, setCurrentGroupId] = useState<string | null>(null);
  const [, setLiveRelay] = useState<RelayData | null>(null);
  const [, setFocusRelayId] = useState<string | null>(null);
  const [, setDeletedRelayId] = useState<string | null>(null);
  const [hasRelay, setHasRelay] = useState(false);
  const [editMode, setEditMode] = useState<"auto" | "manual">(() => {
    try { return (localStorage.getItem(STORAGE.EDIT_MODE) as "auto" | "manual") || "auto"; } catch { return "auto"; }
  });
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => {
    try { return normalizePermissionMode(localStorage.getItem(STORAGE.PERMISSION_MODE)); } catch { return "safe"; }
  });
  /** 思考强度默认关闭；切换模型时由 ChatPanel 主动重置。 */
  const [effort, setEffort] = useState<string | null>(null);
  /** 没配置强度档位但声明支持思考时仍开启，由后端选择默认强度。 */
  const selectedModel = models.find((m) => m.id === model && (!providerState || m.provider === providerState));
  const think = shouldEnableThinking(selectedModel, effort);
  // Quest 模式：联网搜索开关（持久化）
  const [questWebSearch, setQuestWebSearchState] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE.QUEST_WEBSEARCH) === "1"; } catch { return false; }
  });
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
  const [creditBudgetPaused, setCreditBudgetPaused] = useState<{ spent: number; threshold: number; usage?: string } | null>(null);
  const [pendingPaths, setPendingPaths] = useState<string[]>([]);
  const [pendingDiffs, setPendingDiffs] = useState<Record<string, { oldContent: string; newContent: string }>>({});
  const [pendingExpanded, setPendingExpanded] = useState(false);
  /** 撤销失败的轻提示（自动消失） */
  const [undoNotice, setUndoNotice] = useState<{ id: number; text: string } | null>(null);
  const [toolConfirm, setToolConfirm] = useState<{ toolName: string; title: string; kind?: string } | null>(null);
  const [waitingInputIds, setWaitingInputIds] = useState<Set<string>>(new Set());
  // ask_form 表单请求（Agent 交付一张声明式表单，等用户填写提交）。结构对齐 eventHandlers 的 FormRequest。
  const [formRequest, setFormRequest] = useState<{ toolCallId: string; spec: FormSpecData } | null>(null);
  // 会话记忆（Markdown）：模型调 update_memory 或用户导入后，由 session_memory 事件推来。
  // 它不进消息历史（在 core 侧就是分开存的），这里只用于展示与导入/导出。
  const [memory, setMemory] = useState<string>("");
  // 记忆的历史版本（新的在前）：记忆面板打开「历史版本」时才请求
  const [memoryHistory, setMemoryHistory] = useState<MemoryVersion[]>([]);
  // ask_user 问答请求（Agent 抛问题 + 选项，等用户作答）。结构对齐 eventHandlers 的 AskUserRequest。
  const [askUser, setAskUser] = useState<{ toolCallId: string; questions: { question: string; options: { id: string; label: string; description?: string }[]; multi: boolean; allowOther: boolean }[] } | null>(null);
  const [commandApprovals, setCommandApprovals] = useState<Record<string, CommandApproval>>({});
  const [commandRiskNotice, setCommandRiskNotice] = useState<{ id?: string; command: string; reason: string } | null>(null);
  const [contextOverflow, setContextOverflow] = useState(false);
  const [toolHistoryMismatch, setToolHistoryMismatch] = useState<{ model: string } | null>(null);
  const [messageQueue, setMessageQueue] = useState<Array<{ id: string; payload: SubmitPayload }>>([]);
  /**
   * 插话：回复进行中发出的消息。已经发给后端，等模型下一次请求时插进对话（steer_absorbed），
   * 或者这一轮结束后被拿去开新一轮（steer_turn）。在那之前显示在输入框上方，可以撤回。
   */
  const [pendingSteers, setPendingSteers] = useState<PendingSteer[]>([]);
  // 事件处理器是稳定闭包，读最新的待发插话要走 ref
  const pendingSteersRef = useRef<PendingSteer[]>([]);
  useEffect(() => { pendingSteersRef.current = pendingSteers; }, [pendingSteers]);

  // ── refs ───────────────────────────────────────────────────────────
  const cancelled = useRef(false);
  const cancelledTurnMsgId = useRef<string | null>(null);
  const cancelledTurnGeneration = useRef<number | null>(null);
  const turnStartTime = useRef<number>(0);
  /** 当前任务开始时间：state 用于让首个“思考中...”占位头部立刻重渲染并开始计时 */
  const [turnStartedAt, setTurnStartedAt] = useState(0);
  const turnGeneration = useRef(0);
  const modelRef = useRef(model); modelRef.current = model;
  const statusPhaseRef = useRef(statusPhase); statusPhaseRef.current = statusPhase;
  const editModeRef = useRef(editMode); editModeRef.current = editMode;
  const permissionModeRef = useRef(permissionMode); permissionModeRef.current = permissionMode;
  const toolResultResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typewriter = useTypewriter();
  // ── tool_call 渲染队列 hook（卡片按序逐个入场） ──
  const toolCallQueueApi = useToolCallQueue();
  const commandApprovalsRef = useRef<Record<string, CommandApproval>>({}); commandApprovalsRef.current = commandApprovals;
  const onSessionCreatedRef = useRef(onSessionCreated); onSessionCreatedRef.current = onSessionCreated;
  const onCompactionMigratedRef = useRef(onCompactionMigrated); onCompactionMigratedRef.current = onCompactionMigrated;
  const onSessionForkedRef = useRef(onSessionForked); onSessionForkedRef.current = onSessionForked;
  const ownedSessionId = useRef<string | null>(null);
  const lastLoadedSessionId = useRef<string | null>(null);
  const hasEverConnected = useRef(false);

  const MIN_LOADING_MS = 400;
  /**
   * 本轮用户消息 id（sendNow 时写入）。与 user_message 一并发给后端，
   * 后端在收尾事件里原样带回同一个值，供前端精确归属"这条终态属于哪一轮"。
   */
  const currentTurnClientMessageId = useRef<string | null>(null);
  const finishLoading = useCallback(() => {
    const elapsed = Date.now() - (turnStartTime.current || Date.now());
    const remaining = Math.max(0, MIN_LOADING_MS - elapsed);
    if (remaining > 0) {
      // ⚠️ 这个延迟置 false 必须绑定「它属于哪一轮」，否则会让排队的两轮并发。
      //
      // isLoading 是排队出队的唯一闸门：consumingQueue 在本轮开跑时就被释放了，
      // 此后只剩 isLoading 挡着下一条排队消息。所以只要有一个"上一轮遗留的收尾定时器"
      // 在新一轮已经开跑之后落地，isLoading 就会被误置成 false，
      // 出队 effect 立刻放行 —— 下一条排队消息被发出去，两轮并发。
      //
      // 而它会成对出现：一轮的结束事件不止一个（stream_end 之后的 turn_cancelled / error
      // 等都会调 finishLoading），每次各排一个定时器，而它们算出的 remaining 都基于同一个
      // turnStartTime，于是在同一时刻一起到期：第一个收掉 loading、队列放行、新一轮开跑，
      // 第二个紧接着又把新开那一轮的 loading 收掉。
      //
      // 守卫：只有"发起它的那一轮仍是当前轮"时才真正收 loading（turnStartTime 变了即作废）。
      const ownerTurnStart = turnStartTime.current;
      setTimeout(() => {
        if (turnStartTime.current !== ownerTurnStart) return;
        setIsLoading(false);
      }, remaining);
    } else {
      setIsLoading(false);
    }
  }, []);

  /** 带本面板 clientId 的发送 */
  const send = useCallback((cmd: Record<string, unknown>) => {
    baseSend({ ...cmd, clientId });
  }, [baseSend, clientId]);

  /**
   * 保存 / 导入会话记忆。
   * · 编辑后保存：带上开始编辑时的 base，后台期间改过记忆时 core 做三方合并
   * · 导入（mode=merge）：合并进当前记忆，不整份替换
   * 不在本地乐观写入：合并结果以 core 回推的 session_memory 为准。
   */
  const saveMemory = useCallback((content: string, opts: { base?: string; mode?: "replace" | "merge" } = {}) => {
    send({ type: "set_memory", memory: content, ...(opts.base !== undefined ? { base: opts.base } : {}), ...(opts.mode ? { mode: opts.mode } : {}) });
  }, [send]);
  const requestMemoryHistory = useCallback(() => send({ type: "get_memory_history" }), [send]);
  const restoreMemoryVersion = useCallback((at: number) => send({ type: "restore_memory_version", at }), [send]);

  // 面板首次连接或恢复时也同步当前选择，避免状态栏继续停留在上一个 Provider。
  useEffect(() => {
    if (!connected) return;
    send({ type: CONTROL_CMD.SET_ACTIVE_PROVIDER, provider: providerState });
  }, [connected, providerState, send]);

  useEffect(() => {
    const currentModel = models.find((m) => m.id === model);
    if (!currentModel?.contextWindow) return;
    // 只在后端还没报过窗口时占位：模型列表刷新不能把后端的窗口冲掉
    setTokenUsage((prev) => (prev.maxFromBackend || prev.max === currentModel.contextWindow ? prev : { ...prev, max: currentModel.contextWindow }));
  }, [model, models]);

  // ── 通知上层流式状态变化（供 SessionContainer 决定保活/卸载） ──
  // 回调走 ref：上层是内联箭头函数，身份每次渲染都变。若把它放进依赖，上层在回调里 setState
  // → 重渲染 → 新回调 → effect 重跑 → 再 setState……形成死循环（React #185）。只在 isLoading 真变时通知。
  const onStreamingChangeRef = useRef(onStreamingChange);
  onStreamingChangeRef.current = onStreamingChange;
  useEffect(() => { onStreamingChangeRef.current?.(isLoading); }, [isLoading]);

  // ── Agent 事件处理（稳定 handler，按 clientId 订阅） ────────────────────
  // ── 构建 EventHandlerCtx ──
  const ctx: EventHandlerCtx = {
    setChatHistory, setStatusText, setStatusPhase, setIsLoading,
    setIsLoadingSession, setTokenUsage, setReasoning, setWorkspace, setWorkspaces,
    setCurrentGroupId, setLiveRelay, setFocusRelayId, setDeletedRelayId, setHasRelay,
    setEditMode, setIsCompacting, setCompactingMessage, setCompactionNeeded, setCompactionMigrated,
    setCreditBudgetPaused,
    setPendingPaths, setPendingDiffs, setPendingExpanded, setUndoNotice,
    setToolConfirm, setWaitingInputIds, setCommandApprovals, setCommandRiskNotice,
    setAskUser,
    setFormRequest,
    setMemory,
    setMemoryHistory,
    setContextOverflow, setToolHistoryMismatch, setTurnStartedAt,
    pendingSteersRef, setPendingSteers,
    cancelled, cancelledTurnMsgId, cancelledTurnGeneration, turnGeneration,
    turnStartTime,
    modelRef, statusPhaseRef, toolResultResetTimer,
    compactionMigratedRef, onSessionCreatedRef, onCompactionMigratedRef,
    onSessionForkedRef,
    ownedSessionId,
    typewriter,
    clientId, send, finishLoading,
    currentTurnClientMessageId,
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
  /** 把本面板的编辑模式、权限模式告诉后端（后端按面板记住，会话建好时回填） */
  const syncModes = () => {
    send({ type: CONTROL_CMD.SET_EDIT_MODE, mode: editModeRef.current });
    send({ type: CONTROL_CMD.SET_PERMISSION_MODE, mode: permissionModeRef.current });
  };
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
        syncModes();
        return;
      }
      if (sessionId === lastLoadedSessionId.current && !reconnected) {
        ownedSessionId.current = sessionId;
        syncModes();
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
      send({ type: "load_session", sessionId, ...selectedModelRef.current });
    } else {
      ownedSessionId.current = null;
      lastLoadedSessionId.current = null;
      setChatHistory([]);
      setIsLoadingSession(false);
      setWorkspacesLoaded(false);  // 新开 session 时重置加载标志，等后端返回工作区列表后再判断
      send({ type: "reset_session" });
    }
    syncModes();
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
          // 断线收尾：思考段一并封口，否则重连后思考块仍显示转圈、拿不到耗时
          const sealed = sealReasoning(last.segments || []);
          updated[updated.length - 1] = { ...last, streaming: false, ...(sealed ? { segments: sealed } : {}) };
        }
        return updated;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  /**
   * 排队消息的"在途锁"。
   *
   * 旧写法是发完 `sendNow()` 就立刻把锁复位，而放行条件看的 `isLoading` 要等后端首条流事件
   * 回来才变 true —— 于是"已发出、还没开跑"这段窗口里没有任何互斥保护。窗口内只要 effect
   * 重跑一次（messageQueue 变更 / connected 抖动 / isLoading 抖动），条件重新成立，
   * **下一条排队消息也会被发出去**，同一会话并发两轮；两轮的 stream_delta 又会被追加进
   * 同一个文本段，表现为输出"串段"。
   *
   * 现在锁只在两种情况下释放：
   *   ① 观察到 isLoading 变 true（这一轮真的开跑了）→ 交给"它结束后再发下一条"的正常流程；
   *   ② 兜底超时（后端异常没回任何事件，避免队列永久卡死）。
   */
  const consumingQueue = useRef(false);
  const queueUnlockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * "放行延迟"定时器的句柄。
   *
   * ⚠️ 它**绝不能**挂在下面消费 effect 的 cleanup 上，原因见那里。这里只做卸载时清理。
   */
  const queueSendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 唯一该取消在途定时器的时机：面板真的卸载了
  useEffect(() => {
    return () => {
      if (queueSendTimer.current) {
        clearTimeout(queueSendTimer.current);
        queueSendTimer.current = null;
      }
      if (queueUnlockTimer.current) {
        clearTimeout(queueUnlockTimer.current);
        queueUnlockTimer.current = null;
      }
    };
  }, []);

  // 锁定解除：一旦观察到本轮真的开跑，就允许"结束后"再发下一条
  useEffect(() => {
    if (isLoading) {
      consumingQueue.current = false;
      if (queueUnlockTimer.current) {
        clearTimeout(queueUnlockTimer.current);
        queueUnlockTimer.current = null;
      }
    }
  }, [isLoading]);

  useEffect(() => {
    // 连接不可用时绝不放行：此时 isLoading 可能是被断线逻辑清掉的，不代表本轮已结束
    if (isLoading || !connected) return;
    if (messageQueue.length === 0 || consumingQueue.current) return;

    consumingQueue.current = true;
    const [next, ...rest] = messageQueue;
    setMessageQueue(rest);
    // ⚠️ 这里**不能**返回 cleanup 去 clearTimeout。
    // 本 effect 的依赖里有 messageQueue，而上一行 setMessageQueue 会立刻换掉它的引用，
    // 于是 effect 马上重跑一遍：React 会先执行上一次的 cleanup——那个 clearTimeout 恰好把
    // 还没到期的定时器掐掉，紧接着新一轮又因 consumingQueue 已置位而直接 return。
    // 结果就是消息从队列 UI 里消失了、却从来没被发出去（"排队信息丢失、发不出去"）。
    // 生命周期清理改由上面那个「仅卸载时执行」的 effect 负责。
    queueSendTimer.current = setTimeout(() => {
      queueSendTimer.current = null;
      sendNow(next.payload);
      // 兜底解锁：正常情况下上面那个 isLoading effect 会解锁；这里只防"后端一个事件都没回"
      queueUnlockTimer.current = setTimeout(() => {
        consumingQueue.current = false;
        queueUnlockTimer.current = null;
      }, 15_000);
    }, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, connected, messageQueue]);

  // ── 发送动作 ────────────────────────────────────────────────────────

  const sendNow = useCallback((payload: SubmitPayload) => {
    // 上一段回复还在打字收尾时就发了下一句：先把它结清，再开新一轮
    typewriter.settle({ setChatHistory, finishLoading });
    const gen = ++turnGeneration.current;
    const userMessageId = `user-${Date.now()}`;
    currentTurnClientMessageId.current = userMessageId;
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
        effort: payload.userBubble.effort,
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
    const startedAt = Date.now();
    turnStartTime.current = startedAt;
    setTurnStartedAt(startedAt);
  }, [send, providerState]);

  /**
   * 发消息。回复进行中不再排队等这一轮结束，而是「插话」：立刻发给后端，模型下一步就能看到，
   * 手上的动作照常继续。只有压缩进行中（会话正在被改写）才排队。
   */
  const submit = useCallback((payload: SubmitPayload): boolean => {
    if (isCompacting) {
      setMessageQueue((prev) => [...prev, { id: `q-${Date.now()}`, payload }]);
      return true;
    }
    if (isLoading) {
      const id = `user-${Date.now()}`;
      setPendingSteers((prev) => [...prev, { id, payload }]);
      const finalProvider = payload.send.provider ?? providerState;
      send({ type: "steer_message", ...payload.send, clientMessageId: id, provider: finalProvider });
      return true;
    }
    sendNow(payload);
    return false;
  }, [isLoading, isCompacting, sendNow, send, providerState]);

  /** 撤回还没被模型看到的插话 */
  const cancelSteer = useCallback((id: string) => {
    send({ type: "steer_cancel", clientMessageId: id });
  }, [send]);

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
    // ⚠️ 临时诊断：记录取消后收尾窗口内的布局变化（定位偶发闪烁后删除）
    markTurnEnd("取消");
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
    // 守卫在这里**同步**装配，不能只放在下面的 setChatHistory updater 里：
    // updater 要等渲染阶段才执行，而 turn_cancelled 是 WebSocket 上来的，可能在这次渲染之前就到
    // —— 那个窗口里 cancelledTurnGeneration 还是 null，handleTurnCancelled 的判据不成立。
    // 而且原来它只在"最后一条是 streaming 的 assistant"时才装配；取消发生在还没建出
    // assistant 消息的时刻（如工具轮中、首字之前）就会漏装。标记的语义是"用户取消了当前这一轮"，
    // 与最后一条消息是什么无关。
    cancelledTurnGeneration.current = turnGeneration.current;
    // 先把已到达、还没出字的残余写进当前消息，再停循环。
    // 早先只 cancel()，缓冲里的字被直接丢弃；而后端取消时会把本轮已流式发出的正文完整落盘
    // （streamedContentThisRound），于是刷新后这条消息比取消时看到的多出一截。
    // 错误收尾（finalizeStreamingTurnAsError）一直是 flush 再 cancel，这里对齐。
    // flush 的 updater 排在下面收尾 updater 之前执行，所以统计的字数也包含这段残余。
    typewriter.flush({ setChatHistory, finishLoading });
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
              s.type === "tool" && isToolInFlight(s.status) ? { ...s, status: "error" as ToolStatus } : s);
            return { ...seg, status: "done" as const, innerStreaming: false, inner };
          }
          // 排队中的卡片同样要收掉：用户取消后它们永远不会再被执行
          if (seg.type === "tool" && isToolInFlight(seg.status)) {
            return { ...seg, status: "error" as ToolStatus };
          }
          return seg;
        });
        updated[updated.length - 1] = {
          ...last,
          // 取消收尾：思考段一并封口（否则取消后思考块仍转圈、不显示耗时）
          segments: sealReasoning(segments) ?? segments,
          streaming: false,
          turnStatus: "cancelled",
          turnStats: { elapsed, tokens, credits: cancelCredits, model: currentModel, creditDetail: cancelCreditDetail },
        };
      }
      return updated;
    });
    finishLoading();
    setReasoning("");
  // typewriter 不进依赖：useTypewriter 每次渲染返回新的字面量对象（方法本身是稳定的 useCallback），
  // 写进来会让 cancelTurn 每次渲染都重建。本文件其余回调对 typewriter 也是同样处理。
  }, [send, toolConfirm, tokenUsage.used, finishLoading]);

  /** 设置权限模式（安全 / 自动 / 完全访问），本机记住，连接 / 切会话时重发 */
  const setPermissionModePreference = useCallback((next: PermissionMode) => {
    setPermissionMode(next);
    send({ type: CONTROL_CMD.SET_PERMISSION_MODE, mode: next });
    try { localStorage.setItem(STORAGE.PERMISSION_MODE, next); } catch { /* ignore */ }
  }, [send]);

  /** 设置编辑模式；无本地记录的首次使用默认自动应用。 */
  const setEditModePreference = useCallback((next: "auto" | "manual") => {
    if (next === editMode) return;
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
    // 序号只数还在上下文里的用户消息（压缩存档里的不算），与后端口径一致
    const userIndex = chatHistory.filter((msg) => msg.role === "user" && !msg.archived).findIndex((msg) => msg.id === messageId);
    setChatHistory((prev) => prev.map((msg) => (
      msg.role === "user" && msg.id === messageId
        ? { ...msg, content, images: images && images.length > 0 ? images : undefined, attachedFiles: attachedFiles && attachedFiles.length > 0 ? attachedFiles : undefined, userSegments: undefined }
        : msg
    )));
    send({ type: "edit_user_message", messageId, content, userIndex, images, attachedFiles: attachedFiles?.map((f) => ({ name: f.name, size: f.size })) });
  }, [send, chatHistory]);

  /**
   * 从某条 AI 回复分叉：新会话带上「截至这一轮为止」的完整历史前缀。
   *
   * 锚点必须传「这一轮从哪条用户消息开始」，而不是被点的那条 assistant 消息 ——
   * 落盘的 assistant 消息没有 id，后端无从按 id 定位；而前端一条 assistant 气泡
   * 本来就覆盖后端一串消息（assistant + tool_calls + 工具结果 + 收尾正文），
   * 用回合起点定位，两端才在同一个口径上。
   *
   * 两个字段一起发：
   * · upToMessageId = 锚点气泡的 id（就是发给后端的 clientMessageId）；
   * · upToUserIndex = 锚点是历史里第几条用户消息 —— 老会话 / 压缩摘要出来的用户消息
   *   没有 clientMessageId（前端只能给 `hist-u-N` 这种临时 id），后端查不到 id 时按它兜底。
   *   口径与 editUserMessage 的 userIndex 一致：只数用户消息，跳过系统提示等非用户条目。
   */
  // 历史通过 ref 读：MessageBubble 是 memo 且比较函数不看回调身份，
  // 老消息不会因为 chatHistory 变化而重渲染，闭包里捕获的 chatHistory 会是旧的。
  // 前缀在这些场景下可能被压缩/编辑改写过，用旧快照算序号就可能算错。
  const chatHistoryRef = useRef(chatHistory);
  chatHistoryRef.current = chatHistory;
  const forkFromMessage = useCallback((message: ChatMessage) => {
    // 还没有会话 id（首轮刚发出、后端尚未回 session_created）就没有可截断的落盘历史
    if (!sessionId) return;
    const history = chatHistoryRef.current;
    const clickedIdx = history.findIndex((m) => m.id === message.id);
    if (clickedIdx < 0) return;
    // 往回找这一轮的起点用户消息；找不到（极端情况下历史以 assistant 开头）就不发请求，
    // 免得让用户得到一个「以为带了历史、实际只有记忆」的会话
    let anchorIdx = -1;
    for (let i = clickedIdx; i >= 0; i--) {
      if (history[i].role === "user") { anchorIdx = i; break; }
    }
    // 压缩存档里的消息已不在上下文里，无从按它截断
    if (anchorIdx < 0 || history[anchorIdx].archived) return;
    const anchorId = history[anchorIdx].id;
    let upToUserIndex = 0;
    for (let i = 0; i < anchorIdx; i++) {
      if (history[i].role === "user" && !history[i].archived) upToUserIndex++;
    }
    // `hist-u-N` 是会话加载时为「没有 clientMessageId 的历史用户消息」临时生成的 id
    // （老会话 / 压缩摘要出来的用户消息），后端不可能匹配到，只发序号。
    // 反过来，有真实 id 时就不发序号：id 查不到说明这条消息已经被压缩掉了，
    // 这时候让后端明确报错，比按一个可能已经错位的序号截出一段牛头不对马嘴的历史好。
    const hasRealId = !anchorId.startsWith("hist-u-");
    send({
      type: CONTROL_CMD.FORK_SESSION,
      sessionId,
      ...(hasRealId ? { upToMessageId: anchorId } : { upToUserIndex }),
    });
  }, [send, sessionId]);

  const answerUserQuestion = useCallback((answers: { selected: string[]; other?: string; skipped?: boolean }[]) => {
    const req = askUser;
    setAskUser(null);
    if (req) {
      send({ type: "answer_user_question", toolCallId: req.toolCallId, answers });
    }
  }, [send, askUser]);

  /**
   * 提交表单：把当前全部字段值与触发的动作回传后端，挂起中的 agent loop 随即继续。
   * 卡片立刻收起（与问答卡片同一处理）——表单的"已提交"态由内联面板自己维护，
   * 阻塞式这张留着只会占位置，用户已经看得见 AI 接着往下做了。
   */
  const submitForm = useCallback((payload: FormSubmitData) => {
    const req = formRequest;
    setFormRequest(null);
    if (req) {
      send({
        type: "submit_form",
        toolCallId: req.toolCallId,
        action: payload.action,
        values: payload.values,
        selectedRows: payload.selectedRows,
      });
    }
  }, [send, formRequest]);

  const confirmTool = useCallback((confirmed: boolean, options?: { mode?: "strict" | "auto" }) => {
    setToolConfirm(null);
    send({ type: "confirm_tool", confirmed, ...options });
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

  /** 关闭命令风险提醒（提醒不需要应答，命令已执行） */
  const dismissCommandRiskNotice = useCallback(() => setCommandRiskNotice(null), []);

  /** 关闭上下文超限提示条 */
  const dismissContextOverflow = useCallback(() => setContextOverflow(false), []);

  /** 强制压缩上下文（不检查阈值，用于上下文超限场景） */
  const forceCompact = useCallback(() => {
    setContextOverflow(false);
    send({ type: "force_compact_session", model, provider: providerState });
  }, [send, model, providerState]);

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
    tokenUsage, reasoning, statusText, statusPhase,
    turnStartTime: turnStartedAt,
    isCompacting, compactingMessage, compactSession, compactionNeeded, compactionMigrated, chooseCompaction, navigateToMigratedSession,
    creditBudgetPaused, chooseCreditBudget,
    pendingPaths, pendingDiffs, pendingExpanded, setPendingExpanded,
    messageQueue, toolConfirm,
    askUser,
    formRequest,
    memory,
    memoryHistory,
    waitingInputIds,
    commandApprovals, commandRiskNotice, setCommandRiskNotice,
    contextOverflow, dismissContextOverflow, forceCompact,
    toolHistoryMismatch,
    flattenToolHistory: () => { setToolHistoryMismatch(null); send({ type: CONTROL_CMD.FLATTEN_TOOL_HISTORY }); },
    dismissToolHistoryMismatch: () => setToolHistoryMismatch(null),
    editMode, workspace, workspaces, workspacesLoaded, currentGroupId, hasRelay, model, provider: providerState,
    // 撤销轻提示
    undoNotice, setUndoNotice,
    // 思考开关（agent / quest 通用）+ Quest 专属联网开关
    mode, think, effort, setEffort, questWebSearch, setQuestWebSearch,
    // 动作
    submit, removeFromQueue, cancelTurn,
    pendingSteers, cancelSteer,
    setEditModePreference, permissionMode, setPermissionModePreference, acceptEdits, rejectEdits, undoEdits, editUserMessage, confirmTool,
    /** 从某条 AI 回复分叉：新会话带截至那一轮为止的历史前缀 */
    forkFromMessage,
    answerUserQuestion,
    submitForm,
    saveMemory,
    requestMemoryHistory,
    restoreMemoryVersion,
    approveCommand, dismissCommandRiskNotice,
    setModel, selectWorkspace, selectGroup, groupUpdated,
    listSnapshots: () => send({ type: "list_snapshots" }),
    restoreSnapshot: (id: string) => send({ type: "restore_snapshot", snapshotId: id }),
    // 底层发送通道（供拖入文件等特殊场景直接发命令）
    send,
  };
}
