/**
 * ChatPanel —— 单个会话面板的 UI 壳层（多会话版）
 *
 * 会话与传输逻辑收敛在 useChatSession hook，本组件只负责：
 * 输入区编排、消息列表渲染、滚动跟随、文件/图片处理、各类弹窗。
 *
 * 多会话：每个面板有稳定的 clientId（事件总线路由 + 命令打标），由 SessionContainer 管理生命周期。
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { SESSION_HEADER_SLOT_ID } from "./SessionSwitcher";
import { LiveSparkModeContext, type SparkMode } from "./AxonSpark";
import { Loader2, ImagePlus, X, Paperclip, Plus, Camera, ChevronDown, ListChecks, Globe, NotebookPen, FolderOpen, Plug } from "lucide-react";
import { OPEN_CONNECTORS_EVENT } from "./ConnectorsDialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ImageViewer } from "./chat/ImageViewer";
import { EffortSelector, ModelSelector, useModels, findModel, getModels } from "@/components/ModelSelector";
import { useModelEffort, resolveEffortForModel } from "./chat/useModelEffort";
import { getVisionFallbackModel } from "@/lib/apiClient";
import { updateDiagState } from "@/lib/diagnostics";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { WorkspaceAxonPanel, type WorkspaceAxonStatusItem } from "@/components/WorkspaceAxonPanel";
import { WorkspaceGroupManager, type WorkspaceGroup } from "@/components/WorkspaceGroupManager";
import { AxonMascot } from "@/components/AxonMascot";
import { useMascotMood } from "./chat/useMascotMood";
import { MascotStatusText } from "./chat/MascotStatusText";
import { SkillStudio } from "@/components/SkillStudio";

import type { AttachedFile, ChatPanelProps, UserSegment } from "./chat/types";
import { FILE_MAX_SIZE, FILE_INLINE_MAX_SIZE, isAllowedTextFile, looksBinary } from "./chat/fileUtils";
import { MessageBubble } from "./chat/MessageBubble";
import { AssistantTurnHeader } from "./chat/AssistantTurn";
import { UnifiedStatusBar } from "./UnifiedStatusBar";
import { NoticeBar, type NoticeItem } from "./chat/NoticeBar";
import { AskUserCard } from "./AskUserCard";
import { FormPanel } from "./chat/FormPanel";
import { MemoryPanel } from "./chat/MemoryPanel";
import { MentionEditor, type MentionEditorHandle } from "./chat/MentionEditor";
import { EmptyStateGreeting } from "./chat/EmptyStateGreeting";
import { TokenIndicator } from "./chat/TokenIndicator";
import { BackgroundTasksButton } from "./chat/BackgroundTasks";
import { attachmentTypeLabel, imageTypeLabel } from "./chat/attachmentType";
import { SendStopIcon } from "./chat/SendStopIcon";
import { ProcessingAttachmentCard, type ProcessingAttachment } from "./chat/ProcessingAttachmentCard";
import { AttachmentCard, FileCardBody } from "./chat/AttachmentCard";
import { useChatSession, type SubmitPayload } from "./chat/useChatSession";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import { useSlashCommands } from "./chat/slash/useSlashCommands";
import { useSlashCommandHost } from "./chat/slash/useSlashCommandHost";
import { SlashCommandMenu } from "./chat/slash/SlashCommandMenu";
import { DEFAULT_SLASH_COMMANDS } from "./chat/slash/commands";
import { CommandApprovalContext } from "./chat/commandApprovalContext";
import { InlineFormContext } from "./chat/inlineFormContext";
import { formatInlineFormMessage } from "./chat/inlineFormMessage";
import type { FormSpecData, FormSubmitData } from "./chat/formTypes";
import { QuestionListPanel } from "./chat/QuestionListPanel";
import { VirtualMessageList, type VirtualMessageListHandle } from "./chat/VirtualMessageList";
import { nextHiddenCount, safeHiddenCount } from "./chat/scrollAnchor";
import { CONTROL_CMD, STORAGE } from "@/lib/constants";
import { PanelClientIdContext } from "@/lib/openDiff";

/** 时间线默认保留的最近消息数；早期消息可按需从顶部逐批展开。 */
const VISIBLE_HISTORY_LIMIT = 32;
const RESTORE_HISTORY_BATCH_SIZE = 24;

/**
 * 空态首发时「输入框从居中落到底部」的动画时长（ms）。
 * CSS 过渡与等待发送的定时器共用这一个值，改动时两边自动同步。
 */
const COMPOSER_LANDING_MS = 420;

/** 单行版式下编辑区与工具栏之间的间距（对应容器上的 gap-1）。 */
const COMPOSER_ROW_GAP = 4;
/** 单行版式下工具栏自身左右内边距合计（对应 toolbar 上的 px-1.5）。 */
const COMPOSER_TOOLBAR_PAD = 12;
/**
 * 单行版式里编辑区至少要留出的宽度。
 * 面板窄到工具栏吃掉大半宽度时，勉强并排会把输入区挤成一条缝（连发送按钮都可能被裁掉），
 * 这时宁可退回多行版式——多行本来就是"一定放得下"的那一侧。
 */
const COMPOSER_MIN_INLINE_EDITOR_WIDTH = 200;

/**
 * 数编辑区「真实渲染出来的行数」。
 *
 * 用 Range 量内容占据的矩形、总高除以行高。自动折行会多出一个行盒，所以它同时覆盖
 * 「用户敲了回车」和「长文本被折行」两种情况——只数 "\n" 的个数会漏掉后者。
 *
 * 不能用 scrollHeight：contentEditable 带 min-height(44px)，空文档的 scrollHeight 就是 44，
 * 换算下来永远"两行多"，空态根本收不回一行。
 */
function measureRenderedLines(root: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width <= 0 && rect.height <= 0) continue;
    if (rect.top < top) top = rect.top;
    if (rect.bottom > bottom) bottom = rect.bottom;
  }
  if (!Number.isFinite(top) || bottom - top <= 0) return 1; // 空文档：一个空段落，按一行算
  const lineHeight = Number.parseFloat(window.getComputedStyle(root).lineHeight) || 21;
  // 行内 tag（28px 高）比行高略高，所以按四舍五入收，别把一行算成两行
  return Math.max(1, Math.round((bottom - top) / lineHeight));
}

export function ChatPanel({ clientId, sessionId, mode, connected, active, send, onSessionCreated, onCompactionMigrated, onSessionForked, onStreamingChange }: ChatPanelProps) {
  const session = useChatSession({ clientId, sessionId, mode, connected, send, onSessionCreated, onCompactionMigrated, onSessionForked, onStreamingChange });
  const [hiddenMessageCount, setHiddenMessageCount] = useState(0);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [axonProposal, setAxonProposal] = useState<{ workspace: string; content: string } | null>(null);
  const [axonProposalLoading, setAxonProposalLoading] = useState(false);
  /** 上一次的会话消息总数：用于区分"追加消息"与"压缩/编辑后变短" */
  const prevHistoryLenRef = useRef(session.chatHistory.length);

  // 虚拟列表只减少 DOM 数量，不会缩短滚动比例。把较早的 UI 消息折叠，
  // 但绝不修改 session.chatHistory：后端持久化、上下文压缩和历史恢复仍持有完整记录。
  //
  // ⚠️ 折叠只能在【用户看不见】的时刻做：面板在后台、或会话刚加载（列表还没画出来）。
  // 早先是"每轮结束、且贴底时"折叠——也就是回复完成 / 取消的那一刻。从头部裁掉几条会让
  // 虚拟列表的 firstItemIndex 前移，它要同时平移高度缓存、回调 scrollTop、重算渲染区间，
  // 而那一刻最后一条回复还在长高（统计行出现）。实测（收尾探针）：完成后 +26ms scrollTop
  // 被回调 400px（恰为两条未测量消息的估高 200×2），+44ms 视口里的三条消息同时被卸载，
  // +161ms 才再跳 2151px 纠正回来——中间 100 多毫秒视口里没有消息，就是"完成时偶发白闪"。
  // 只在历史超过窗口上限、本轮确实触发折叠时才出现，所以是偶发。
  //
  // 硬约束：计数必须能随消息变少而收缩——上下文压缩会把 chatHistory 从几十条换成几条，
  // 陈旧的大计数会让 slice() 直接切空，对话区白屏（见 scrollAnchor.nextHiddenCount）。
  // 这种"内容被整体替换"的情况必须立即纠正，不受可见性限制。
  useEffect(() => {
    const len = session.chatHistory.length;
    const prevLen = prevHistoryLenRef.current;
    prevHistoryLenRef.current = len;
    if (len === 0) return;
    const shrank = len < prevLen;
    // prevLen === 0：会话刚加载，列表尚未绘制，此时定窗口没有可见位移
    const freshLoad = prevLen === 0;
    if (!shrank && !freshLoad && (active || session.isLoading)) return;
    setHiddenMessageCount((previous) => nextHiddenCount(previous, prevLen, len, VISIBLE_HISTORY_LIMIT));
  }, [session.chatHistory.length, session.isLoading, active]);

  // 切换到另一会话时，不能沿用上一会话的折叠数量。
  useEffect(() => {
    setHiddenMessageCount(0);
  }, [sessionId]);

  const historyLen = session.chatHistory.length;
  /** 期望折叠数：窗口保留最近 VISIBLE_HISTORY_LIMIT 条 */
  const wantHidden = Math.max(0, historyLen - VISIBLE_HISTORY_LIMIT);
  /**
   * 渲染期修正折叠计数（React 支持的"渲染中调整 state"模式：立即重渲染，不产生额外已绘制帧）。
   *
   * 触发条件是"折叠数超过了上限 len-1"，只有一种情况会造成它——上下文压缩把 chatHistory
   * 从几十条替换成几条，而计数还停在旧的大值上。不修正的话，下面这一帧的 slice 就会切空，
   * 对话区变成一片空白（白屏）。
   *
   * 为什么放在渲染期而不是 effect：effect 要等 paint 之后才跑，中间会真实绘制一帧
   * "只剩最后一条消息"的中间态——那看起来就是闪一下。修正后接 setState 立即重渲染，
   * 这个中间态不会被画出来。
   */
  if (hiddenMessageCount > Math.max(0, historyLen - 1)) {
    setHiddenMessageCount(wantHidden);
  }

  const visibleHistory = useMemo(
    // 再钳一道：即便上面那帧修正还没落地，也保证永远不切空
    () => session.chatHistory.slice(safeHiddenCount(hiddenMessageCount, historyLen)),
    [session.chatHistory, hiddenMessageCount, historyLen],
  );
  const restoreEarlierMessages = useCallback(() => {
    setHiddenMessageCount((count) => Math.max(0, count - RESTORE_HISTORY_BATCH_SIZE));
  }, []);

  // ── AI 回复状态的落位 ─────────────────────────────────────────────────
  // 状态（图标 + "思考中…"）跟着 AI 回复走，不再挂在输入框上方：
  // · AI 已建好 assistant 消息 → 由该消息自己的头部显示（liveAssistantStatus）
  // · 还没建（用户刚发出、stream_start 未到）→ 由列表 footer 用同一个头部占位
  const lastMessage = session.chatHistory[session.chatHistory.length - 1];
  const assistantTurnStarted = lastMessage?.role === "assistant" && !!lastMessage.streaming;
  const liveAssistantStatus = session.isLoading && assistantTurnStarted ? session.statusText : undefined;
  // 回复头部星芒的动作：等用户 > 压缩 > 输出正文 > 执行工具 > 思考
  const sparkMode: SparkMode =
    session.askUser || session.formRequest || session.toolConfirm || session.compactionNeeded
      || session.creditBudgetPaused || Object.keys(session.commandApprovals).length > 0
      ? "wait"
      : session.isCompacting
        ? "compact"
        : session.statusPhase === "responding"
          ? "write"
          : ["tool", "acting", "executing", "running"].includes(session.statusPhase)
            ? "tool"
            : "think";
  /**
   * 本轮（末尾往前数、遇到第一条 user 消息为止）是否已建出 assistant 消息、它是否仍在流式。
   *
   * ⚠️ 不能只看「最后一条消息」的角色。本轮结束之后还可能追加非 assistant 的消息——
   * 压缩成功时 handleCompactingEnd 追加的 `[上下文已压缩]`（role: system）就是一条——
   * 此时"最后一条不是 assistant"并不等于"本轮还没有 assistant 消息"，可只看最后一行的写法
   * 会把它当成后者，于是"进行中"的占位元素又在已有回复下方冒出来（早先那版
   * isLoading && !assistantTurnStarted 造成的"两个 Axon 连续出现"，就是同一类误判）。
   * 判据回到本源：往后找本轮属于本条回复的 assistant 消息，找到就是"消息已存在"。
   */
  const { turnAssistantExists, turnStreaming } = useMemo(() => {
    const history = session.chatHistory;
    let exists = false;
    let streaming = false;
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m.role === "user") break;          // 到本轮的提问为止，不再往前找
      if (m.role !== "assistant") continue;  // system 提示等：跳过，继续往前找本轮的 assistant
      exists = true;
      if (m.streaming) { streaming = true; break; }
    }
    return { turnAssistantExists: exists, turnStreaming: streaming };
  }, [session.chatHistory]);
  /**
   * 本轮是否**仍在进行**。
   *
   * isLoading 不能单独当这个判据：收尾它比消息终态慢——finishLoading 有 MIN_LOADING_MS
   * 最小展示时间（短轮次走 setTimeout 延后收），错误 / 取消 / 断线路径同样是先把消息落终态、
   * 再延后收 loading。这个窗口里 isLoading 仍为 true，任何"以 isLoading 为条件"的进行中
   * 呈现（吉祥物状态文字、列表尾部占位头部、滚动按钮脉动…）都会在回复已经结束之后再多冒一下。
   */
  const turnRunning = session.isLoading && (!turnAssistantExists || turnStreaming);
  /**
   * 占位头部只在「本轮 assistant 消息还没建出来」时显示。
   *
   * ⚠️ 不能写成 isLoading && !assistantTurnStarted。后者把「消息还在 streaming」当成了
   * 「消息存在」的判据，而这两件事并不同步：loading 收得比 streaming 慢是常态
   * （finishLoading 有 MIN_LOADING_MS 最小展示时间，短轮次走 setTimeout 延后收；
   * 断线 / 错误 / 取消路径同样会先把消息落终态、再延后收 loading）。
   * 于是那个条件在「消息已落终态、loading 未收」的窗口里恒真，footer 就在已有消息下方
   * 再渲染一个头部——而 AssistantTurnHeader 在 streaming 时不渲染品牌名，所以它是一个
   * 「只有图标、没有 Axon 文案」的光头，与消息自己的头部叠成「两个 Axon 连续出现」。
   *
   * 判据回到本源：消息一旦存在（无论是否还在流式），头部就归它自己管；只有当**本轮**
   * 还没有 assistant 消息（用户刚发出、assistant 尚未建立）时，才需要这个占位。
   */
  const showPendingAssistantHeader = session.isLoading && !turnAssistantExists;

  // 正在被 AI 回复的用户消息 ID（回复中不可编辑）
  const replyingToMessageId = useMemo(() => {
    if (!turnRunning || !session.chatHistory) return undefined;
    for (let i = session.chatHistory.length - 1; i >= 0; i--) {
      if ((session.chatHistory[i] as any).role === "user") {
        return (session.chatHistory[i] as any).id as string | undefined;
      }
    }
    return undefined;
  }, [turnRunning, session.chatHistory]);

  // ── 输入区编排（壳层本地状态） ──────────────────────────────────────────
  const [images, setImages] = useState<string[]>([]);
  /**
   * 上传的文件：和图片一样以卡片形式排在输入框顶部，而不是作为 inline tag 塞进编辑器。
   * inline 节点只适合几十像素高的标签；方形卡片放进文字行会把光标和行高一起撑乱。
   * 发送时与编辑器内的上下文 tag（终端/文件夹/诊断等）合并，doSend 的处理逻辑不变。
   */
  const [uploadedFiles, setUploadedFiles] = useState<(AttachedFile & { id: string })[]>([]);
  const [processingAttachments, setProcessingAttachments] = useState<ProcessingAttachment[]>([]);
  const cancelledAttachmentIds = useRef(new Set<string>());
  const [fileError, setFileError] = useState<string>("");
  const fileErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 设置文件错误提示，3 秒后自动消失。 */
  const showFileError = useCallback((msg: string) => {
    if (fileErrorTimer.current) clearTimeout(fileErrorTimer.current);
    setFileError(msg);
    if (msg) {
      fileErrorTimer.current = setTimeout(() => setFileError(""), 3000);
    }
  }, []);
  /** 手动关掉文件错误提示（状态条右侧的 ×）：同时清掉自动消失的定时器。 */
  const dismissFileError = useCallback(() => {
    if (fileErrorTimer.current) clearTimeout(fileErrorTimer.current);
    fileErrorTimer.current = null;
    setFileError("");
  }, []);
  const [composerEmpty, setComposerEmpty] = useState(true); // 编辑器是否为空（控制发送按钮可用态）
  /**
   * 空态首发的「落位动画」状态。
   * true = 正在播放输入框从居中下落到底部的过渡；动画结束后才真正发请求（见 handleSend）。
   */
  const [composerLanding, setComposerLanding] = useState(false);
  /**
   * 空态（新会话、没有任何消息）：输入框居中显示，像 Claude 的新对话页。
   *
   * 两个排除项：
   * - 会话历史加载中不算空态：那时还不知道到底有没有消息，先居中再跳回底部会闪一下。
   * - 落位动画期间不算空态：动画一开始就要让输入框往底部走，此时消息还没插入、
   *   chatHistory 仍是空的，不排除它的话 transform 目标不会变化、动画根本不会发生。
   */
  const composerCentered = session.chatHistory.length === 0 && !session.isLoadingSession && !composerLanding;
  /** 落位动画结束后要执行的发送动作（动画期间暂存，避免消息插入打断过渡） */
  const pendingSendRef = useRef<(() => void) | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // ── 产物目录 ──
  // 空串 = 未设置，后端落到默认位置 ~/.axon/artifacts/<会话id>/。
  // 存 localStorage 是面板级偏好（跨会话保留），不进会话数据：换会话不该丢掉用户选的目录。
  const [artifactDir, setArtifactDir] = useState<string>(() => {
    try { return localStorage.getItem(STORAGE.ARTIFACT_DIR) || ""; } catch { return ""; }
  });
  const pendingArtifactPickRef = useRef<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [axonPanelOpen, setAxonPanelOpen] = useState(false);
  const [axonStatuses, setAxonStatuses] = useState<WorkspaceAxonStatusItem[]>([]);
  const [axonStatusLoading, setAxonStatusLoading] = useState(false);
  /** 用户已忽略"未启用"提示的工作区，避免每轮都弹 */
  const [axonNoticeDismissed, setAxonNoticeDismissed] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("axon.workspaceAxonNoticeDismissed") || "[]") as unknown;
      return Array.isArray(saved) ? saved.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  });
  const [groupManagerOpen, setGroupManagerOpen] = useState(false);
  const [skillStudioOpen, setSkillStudioOpen] = useState(false);
  /** 图片查看器状态：当前图片组 + 索引（输入框图片与历史消息图片共用） */
  const [previewState, setPreviewState] = useState<{ images: string[]; index: number } | null>(null);
  // 问题列表 Popover 受控状态
  const [questionListOpen, setQuestionListOpen] = useState(false);
  // 顶部 sticky：当前视图所属 AI 回答对应的用户提问
  const [stickyQuestion, setStickyQuestion] = useState<{ id: string; text: string } | null>(null);
  // 条上显示的提问：隐藏时保留最后一条，淡出动画期间文字不会先消失
  const [shownStickyQuestion, setShownStickyQuestion] = useState<{ id: string; text: string } | null>(null);
  const lastStickyIdRef = useRef<string | null>(null);
  const pendingStickyQuestionRef = useRef<{ id: string; text: string } | null>(null);
  const stickyUpdateFrameRef = useRef<number | null>(null);

  const virtualListRef = useRef<VirtualMessageListHandle>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MentionEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);

  // ── 斜杠命令（/）：当前文件 / 搜索文件 / 搜索文件夹 / 诊断 ──────────────
  // QUEST（纯问答）模式去掉“问题/诊断”（诊断主要服务于 Agent 改代码场景），保留当前文件与文件/文件夹搜索
  const slashCommands = useMemo(
    () => (mode === "quest" ? DEFAULT_SLASH_COMMANDS.filter((c) => c.id !== "problems") : DEFAULT_SLASH_COMMANDS),
    [mode],
  );
  const slashHost = useSlashCommandHost(clientId, editorRef);
  const slashEditorBridge = useMemo(
    () => ({
      deleteBeforeCaret: (len: number) => editorRef.current?.deleteBeforeCaret(len),
      focus: () => editorRef.current?.focus(),
    }),
    [],
  );
  const slash = useSlashCommands({ host: slashHost, editor: slashEditorBridge, commands: slashCommands });

  // 输入框上沿的吉祥物：按 焦点 / 击键 / AI 忙 / 静默 切换表情
  const mascotAiState = turnRunning
    ? (assistantTurnStarted ? "thinking" : "waiting")
    : lastMessage?.role === "assistant" && lastMessage.turnStatus === "error"
      ? "error"
      : lastMessage?.role === "assistant" && lastMessage.turnStatus === "cancelled"
        ? "cancelled"
        : lastMessage?.role === "assistant" && lastMessage.turnStatus === "success"
          ? "done"
          : "idle";
  const mascot = useMascotMood(mascotAiState);
  // 吉祥物右侧的执行状态文字：AI 干活期间显示当前阶段（思考中/正在读取文件…）。
  // statusText 在本轮结束时被置空，这里再兜一个"执行中…"，避免恰好切到空串时闪烁。
  // ⚠️ 判据必须用 turnRunning 而不是 isLoading：本轮刚落终态、loading 还没收的那一小段里，
  // statusText 已被错误/取消路径清空，于是这里会兜出"执行中…"、或继续显示上一阶段的
  // "正在回复…"——回复都写完了，输入框上方却又冒出一个"还在干活"的指示。
  // （实测：逐帧采样下，消息头部已变成终态"Axon + Credits"之后，该文字仍多显示约 80~400ms。）
  const mascotStatusText = turnRunning ? session.statusText || "执行中…" : null;

  // 把"AI 是否正在输出"同步给诊断模块：界面卡死时用它判断"卡灰"是否与流式同时发生
  useEffect(() => {
    updateDiagState({ streaming: session.isLoading });
  }, [session.isLoading]);

  // ── 输入区版式：单行 / 多行 ──────────────────────────────────────────────
  // 只有一行文字时整块只有一行高：编辑区与工具栏并排（空态居中时例外，见 composerStacked）；
  // 内容超过一行（敲回车、粘贴多行、或长文本自动折行）时切成上下两段，并随内容继续长高。
  const [composerMultiline, setComposerMultiline] = useState(false);
  /** state 的同步镜像：同一次事件里可能连跑两遍判定，读 state 会拿到旧值 */
  const composerMultilineRef = useRef(false);
  // 空态居中时一律用上下两段的版式，并给编辑区留出几行高度：新对话页的输入框就是这一屏的主角，
  // 压成一行细条既不好点、也不像"从这里开始"。有消息之后再回到按内容判定的单行 / 多行。
  const composerStacked = composerMultiline || composerCentered;
  /** 输入区内容层：它的自然高度就是动画的目标高度 */
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const editorWrapRef = useRef<HTMLDivElement>(null);
  const toolbarLeftRef = useRef<HTMLDivElement>(null);
  const toolbarRightRef = useRef<HTMLDivElement>(null);
  const [inputAreaHeight, setInputAreaHeight] = useState<number | null>(null);
  /** 会话记忆是否已沉淀过内容（决定记忆图标的着色与状态点） */
  const hasMemory = session.memory.trim().length > 0;

  /**
   * 「如果现在切回单行版式，这行内容会不会折行？」
   *
   * 单行版式里编辑区被工具栏挤窄，多行版式里是满宽——同一段文字在两种版式下的行数可能不一样。
   * 不收这个口子，宽度刚好落在「满宽一行、窄版两行」区间的内容就会
   * 展开 → 折行 → 收起 → 不折行 → 展开……来回抖。
   *
   * 做法：把编辑区同步收窄到单行版式的可用宽度，量一次真实行数，再复原。三段都在同一个
   * JS 任务里完成（中间不会被绘制），所以看不到闪烁；而且只有「多行版式 + 当前只剩一行」
   * 这个边界才会走到（典型是删字删到只剩一行），不是每次按键都做。
   */
  const wouldWrapInCompactRow = useCallback((): boolean => {
    const editorEl = editorRef.current?.getEditorElement();
    const wrap = editorWrapRef.current;
    const leftW = toolbarLeftRef.current?.getBoundingClientRect().width ?? 0;
    const rightW = toolbarRightRef.current?.getBoundingClientRect().width ?? 0;
    // 量不到宽度就保守地留在多行：多行是"一定放得下"的那一侧，不会来回切
    if (!editorEl || !wrap || leftW <= 0) return true;
    // 单行版式下编辑区可用宽度 ≈ 满宽 - 工具栏自然宽 - 组间距 - 工具栏内边距。
    // 这里没扣掉「多行版式右内边距更大」那几十像素，量出来比实际窄一点——
    // 只会让刚好塞满一行的文本晚一步收窄，不会抖。
    const capacity = editorEl.clientWidth - leftW - rightW - COMPOSER_ROW_GAP - COMPOSER_TOOLBAR_PAD;
    if (capacity < COMPOSER_MIN_INLINE_EDITOR_WIDTH) return true;
    const style = window.getComputedStyle(wrap);
    const hPad = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
    const prevWidth = wrap.style.width;
    let wrapped = true;
    try {
      wrap.style.width = `${capacity + hPad}px`;
      // 读矩形会强制同步布局，量到的是收窄之后的真实排版
      wrapped = measureRenderedLines(editorEl) > 1;
    } finally {
      // 复原必须无条件执行：内联宽度留在收窄值上会把编辑区永久压窄
      wrap.style.width = prevWidth;
    }
    return wrapped;
  }, []);

  /**
   * 重新判定单行 / 多行。判据是真实排版高度，不是 "\n" 的个数。
   * 只在结果真的变了才 setState，避免每次按键都多渲染一遍输入区。
   */
  const evaluateComposerLayout = useCallback(() => {
    const editorEl = editorRef.current?.getEditorElement();
    if (!editorEl) return;
    let next = measureRenderedLines(editorEl) > 1;
    // 单行版式里编辑区已经被挤到没法用（面板太窄）：退回多行版式。
    // 反过来在多行版式里由 wouldWrapInCompactRow 按同一个阈值把关，两边一致不会来回切。
    // clientWidth 为 0 说明面板处于隐藏状态（量不到宽度），这时别据此判定。
    const inlineWidth = editorEl.clientWidth;
    if (!next && !composerMultilineRef.current && inlineWidth > 0 && inlineWidth < COMPOSER_MIN_INLINE_EDITOR_WIDTH) {
      next = true;
    }
    if (!next && composerMultilineRef.current) next = wouldWrapInCompactRow();
    if (next === composerMultilineRef.current) return;
    composerMultilineRef.current = next;
    setComposerMultiline(next);
  }, [wouldWrapInCompactRow]);

  // 编辑区宽度变化（面板拖拽 / 窗口缩放 / 版式切换本身）后重新判定。
  // 只认宽度：高度变化是本组件自己的排版产物，跟着它重算会和 ResizeObserver 形成回环。
  useEffect(() => {
    const wrap = editorWrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    let lastWidth = -1;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (Math.abs(width - lastWidth) < 0.5) return;
      lastWidth = width;
      evaluateComposerLayout();
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [evaluateComposerLayout]);

  // 高度动画的数据源：量内层（内容自然高度），写到外层的内联 height 上。
  // 分成两个元素是为了打破回环——内层高度不受外层的固定高度约束，外层也就不会量到自己。
  useEffect(() => {
    const inner = inputAreaRef.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const height = inner.getBoundingClientRect().height;
      if (height > 0) setInputAreaHeight(height); // 面板被隐藏时量到 0，别把盒子压没
    });
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  /** 编辑器内容变化：刷新空态 + 驱动斜杠检测 */
  const handleEditorChange = useCallback((before: string) => {
    setComposerEmpty(editorRef.current?.isEmpty() ?? true);
    slash.handleTextChange(before);
    // 内容一变就重判版式：变长（换行 / 折行 / 粘贴）展开，删回一行收起
    evaluateComposerLayout();
  }, [slash, evaluateComposerLayout]);

  /** 当前模型是否支持图片（含自定义 provider 模型，故走合并列表） */
  const models = useModels();
  const currentModelVision = models.find((m) => m.id === session.model)?.vision ?? false;
  const hasConfiguredSelection = models.some((m) => m.id === session.model && m.provider === session.provider);

  /** 识图兜底模型是否已配置（配置后，非多模态模型的图片行为与多模态一致，后端负责识图转文字） */
  const [visionFallbackModel, setVisionFallbackModelState] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getVisionFallbackModel(session.workspace || undefined)
      .then((r) => { if (!cancelled) setVisionFallbackModelState(r.model); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [session.workspace]);
  const canSendImages = currentModelVision || !!visionFallbackModel;

  // 命令审批 Context：把"按 toolCallId 索引的待审批项 + 决策回调"下发给对话流里的命令卡片
  const commandApprovalCtx = useMemo(
    () => ({ approvals: session.commandApprovals, onApprove: session.approveCommand, waitingInputIds: session.waitingInputIds }),
    [session.commandApprovals, session.approveCommand, session.waitingInputIds],
  );

  /** 用户提问文本（content 优先，回退到 userSegments 拼接），供 sticky 条展示 */
  const questionTextById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of session.chatHistory) {
      if (m.role !== "user") continue;
      let text = (m.content || "").trim();
      if (!text && m.userSegments && m.userSegments.length > 0) {
        text = m.userSegments.map((s) => (s.type === "text" ? s.text : s.tag?.name ?? "")).join("").trim();
      }
      map.set(m.id, text);
    }
    return map;
  }, [session.chatHistory]);
  /** 提问目录（标题栏按钮）的条目 */
  const userQuestions = useMemo(() => session.chatHistory
    .filter((m) => m.role === "user")
    .map((m) => ({
      id: m.id,
      text: questionTextById.get(m.id) || "",
      timestamp: m.timestamp,
      hasImage: !!(m.images && m.images.length > 0),
      files: m.attachedFiles?.map((f) => f.name),
    })), [session.chatHistory, questionTextById]);
  // 标题栏按钮位：标题栏随 Cowork 开关重新挂载时节点会换，每次渲染后重取（同一节点时 setState 直接跳过）
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 故意每次渲染后执行：节点换了要跟上
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 读 DOM 节点只能在提交后；同值时 React 不重渲染
    setHeaderSlot(active ? document.getElementById(SESSION_HEADER_SLOT_ID) : null);
  });
  const chatHistoryRef = useRef(session.chatHistory);
  const questionTextByIdRef = useRef(questionTextById);
  const hiddenMessageCountRef = useRef(hiddenMessageCount);
  chatHistoryRef.current = session.chatHistory;
  questionTextByIdRef.current = questionTextById;
  hiddenMessageCountRef.current = hiddenMessageCount;

  /** 点击 sticky 条：平滑滚动到对应提问处，落点刚好在 sticky 条下方一点 */
  const scrollToQuestion = useCallback((id: string) => {
    // 列表里只有切片后的消息，scrollToIndex 要的是切片内的索引（Virtuoso 的 scrollToIndex
    // 与 firstItemIndex 无关、始终从 0 起）。早先传的是在完整 chatHistory 里的下标，
    // 有消息被折叠时会跳到错的位置。
    const idx = visibleHistory.findIndex((m) => m.id === id);
    if (idx >= 0) virtualListRef.current?.scrollToIndex(idx, "smooth");
  }, [visibleHistory]);

  // ── 自动滚动 ──────────────────────────────────────────────────────────────
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "instant") => {
    setShowScrollBtn(false);
    virtualListRef.current?.scrollToBottom(behavior);
  }, []);

  const animatedScrollToBottom = useCallback(() => {
    setShowScrollBtn(false);
    virtualListRef.current?.scrollToBottom("smooth");
  }, []);

  // 列表滚动回调：只做 showScrollBtn（sticky 改由 onTopItemChange 驱动）
  const handleScrollRef = useRef<((scrollTopVal: number) => void) | null>(null);

  // sticky user question 检测：基于顶部可见消息 index，在数据数组里往前找最近的用户消息。
  // 不依赖 DOM（虚拟列表会移除滚出视口的元素），所以靠近底部也能稳定显示。
  // 只在这条提问已经滚出视口上方时显示：提问气泡还在屏幕上（它就是顶部那条）时再钉一遍是重复。
  const handleTopItemChange = useCallback((visibleTopIndex: number) => {
    const history = chatHistoryRef.current;
    const topIndex = visibleTopIndex + hiddenMessageCountRef.current;
    let current: { id: string; text: string } | null = null;
    for (let i = Math.min(topIndex, history.length - 1); i >= 0; i--) {
      const m = history[i];
      if (m.role === "user") {
        if (i < topIndex) current = { id: m.id, text: questionTextByIdRef.current.get(m.id) || "" };
        break;
      }
    }
    const nextId = current?.id ?? null;
    // rangeChanged 发生在 Virtuoso 的同步测量过程中。不能在这里直接 setState：
    // 流式内容变高 → 测量范围变化 → 更新 sticky → 列表重新测量，会形成嵌套更新循环。
    // 合并到下一帧后，测量与 React 更新不再位于同一个调用栈。
    pendingStickyQuestionRef.current = current && current.text ? current : null;
    if (stickyUpdateFrameRef.current !== null) return;
    if (nextId === lastStickyIdRef.current) return;
    stickyUpdateFrameRef.current = requestAnimationFrame(() => {
      stickyUpdateFrameRef.current = null;
      const next = pendingStickyQuestionRef.current;
      pendingStickyQuestionRef.current = null;
      const pendingId = next?.id ?? null;
      if (pendingId === lastStickyIdRef.current) return;
      lastStickyIdRef.current = pendingId;
      setStickyQuestion(next);
      if (next) setShownStickyQuestion(next);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (stickyUpdateFrameRef.current !== null) {
        cancelAnimationFrame(stickyUpdateFrameRef.current);
      }
    };
  }, []);

  handleScrollRef.current = (scrollTopVal: number) => {
    const state = virtualListRef.current?.getScrollState();
    if (state) {
      const distanceToBottom = state.scrollHeight - scrollTopVal - state.clientHeight;
      setShowScrollBtn(distanceToBottom > 200);
    }
  };

  const stableOnScroll = useCallback((scrollTopVal: number) => {
    handleScrollRef.current?.(scrollTopVal);
  }, []);

  // 撤销失败轻提示：3 秒后自动消失
  useEffect(() => {
    if (!session.undoNotice) return;
    const t = setTimeout(() => session.setUndoNotice(null), 3000);
    return () => clearTimeout(t);
  }, [session.undoNotice, session.setUndoNotice]);

  // 命令风险提醒：停留久一些（安全信息值得看清），但也会自动消失，避免长期占位
  useEffect(() => {
    if (!session.commandRiskNotice) return;
    const t = setTimeout(() => session.setCommandRiskNotice(null), 8000);
    return () => clearTimeout(t);
  }, [session.commandRiskNotice, session.setCommandRiskNotice]);

  // 会话清空时重置顶部 sticky 提问条
  useEffect(() => {
    if (session.chatHistory.length === 0) {
      lastStickyIdRef.current = null;
      setStickyQuestion(null);
    }
  }, [session.chatHistory.length]);

  // 持久化会话加载完成后滚到底部（window.reload / 切回历史会话）。
  // Virtuoso 需要时间渲染末尾消息并测量高度，多次调用确保到底。
  const prevLoadingRef = useRef(session.isLoadingSession);
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = session.isLoadingSession;
    if (!wasLoading || session.isLoadingSession || session.chatHistory.length === 0) return;
    // 多次滚动确保 virtuoso 完成渲染和测量
    const scroll = () => virtualListRef.current?.scrollToBottom("instant");
    scroll();
    requestAnimationFrame(scroll);
    setTimeout(scroll, 50);
    setTimeout(scroll, 150);
    setTimeout(scroll, 300);
  }, [session.isLoadingSession, session.chatHistory.length]);

  // 流式跟随已下沉到 VirtualMessageList 内部：由它按真实滚动位置（距底部 ≤ 10px）
  // 决定"钉底"还是"保持视界"。放在这里做不到——本组件拿不到滚轮以外的用户滚动
  // （拖滚动条、键盘翻页），也判断不出收尾那几帧的布局变化。

  // 切回该会话（变为可见）时自动滚到底部
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => scrollToBottom("instant"));
    return () => cancelAnimationFrame(id);
  }, [active, scrollToBottom]);

  // 连接断开时把用户最后一条问题回填到输入框
  useEffect(() => {
    if (!connected && session.isLoading) {
      const lastUserMsg = session.chatHistory.filter((m) => m.role === "user").pop();
      if (lastUserMsg?.content) {
        editorRef.current?.setText(lastUserMsg.content);
        setComposerEmpty(editorRef.current?.isEmpty() ?? false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // ── 发送 ──────────────────────────────────────────────────────────────────
  const doSend = (text: string, sendImgs: string[], sendFileList: AttachedFile[], segments: UserSegment[]) => {
    if (!hasConfiguredSelection) return;
    const sendImages = canSendImages ? sendImgs : [];
    const sendFiles = [...sendFileList];

    let contentForModel = text;
    if (sendFiles.length > 0) {
      const fileBlocks = sendFiles
        .map((f) => {
          if (f.kind === "terminal") return `终端输出（${f.name}）：\n\`\`\`\n${f.content}\n\`\`\``;
          if (f.kind === "editor") return `代码片段（${f.name}）：\n\`\`\`\n${f.content}\n\`\`\``;
          // 粘贴的长文本按纯文本发送：用户粘的是散文/日志，包成代码块会让模型当成源码读
          if (f.kind === "paste") return `粘贴文本（${f.name}）：\n${f.content}`;
          if (f.kind === "folder") return f.content;
          if (f.kind === "diagnostics") return `诊断信息（${f.name}）：\n\`\`\`\n${f.content}\n\`\`\``;
          // 大文件（已落盘）：只给路径 + 开头若干行，让模型自己决定读哪一段。
          //
          // 全文注入会一次性吃掉大半个上下文窗口，而且把"读哪里"的判断权从模型手里拿走了。
          // 给开头几行是为了让它知道这是什么文件（表头、格式、缩进风格），足够判断
          // 接下来该用 read_file 读哪个区间、还是先 search 定位关键词。
          //
          // 判据是体积而不是"有没有 path"：小文件现在也会落盘（为了支持点击预览），
          // 但它们该继续内联全文——几十行的文件让模型多走一轮工具调用纯属浪费。
          if (f.path && f.size > FILE_INLINE_MAX_SIZE) {
            const lines = f.content.split(/\r?\n/);
            const headLines = lines.slice(0, 40);
            const head = headLines.join("\n");
            const omitted = lines.length - headLines.length;
            return [
              `文件：${f.path}`,
              `共 ${lines.length} 行、${Math.round(f.size / 1024)} KB。这里只给出开头 ${headLines.length} 行；`,
              `需要更多内容时用 read_file 按行号区间读取，或用 search 定位关键词后再精读。`,
              "",
              "```",
              head,
              omitted > 0 ? `\n…（还有 ${omitted} 行未展示）` : "",
              "```",
            ].join("\n");
          }
          return `文件：${f.name}\n\`\`\`\n${f.content}\n\`\`\``;
        })
        .join("\n\n");
      contentForModel = text
        ? `${text}\n\n以下是我提供的上下文：\n\n${fileBlocks}`
        : `以下是我提供的上下文：\n\n${fileBlocks}`;
    }

    // 文档产出目录：用户显式指定过就随消息告知 Agent，覆盖 document-forge 的默认位置
    // （那个默认是"工作区 output/"，对办公场景等于找不到）。
    // 文档产出目录只属于 Cowork（CoworkPanel 自己维护那一套），Code/Chat 不再注入该偏好。

    const actualModel = session.model;
    const actualProvider = session.provider || findModel(session.model)?.provider;
    const effortModel = actualProvider
      ? models.find((m) => m.id === actualModel && m.provider === actualProvider)
      : findModel(actualModel);
    // Provider 配置可能在当前页面打开期间刷新/删除档位；只发送仍在当前模型白名单里的值。
    const actualEffort = effortModel?.effortLevels?.some((x) => x.value === session.effort) ? session.effort || undefined : undefined;

    const payload: SubmitPayload = {
      userBubble: {
        content: text,
        images: sendImages.length > 0 ? [...sendImages] : undefined,
        attachedFiles: sendFiles.length > 0 ? sendFiles : undefined,
        segments: segments.length > 0 ? segments : undefined,
        effort: actualEffort,
      },
      send: {
        content: contentForModel,
        displayText: text,
        attachedFiles: sendFiles.length > 0 ? sendFiles.map((f) => ({ name: f.name, size: f.size })) : undefined,
        userSegments: segments.length > 0 ? segments : undefined,
        model: actualModel,
        provider: actualProvider,
        images: sendImages.length > 0 ? sendImages : undefined,
        workspace: mode === "quest" ? undefined : (session.workspace || undefined),
        workspaces: mode === "quest" ? undefined : (session.workspaces.length > 0 ? session.workspaces : undefined),
        mode,
        think: session.think,
        effort: actualEffort,
        quest: mode === "quest" ? { webSearch: session.questWebSearch } : undefined,
        // 空串不下发：后端把「缺省」解释为「用默认位置」，省得协议里出现两种等价的空值
        artifactDir: artifactDir || undefined,
      },
    };

    const queued = session.submit(payload);
    if (!queued) {
      // submit 会先更新 chatHistory/isLoading，footer 的“思考中...”占位随后才挂载；
      // 发送瞬间滚动时 Virtuoso 还看不到这个 footer，导致视口停在上一条消息上。
      // 连续补两帧，分别覆盖 React 提交和 Virtuoso 测量完成后的时序。
      requestAnimationFrame(() => {
        scrollToBottom("smooth");
        requestAnimationFrame(() => scrollToBottom("instant"));
      });
      editorRef.current?.focus();
    }
  };

  const handleSend = () => {
    if (session.isCompacting || session.contextOverflow) return;
    if (processingAttachments.length > 0) {
      showFileError("附件仍在处理中，请稍候再发送");
      return;
    }
    // 无工作区时不允许发送——引导用户先添加工作区
    if (mode !== "quest" && session.workspacesLoaded && !session.workspace && session.workspaces.length === 0) {
      setPickerOpen(true);
      return;
    }
    const { text, tags, segments } = editorRef.current?.read() ?? { text: "", tags: [], segments: [] };
    const sendTags: AttachedFile[] = [...uploadedFiles.map(({ id: _id, ...file }) => file), ...tags];
    if (!text && images.length === 0 && sendTags.length === 0) return;
    pushHistory(text);

    // 空态首次发送：先播放"输入框从居中落到底部"的动画，等动画跑完再真正发请求。
    // 为什么要等：doSend 会立刻插入用户消息并开始流式输出，消息列表随即撑开高度，
    // 把正在做 transform 的输入框挤走——动画会被打断成一次突兀的跳变。
    if (composerCentered) {
      setComposerLanding(true);
      // 输入框立即清空，和普通发送的手感一致（不要让文字留在框里跟着动画一起飞）
      editorRef.current?.clear();
      setComposerEmpty(true);
      setImages([]);
      setUploadedFiles([]);
      showFileError("");
      pendingSendRef.current = () => doSend(text, images, sendTags, segments);
      return;
    }

    doSend(text, images, sendTags, segments);
    editorRef.current?.clear();
    setComposerEmpty(true);
    setImages([]);
    setUploadedFiles([]);
    showFileError("");
  };

  // ── 输入历史栈（上下箭头切换） ────────────────────────────────────────────
  const MAX_INPUT_HISTORY = 50;
  const inputHistory = useRef<string[]>([]); // 已发送的历史消息
  const historyIndex = useRef(-1); // 当前浏览位置：-1 = 草稿（未进入历史）
  const draft = useRef(""); // 用户当前正在编辑但未发送的草稿

  /** 发送时记录历史 */
  const pushHistory = useCallback((text: string) => {
    if (!text.trim()) return;
    // 去重：连续发送相同内容不重复记录
    if (inputHistory.current[inputHistory.current.length - 1] === text) return;
    inputHistory.current.push(text);
    if (inputHistory.current.length > MAX_INPUT_HISTORY) {
      inputHistory.current.shift(); // 丢弃最旧的
    }
    historyIndex.current = -1;
    draft.current = "";
  }, []);

  /**
   * 判断光标是否位于「首行行首」（checkTop=true）或「末行行尾」（checkTop=false）。
   * 用于上下箭头切换历史的触发条件——与终端 bash/zsh 行为一致：
   *   ↑ 只有在光标已在本行最前面时才翻历史，否则让光标正常上移
   *   ↓ 只有在光标已在本行最后面时才翻历史，否则让光标正常下移
   * contentEditable 可能有多个文本节点 + tag 节点，需综合判断。
   */
  const caretAtLineEdge = useCallback((checkTop: boolean): boolean => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return false;
    const el = editorRef.current?.getEditorElement();
    if (!el || !el.contains(sel.focusNode)) return false;

    // 光标未选中范围（collapsed）才判断，有选区时不拦截
    if (!sel.isCollapsed) return false;

    if (checkTop) {
      // ── 判断「首行行首」：光标在整个编辑器内容的最前面 ──
      const range = document.createRange();
      range.selectNodeContents(el);
      range.setEnd(sel.focusNode!, sel.focusOffset);
      const before = range.toString();
      return before.length === 0;
    } else {
      // ── 判断「末行行尾」：光标在整个编辑器内容的最后面 ──
      const range = document.createRange();
      range.selectNodeContents(el);
      range.setStart(sel.focusNode!, sel.focusOffset);
      const after = range.toString();
      return after.length === 0;
    }
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }
    // 上下箭头切换历史：仅在「光标位于首行行首（↑）/末行行尾（↓）」时拦截，
    // 其余位置让光标正常移动（用户可在文本内自由导航）。与终端 bash/zsh 行为一致。
    const isUp = e.key === "ArrowUp";
    const isDown = e.key === "ArrowDown";
    if ((isUp || isDown) && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const atEdge = caretAtLineEdge(isUp); // ↑查行首，↓查行尾
      if (!atEdge) return; // 光标不在边缘 → 不拦截，光标正常移动

      const currentText = editorRef.current?.read().text || "";
      if (isUp) {
        // 首次按上：保存当前草稿
        if (historyIndex.current === -1) {
          draft.current = currentText;
        }
        const newIdx = historyIndex.current + 1;
        const histLen = inputHistory.current.length;
        if (newIdx < histLen) {
          historyIndex.current = newIdx;
          const histText = inputHistory.current[histLen - 1 - newIdx];
          editorRef.current?.setText(histText);
          e.preventDefault();
        }
      } else {
        // 按下：往新方向走
        if (historyIndex.current > 0) {
          historyIndex.current--;
          const histLen = inputHistory.current.length;
          const histText = inputHistory.current[histLen - 1 - historyIndex.current];
          editorRef.current?.setText(histText);
          e.preventDefault();
        } else if (historyIndex.current === 0) {
          // 回到草稿
          historyIndex.current = -1;
          editorRef.current?.setText(draft.current);
          e.preventDefault();
        }
      }
    }
  };

  const handleModelChange = (newModel: string, providerName?: string) => {
    const targetModel = providerName
      ? getModels().find((m) => m.id === newModel && m.provider === providerName)
      : findModel(newModel);
    if (images.length > 0 && targetModel && !targetModel.vision && !visionFallbackModel) return; // 有图片且未配置识图兜底时，禁止切到不支持 vision 的模型
    // 强度档位是模型专属配置：优先恢复该 provider:model 的用户偏好；从未设置才用模型默认值。
    session.setEffort(resolveEffortForModel(targetModel));
    session.setModel(newModel, providerName);
  };

  // 模型/强度联动与 Cowork 面板共用同一套实现，避免两处对"配置失效如何回落"的判断漂移。
  const {
    levels: selectedEffortLevels,
    defaultEffort: selectedDefaultEffort,
    handleEffortChange,
  } = useModelEffort({
    model: session.model,
    provider: session.provider,
    effort: session.effort,
    setEffort: session.setEffort,
    models,
  });

  // ── 图片/文件处理 ──────────────────────────────────────────────────────────
  const fileToBase64 = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.onabort = () => reject(new Error("图片读取已取消"));
    reader.readAsDataURL(file);
  });

  /** data URL 的实际字节数（base64 部分长度 × 3/4，忽略 padding 的微小误差）。 */
  const dataUrlBytes = (dataUrl: string): number => {
    const comma = dataUrl.indexOf(",");
    const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    return Math.floor(b64.length * 0.75);
  };

  /**
   * 规范化图片：无条件经 canvas 重编码，保证尺寸与编码后体积都可控。
   * - 尺寸超过 maxDim(2000px) 时等比缩小
   * - 统一重编码为 JPEG；若编码后仍超过 maxBytes(1.5MB)，逐级降质量(0.85→0.7→0.55→0.4)重压
   * - 带透明通道的小 PNG（可能是图标/带 alpha 的截图）尺寸和体积都达标时保留 PNG，避免透明变黑底
   */
  const normalizeImage = (dataUrl: string, maxDim = 2000, maxBytes = 1.5 * 1024 * 1024): Promise<string> => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const { width, height } = img;
      const isPng = dataUrl.startsWith("data:image/png");
      const overDim = width > maxDim || height > maxDim;
      const overBytes = dataUrlBytes(dataUrl) > maxBytes;
      // 尺寸和体积都达标：小 PNG 直接原样保留（保护透明通道），其余也无需重编码
      if (!overDim && !overBytes) { resolve(dataUrl); return; }

      const scale = overDim ? maxDim / Math.max(width, height) : 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) { resolve(dataUrl); return; }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // 仅缩了尺寸、未超体积，且原图是 PNG：保留 PNG（不破坏透明）
      if (isPng && !overBytes) {
        const png = canvas.toDataURL("image/png");
        if (dataUrlBytes(png) <= maxBytes) { resolve(png); return; }
      }

      // 统一 JPEG，逐级降质量直到达标
      const qualities = [0.85, 0.7, 0.55, 0.4];
      let out = canvas.toDataURL("image/jpeg", qualities[0]);
      for (let q = 1; q < qualities.length && dataUrlBytes(out) > maxBytes; q++) {
        out = canvas.toDataURL("image/jpeg", qualities[q]);
      }
      resolve(out);
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });

  const addImages = async (files: FileList | File[]) => {
    if (!canSendImages) return;
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const tasks = imageFiles.map(async (file) => {
      const id = `image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setProcessingAttachments((prev) => [...prev, { id, name: file.name || "图片", kind: "image", size: file.size }]);
      try {
        const base64 = await fileToBase64(file);
        const resized = await normalizeImage(base64);
        if (!cancelledAttachmentIds.current.has(id)) setImages((prev) => [...prev, resized]);
      } catch {
        if (!cancelledAttachmentIds.current.has(id)) showFileError(`${file.name || "图片"}：处理失败`);
      } finally {
        setProcessingAttachments((prev) => prev.filter((item) => item.id !== id));
        cancelledAttachmentIds.current.delete(id);
      }
    });
    await Promise.all(tasks);
  };

  const captureScreenshot = async () => {
    if (!canSendImages) {
      showFileError("当前模型不支持图片，无法使用截图");
      return;
    }

    // VS Code webview 环境：getDisplayMedia 不可靠（iframe 沙箱限制），
    // 直接走剪贴板读取（用户用 Win+Shift+S 截图后点此按钮粘贴）。
    const isVscode = typeof (window as any).acquireVsCodeApi === "function";

    if (!isVscode && navigator.mediaDevices?.getDisplayMedia) {
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const track = stream.getVideoTracks()[0];
        const video = document.createElement("video");
        video.srcObject = stream;
        await video.play();
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx || canvas.width === 0) throw new Error("无法读取画面");
        ctx.drawImage(video, 0, 0);
        const dataUrl = canvas.toDataURL("image/png");
        track.stop();
        const resized = await normalizeImage(dataUrl);
        setImages((prev) => [...prev, resized]);
        showFileError("");
        return;
      } catch (err) {
        if ((err as Error).name !== "NotAllowedError") {
          console.warn("[screenshot] getDisplayMedia 失败,尝试剪贴板降级:", err);
        } else {
          return;
        }
      } finally {
        stream?.getTracks().forEach((t) => t.stop());
      }
    }

    // 剪贴板读取（webview 环境主路径 / 浏览器降级路径）
    if (navigator.clipboard?.read) {
      try {
        const items = await navigator.clipboard.read();
        let found = false;
        for (const item of items) {
          const imageType = item.types.find((t) => t.startsWith("image/"));
          if (imageType) {
            const blob = await item.getType(imageType);
            const dataUrl = await new Promise<string>((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.readAsDataURL(blob);
            });
            const resized = await normalizeImage(dataUrl);
            setImages((prev) => [...prev, resized]);
            found = true;
            break;
          }
        }
        if (!found) {
          showFileError("剪贴板中没有图片。请先截图（Windows: Win+Shift+S / macOS: Cmd+Shift+4 / Linux: 选区截图），再点此按钮");
        } else {
          showFileError("");
        }
      } catch (err) {
        if ((err as Error).name === "NotAllowedError") {
          showFileError("浏览器拒绝了剪贴板访问权限，请在权限提示中点击「允许」");
        } else {
          showFileError(`读取剪贴板失败：${(err as Error).message}`);
        }
      }
      return;
    }

    // webview 且无 clipboard.read：引导用户用粘贴
    showFileError(isVscode
      ? "请截图（Windows: Win+Shift+S / macOS: Cmd+Shift+4 / Linux: 选区截图）后，直接在输入框 Ctrl+V 粘贴"
      : "当前环境不支持截图（需要 HTTPS 或浏览器剪贴板权限）");
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    if (!canSendImages) return;
    const files = e.clipboardData.files;
    if (files.length > 0) {
      e.preventDefault();
      addImages(files);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    // 1) 操作系统文件拖入（dataTransfer.files）
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      const imgs = files.filter((f) => f.type.startsWith("image/"));
      const docs = files.filter((f) => !f.type.startsWith("image/"));
      if (imgs.length > 0 && canSendImages) addImages(imgs);
      if (docs.length > 0) addFiles(docs);
      return;
    }
    // 2) VS Code 文件树拖入（text/uri-list 或 text/plain 含 file:// URI）
    const uriList = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain") || "";
    if (uriList) {
      const uris = uriList.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
      const filePaths: string[] = [];
      for (const uri of uris) {
        try {
          if (uri.startsWith("file://")) {
            const decoded = decodeURIComponent(uri.replace(/^file:\/\/\/?/, ""));
            const path = /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
            filePaths.push(path);
          } else if (/^[A-Za-z]:[\\/]/.test(uri) || uri.startsWith("/")) {
            filePaths.push(uri);
          }
        } catch { /* ignore malformed URI */ }
      }
      if (filePaths.length > 0) {
        // 通过扩展后端读取文件内容后注入 tag
        session.send({ type: "read_dropped_files", paths: filePaths });
      }
    }
  };

  const removeImage = (index: number) => setImages((prev) => prev.filter((_, i) => i !== index));
  const cancelProcessingAttachment = (id: string) => {
    cancelledAttachmentIds.current.add(id);
    setProcessingAttachments((prev) => prev.filter((item) => item.id !== id));
  };

  // 监听 IDE Shell 原生 drop 转发的 explorer_drop 消息（从文件树拖文件到 Axon webview 容器）
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const data = e.data;
      if (!data || typeof data !== "object" || data.type !== "explorer_drop") return;
      const uris = data.uris as string[] | undefined;
      if (!Array.isArray(uris) || uris.length === 0) return;
      const filePaths: string[] = [];
      for (const uri of uris) {
        try {
          if (uri.startsWith("file://")) {
            const decoded = decodeURIComponent(uri.replace(/^file:\/\/\/?/, ""));
            const path = /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
            filePaths.push(path);
          } else if (/^[A-Za-z]:[\\/]/.test(uri) || uri.startsWith("/")) {
            filePaths.push(uri);
          }
        } catch { /* ignore */ }
      }
      if (filePaths.length > 0) {
        session.send({ type: "read_dropped_files", paths: filePaths });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [session]);

  const readFileAsText = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string) ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });

  /**
   * 请求宿主把上传内容落盘到系统临时目录，拿回绝对路径。
   *
   * 拿不到路径（非 webview 环境、写盘失败、超时）时返回 undefined —— 调用方会退回
   * 内联正文。宁可多占一些上下文，也不能让上传本身失败。
   */
  const stashUpload = (name: string, content: string): Promise<string | undefined> => {
    const host = (window as unknown as { __axonVSCode?: { postMessage: (m: unknown) => void } }).__axonVSCode;
    if (!host) return Promise.resolve(undefined);
    return new Promise<string | undefined>((resolve) => {
      const requestId = `stash-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let settled = false;
      const done = (value?: string) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        resolve(value);
      };
      const onMessage = (ev: MessageEvent) => {
        const msg = ev.data as { type?: string; requestId?: string; path?: string };
        if (msg?.type !== "upload_stashed" || msg.requestId !== requestId) return;
        done(typeof msg.path === "string" ? msg.path : undefined);
      };
      window.addEventListener("message", onMessage);
      host.postMessage({ type: "stash_upload", clientId, requestId, name, content });
      // 超时兜底：宿主无响应时退回内联，不能让上传卡住
      window.setTimeout(() => done(undefined), 5000);
    });
  };

  const addFiles = async (files: FileList | File[]) => {
    showFileError("");
    const list = Array.from(files);
    const errors: string[] = [];
    let added = 0;
    for (const file of list) {
      if (!isAllowedTextFile(file.name)) { errors.push(`${file.name}：不支持的文件类型`); continue; }
      if (file.size > FILE_MAX_SIZE) { errors.push(`${file.name}：超过 ${Math.round(FILE_MAX_SIZE / 1024)}KB 限制`); continue; }
      const id = `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      setProcessingAttachments((prev) => [...prev, { id, name: file.name, kind: "file", size: file.size }]);
      try {
        const content = await readFileAsText(file);
        if (cancelledAttachmentIds.current.has(id)) continue;
        if (looksBinary(content)) { errors.push(`${file.name}：疑似二进制文件，已跳过`); continue; }
        // 一律落盘到临时目录，拿一个真实路径。两个用途：
        // ① 点卡片预览时宿主按路径读盘（预览窗在 workbench 层，拿不到 webview 的内存内容）；
        // ② 大文件发送时只给路径不给全文，让 Agent 用 read_file 自己分段读。
        // 落盘失败不影响上传——只是失去预览入口，大文件会退回内联正文。
        const stashedPath = await stashUpload(file.name, content);
        if (cancelledAttachmentIds.current.has(id)) continue;
        setUploadedFiles((prev) => [...prev, { id, name: file.name, content, size: file.size, kind: "file", path: stashedPath }]);
        added++;
      } catch {
        if (!cancelledAttachmentIds.current.has(id)) errors.push(`${file.name}：读取失败`);
      } finally {
        setProcessingAttachments((prev) => prev.filter((item) => item.id !== id));
        cancelledAttachmentIds.current.delete(id);
      }
    }
    if (added > 0) setComposerEmpty(false);
    if (errors.length > 0) showFileError(errors.join("；"));
  };

  // 接收外部注入的上下文 → 作为内联 tag 插入编辑器。
  // 带 contextId（斜杠命令触发，已先插入占位 tag）→ 补全该 tag；否则（终端/编辑器选区）→ 在光标处插入新 tag。
  const updateArtifactDir = useCallback((dir: string) => {
    setArtifactDir(dir);
    try {
      if (dir) localStorage.setItem(STORAGE.ARTIFACT_DIR, dir);
      else localStorage.removeItem(STORAGE.ARTIFACT_DIR);
    } catch { /* 忽略写入失败 */ }
  }, []);

  /** 请求宿主弹出系统目录选择框；浏览器形态没有宿主，无法选目录，直接忽略 */
  const pickArtifactDir = useCallback(() => {
    const host = (window as unknown as { __axonVSCode?: { postMessage: (m: unknown) => void } }).__axonVSCode;
    if (!host) return;
    const requestId = `artifact-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingArtifactPickRef.current = requestId;
    host.postMessage({ type: "pick_artifact_dir", clientId, requestId, initialPath: artifactDir });
  }, [clientId, artifactDir]);

  // 工作区变化时只读探测一次 .axon 现状：供"未启用"轻提示与状态面板使用。
  // 只发查询命令，绝不触发创建；探测失败也不打扰正常对话。
  useEffect(() => {
    if (!connected || !session.workspace) return;
    setAxonStatusLoading(true);
    send({ type: "inspect_workspace_axon", clientId, sessionId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, session.workspace, clientId, sessionId]);

  useSessionEvents(clientId, useCallback((msg) => {
    if (msg.type === "workspace_axon_proposal") {
      const proposal = msg as { workspace?: string; content?: string };
      setAxonProposal(proposal.workspace && proposal.content ? { workspace: proposal.workspace, content: proposal.content } : null);
      setAxonProposalLoading(false);
      return;
    }
    if (msg.type === "workspace_axon_status") {
      const status = msg as { workspaces?: WorkspaceAxonStatusItem[] };
      setAxonStatuses(Array.isArray(status.workspaces) ? status.workspaces : []);
      setAxonStatusLoading(false);
      return;
    }
    if (msg.type === "workspace_axon_initialized") {
      setAxonProposal(null);
      setAxonProposalLoading(false);
      // 初始化后立刻回读一次，列表与"未启用"提示同步到最新状态
      send({ type: "inspect_workspace_axon", clientId, sessionId });
      return;
    }
    if (msg.type === "workspace_error") {
      setAxonProposalLoading(false);
    }
    // 宿主选完产物目录后的回包。requestId 对不上说明是别的面板/过期的请求，直接忽略。
    if (msg.type === "artifact_dir_picked") {
      const r = msg as { requestId?: string; path?: string; error?: string };
      if (r.requestId !== pendingArtifactPickRef.current) return;
      pendingArtifactPickRef.current = null;
      if (r.path) updateArtifactDir(r.path);
      return;
    }
    if (msg.type !== CONTROL_CMD.ADD_CONTEXT) return;
    const text = (msg as { text?: string }).text;
    if (text === undefined) return;
    const rawSource = (msg as { source?: string }).source;
    const kind: AttachedFile["kind"] =
      rawSource === "editor" ? "editor"
        : rawSource === "file" ? "file"
          : rawSource === "folder" ? "folder"
            : rawSource === "diagnostics" ? "diagnostics"
              : "terminal";
    const fallbackLabel =
      kind === "editor" ? "代码片段"
        : kind === "file" ? "文件"
          : kind === "folder" ? "文件夹"
            : kind === "diagnostics" ? "诊断"
              : "终端选区";
    const label = (msg as { label?: string }).label || fallbackLabel;
    const sizeRaw = (msg as { size?: number }).size;
    const size = typeof sizeRaw === "number" ? sizeRaw : text.length;
    const contextId = (msg as { contextId?: string }).contextId;
    if (contextId) {
      editorRef.current?.updateTag(contextId, { name: label, content: text, size, kind });
    } else {
      editorRef.current?.insertTag({ name: label, content: text, size, kind });
    }
    setComposerEmpty(editorRef.current?.isEmpty() ?? false);

    // 一键操作：解释 / 找 bug / 写测试 / 重构
    // ⚠️ 不能用 setText()：它会 clear dataMap，导致刚插入的代码 tag 丢失
    const quickAction = (msg as { quickAction?: string }).quickAction;
    if (quickAction) {
      const prompts: Record<string, string> = {
        explain: "请解释以下代码",
        findBug: "请帮我检查以下代码是否有bug",
        test: "请为以下代码写单元测试",
        refactor: "请重构以下代码，提高可读性和可维护性",
      };
      const prompt = prompts[quickAction];
      if (prompt) {
        editorRef.current?.appendText(prompt);
        setComposerEmpty(false);
        // 等 React 渲染完 tag 后再提交
        requestAnimationFrame(() => handleSendRef.current());
      }
    }
  }, [clientId, updateArtifactDir]));

  // quickAction auto-send：handleSend 在 add_context 回调外定义，用 ref 桥接
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;

  /**
   * 空态提示词块：把预置文案填进输入框并聚焦，不直接发送。
   * 这些文案都是半句起手式（"帮我分析这段代码："），用户几乎总要接着补自己的上下文；
   * 点一下就发出去只会换回一句"请提供代码"，白跑一轮。
   * 「随便聊」传空串，此时只聚焦输入框，相当于一个"我就是想开个空白对话"的确认动作。
   */
  /**
   * 内联表单提交：把用户填写的内容整理成一条用户消息发给 AI。
   *
   * 不新增协议——内联表单没有挂起门，提交在语义上就是「用户说了这段话」，
   * 走与输入框完全相同的一条链路，排队/取消/计费/历史回放因此自动与手打消息一致。
   */
  const inlineFormCtx = useMemo(
    () => ({
      submit: (spec: FormSpecData, payload: FormSubmitData) => {
        const text = formatInlineFormMessage(spec, payload);
        const actualModel = session.model;
        const actualProvider = session.provider || findModel(session.model)?.provider;
        const effortModel = findModel(actualModel);
        const actualEffort = effortModel?.effortLevels?.some((x) => x.value === session.effort) ? session.effort || undefined : undefined;
        session.submit({
          userBubble: { content: text, effort: actualEffort },
          send: {
            content: text,
            displayText: text,
            model: actualModel,
            provider: actualProvider,
            workspace: mode === "quest" ? undefined : (session.workspace || undefined),
            workspaces: mode === "quest" ? undefined : (session.workspaces.length > 0 ? session.workspaces : undefined),
            mode,
            think: session.think,
            effort: actualEffort,
            quest: mode === "quest" ? { webSearch: session.questWebSearch } : undefined,
          },
        });
      },
    }),
    [session, mode],
  );

  const handlePickPrompt = useCallback((prompt: string) => {
    if (prompt) {
      editorRef.current?.appendText(prompt);
      setComposerEmpty(editorRef.current?.isEmpty() ?? false);
    }
    editorRef.current?.focus();
  }, []);

  /**
   * 落位动画跑完后，把暂存的发送动作真正执行掉。
   *
   * 用定时器而不是 transitionend：后者在过渡被打断、元素中途被隐藏（切走 tab）或用户
   * 系统开了 reduce-motion 时可能压根不触发，那条消息就永远发不出去了——宁可按固定时长
   * 兜底，也不能让用户的输入凭空消失。
   */
  useEffect(() => {
    if (!composerLanding) return;
    const timer = setTimeout(() => {
      const send = pendingSendRef.current;
      pendingSendRef.current = null;
      setComposerLanding(false);
      send?.();
    }, COMPOSER_LANDING_MS);
    return () => clearTimeout(timer);
  }, [composerLanding]);
  // Skill Studio 整页接管
  if (skillStudioOpen) {
    return <SkillStudio workspace={session.workspace} onBack={() => setSkillStudioOpen(false)} />;
  }

  /**
   * 输入框上方状态条的条目集合（「提示类」提示）。
   *
   * 这些提示原先全部平铺在输入框容器【内部】，每多一条就把输入框顶高一截；现在统一交给
   * NoticeBar 收敛成上面一条满宽胶囊：单条按自己的样式渲染，多条自动合成一条汇总。
   * 这里只做「业务状态 → NoticeItem」的映射，文案与回调沿用原来的语义：
   * · 自动消失仍由各自的定时器负责（fileError 3s、undoNotice 3s、commandRiskNotice 8s，
   *   见上方的 showFileError 与两个 useEffect）；
   * · 关闭、动作按钮、按钮禁用条件与原先完全一致，不新增也不减少可执行的操作。
   * 决策类提示（工具确认 / 压缩选择 / Credits 暂停）不在此列，它们留在输入框内部。
   */
  const noticeItems: NoticeItem[] = [];
  /**
   * 主工作区没启用 .axon 时给一条轻提示。只提示、不创建——初始化必须由用户点。
   * 已忽略过的工作区记在 localStorage，避免每轮重复打扰。
   */
  const primaryAxonStatus = axonStatuses.find((item) => item.workspace === session.workspace);
  if (
    session.workspace
    && primaryAxonStatus
    && !primaryAxonStatus.hasAxonMd
    && !axonNoticeDismissed.includes(session.workspace)
  ) {
    const targetWorkspace = session.workspace;
    noticeItems.push({
      id: "axon-workspace-not-initialized",
      tone: "info",
      title: "此工作区未启用 Axon 配置",
      detail: `${targetWorkspace} 还没有 .axon/AXON.md，项目约定与长期知识不会被自动带入。`,
      actions: [
        {
          label: "初始化",
          onClick: () => send({ type: "initialize_workspace", workspace: targetWorkspace, clientId, sessionId }),
        },
        {
          label: "查看全部工作区",
          onClick: () => {
            setAxonPanelOpen(true);
            send({ type: "inspect_workspace_axon", clientId, sessionId });
          },
        },
      ],
      onDismiss: () => {
        const next = [...axonNoticeDismissed, targetWorkspace];
        setAxonNoticeDismissed(next);
        try {
          localStorage.setItem("axon.workspaceAxonNoticeDismissed", JSON.stringify(next));
        } catch { /* 忽略写入失败 */ }
      },
    });
  }
  // 1) 文件 / 附件错误（3 秒自动消失，可手动关）
  if (fileError) {
    noticeItems.push({
      id: "file-error",
      tone: "error",
      title: "文件处理失败",
      detail: fileError,
      onDismiss: dismissFileError,
    });
  }
  // 2) 撤销失败轻提示（保守策略：文件未被改动）。3 秒后自动消失，也可手动关
  if (session.undoNotice) {
    noticeItems.push({
      id: "undo-notice",
      tone: "warn",
      title: "撤销未生效",
      detail: session.undoNotice.text,
      onDismiss: () => session.setUndoNotice(null),
    });
  }
  // 3) 命令风险提醒：已信任的命令命中风险模式（如递归删除）时照常执行，这里只做提示、
  //    不需要应答。8 秒后自动消失，也可手动关闭。
  if (session.commandRiskNotice) {
    noticeItems.push({
      id: "command-risk",
      tone: "warn",
      title: "风险提醒（命令已执行）",
      detail: `${session.commandRiskNotice.command} · 原因：${session.commandRiskNotice.reason}`,
      // 命令行与原因合起来通常很长，条上必然被截断，给浮层看全文
      expandable: true,
      onDismiss: session.dismissCommandRiskNotice,
    });
  }
  // 4) 上下文超限：引导用户压缩上下文（不压缩就没法继续对话）
  if (session.contextOverflow) {
    noticeItems.push({
      id: "context-overflow",
      tone: "warn",
      title: "上下文超出模型窗口限制",
      detail: "无法继续对话，需先压缩上下文",
      actions: [{ label: "压缩上下文", onClick: session.forceCompact }],
      onDismiss: session.dismissContextOverflow,
    });
  }
  // 5) 模型历史格式不兼容：deepseek 输出 DSML 退化时出现，用户主动整理不兼容记忆
  if (session.toolHistoryMismatch) {
    noticeItems.push({
      id: "tool-history-mismatch",
      tone: "warn",
      title: "检测到模型工具调用格式不兼容",
      detail: "历史记忆里可能残留了其它模型的工具调用痕迹，建议整理记忆让模型恢复稳定",
      expandable: true,
      actions: [{ label: "整理记忆", onClick: session.flattenToolHistory }],
      onDismiss: session.dismissToolHistoryMismatch,
    });
  }
  // 6) 会话已压缩并迁移：输入框此时不可用，引导跳转到新会话
  if (session.compactionMigrated) {
    const migratedSessionId = session.compactionMigrated.newSessionId;
    noticeItems.push({
      id: "compaction-migrated",
      tone: "info",
      title: "当前会话已压缩并迁移",
      detail: "记忆已应用到新会话，AI 将在新会话中继续回复",
      expandable: true,
      actions: [{ label: "跳转到新会话", onClick: () => session.navigateToMigratedSession(migratedSessionId) }],
    });
  }
  // 7) 排队消息：当前回复结束后自动发送。条上只显示条数，逐条明细与「移除」进浮层。
  if (session.messageQueue.length > 0) {
    noticeItems.push({
      id: "message-queue",
      tone: "info",
      title: "排队中",
      detail: `${session.messageQueue.length} 条（当前回复结束后自动发送）`,
      overlayExtra: (
        <div className="mt-1.5 max-h-[200px] space-y-1 overflow-y-auto">
          {session.messageQueue.map((q) => {
            const ub = q.payload.userBubble;
            const label = ub.content || (ub.attachedFiles && ub.attachedFiles.length > 0 ? `[${ub.attachedFiles.length} 个文件]` : "[图片]");
            return (
              <div key={q.id} className="flex items-center gap-2 rounded bg-muted/40 px-2 py-1 text-foreground/80">
                <span className="flex-1 truncate" title={label}>
                  {label}
                </span>
                <button
                  type="button"
                  onClick={() => session.removeFromQueue(q.id)}
                  className="px-1.5 py-0.5 rounded text-[10px] text-muted-foreground hover:text-red-500 hover:bg-muted/60 shrink-0"
                  title="移除此条"
                >
                  移除
                </button>
              </div>
            );
          })}
        </div>
      ),
    });
  }

  return (
    <PanelClientIdContext.Provider value={clientId}>
    <LiveSparkModeContext.Provider value={sparkMode}>
    <div className="flex flex-col h-full overflow-hidden">
      {/* 消息列表。
          空态时不吃满剩余高度（flex-none + 内容自适应），把空间让给下方的输入区，
          使「欢迎文案 + 输入框」作为一组整体垂直居中——即 Claude 新对话页的排布。 */}
      <div className={`relative min-h-0 flex flex-col px-3 ${composerCentered ? "flex-none" : "flex-1"}`}>
        {/* 顶部导航条：当前视图所属 AI 回答对应的用户提问。

            ⚠️ 必须是 absolute 覆盖层，不能是 flex 流里的兄弟节点。
            它的出现/消失由"当前视口顶部是哪条消息"决定，也就是在**滚动过程中**切换。
            早先它占 flex 流，一出现就把下面的虚拟列表视口挤矮约 32px、一消失又撑回去：
            视口高度一变，Virtuoso 重算可见区间并补测新进来的项，scrollTop 被校正，
            于是"往上翻历史时突然刷白一下、滚动条跳走"。向上滚动正好会反复跨越
            "顶部是 user 消息 / 是 assistant 消息"的边界，所以滚着滚着就触发。
            改成覆盖在列表顶部后，视口高度与它是否出现无关。 */}
        {/* 出现 / 消失走淡入淡出 + 轻微位移，而不是挂载卸载：滚动时它会反复切换，硬切显得一跳一跳的。
            底边不画线，用渐隐过渡到下面的内容，免得与标题栏的分隔线叠成两条横杠。 */}
        {shownStickyQuestion && (
          <div
            aria-hidden={!stickyQuestion}
            className={`absolute top-0 inset-x-0 z-10 transition-[opacity,transform] duration-200 ease-out ${
              stickyQuestion ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-1 pointer-events-none"
            }`}
          >
            <div className="bg-background">
              <TooltipProvider delayDuration={400}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => scrollToQuestion(shownStickyQuestion.id)}
                      aria-label="跳转到该提问"
                      tabIndex={stickyQuestion ? 0 : -1}
                      className="w-full min-w-0 flex items-center gap-1.5 px-3 py-1.5 text-[11.5px] text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground/60 rotate-180" />
                      {/* 换成另一条提问时文字淡入，而不是瞬间替换 */}
                      <span key={shownStickyQuestion.id} className="truncate text-left animate-in fade-in-0 duration-200">
                        {shownStickyQuestion.text}
                      </span>
                    </button>
                  </TooltipTrigger>
                  {/* 提问较长时条里只露一行：悬停看全文 */}
                  <TooltipContent side="bottom" align="start" className="max-w-[min(480px,calc(100vw-32px))] whitespace-pre-wrap break-words line-clamp-[12]">
                    {shownStickyQuestion.text}
                    <div className="mt-1 opacity-70">点击跳回这条提问</div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <div aria-hidden className="h-3 bg-gradient-to-b from-background to-transparent pointer-events-none" />
          </div>
        )}
        {/* 提问目录：放进标题栏（只有可见的面板渲染），顶部条只负责跳回当前提问 */}
        {active && headerSlot && userQuestions.length >= 2 && createPortal(
          <Popover open={questionListOpen} onOpenChange={setQuestionListOpen}>
            <PopoverTrigger asChild>
              <button
                title="提问目录"
                aria-label="提问目录"
                className={`p-1 rounded transition-colors cursor-pointer ${questionListOpen ? "text-foreground bg-muted/60" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"}`}
              >
                <ListChecks className="w-3.5 h-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              side="bottom"
              sideOffset={6}
              collisionPadding={8}
              className="w-[min(420px,calc(100vw-16px))] p-0 max-h-[50vh] flex flex-col"
            >
              <QuestionListPanel
                questions={userQuestions}
                onSelect={(id) => { setQuestionListOpen(false); scrollToQuestion(id); }}
              />
            </PopoverContent>
          </Popover>,
          headerSlot,
        )}
        {session.chatHistory.length === 0 ? (
          <>
            {/* 空历史占位。只保留"加载中"这一种：欢迎文案已移到输入区容器内部，
                与输入框作为同一组垂直居中（见下方输入区的 emptyStateGreeting）。
                留在这里的话它是独立的 flex 项，会被吃满高度的输入区顶到面板顶部。 */}
            {session.isLoadingSession && (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center text-muted-foreground">
                  <Loader2 className="w-8 h-8 mx-auto mb-4 animate-spin text-primary/60" />
                  <p className="text-sm">会话历史加载中...</p>
                </div>
              </div>
            )}
          </>
        ) : (
          <VirtualMessageList
            ref={virtualListRef}
            messages={visibleHistory}
            firstItemIndex={safeHiddenCount(hiddenMessageCount, historyLen)}
            estimateHeight={200}
            overscan={300}
            onScroll={stableOnScroll}
            onTopItemChange={handleTopItemChange}
            followOutput={false}
            active={active}
            initialBottom={!session.isLoadingSession && session.chatHistory.length > 0}
            header={
              <>
                {/* 给顶部覆盖的提问条让位（它 absolute 覆盖在列表上方，见上方注释）。
                    常驻、不随提问条出现与否切换：切换的话列表内容高度又会跟着变，等于把问题原样搬了进来。
                    高度不小于提问条（py-1.5 + 11.5px 行高 ≈ 28px）。 */}
                <div aria-hidden className="h-8" />
                {hiddenMessageCount > 0 && (
                  <div className="flex justify-center py-2">
                    <button
                      onClick={restoreEarlierMessages}
                      className="rounded-full border border-border bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                    >
                      已折叠较早的 {hiddenMessageCount} 条消息，点击展开 {Math.min(RESTORE_HISTORY_BATCH_SIZE, hiddenMessageCount)} 条
                    </button>
                  </div>
                )}
                {!connected && session.chatHistory.length > 0 && (
                  <div className="flex items-center justify-center gap-2 py-2 px-4 rounded-lg bg-destructive/10 text-destructive text-xs">
                    <X className="w-3.5 h-3.5" />
                    连接已断开，请稍后重试
                  </div>
                )}
              </>
            }
            footer={
              <>
                {/* AI 还没开始输出的那一小段（用户消息已发出、stream_start 未到）：
                    用与真正回复相同的头部占位，让"图标 + 状态"出现在 AI 消息该出现的位置。
                    一旦 assistant 消息建好，改由它自己的头部显示（见下方 liveStatus）。 */}
                {showPendingAssistantHeader && (
                  <div className="py-1">
                    {/* ⚠️ 这里不能加 `animate-fade-in`（或任何入场动画）。
                        注意注释必须写在 div **内部** —— 放在 `cond && (` 之后会让括号里出现两个
                        表达式，那是语法错误（TS1003/TS1005），不是"注释可有可无"的问题。
                        这个占位块只在「消息已落终态、loading 还没收」的窗口里存在
                        （finishLoading 有 MIN_LOADING_MS=400 的下限，短轮次走 setTimeout 延后收），
                        于是它会在**回复完成 / 取消的那一刻**挂上、很快又卸载 —— 0.2s 的 opacity 0→1
                        被就地重放，就是肉眼看到的那一下闪，且与回复内容无关（任何回复都经历）。
                        同一个类在 VirtualMessageList 的列表项上造成滚动闪烁（见那里的注释），这是最后残留。 */}
                    <AssistantTurnHeader streaming liveStatus={session.statusText} startedAt={session.turnStartTime} />
                  </div>
                )}
                <div ref={bottomRef} />
              </>
            }
            renderMessage={(msg, idx) => (
              <CommandApprovalContext.Provider value={commandApprovalCtx}>
              <InlineFormContext.Provider value={inlineFormCtx}>
                <MessageBubble
                  message={msg as any}
                  liveStatus={idx === visibleHistory.length - 1 ? liveAssistantStatus : undefined}
                  startedAt={idx === visibleHistory.length - 1 && !!(msg as any).streaming ? session.turnStartTime : undefined}
                  onAcceptEdit={session.acceptEdits}
                  onRejectEdit={session.rejectEdits}
                  onUndoEdit={session.undoEdits}
                  onEditUserMessage={session.editUserMessage}
                  replyingToMessageId={replyingToMessageId}
                  // 会话还没落盘（首轮刚发出）时不给入口：没有可截断的后端历史
                  onForkFromMessage={sessionId ? session.forkFromMessage : undefined}
                  onQuoteToInput={(qMsg) => {
                    if (qMsg.userSegments && qMsg.userSegments.length > 0) {
                      editorRef.current?.appendSegments(qMsg.userSegments);
                    } else if (qMsg.content) {
                      editorRef.current?.appendText(qMsg.content);
                    }
                    if (qMsg.images && qMsg.images.length > 0) setImages((prev) => [...prev, ...qMsg.images!]);
                    setComposerEmpty(editorRef.current?.isEmpty() ?? false);
                  }}
                  onImagePreview={(imgs, idx) => setPreviewState({ images: imgs, index: idx })}
                />
              </InlineFormContext.Provider>
              </CommandApprovalContext.Provider>
            )}
          />
          )}
        {/* ask_form 表单卡片：渲染在会话区容器内（不是输入区），与消息同宽、跟会话是一体的；
            最大高度取会话区的一半，超出部分内部滚动——否则一张长表单会把输入框挤出可视区。 */}
        {session.formRequest && (
          <div className="shrink-0 max-h-[50%] overflow-y-auto">
            <FormPanel spec={session.formRequest.spec} onSubmit={session.submitForm} />
          </div>
        )}
        {/* Loading 指示器已合并到输入区上方的统一状态条中 */}
        {/* 「滚动到底部」：下方仍在生成时外圈蓝色脉动（.scroll-btn-running），
            提示底部还有内容在产出；空闲时保持常态样式。 */}
        <button
          onClick={animatedScrollToBottom}
          className={`absolute bottom-4 left-1/2 -translate-x-1/2 z-10 w-9 h-9 rounded-full bg-background border border-border shadow-md flex items-center justify-center hover:shadow-lg transition-all duration-200 ${showScrollBtn ? "opacity-100 translate-y-0 pointer-events-auto" : "opacity-0 translate-y-2 pointer-events-none"} ${showScrollBtn && turnRunning ? "scroll-btn-running text-blue-500" : "text-muted-foreground hover:text-foreground"}`}
          title="滚动到底部"
          aria-label="滚动到底部"
        >
          <ChevronDown className="w-5 h-5" />
        </button>
      </div>

      {/* 输入区域。
          空态：flex-grow=1 吃满剩余高度并把内容垂直居中（配合上方不再抢高度的欢迎块，
          整组看起来落在面板中间）。首发时 composerCentered 转 false，flex-grow 回到 0，
          容器高度收缩、带动输入框平滑落到底部——落位动画就是这么来的。

          过渡放在 flex-grow 而不是 transform：transform 会让输入框脱离布局、压在消息
          列表上；flex-grow 是真实的布局动画，动画结束时位置即最终位置，不用再校正。
          grow 值写在 style 里（而非 flex-1/flex-none 类名）：类名简写会连带改 basis 与
          shrink，属性一起跳变就过渡不起来了。 */}
      <div
        className={`px-3 py-4 flex flex-col justify-center ${composerCentered ? "min-h-0" : ""}`}
        style={{
          flexGrow: composerCentered ? 1 : 0,
          flexShrink: 0,
          flexBasis: "auto",
          transition: `flex-grow ${COMPOSER_LANDING_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        }}
      >
        {/* 空态输入框宽度 = min(面板宽度, max(640px, 80%))。
            两头都要顾：早先写死 720px，面板拖宽后输入框不再跟随；改成纯铺满整行，超宽面板上
            一行字又太长。用 max() 让两者同时成立——宽面板恒为 80%（两侧留出边距），
            窄面板不低于 640px（低于此工具栏与 placeholder 就会挤）。用 max-width 而非 width：
            面板比 640 还小时 max-width 不生效，宽度自然回落到满宽，永远不会溢出。 */}
        <div className={`relative ${composerCentered ? "w-full max-w-[max(640px,80%)] mx-auto" : ""}`}>
          {/* 斜杠命令菜单（贴输入框上方，置于 overflow-hidden 容器之外避免被裁剪） */}
          {slash.open && (
            <SlashCommandMenu
              mode={slash.mode}
              breadcrumb={slash.activeCommand?.label ?? null}
              commandItems={slash.commandItems}
              fallbackResults={slash.fallbackResults}
              results={slash.results}
              loading={slash.loading}
              activeIndex={slash.activeIndex}
              onHover={slash.setActiveIndex}
              onSelect={slash.selectAt}
              onRequestClose={slash.close}
            />
          )}
        {/* 吉祥物「Axo」+ 文件改动汇总（"N 已应用 / N 待确认"）合并为同一行：
            左侧吉祥物/状态，右侧汇总按钮（点击展开改动面板）。汇总原先是输入框上方单独一条
            bar，现并到这一行，省一行高度、也贴近输入框。

            ── 这一行为什么留在容器里、而不是输入框内部 ──
            输入框带 overflow-hidden，吉祥物放进去会被上边缘裁掉，所以它是输入框的兄弟节点、
            与斜杠菜单同处这一层。
            · 高度沿用 h-[26px] + -mb-[5px]：26px 是本体高度，-mb-[5px] 让底部 5px 搭在输入框
              边框上，净占 21px。
            · 斜杠菜单打开时整行只 invisible、不卸载：菜单贴着输入框上方弹出会与这行相撞，
              直接摘掉节点会让预留的 21px 一起塌掉、输入框上跳。invisible 保留盒子。 */}
        {/* 空态欢迎文案：放在输入区容器【内部】、输入框上方，与输入框同属一个居中的组
            （Claude 新对话页就是"一句问候 + 紧跟其下的输入框"整体居中）。
            放在消息列表那一侧行不通：那是独立的 flex 项，会被吃满高度的输入区顶到顶部。 */}
        {composerCentered && (
          mode !== "quest" && session.workspacesLoaded && !session.workspace && session.workspaces.length === 0 ? (
            // 无工作区是真正的阻塞态（Agent 读写代码、跑命令都需要它），这一屏必须讲清楚
            // 为什么不能用、怎么解决，不能换成问候语糊过去。
            <div className="text-center px-3 pb-5">
              <p className="text-lg font-medium text-foreground">欢迎使用 Axon</p>
              <p className="text-sm text-muted-foreground mt-1 mb-4">AI 编程助手 · 读写代码、执行命令、搜索项目</p>
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-5 py-4 text-left">
                <p className="text-sm font-medium text-amber-600 dark:text-amber-400 mb-2">⚠ 尚未添加工作区</p>
                <p className="text-xs text-muted-foreground leading-relaxed mb-3">Axon Agent 需要至少一个工作区文件夹才能读写代码、执行命令。请先添加工作区。</p>
                <button
                  onClick={() => setPickerOpen(true)}
                  className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
                >
                  → 点击添加工作区
                </button>
              </div>
            </div>
          ) : (
            <EmptyStateGreeting mode={mode} onPickPrompt={handlePickPrompt} />
          )
        )}
        {/* ask_user 选项问答卡片：必须放在吉祥物行【上方】。
            吉祥物是靠 -mb-[5px] 搭在"紧邻其下的那个元素"上沿的；卡片若夹在它和输入框之间，
            吉祥物就会改搭在卡片上、看起来被顶到半空，破坏"趴在输入框上沿"的观感。 */}
        {session.askUser && (
          <AskUserCard request={session.askUser} onAnswer={session.answerUserQuestion} />
        )}
        {/* 提示类状态条：必须放在吉祥物行【上方】。
            吉祥物靠 -mb-[5px] 搭在"紧邻其下的那个元素"上沿；状态条若插在吉祥物与输入框
            之间，吉祥物就会改搭在状态条上、被顶到半空，破坏"趴在输入框上沿"的观感。
            放在这里也不会推动输入框：条本身固定 34px，详情浮层是绝对定位、不参与布局。 */}
        {/* 没有提示时整条不渲染（组件卸载即重置「详情」浮层的开合状态） */}
        {noticeItems.length > 0 && <NoticeBar items={noticeItems} />}
        {/* 空态不渲染这一行：新对话页只留「一句欢迎 + 输入框」，吉祥物和改动汇总
            （"N 已应用"）在还没有任何消息时都没有信息量，纯属噪音。
            有消息后照常出现。 */}
        {!composerCentered && (
          <UnifiedStatusBar
            mode={mode}
            chatHistory={session.chatHistory}
            pendingPaths={session.pendingPaths}
            pendingDiffs={session.pendingDiffs}
            onAcceptAll={session.acceptEdits}
            onRejectAll={session.rejectEdits}
            onUndo={session.undoEdits}
            onListSnapshots={session.listSnapshots}
            onRestoreSnapshot={session.restoreSnapshot}
            slashOpen={slash.open}
            leading={
              <>
                <AxonMascot mood={mascot.mood} size={26} />
                {/* 执行中状态：贴在吉祥物右边，始终可见（消息流里的那个可能已滚出视野）。
                    整行是 pointer-events-none，所以它不吃点击；高度由 26px 那行决定，不顶动布局。 */}
                <MascotStatusText text={mascotStatusText} />
              </>
            }
          />
        )}
        <div
          className="border border-border rounded-xl overflow-hidden focus-within:ring-1 focus-within:ring-ring focus-within:border-transparent transition-all relative bg-background shadow-[0_1px_2px_rgba(0,0,0,0.04),0_6px_16px_-4px_rgba(0,0,0,0.08)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.30),0_6px_16px_-4px_rgba(0,0,0,0.45)]"
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          // focus/blur 挂在容器上而非 MentionEditor：React 的 onFocus/onBlur 底层是
          // focusin/focusout，会冒泡，因此无需给编辑器新增 props。
          onFocus={mascot.onFocus}
          onBlur={mascot.onBlur}
        >
          {/* 附件处理中 / 图片预览区 */}
          {(processingAttachments.length > 0 || images.length > 0 || uploadedFiles.length > 0) && (
            <div className="flex gap-3 px-4 pt-3 pr-12 flex-wrap">
              {processingAttachments.map((attachment) => (
                <ProcessingAttachmentCard key={attachment.id} attachment={attachment} onRemove={cancelProcessingAttachment} />
              ))}
              {images.map((img, i) => (
                <AttachmentCard key={i} bleed onRemove={() => removeImage(i)} removeLabel="移除图片">
                  <img
                    src={img}
                    alt=""
                    className="h-full w-full object-cover cursor-zoom-in hover:opacity-90 transition-opacity"
                    onClick={() => setPreviewState({ images, index: i })}
                    onContextMenu={(event) => event.preventDefault()}
                    title="点击查看大图"
                  />
                  {/* 角标叠在缩略图左下角：加一层半透明底，避免压在亮色图片上看不清 */}
                  <span className="pointer-events-none absolute bottom-1.5 left-1.5 z-[2] rounded-md bg-background/85 px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-4 tracking-wide text-foreground/80 shadow-sm backdrop-blur-sm">
                    {imageTypeLabel(img)}
                  </span>
                </AttachmentCard>
              ))}
              {uploadedFiles.map((file) => (
                <AttachmentCard
                  key={file.id}
                  onRemove={() => setUploadedFiles((prev) => prev.filter((f) => f.id !== file.id))}
                  removeLabel={`移除 ${file.name}`}
                  title={file.name}
                  previewPath={file.path}
                >
                  <FileCardBody name={file.name} badge={attachmentTypeLabel(file)} />
                </AttachmentCard>
              ))}
            </div>
          )}
          {/* 文件 / 上下文预览区已移到输入框内，与输入文字同处一行（见下方内联 tag） */}
          {/* 文件错误 / 排队中 / 命令风险 / 上下文超限 / 工具格式不兼容 / 会话已迁移 等
              「提示类」信息已上移到输入框上方的状态条（见本组件 render 顶部的 <NoticeBar>），
              不再占用输入框内部的高度。 */}
          {/* 工具确认条 —— 决策类，仍留在输入框内部（挡住输入、等用户回答）。
              配色向输入框上方的状态条看齐（ask 蓝），结构、按钮与行为不动。 */}
          {session.toolConfirm && (
            <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 dark:bg-blue-950/25 border border-blue-200 dark:border-blue-900/60 rounded-xl mb-2">
              <ListChecks className="w-4 h-4 text-primary shrink-0" />
              <span className="text-xs flex-1 min-w-0 truncate">
                {session.toolConfirm.kind === "mcp"
                  ? `AI 请求调用 MCP 工具「${session.toolConfirm.title}」`
                  : `AI 建议创建 Relay 工作流「${session.toolConfirm.title}」`}
              </span>
              {session.toolConfirm.kind === "relay" ? (
                <>
                  <button
                    onClick={() => session.confirmTool(true, { mode: "strict" })}
                    className="px-2.5 py-1 rounded text-xs font-medium bg-amber-500/80 text-white hover:bg-amber-500 transition-colors"
                    title="每阶段等用户确认再推进"
                  >
                    严格模式
                  </button>
                  <button
                    onClick={() => session.confirmTool(true, { mode: "auto" })}
                    className="px-2.5 py-1 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                    title="全自动连续推进，不等确认"
                  >
                    全自动
                  </button>
                </>
              ) : (
                <button
                  onClick={() => session.confirmTool(true)}
                  className="px-2.5 py-1 rounded text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  确认
                </button>
              )}
              <button
                onClick={() => session.confirmTool(false)}
                className="px-2.5 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              >
                跳过
              </button>
            </div>
          )}
          {/* 撤销失败 / 工具格式不兼容都属于「提示类」，已上移到输入框上方的状态条 */}
          {/* 压缩选择弹窗：发消息前达到自动压缩线时，给用户选择继续或新会话。
              决策类，留在输入框内；仅把配色/圆角对齐到状态条的 ask 蓝。 */}
          {session.compactionNeeded && (
            <div className="flex flex-col gap-2 px-3 py-3 bg-blue-50 dark:bg-blue-950/25 border border-blue-200 dark:border-blue-900/60 rounded-xl mb-2">
              <div className="flex items-start gap-2">
                <span className="text-sm">⚠️</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground">上下文已使用 {session.compactionNeeded.percent}%</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    当前会话上下文已到自动压缩线，为保证回复质量建议压缩。请选择：
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={() => session.chooseCompaction("new_session")}
                  className="px-3 py-1.5 rounded-md text-xs border border-border hover:bg-muted/60 transition-colors"
                >
                  在新会话中继续
                </button>
                <button
                  onClick={() => session.chooseCompaction("continue")}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  压缩并继续
                </button>
              </div>
            </div>
          )}
          {/* Credits 预算暂停弹窗：单轮花费达到硬暂停阈值时，给用户选择继续或停止。
              决策类，留在输入框内；仅把配色/圆角对齐到状态条的 warn 琥珀。 */}
          {session.creditBudgetPaused && (
            <div className="flex flex-col gap-2 px-3 py-3 bg-amber-50 dark:bg-amber-950/25 border border-amber-200 dark:border-amber-900/60 rounded-xl mb-2">
              <div className="flex items-start gap-2">
                <span className="text-sm">💰</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground">本轮任务已消耗 {session.creditBudgetPaused.usage ?? `${session.creditBudgetPaused.spent.toFixed(2)} credits`}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    消耗明显偏高，是否继续当前任务？
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={() => session.chooseCreditBudget("stop")}
                  className="px-3 py-1.5 rounded-md text-xs border border-border hover:bg-muted/60 transition-colors"
                >
                  停止
                </button>
                <button
                  onClick={() => session.chooseCreditBudget("continue")}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  继续
                </button>
              </div>
            </div>
          )}
          {/* 会话已迁移 / 命令风险 / 上下文超限都属于「提示类」，已上移到输入框上方的状态条 */}
          {/* 命令信任授权改为内联在对应命令卡片下方（无感模式），见 ToolCallItem。此处不再用模态弹窗 */}
          {/* 输入区：单行版式 = 编辑区与工具栏并排一行；多行版式 = 编辑区在上、工具栏在下。
              外层是「高度动画壳」：内层高度由内容自然撑开（文字逐行变高、或版式切换都会改变它），
              外层写内联 height 并做 CSS 过渡——height 从旧值过渡到新值，盒子才会平滑长高/收拢，
              而不是被内容顶得一跳一跳。prefers-reduced-motion 下由 motion-reduce 关掉过渡，直接切换。 */}
          <div
            className="overflow-hidden transition-[height] duration-200 ease-out motion-reduce:transition-none"
            style={inputAreaHeight != null ? { height: inputAreaHeight } : undefined}
          >
            <div
              ref={inputAreaRef}
              className={composerStacked ? "flex flex-col" : "flex items-center gap-1"}
            >
              {/* 输入框：contentEditable 富文本，tag 内联在光标处（MentionEditor）
                  多行版式：满宽、沿用原来的内边距；
                  单行版式：flex-1 吃掉工具栏之外的剩余宽度（min-w-0 才允许被压窄），
                  右侧只留一点缝，工具栏自己的 px 会再补一点间距。
                  单行时还要把编辑区自己的 min-height 压到一行高（原本 44px，是给多行留的
                  舒适点按高度）：否则一行文字贴在 44px 盒子的顶上，同一行里的工具栏却被
                  垂直居中，看起来按钮比文字低半截。用后代选择器改 ProseMirror 的 min-height，
                  不去动 MentionEditor 的默认值（多行版式仍然要 44px）。 */}
              <div
                ref={editorWrapRef}
                className={
                  composerCentered
                    ? "w-full px-4 pt-3.5 pb-1 [&_.ProseMirror]:min-h-[66px]"
                    : composerMultiline
                      ? "w-full px-3 pr-10 pt-2 pb-1"
                      : "min-w-0 flex-1 pl-3 pr-1 py-1.5 [&_.ProseMirror]:min-h-[22px]"
                }
              >
                <MentionEditor
                  ref={editorRef}
                  disabled={!connected || !hasConfiguredSelection}
                  placeholder={!connected ? "等待连接..." : !hasConfiguredSelection ? "请先配置 Provider 并选择模型" : canSendImages ? "给 Axon 发消息...（可粘贴或拖拽图片）" : "给 Axon 发消息..."}
                  onChange={handleEditorChange}
                  onKeyDown={(e) => {
                    // 吉祥物只是旁观者：先记一笔按键类型，不影响后续任何消费判定
                    mascot.noteKey(e.key);
                    // 斜杠菜单优先消费方向键/回车/Esc，未消费时再走默认发送逻辑
                    if (slash.handleKeyDown(e)) return;
                    handleKeyDown(e);
                  }}
                  onPaste={handlePaste}
                />
              </div>
              {/*
                底部工具栏。
                ── 排版约定（左右两组共用，改之前先读） ──
                · 所有控件统一 28px（h-7）高、同一条中线；组内间距 gap-0.5（2px），靠控件自身的
                  hover 底色来区分彼此，而不是靠留白——留白一大，一组控件就散成几个孤立的点。
                · 颜色只给「状态」：发送按钮（主操作）与上下文用量色。其余控件一律 muted 灰字，
                  hover 才变深。编辑模式的绿/黄点缩成 6px 状态点，不再与用量圆环抢视觉。
                · 左组：[+] 在最左（附加内容是输入的"前置动作"，靠近输入起点），模型选择紧随其后。
                · 单行版式下这一整组贴在编辑区右侧（shrink-0，不跟着编辑区一起压缩），
                  多行版式下回到整行：左边一组、右边发送。
              */}
              <div
                className={
                  composerStacked
                    ? "flex items-center justify-between gap-2 px-1.5 pb-1.5"
                    : "flex shrink-0 items-center gap-0.5 px-1.5"
                }
              >
                <div ref={toolbarLeftRef} className="flex items-center gap-0.5 min-w-0">
                  <Popover open={menuOpen} onOpenChange={setMenuOpen}>
                    <PopoverTrigger asChild>
                      <button
                        className="inline-flex items-center justify-center h-7 w-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 data-[state=open]:bg-muted/60 data-[state=open]:text-foreground transition-colors"
                        title="添加内容或设置改动应用方式"
                        aria-label="更多"
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" side="top" className="w-52 p-1 gap-0">
                      <button
                        onClick={() => { docInputRef.current?.click(); setMenuOpen(false); }}
                        className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs hover:bg-muted/60 transition-colors text-left"
                      >
                        <Paperclip className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                        <span className="flex-1">上传文件</span>
                        <span className="text-[10px] text-muted-foreground/60">≤256KB</span>
                      </button>
                      <button
                        onClick={() => { fileInputRef.current?.click(); setMenuOpen(false); }}
                        disabled={!canSendImages}
                        className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
                        title={canSendImages ? "" : "当前模型不支持图片"}
                      >
                        <ImagePlus className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                        <span className="flex-1">上传图片</span>
                      </button>
                      <button
                        onClick={() => { captureScreenshot(); setMenuOpen(false); }}
                        disabled={!canSendImages}
                        className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs hover:bg-muted/60 transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed"
                        title={canSendImages ? "" : "当前模型不支持图片"}
                      >
                        <Camera className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                        <span className="flex-1">截图</span>
                      </button>

                      <button
                        onClick={() => { window.dispatchEvent(new Event(OPEN_CONNECTORS_EVENT)); setMenuOpen(false); }}
                        className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs hover:bg-muted/60 transition-colors text-left"
                        title="把 GitHub、邮箱、飞书等服务接给 Axon"
                      >
                        <Plug className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                        <span className="flex-1">连接器</span>
                      </button>

                      <div className="my-0.5 border-t border-border" />

                      {/* 产物目录：AI 生成的 HTML / SVG / 文档等成品存放位置。
                          没设置时显示「默认位置」，让用户知道不填也有地方可去；
                          已设置时可以点右侧 × 恢复默认。 */}
                      <div className="group/artifact flex items-center rounded-md hover:bg-muted/60 transition-colors">
                        <button
                          type="button"
                          onClick={() => { pickArtifactDir(); setMenuOpen(false); }}
                          disabled={!(window as unknown as { __axonVSCode?: unknown }).__axonVSCode}
                          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left disabled:opacity-40 disabled:cursor-not-allowed"
                          title={artifactDir || "默认保存到 ~/.axon/artifacts/<会话>/"}
                        >
                          <FolderOpen className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-xs font-medium text-foreground">产物目录</span>
                            <span className="block truncate text-[10px] leading-4 text-muted-foreground">
                              {artifactDir || "默认位置（~/.axon/artifacts）"}
                            </span>
                          </span>
                        </button>
                        {artifactDir && (
                          <button
                            type="button"
                            onClick={() => updateArtifactDir("")}
                            className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background/60 hover:text-foreground"
                            title="恢复默认位置"
                            aria-label="恢复默认产物目录"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </div>

                      {mode !== "quest" && (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={session.editMode === "auto"}
                          onClick={() => session.setEditModePreference(session.editMode === "auto" ? "manual" : "auto")}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
                        >
                          <span className={`size-2 shrink-0 rounded-full ${session.editMode === "auto" ? "bg-emerald-500" : "bg-amber-500"}`} />
                          <span className="min-w-0 flex-1">
                            <span className="block text-xs font-medium text-foreground">自动应用</span>
                            <span className="block text-[10px] leading-4 text-muted-foreground">
                              {session.editMode === "auto" ? "代码改动直接写入文件" : "关闭后需手动确认改动"}
                            </span>
                          </span>
                          <span className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${session.editMode === "auto" ? "bg-emerald-500" : "bg-muted-foreground/25"}`}>
                            <span className={`absolute top-0.5 size-3 rounded-full bg-white shadow-sm transition-transform ${session.editMode === "auto" ? "translate-x-3.5" : "translate-x-0.5"}`} />
                          </span>
                        </button>
                      )}
                    </PopoverContent>
                  </Popover>

                  <ModelSelector
                    value={session.model}
                    provider={session.provider}
                    onChange={handleModelChange}
                    disabledModels={images.length > 0 && !visionFallbackModel ? models.filter((m) => !m.vision).map((m) => m.id) : []}
                    disabled={session.isCompacting || session.contextOverflow}
                    disabledTooltip={session.contextOverflow ? "上下文超限，请先压缩" : "压缩期间不可切换模型"}
                  />
                  {/* 会话记忆入口：早先是输入框最上沿的整行文字按钮，空态白占一行高度。
                      现在收成工具栏里的一个图标（紧挨模型选择）：有记忆时图标着色 + 右上角
                      一个小状态点，字数放进 title 里悬停可见；没有记忆时保持中性灰。 */}
                  <button
                    type="button"
                    onClick={() => setMemoryOpen(true)}
                    className="relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                    title={
                      hasMemory
                        ? `会话记忆 · 已沉淀 ${session.memory.length} 字（点击查看 / 编辑 / 导出 / 导入）`
                        : "会话记忆 · 空（模型会在会话里自动沉淀，也可导入 .md）"
                    }
                    aria-label="会话记忆"
                  >
                    {/* 记忆用 NotebookPen、思考过程用 Brain：两者此前共用 Brain，
                        同一屏里「思考过程」和「已更新记忆」长得一模一样，用户分不开。 */}
                    <NotebookPen className={`h-4 w-4 ${hasMemory ? "text-primary" : ""}`} />
                    {hasMemory && (
                      <span className="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-primary" />
                    )}
                  </button>
                  <EffortSelector
                    levels={selectedEffortLevels}
                    value={session.effort}
                    defaultValue={selectedDefaultEffort}
                    onChange={handleEffortChange}
                    disabled={session.isCompacting || session.contextOverflow}
                  />
                  {/* 上下文占比紧跟模型强度；圆环本身同时作为手动压缩入口。 */}
                  <TokenIndicator
                    used={session.tokenUsage.used}
                    max={session.tokenUsage.max}
                    cumulative={session.tokenUsage.cumulative}
                    compacting={session.isCompacting}
                    compactingMessage={session.compactingMessage}
                    overflow={session.contextOverflow}
                    replying={session.isLoading}
                    onCompact={() => session.compactSession()}
                    breakdown={session.tokenUsage.breakdown}
                  />
                  {/* 后台任务（AI 启动的服务器 / 长任务）：有任务时才出现 */}
                  <BackgroundTasksButton clientId={clientId} connected={connected} send={send} />

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => { if (e.target.files) addImages(e.target.files); e.target.value = ""; }}
                  />
                  <input
                    ref={docInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }}
                  />

                </div>
                <div ref={toolbarRightRef} className="flex items-center gap-0.5 shrink-0">
                  {mode === "quest" ? (
                    /* Quest：联网搜索开关（思考开关已统一到模型选择器里，agent / quest 共用） */
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => session.setQuestWebSearch(!session.questWebSearch)}
                            className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-xs font-medium transition-colors ${session.questWebSearch ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted/60"}`}
                          >
                            <Globe className="w-3.5 h-3.5" />
                            联网
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" align="end" className="max-w-[220px]">
                          <p className="text-xs text-white">开启后允许联网搜索与抓取网页；关闭时仅基于模型知识作答。</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : null}
                  {/* 发送/停止与辅助控件之间多留一点距离：主操作单独成组，不和开关挤在一起 */}
                  <span className="w-1" aria-hidden />
                  <Button
                    size="sm"
                    onClick={session.isLoading ? () => session.cancelTurn(session.model) : handleSend}
                    disabled={session.isLoading
                      ? session.isCompacting
                      : !connected || !hasConfiguredSelection || processingAttachments.length > 0 || (composerEmpty && images.length === 0) || !!session.compactionMigrated || session.isCompacting || session.contextOverflow}
                    title={session.isLoading ? "停止生成" : "发送消息"}
                    aria-label={session.isLoading ? "停止生成" : "发送消息"}
                    className={`axon-send-stop-button h-7 w-7 rounded-full shrink-0 disabled:opacity-40 ${session.isLoading ? "is-stopping" : "is-ready"}`}
                  >
                    <SendStopIcon stopping={session.isLoading} />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
        </div>
      </div>

      {/* 工作区选择弹窗 */}
      <WorkspacePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        initialPath={session.workspace || undefined}
        onSelect={session.selectWorkspace}
        onInitialize={(path) => send({ type: "initialize_workspace", workspace: path, clientId, sessionId })}
        onPropose={(path) => { setAxonProposalLoading(true); send({ type: "propose_workspace_axon", workspace: path, clientId, sessionId }); }}
        proposal={axonProposal}
        proposalLoading={axonProposalLoading}
        onAcceptProposal={(workspace, content) => send({ type: "initialize_workspace", workspace, axonContent: content, clientId, sessionId })}
        onCloseProposal={() => setAxonProposal(null)}
      />

      {/* 工作区 Axon 状态一览：只读展示，逐个初始化，不提供批量创建 */}
      <WorkspaceAxonPanel
        open={axonPanelOpen}
        onOpenChange={(next) => {
          setAxonPanelOpen(next);
          if (next) send({ type: "inspect_workspace_axon", clientId, sessionId });
        }}
        statuses={axonStatuses}
        loading={axonStatusLoading}
        onRefresh={() => send({ type: "inspect_workspace_axon", clientId, sessionId })}
        onInitialize={(workspace) => send({ type: "initialize_workspace", workspace, clientId, sessionId })}
      />


      {/* 工作区组管理弹窗 */}
      <WorkspaceGroupManager
        open={groupManagerOpen}
        onOpenChange={setGroupManagerOpen}
        onSelect={(group: WorkspaceGroup) => session.selectGroup(group)}
        onGroupUpdated={(group: WorkspaceGroup) => session.groupUpdated(group)}
      />

      {/* 图片查看器（输入框图片 / 历史消息图片共用：翻页 + 缩放 + 旋转） */}
      <ImageViewer
        open={!!previewState}
        images={previewState?.images ?? []}
        index={previewState?.index ?? 0}
        onIndexChange={(index) => setPreviewState((prev) => (prev ? { ...prev, index } : prev))}
        onClose={() => setPreviewState(null)}
      />
    </div>

    {/* 会话记忆面板：查看 / 编辑 / 导出 / 导入 .md */}
    {memoryOpen && (
      <MemoryPanel
        memory={session.memory}
        history={session.memoryHistory}
        onSave={(content, opts) => session.saveMemory(content, opts)}
        onRequestHistory={session.requestMemoryHistory}
        onRestore={session.restoreMemoryVersion}
        onClose={() => setMemoryOpen(false)}
      />
    )}
    </LiveSparkModeContext.Provider>
    </PanelClientIdContext.Provider>
  );
}
