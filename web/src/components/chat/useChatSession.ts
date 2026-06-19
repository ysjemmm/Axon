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

import { useState, useRef, useEffect, useCallback } from "react";
import { MODELS, findModel } from "@/components/ModelSelector";
import { formatToolDescription, fallbackIntent, formatLineSuffix, type ToolStatus } from "@/components/ToolCallItem";
import { listRelays, getRelay, type RelayData } from "@/lib/apiClient";
import type { WsMessage } from "@/hooks/useWebSocket";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import type { AttachedFile, ChatMessage, CreditDetail, SubAgentSegment, TextSegment, ToolSegment, UserSegment } from "./types";
import type { CommandDecision } from "./commandApprovalContext";
import { isRelayTool, relayToolLabel, firstLine } from "./relayUtils";
import { updateSubAgentInner } from "./subAgentEvents";

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

/** 命令信任授权请求：未信任命令时后端弹出，含三档"加入白名单"选项 */
export interface CommandApproval {
  requestId: string;
  command: string;
  options: { choice: "exact" | "prefix" | "all"; pattern: string; label: string }[];
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

/** 取一个工具段的编辑单元列表 {path, editId}（editId 由后端随 diff 下发，前端不推导，避免 seg.id≠toolCallId 的偏差） */
function segEditUnits(seg: { diff?: { path: string; editId?: string }; diffs?: { path: string; editId?: string }[] }): { path: string; editId?: string }[] {
  const units: { path: string; editId?: string }[] = [];
  if (seg.diff?.path) units.push({ path: seg.diff.path, editId: seg.diff.editId });
  if (seg.diffs) for (const d of seg.diffs) if (d.path) units.push({ path: d.path, editId: d.editId });
  return units;
}

/** 这些工具的结果文本要作为卡片下层"输出"展示（后台进程 / 浏览器类）。execute_command 单独处理。 */
const OUTPUT_TOOLS = new Set(["start_process", "get_process_output", "get_browser_logs", "get_browser_network", "get_browser_storage", "browser_eval", "browser_get_html", "open_browser"]);

/** 工具名 → 底部状态指示器文案（后端 status 事件可能滞后/缺失时按工具名兜底，保持状态条与实际进度同步） */
function toolPhaseText(name: string): string {
  switch (name) {
    case "read_file": return "正在读取文件...";
    case "create_file": return "正在创建文件...";
    case "str_replace": return "正在编辑文件...";
    case "apply_patch": return "正在应用补丁...";
    case "execute_command": return "正在执行命令...";
    case "search": return "正在搜索...";
    case "list_dir": return "正在浏览目录...";
    case "check_diagnostics": return "正在检查语法...";
    case "web_search": return "正在联网搜索...";
    case "web_fetch": return "正在抓取网页...";
    default: return name.startsWith("mcp__") ? "正在调用工具..." : "处理中...";
  }
}

export function useChatSession(opts: UseChatSessionOptions) {
  const { clientId, sessionId, mode, connected, send: baseSend, onSessionCreated, onStreamingChange } = opts;

  // ── 会话状态 ──────────────────────────────────────────────────────────────
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingSession, setIsLoadingSession] = useState(!!sessionId);
  const [tokenUsage, setTokenUsage] = useState<{ used: number; max: number; cumulative: number }>(() => {
    let savedModel = "deepseek-v4-pro";
    try { savedModel = localStorage.getItem("axon-last-model") || "deepseek-v4-pro"; } catch { /* ignore */ }
    const currentModel = MODELS.find((m) => m.id === savedModel);
    return { used: 0, max: currentModel?.contextWindow || 128000, cumulative: 0 };
  });
  const [model, setModelState] = useState(() => {
    try { return localStorage.getItem("axon-last-model") || "deepseek-v4-pro"; } catch { return "deepseek-v4-pro"; }
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
  const typewriterBuffer = useRef<string>("");
  const typewriterTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamEnding = useRef<{ elapsed: number; tokens: number } | null>(null);
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

  /** 结束当前加载态 */
  const finishLoading = useCallback(() => { setIsLoading(false); }, []);

  /** 带本面板 clientId 的发送 */
  const send = useCallback((cmd: Record<string, unknown>) => {
    baseSend({ ...cmd, clientId });
  }, [baseSend, clientId]);

  // ── 通知上层流式状态变化（供 SessionContainer 决定保活/卸载） ──
  useEffect(() => { onStreamingChange?.(isLoading); }, [isLoading, onStreamingChange]);

  // ── Agent 事件处理（稳定 handler，按 clientId 订阅） ──────────────────────
  const handleEvent = useCallback((msg: WsMessage) => {
    if (msg.type === "token_usage") {
      setTokenUsage({
        used: msg.used as number,
        max: msg.max as number,
        cumulative: (msg as any).cumulative ?? 0,
      });
      return;
    }

    if (msg.type === "session_created") {
      // 当前会话已迁移 → 这是新会话的创建事件，不要覆盖本面板 id
      if (compactionMigratedRef.current) return;
      // 标记本会话为本面板自己创建，避免随后 tab.id 变化触发的挂载 effect 重新 load_session
      ownedSessionId.current = (msg as any).sessionId;
      onSessionCreatedRef.current((msg as any).sessionId);
      if ((msg as any).workspace) setWorkspace((msg as any).workspace);
      if ((msg as any).workspaces) setWorkspaces((msg as any).workspaces);
      return;
    }

    if (msg.type === "workspace_set") {
      setWorkspace((msg as any).workspace || "");
      if ((msg as any).workspaces) setWorkspaces((msg as any).workspaces);
      if ("groupId" in (msg as any)) setCurrentGroupId((msg as any).groupId || null);
      return;
    }

    if (msg.type === "edits_updated") {
      const pending = ((msg as any).pending as string[]) || [];
      setPendingPaths(pending);
      if (pending.length === 0) setPendingExpanded(false);
      const diffs = ((msg as any).diffs as { path: string; oldContent: string; newContent: string }[]) || [];
      const diffMap: Record<string, { oldContent: string; newContent: string }> = {};
      for (const d of diffs) diffMap[d.path] = { oldContent: d.oldContent, newContent: d.newContent };
      setPendingDiffs(diffMap);
      const rejected = ((msg as any).rejected as string[]) || [];
      const pendingEditIds = new Set(((msg as any).pendingEditIds as string[]) || []);
      const undoableEditIds = new Set(((msg as any).undoableEditIds as string[]) || []);
      const rejectedSet = new Set(rejected);
      setChatHistory((prev) => {
        let changed = false;
        const updated = prev.map((chatMsg) => {
          if (chatMsg.role !== "assistant" || !chatMsg.segments) return chatMsg;
          const newSegs = chatMsg.segments.map((seg) => {
            if (seg.type !== "tool") return seg;
            const units = segEditUnits(seg);
            if (units.length === 0) return seg;
            // editId 由后端随 diff 下发，直接匹配（不推导，避免 seg.id≠toolCallId 偏差）
            const perFilePending = units.filter((u) => u.editId && pendingEditIds.has(u.editId)).map((u) => u.path);
            const perFileUndoable = units.filter((u) => u.editId && undoableEditIds.has(u.editId)).map((u) => u.path);
            const shouldBePending = perFilePending.length > 0;
            const wasRejected = units.some((u) => rejectedSet.has(u.path));
            const shouldBeUndoable = perFileUndoable.length > 0;
            const prevPP = seg.pendingPaths || [];
            const ppChanged = perFilePending.length !== prevPP.length || perFilePending.some((p) => !prevPP.includes(p));
            const prevUP = (seg as any).undoablePaths || [];
            const upChanged = perFileUndoable.length !== prevUP.length || perFileUndoable.some((p: string) => !prevUP.includes(p));
            const needsUpdate =
              (!!seg.pending !== shouldBePending) ||
              (wasRejected && !seg.rejected) ||
              (!!seg.undoable !== shouldBeUndoable) ||
              ppChanged || upChanged;
            if (needsUpdate) {
              changed = true;
              return {
                ...seg,
                pending: shouldBePending || undefined,
                rejected: wasRejected || seg.rejected || undefined,
                undoable: shouldBeUndoable || undefined,
                pendingPaths: perFilePending.length > 0 ? perFilePending : undefined,
                undoablePaths: perFileUndoable.length > 0 ? perFileUndoable : undefined,
              };
            }
            return seg;
          });
          return newSegs !== chatMsg.segments ? { ...chatMsg, segments: newSegs } : chatMsg;
        });
        return changed ? updated : prev;
      });
      return;
    }

    if (msg.type === "edit_undo_result") {
      const target = (msg as any).path as string; // 前端发送的 target：editId（逐次）或 path（整文件）
      const ok = (msg as any).ok as boolean;
      const reason = (msg as any).reason as string | undefined;
      if (ok) {
        // 撤销成功：把命中该 target（editId 或 path）的工具段对应文件标为已撤销
        setChatHistory((prev) => {
          let changed = false;
          const updated = prev.map((chatMsg) => {
            if (chatMsg.role !== "assistant" || !chatMsg.segments) return chatMsg;
            const newSegs = chatMsg.segments.map((seg) => {
              if (seg.type !== "tool") return seg;
              const units = segEditUnits(seg);
              // 命中的文件：editId 匹配（后端下发）或 path 直接匹配
              const hit = units.filter((u) => (u.editId && u.editId === target) || u.path === target).map((u) => u.path);
              if (hit.length === 0) return seg;
              changed = true;
              const prevRP = (seg as any).revertedPaths as string[] | undefined;
              const revertedPaths = Array.from(new Set([...(prevRP || []), ...hit]));
              const allPaths = units.map((u) => u.path);
              const allReverted = allPaths.length > 0 && allPaths.every((p) => revertedPaths.includes(p));
              const remainUndoable = ((seg as any).undoablePaths as string[] | undefined || []).filter((p) => !hit.includes(p));
              return {
                ...seg,
                revertedPaths,
                reverted: allReverted || undefined,
                undoable: remainUndoable.length > 0 || undefined,
                undoablePaths: remainUndoable.length > 0 ? remainUndoable : undefined,
              };
            });
            return newSegs !== chatMsg.segments ? { ...chatMsg, segments: newSegs } : chatMsg;
          });
          return changed ? updated : prev;
        });
      } else {
        // 撤销/拒绝失败：轻提示（保守策略：文件未被改动）
        setUndoNotice({ id: Date.now(), text: reason || "无法撤销该改动" });
      }
      return;
    }

    if (msg.type === "relay_updated") {
      const relay = (msg as any).relay as RelayData | undefined;
      if (relay) {
        setLiveRelay(relay);
        setHasRelay(true);
        setFocusRelayId(relay.id);
      }
      return;
    }

    if (msg.type === "relay_deleted") {
      const relayId = (msg as any).relayId as string | undefined;
      if (relayId) setDeletedRelayId(relayId);
      return;
    }

    if (msg.type === "confirm_tool_request") {
      const toolName = (msg as any).toolName as string;
      const args = (msg as any).args as Record<string, unknown>;
      const kind = ((msg as any).kind as string) || "relay";
      const label = (msg as any).label as string | undefined;
      const title = label || (typeof args?.title === "string" ? args.title : "Relay 工作流");
      setToolConfirm({ toolName, title, kind });
      return;
    }

    if (msg.type === "tool_waiting_input") {
      const toolCallId = (msg as any).toolCallId as string | undefined;
      if (toolCallId) {
        setWaitingInputIds((prev) => new Set(prev).add(toolCallId));
      }
      return;
    }

    // tool 结果到达时清除该卡片的等待输入状态
    if (msg.type === "tool_result") {
      const toolCallId = (msg as any).id as string | undefined;
      if (toolCallId) {
        setWaitingInputIds((prev) => {
          const next = new Set(prev);
          next.delete(toolCallId);
          return next;
        });
      }
      // fall through: tool_result 继续由下方通用段更新 (segments/chatHistory)
    }

    // 流式内容或取消时清除所有等待输入状态
    if (msg.type === "stream_delta" || msg.type === "stream_start" || msg.type === "stream_end" || msg.type === "turn_cancelled") {
      setWaitingInputIds(new Set());
    }

    if (msg.type === "confirm_command_request") {
      const toolCallId = ((msg as any).id as string) || ((msg as any).requestId as string);
      setCommandApprovals((m) => ({
        ...m,
        [toolCallId]: {
          requestId: (msg as any).requestId as string,
          command: (msg as any).command as string,
          options: ((msg as any).options as CommandApproval["options"]) || [],
        },
      }));
      return;
    }

    if (msg.type === "command_blocked") {
      setCommandBlocked({
        requestId: (msg as any).requestId as string | undefined,
        command: (msg as any).command as string,
        reason: (msg as any).reason as string,
        dangerous: (msg as any).dangerous as boolean | undefined,
      });
      return;
    }

    if (msg.type === "focus_relay") {
      const relayId = (msg as any).relayId as string | undefined;
      if (relayId) {
        setFocusRelayId(relayId);
        getRelay(relayId).then((relay) => {
          setLiveRelay(relay);
          setHasRelay(true);
        }).catch(() => { /* relay 可能已被删除 */ });
      }
      return;
    }

    if (msg.type === "edit_mode_set") {
      setEditMode((msg as any).mode === "auto" ? "auto" : "manual");
      return;
    }

    if (msg.type === "workspace_error") {
      console.error("[workspace]", (msg as any).message);
      return;
    }

    if (msg.type === "session_loaded") {
      setIsLoadingSession(false);
      const messages = (msg as any).messages || [];
      const totalTokens = (msg as any).totalTokens || 0;
      if ((msg as any).workspace) setWorkspace((msg as any).workspace);
      if ((msg as any).workspaces) setWorkspaces((msg as any).workspaces);
      setCurrentGroupId((msg as any).workspaceGroupId || null);
      const activePendingPaths: string[] = (msg as any).pendingPaths || [];
      const activePendingEditIds: Set<string> = new Set((msg as any).pendingEditIds || []);
      const restored: ChatMessage[] = [];
      let currentAssistant: ChatMessage | null = null;
      let seq = 0;

      for (const m of messages) {
        if (m.role === "system") continue;

        if (m.role === "user") {
          // 系统注入的截图消息（_screenshotInjection 标记）：不当作用户消息,不重置 currentAssistant。
          // 它是 screenshot_page 工具为喂多模态模型而注入的图片,不该打断 tool_calls 配对流。
          if ((m as any)._screenshotInjection) continue;
          if (currentAssistant) {
            restored.push(currentAssistant);
            currentAssistant = null;
          }
          let content = "";
          let images: string[] | undefined;
          if (typeof m.content === "string") {
            content = m.content;
          } else if (Array.isArray(m.content)) {
            for (const part of m.content) {
              if (part.type === "text") content = part.text || "";
              if (part.type === "image_url") {
                if (!images) images = [];
                images.push(part.image_url?.url || "");
              }
            }
          }
          const attached = (m as any).attachedFiles as { name: string; size: number }[] | undefined;
          const displayText = (m as any).displayText as string | undefined;
          const bodyText = attached && attached.length > 0 ? (displayText ?? "") : content;
          const attachedFiles: AttachedFile[] | undefined = attached && attached.length > 0
            ? attached.map((f) => ({ name: f.name, size: f.size, content: "" }))
            : undefined;
          const restoredSegments = (m as any).userSegments as UserSegment[] | undefined;
          restored.push({ id: `hist-u-${seq++}`, role: "user", timestamp: (m as any).timestamp as number | undefined, content: bodyText, images, attachedFiles, userSegments: restoredSegments });
        } else if (m.role === "assistant") {
          const text = typeof m.content === "string" ? (m.content || "").trim() : "";
          const hasToolCalls = m.tool_calls && m.tool_calls.length > 0;

          if (!currentAssistant) {
            currentAssistant = { id: `hist-a-${seq++}`, role: "assistant", segments: [] };
          }

          if (text) {
            currentAssistant.segments!.push({ type: "text", content: text });
          }

          if ((m as any).turnStats) {
            currentAssistant.turnStats = (m as any).turnStats;
            currentAssistant.turnStatus = "success";
          }

          if (hasToolCalls) {
            for (const tc of m.tool_calls) {
              let tcArgs: Record<string, unknown> = {};
              try { tcArgs = JSON.parse(tc.function?.arguments || "{}"); } catch { /* ignore */ }
              const toolName = tc.function?.name || "";
              if (toolName === "delegate_task") {
                currentAssistant.segments!.push({
                  type: "subagent",
                  id: tc.id || `sub-${seq++}`,
                  intent: (tcArgs.intent as string) || "委托子 Agent 执行任务",
                  skill: (tcArgs.skill as string) || null,
                  prompt: (tcArgs.prompt as string) || "",
                  status: "done",
                  inner: [],
                });
                continue;
              }
              const pathArg = tcArgs.path as string || "";
              const shortName = pathArg ? (pathArg.split("/").pop()?.split("\\").pop() || pathArg) : "";
              const intentArg = (tcArgs.intent as string) || (tcArgs.query as string) || "";
              const isExplore = toolName === "search" || toolName === "list_dir";
              const lineSuffix = toolName === "read_file" ? formatLineSuffix(tcArgs.startLine, tcArgs.endLine) : "";
              const readNameWithLines = shortName + (lineSuffix ? ` ${lineSuffix}` : "");
              let desc: string;
              switch (toolName) {
                case "read_file": desc = shortName ? `已读取 ${readNameWithLines}` : "已读取文件"; break;
                case "create_file": desc = shortName ? `${tcArgs.overwrite === true ? "已覆盖" : "已创建"} ${shortName}` : "已创建文件"; break;
                case "str_replace": desc = shortName ? `已编辑 ${shortName}` : "已编辑文件"; break;
                case "execute_command": desc = "命令已执行"; break;
                case "search":
                case "list_dir": desc = intentArg || fallbackIntent(toolName); break;
                case "relay_create":
                case "relay_save_doc":
                case "relay_advance":
                case "relay_update_task":
                case "relay_review_task":
                case "parallel_research":
                  desc = relayToolLabel(toolName);
                  break;
                default: desc = `已完成 ${toolName}`;
              }
              currentAssistant.segments!.push({
                type: "tool",
                id: tc.id || `tool-${seq++}-${currentAssistant.segments!.length}`,
                name: toolName,
                status: "success",
                description: desc,
                args: tcArgs,
                command: (toolName === "execute_command" || toolName === "start_process") ? (tcArgs.command as string) : undefined,
                query: isExplore ? (intentArg || fallbackIntent(toolName)) : undefined,
              });
            }
          }
        } else if (m.role === "tool") {
          if (currentAssistant?.segments) {
            const toolStatus: ToolStatus = (m as any).status === "error" ? "error" : "success";
            const toolCallId = (m as any).tool_call_id;
            const toolContent = (m as any).content || "";
            for (let i = currentAssistant.segments.length - 1; i >= 0; i--) {
              const seg = currentAssistant.segments[i];
              if (seg.type === "subagent" && seg.id === toolCallId) {
                const conclusion = toolContent.replace(/^子 Agent 已完成任务[^\n]*\n+/, "").trim();
                seg.conclusion = conclusion || undefined;
                seg.inner = conclusion ? [{ type: "text", content: conclusion }] : [];
                break;
              }
              if (seg.type === "tool" && seg.id === toolCallId) {
                seg.status = toolStatus;
                // MCP 元数据恢复（持久化时存在 tool 消息上）
                if ((m as any).mcpServer) seg.mcpServer = (m as any).mcpServer;
                if ((m as any).mcpTool) seg.mcpTool = (m as any).mcpTool;
                // MCP 工具用友好描述；其他走原有逻辑
                if (seg.mcpTool && toolStatus === "success") {
                  seg.description = `调用 ${seg.mcpTool}`;
                } else if (toolStatus === "error" && seg.name !== "search" && seg.name !== "list_dir" && seg.name !== "execute_command") {
                  seg.description = (m as any).userMessage || toolContent.slice(0, 120) || "操作未成功";
                  if ((m as any).userMessage) seg.userMessage = (m as any).userMessage;
                }
                if (isRelayTool(seg.name) && toolStatus === "success" && toolContent) {
                  seg.description = firstLine(toolContent);
                }
                if (seg.name === "create_file" && toolStatus === "success" && toolContent.startsWith("已覆盖")) {
                  const cfName = typeof seg.args?.path === "string" ? (seg.args.path as string).split("/").pop()?.split("\\").pop() : "";
                  seg.description = cfName ? `已覆盖 ${cfName}` : "已覆盖文件";
                }
                if (seg.name === "execute_command") {
                  // displayContent 是纯命令输出（不含 AI 专用提示）；displayCommand 是实际执行的命令（用户编辑后的版本）
                  seg.output = (m as any).displayContent || toolContent;
                  if ((m as any).displayCommand) seg.command = (m as any).displayCommand;
                } else if (OUTPUT_TOOLS.has(seg.name)) {
                  // 后台进程 / 浏览器类工具：结果文本作为卡片下层输出
                  seg.output = toolContent;
                }
                if ((m as any).fileDiff) {
                  seg.diff = (m as any).fileDiff;
                  const diffPath = (m as any).fileDiff.path as string;
                  // 按 editId 精确判断（回退到 path 兼容旧数据）
                  const eid = `${toolCallId}::${diffPath}`;
                  if (diffPath && (activePendingEditIds.has(eid) || (activePendingEditIds.size === 0 && activePendingPaths.includes(diffPath)))) {
                    seg.pending = true;
                    seg.pendingPaths = [diffPath];
                  }
                }
                if ((m as any).fileDiffs) {
                  // apply_patch 等多文件工具：还原全部 diff，按 editId 逐文件判断待确认
                  seg.diffs = (m as any).fileDiffs;
                  const perFilePending = ((m as any).fileDiffs as { path: string }[])
                    .map((d) => d.path)
                    .filter((p) => p && (activePendingEditIds.has(`${toolCallId}::${p}`) || (activePendingEditIds.size === 0 && activePendingPaths.includes(p))));
                  if (perFilePending.length > 0) {
                    seg.pending = true;
                    seg.pendingPaths = perFilePending;
                  }
                }
                if ((m as any).diagnostics) seg.diagnostics = (m as any).diagnostics;
                if ((m as any).searchResults) seg.searchResults = (m as any).searchResults;
                if ((m as any).fetchResult) seg.fetchResult = (m as any).fetchResult;
                if ((m as any).powerActivated) seg.powerActivated = (m as any).powerActivated;
                break;
              }
            }
          }
        }
      }

      if (currentAssistant) {
        if (currentAssistant.segments) {
          currentAssistant.segments = currentAssistant.segments.filter(
            (s) => !(s.type === "text" && !s.content.trim())
          );
        }
        if (currentAssistant.segments && currentAssistant.segments.length > 0) {
          restored.push(currentAssistant);
        }
      }

      setChatHistory(restored);

      if (totalTokens > 0) {
        const currentModel = MODELS.find((m) => m.id === modelRef.current);
        setTokenUsage((prev) => ({ ...prev, used: totalTokens, max: currentModel?.contextWindow || prev.max }));
      }

      const restoredPending = (msg as any).pendingPaths as string[] | undefined;
      if (restoredPending && restoredPending.length > 0) {
        setPendingPaths(restoredPending);
      }
      const restoredDiffs = (msg as any).pendingDiffs as { path: string; oldContent: string; newContent: string }[] | undefined;
      if (restoredDiffs && restoredDiffs.length > 0) {
        const diffMap: Record<string, { oldContent: string; newContent: string }> = {};
        for (const d of restoredDiffs) diffMap[d.path] = { oldContent: d.oldContent, newContent: d.newContent };
        setPendingDiffs(diffMap);
      } else {
        setPendingDiffs({});
      }
      return;
    }

    if (msg.type === "status") {
      setStatusText((msg as any).content as string || "思考中...");
      setStatusPhase((msg as any).phase as string || "thinking");
      return;
    }

    if (msg.type === "compacting_start") {
      setIsCompacting(true);
      setStatusText("正在压缩上下文...");
      return;
    }

    if (msg.type === "compaction_needed") {
      setCompactionNeeded({
        currentTokens: (msg as any).currentTokens as number,
        maxTokens: (msg as any).maxTokens as number,
        percent: (msg as any).percent as number,
      });
      setStatusText("需要压缩上下文...");
      return;
    }

    if (msg.type === "compaction_migrated") {
      setIsCompacting(false);
      setCompactionNeeded(null);
      const newSessionId = (msg as any).newSessionId as string;
      setCompactionMigrated({
        newSessionId,
        parentSessionId: (msg as any).parentSessionId as string | undefined,
      });
      // 通知父组件打开新会话 tab
      onCompactionMigratedRef.current?.(newSessionId);
      return;
    }

    if (msg.type === "compacting_end") {
      setIsCompacting(false);
      const ok = (msg as any).success as boolean;
      const endMsg = (msg as any).message as string || (ok ? "上下文已压缩" : "压缩失败");
      if (!ok) {
        // 失败提示：用轻 toast 而非藏到聊天历史的系统消息
        setUndoNotice({ id: Date.now(), text: endMsg });
      } else {
        setChatHistory((prev) => {
          const last = prev[prev.length - 1];
          const label = `[${endMsg}]`;
          if ((last as any)?.role === "system" && last.content === label) return prev;
          return [...prev, { id: `compact-${Date.now()}`, role: "system" as any, content: label, timestamp: Date.now() }];
        });
      }
      setStatusText(ok ? "思考中..." : endMsg);
      return;
    }

    if (msg.type === "reasoning_delta") {
      setReasoning((prev) => prev + ((msg as any).content || ""));
      if (statusPhaseRef.current === "thinking") {
        setStatusText("正在推理...");
        setStatusPhase("reasoning");
      }
      return;
    }

    if (msg.type === "stream_start") {
      cancelled.current = false;
      typewriterBuffer.current = "";
      setReasoning("");
      setStatusText("正在回复...");
      setStatusPhase("responding");
      setChatHistory((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant") {
          const segs = [...(last.segments || [])];
          const lastSeg = segs[segs.length - 1];
          if (!lastSeg || lastSeg.type !== "text") {
            segs.push({ type: "text", content: "" });
          }
          updated[updated.length - 1] = { ...last, segments: segs, streaming: true, turnStatus: "running", turnGen: turnGeneration.current };
          return updated;
        }
        return [...prev, { id: `assistant-${Date.now()}`, role: "assistant", segments: [{ type: "text", content: "" }], streaming: true, turnStatus: "running", turnGen: turnGeneration.current }];
      });
      if (typewriterTimer.current) clearInterval(typewriterTimer.current);
      streamEnding.current = null;
      typewriterTimer.current = setInterval(() => {
        if (typewriterBuffer.current.length > 0) {
          const len = typewriterBuffer.current.length;
          const batchSize = len > 100 ? 12 : len > 30 ? 5 : 2;
          const batch = typewriterBuffer.current.slice(0, batchSize);
          typewriterBuffer.current = typewriterBuffer.current.slice(batchSize);

          setChatHistory((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant" && last.segments) {
              const segs = [...last.segments];
              // Find the last TEXT segment (not tool/sub-agent) to append to.
              // Tool calls can be inserted mid-stream, pushing the text segment
              // away from the end of the array — always search backwards.
              let textIdx = -1;
              for (let i = segs.length - 1; i >= 0; i--) {
                if (segs[i].type === "text") { textIdx = i; break; }
              }
              if (textIdx >= 0) {
                const textSeg = segs[textIdx];
                segs[textIdx] = { type: "text" as const, content: (textSeg as any).content + batch } as TextSegment;
              }
              updated[updated.length - 1] = { ...last, segments: segs };
            }
            return updated;
          });
          return;
        }

        if (streamEnding.current) {
          const stats = streamEnding.current;
          streamEnding.current = null;
          if (typewriterTimer.current) {
            clearInterval(typewriterTimer.current);
            typewriterTimer.current = null;
          }
          const finalFlush = typewriterBuffer.current;
          typewriterBuffer.current = "";
          setChatHistory((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant") {
              if (finalFlush && last.segments) {
                const segs = [...last.segments];
                // Find last text segment to flush remaining content into
                let textIdx = -1;
                for (let i = segs.length - 1; i >= 0; i--) {
                  if (segs[i].type === "text") { textIdx = i; break; }
                }
                if (textIdx >= 0) {
                  const textSeg = segs[textIdx];
                  segs[textIdx] = { type: "text" as const, content: (textSeg as any).content + finalFlush } as TextSegment;
                }
                updated[updated.length - 1] = { ...last, segments: segs, streaming: false, turnStats: stats, turnStatus: "success" };
              } else {
                updated[updated.length - 1] = { ...last, streaming: false, turnStats: stats, turnStatus: "success" };
              }
            }
            return updated;
          });
          finishLoading();
        }
      }, 15);
      return;
    }

    if (msg.type === "stream_delta") {
      if (cancelled.current) return;
      typewriterBuffer.current += (msg.content || "");
      return;
    }

    if (msg.type === "stream_pause") {
      if (cancelled.current) return;
      const remaining = typewriterBuffer.current;
      typewriterBuffer.current = "";
      if (typewriterTimer.current) {
        clearInterval(typewriterTimer.current);
        typewriterTimer.current = null;
      }
      if (remaining) {
        setChatHistory((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last?.role === "assistant" && last.segments) {
            const segs = [...last.segments];
            const lastSeg = segs[segs.length - 1];
            if (lastSeg?.type === "text") {
              segs[segs.length - 1] = { ...lastSeg, content: lastSeg.content + remaining };
            }
            updated[updated.length - 1] = { ...last, segments: segs };
          }
          return updated;
        });
      }
      return;
    }

    if (msg.type === "turn_cancelled") {
      // 后端在取消收尾时算出的真实四段拆分：覆盖前端取消时乐观合成的粗糙值（system/本次提问为 0）。
      // 不受 cancelled.current 守卫拦截——这正是取消后才该应用的真实统计。
      const stats = {
        elapsed: (msg as any).elapsed || 0,
        tokens: (msg as any).tokens || 0,
        model: (msg as any).model as string | undefined,
        credits: (msg as any).credits as number | undefined,
        creditDetail: (msg as any).creditDetail as CreditDetail | undefined,
      };
      const targetMsgId = cancelledTurnMsgId.current;
      cancelledTurnMsgId.current = null;
      // 如果取消时没有 assistant 消息可挂载（如仅发出工具卡片还未产生文本回复），
      // 提前生成一个 id 供 fallback 使用——不能在 setChatHistory 回调里用 Date.now()
      const fallbackId = `assistant-cancelled-${Date.now()}`;
      setChatHistory((prev) => {
        let found = false;
        const updated = [...prev];
        // 优先按 targetMsgId 精确定位，找不到时回退到最后一条 assistant 消息
        // （取消可能发生在工具执行中而非流式输出中，此时 targetMsgId 为 null）
        for (let i = updated.length - 1; i >= 0; i--) {
          if (updated[i].role === "assistant") {
            if (targetMsgId && updated[i].id !== targetMsgId) continue;
            updated[i] = {
              ...updated[i],
              streaming: false,
              turnStatus: "cancelled",
              turnStats: updated[i].turnStats || stats,
            };
            found = true;
            break;
          }
        }
        // 取消可能发生在工具执行中：此时本轮可能只有工具卡片、还没有 assistant 文本消息。
        // 如果没有可挂载的 assistant，补一个最小 assistant turn，保证 credit/耗时仍然展示。
        if (!found) {
          updated.push({
            id: fallbackId,
            role: "assistant",
            timestamp: Date.now(),
            segments: [],
            streaming: false,
            turnStatus: "cancelled",
            turnStats: stats,
            turnGen: turnGeneration.current,
          });
        }
        return updated;
      });
      setReasoning("");
      // 仅在取消标记仍为 true（新轮未启动）时收尾 loading；
      // 若 sendNow 已将 cancelled 标为 false，说明队列消费已启动新轮次，不要干扰它。
      if (cancelled.current) {
        finishLoading();
      }
      return;
    }

    if (msg.type === "stream_end") {
      if (cancelled.current) return;
      const stats = {
        elapsed: (msg as any).elapsed || 0,
        tokens: (msg as any).tokens || 0,
        model: (msg as any).model as string | undefined,
        credits: (msg as any).credits as number | undefined,
        creditDetail: (msg as any).creditDetail as CreditDetail | undefined,
      };
      if (typewriterTimer.current) {
        streamEnding.current = stats;
        return;
      }
      const remaining = typewriterBuffer.current;
      typewriterBuffer.current = "";
      setChatHistory((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant" && last.segments) {
          const segs = [...last.segments];
          if (remaining) {
            // Find last text segment to flush remaining content
            let textIdx = -1;
            for (let i = segs.length - 1; i >= 0; i--) {
              if (segs[i].type === "text") { textIdx = i; break; }
            }
            if (textIdx >= 0) {
              const textSeg = segs[textIdx];
              segs[textIdx] = { type: "text" as const, content: (textSeg as any).content + remaining } as TextSegment;
            }
          }
          updated[updated.length - 1] = { ...last, segments: segs, streaming: false, turnStats: stats, turnStatus: "success" };
        }
        return updated;
      });
      finishLoading();
      return;
    }

    if (msg.type === "tool_call") {
      if (cancelled.current) return;
      if (msg.name === "delegate_task") return;
      // 同步底部状态指示器到当前工具（后端 status 事件可能滞后/缺失，这里据工具名兜底）
      setStatusText(toolPhaseText(msg.name || ""));
      setStatusPhase("tool");
      setChatHistory((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        const curGen = turnGeneration.current;
        // 陈旧 tool_call（来自被取消的上一轮）不作用于新轮 assistant
        if (last && last.role === "assistant" && last.turnGen !== curGen) return prev;
        const msgStatus = (msg as any).status as string | undefined;
        const args = (msg.args as Record<string, unknown>) || {};
        const eventId = (msg as any).id as string || "";

        // status="success" 来自软失败工具的延迟展示（str_replace/apply_patch/read_file 成功后才发）。
        // 此时 tool_result 紧随其后——如果这里创建 pending 段且 tool_result 在同一批 React 更新中
        // 执行，setState 的 prev 可能看不到刚加的 pending 段（竞态），导致 pending 段残留在 UI 上。
        // 解法：success tool_call 不创建段，由紧随的 tool_result 负责创建最终的 success 段。
        if (msgStatus === "success") {
          return prev;
        }

        if (last?.role === "assistant" && last.segments && msgStatus === "executing") {
          const segs = [...last.segments];
          let idx = -1;
          if (eventId) {
            for (let i = segs.length - 1; i >= 0; i--) {
              const s = segs[i];
              if (s.type === "tool" && s.status === "pending" && (s.id === eventId || (!s.boundId && s.name === msg.name))) {
                idx = i;
                break;
              }
            }
          } else {
            const lastSeg = segs[segs.length - 1];
            if (lastSeg?.type === "tool" && lastSeg.name === msg.name && lastSeg.status === "pending") {
              idx = segs.length - 1;
            }
          }
          if (idx >= 0) {
            const seg = segs[idx] as ToolSegment;
            segs[idx] = {
              ...seg,
              id: eventId || seg.id,
              boundId: eventId ? true : seg.boundId,
              status: "pending",
              description: formatToolDescription(msg.name || "", undefined, args),
              args,
              command: (msg.name === "execute_command" || msg.name === "start_process") ? (args.command as string) : seg.command,
              cwd: (msg.name === "execute_command" || msg.name === "start_process") ? (msg as any).cwd : seg.cwd,
              query: (msg.name === "search" || msg.name === "list_dir")
                ? ((args.intent as string) || (args.query as string) || seg.query || fallbackIntent(msg.name))
                : seg.query,
            };
            updated[updated.length - 1] = { ...last, segments: segs };
            return updated;
          }
        }

        const toolSeg: ToolSegment = {
          type: "tool",
          id: eventId || `tool-${Date.now()}-${msg.name}`,
          boundId: !!eventId,
          name: msg.name || "",
          status: "pending",
          description: formatToolDescription(msg.name || "", undefined, args),
          args,
          command: (msg.name === "execute_command" || msg.name === "start_process") ? (args.command as string) : undefined,
          cwd: (msg.name === "execute_command" || msg.name === "start_process") ? (msg as any).cwd : undefined,
          query: (msg.name === "search" || msg.name === "list_dir")
            ? ((args.intent as string) || (args.query as string) || fallbackIntent(msg.name))
            : undefined,
          mcpServer: (msg as any).mcpServer,
          mcpTool: (msg as any).mcpTool,
        };

        if (!last || last.role !== "assistant") {
          updated.push({ id: `assistant-${Date.now()}`, role: "assistant", segments: [toolSeg], streaming: true, turnGen: turnGeneration.current });
        } else {
          updated[updated.length - 1] = { ...last, segments: [...(last.segments || []), toolSeg] };
        }
        return updated;
      });
      return;
    }

    if (msg.type === "tool_result") {
      if (cancelled.current) return;
      if (msg.name === "delegate_task") return;
      const toolStatus = (msg as any).status as ToolStatus || "success";
      setChatHistory((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant" && last.segments) {
          const curGen = turnGeneration.current;
          // 陈旧结果（上一轮取消后的延迟到达）不作用于新轮 assistant
          if (last.turnGen !== curGen) return prev;
          const segs = [...last.segments];
          const eventId = (msg as any).id as string || "";
          let matchIdx = -1;
          if (eventId) {
            for (let i = segs.length - 1; i >= 0; i--) {
              const s = segs[i];
              if (s.type === "tool" && s.id === eventId) { matchIdx = i; break; }
            }
          }
          if (matchIdx < 0) {
            for (let i = segs.length - 1; i >= 0; i--) {
              const s = segs[i];
              if (s.type === "tool" && s.name === msg.name && s.status === "pending") { matchIdx = i; break; }
            }
          }
          if (matchIdx >= 0) {
            const seg = segs[matchIdx] as ToolSegment;
            if (seg.type === "tool") {
              const isError = toolStatus === "error";
              const isExplore = seg.name === "search" || seg.name === "list_dir";
              const pendingDesc = seg.description;
              const parts = pendingDesc.match(/^(.+?)\s+(\S+\.\S+)(?:\s+(\d+-(?:\d+|EOF)))?$/);
              const fileName = parts ? parts[2] : null;
              const lineSuffix = parts && parts[3] ? ` ${parts[3]}` : "";
              const hasOutput = seg.name === "execute_command" || OUTPUT_TOOLS.has(seg.name);
              let finalDesc: string;
              if (isError && !isExplore && seg.name !== "check_diagnostics") {
                if (seg.name === "str_replace" || seg.name === "create_file") {
                  finalDesc = (msg as any).userMessage || msg.result?.slice(0, 120) || "操作未成功";
                } else if (seg.name === "read_file" && typeof seg.args?.path === "string") {
                  finalDesc = seg.args.path;
                } else {
                  finalDesc = (msg as any).userMessage || msg.result?.slice(0, 100) || "执行失败";
                }
              } else if (msg.name === "execute_command") {
                finalDesc = "命令已执行";
              } else if (msg.name === "check_diagnostics") {
                finalDesc = (msg.result || "").includes("无错误") ? "无错误" : "error";
              } else if (isExplore) {
                finalDesc = seg.query || (msg.args as Record<string, unknown>)?.query as string || fallbackIntent(seg.name);
              } else if (isRelayTool(msg.name || "")) {
                finalDesc = msg.result ? firstLine(msg.result) : relayToolLabel(msg.name || "");
              } else if (fileName) {
                const cfResult = msg.result || "";
                const cfVerb = cfResult.includes("已存在") ? "已存在" : cfResult.startsWith("已覆盖") ? "已覆盖" : "已创建";
                const verbMap: Record<string, string> = {
                  read_file: `已读取 ${fileName}${lineSuffix}`,
                  create_file: `${cfVerb === "已存在" ? `${fileName} 已存在` : `${cfVerb} ${fileName}`}`,
                  str_replace: `已编辑 ${fileName}`,
                };
                finalDesc = verbMap[msg.name || ""] || `已完成 ${fileName}`;
              } else {
                // MCP 工具或其他无文件名的工具：用友好描述
                if ((msg as any).mcpTool || seg.mcpTool) {
                  finalDesc = `调用 ${(msg as any).mcpTool || seg.mcpTool}`;
                } else {
                  finalDesc = msg.result?.slice(0, 60) || seg.description;
                }
              }
              segs[matchIdx] = {
                ...seg,
                status: toolStatus,
                description: finalDesc,
                args: (msg as any).args || seg.args,
                mcpServer: (msg as any).mcpServer || seg.mcpServer,
                mcpTool: (msg as any).mcpTool || seg.mcpTool,
                // execute_command：用结果里的 args.command 刷新展示命令（用户编辑过则为编辑后的版本）
                command: seg.name === "execute_command"
                  ? (((msg as any).args?.command as string) ?? seg.command)
                  : seg.command,
                output: hasOutput ? (msg.result || "") : undefined,
                diff: (msg as any).fileDiff || seg.diff,
                diffs: (msg as any).fileDiffs || seg.diffs,
                diagnostics: (msg as any).diagnostics || seg.diagnostics,
                searchResults: (msg as any).searchResults || seg.searchResults,
                fetchResult: (msg as any).fetchResult || seg.fetchResult,
                powerActivated: (msg as any).powerActivated || seg.powerActivated,
                pending: (msg as any).pending ?? seg.pending,
                hidden: (msg as any).hidden ?? seg.hidden,
                resolvedPath: (msg as any).resolvedPath || seg.resolvedPath,
              };
            }
          }
          } else {
            // 无匹配段：tool_result 先于 tool_call 到达（软失败工具：tool_call 被跳过了）。
            // 直接用 tool_result 的数据新建成功段，不再需要 tool_call。
            const noMatchName = msg.name || "";
            const noMatchArgs = (msg as any).args as Record<string, unknown> || {};
            const shortName = typeof noMatchArgs.path === "string" ? (noMatchArgs.path as string).split("/").pop()?.split("\\").pop() || "" : "";
            const isExplore = noMatchName === "search" || noMatchName === "list_dir";
            const lineSuffix = noMatchName === "read_file" ? formatLineSuffix(noMatchArgs.startLine, noMatchArgs.endLine) : "";
            let desc = `${noMatchName} 完成`;
            if (noMatchName === "read_file") desc = shortName ? `已读取 ${shortName}${lineSuffix ? ` ${lineSuffix}` : ""}` : "已读取文件";
            else if (noMatchName === "create_file") desc = shortName ? `${noMatchArgs.overwrite === true ? "已覆盖" : "已创建"} ${shortName}` : "已创建文件";
            else if (noMatchName === "str_replace") desc = shortName ? `已编辑 ${shortName}` : "已编辑文件";
            else if (isExplore) desc = (noMatchArgs.intent as string) || (noMatchArgs.query as string) || fallbackIntent(noMatchName);
            else if (noMatchName === "execute_command") desc = "命令已执行";
            else if (isRelayTool(noMatchName)) desc = relayToolLabel(noMatchName);
            segs.push({
              type: "tool",
              id: eventId || `tool-${Date.now()}-${noMatchName}`,
              boundId: !!eventId,
              name: noMatchName,
              status: toolStatus,
              description: desc,
              args: noMatchArgs,
              command: (noMatchName === "execute_command" || noMatchName === "start_process") ? (noMatchArgs.command as string) : undefined,
              query: isExplore ? ((noMatchArgs.intent as string) || (noMatchArgs.query as string) || fallbackIntent(noMatchName)) : undefined,
              mcpServer: (msg as any).mcpServer,
              mcpTool: (msg as any).mcpTool,
              output: (noMatchName === "execute_command" || OUTPUT_TOOLS.has(noMatchName)) ? (msg.result || "") : undefined,
              diff: (msg as any).fileDiff,
              diffs: (msg as any).fileDiffs,
              diagnostics: (msg as any).diagnostics,
              searchResults: (msg as any).searchResults,
              fetchResult: (msg as any).fetchResult,
              powerActivated: (msg as any).powerActivated,
              pending: (msg as any).pending,
              hidden: (msg as any).hidden,
              resolvedPath: (msg as any).resolvedPath,
            });
          }
          updated[updated.length - 1] = { ...last, segments: segs };
        }
        return updated;
      });
      return;
    }

    if (msg.type === "sub_agent_start") {
      if (cancelled.current) return;
      const delegateId = (msg as any).delegateId as string;
      const intent = (msg as any).intent as string || "委托子 Agent 执行任务";
      const skill = (msg as any).skill as string | null;
      const prompt = (msg as any).prompt as string || "";
      setChatHistory((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        const subSeg: SubAgentSegment = {
          type: "subagent", id: delegateId, intent, skill, prompt, status: "running", inner: [],
        };
        if (!last || last.role !== "assistant") {
          updated.push({ id: `assistant-${Date.now()}`, role: "assistant", segments: [subSeg], streaming: true, turnGen: turnGeneration.current });
        } else {
          updated[updated.length - 1] = { ...last, segments: [...(last.segments || []), subSeg] };
        }
        return updated;
      });
      return;
    }

    if (msg.type === "sub_agent_event") {
      if (cancelled.current) return;
      const delegateId = (msg as any).delegateId as string;
      const event = (msg as any).event as WsMessage;
      setChatHistory((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "assistant" && last.turnGen !== turnGeneration.current) return prev;
        return updateSubAgentInner(prev, delegateId, event);
      });
      return;
    }

    if (msg.type === "sub_agent_end") {
      const delegateId = (msg as any).delegateId as string;
      const result = (msg as any).result as string || "";
      setChatHistory((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "assistant" && last.turnGen !== turnGeneration.current) return prev;
        return prev.map((m) => {
        if (m.role !== "assistant" || !m.segments) return m;
        const segs = m.segments.map((s) => {
          if (s.type !== "subagent" || s.id !== delegateId) return s;
          const inner = s.inner.map((seg) =>
            seg.type === "tool" && seg.status === "pending"
              ? { ...seg, status: "success" as ToolStatus }
              : seg);
          return { ...s, status: "done" as const, innerStreaming: false, conclusion: result, inner };
        });
        return { ...m, segments: segs };
      });
      });
      return;
    }

    if (msg.type === "error") {
      setChatHistory((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, role: "assistant", segments: [{ type: "text", content: `❌ ${msg.content}` }], turnStatus: "error" },
      ]);
      finishLoading();
      setReasoning(""); // 清空残留的思考过程，避免跟到下一轮
    }
  }, [finishLoading]);

  // 按 clientId 订阅本面板事件流
  useSessionEvents(clientId, handleEvent);

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
      typewriterBuffer.current = "";
      if (typewriterTimer.current) {
        clearInterval(typewriterTimer.current);
        typewriterTimer.current = null;
      }
      streamEnding.current = null;
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
    send({ type: "user_message", ...payload.send });
    setIsLoading(true);
    setStatusText("思考中...");
    setStatusPhase("thinking");
    turnStartTime.current = Date.now();
  }, [send]);

  /** 提交一条用户消息：AI 回复中则排队，否则立即发送。返回是否已排队。 */
  const submit = useCallback((payload: SubmitPayload): boolean => {
    if (isLoading) {
      setMessageQueue((prev) => [...prev, { id: `q-${Date.now()}`, payload }]);
      return true;
    }
    sendNow(payload);
    return false;
  }, [isLoading, sendNow]);

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
    typewriterBuffer.current = "";
    streamEnding.current = null;
    setWaitingInputIds(new Set()); // 取消时清除所有呼吸灯
    if (typewriterTimer.current) {
      clearInterval(typewriterTimer.current);
      typewriterTimer.current = null;
    }
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
  const setModel = useCallback((newModel: string) => {
    setModelState(newModel);
    try { localStorage.setItem("axon-last-model", newModel); } catch { /* ignore */ }
    const targetModel = findModel(newModel);
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
    editMode, workspace, workspaces, currentGroupId, hasRelay, model,
    // 撤销轻提示
    undoNotice, setUndoNotice,
    // Quest
    mode, questThink, questWebSearch, setQuestThink, setQuestWebSearch,
    // 动作
    submit, removeFromQueue, cancelTurn,
    toggleEditMode, acceptEdits, rejectEdits, undoEdits, confirmTool,
    approveCommand, dismissCommandBlocked, respondToDangerousCommand,
    setModel, selectWorkspace, selectGroup, groupUpdated,
  };
}
