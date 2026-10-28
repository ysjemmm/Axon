/**
 * EventHandlerCtx —— 所有事件 handler 模块的共享上下文。
 *
 * 包含 handleEvent 内部引用的全部 set* 函数、refs 和常量。
 * 主 hook 构建 ctx 后传给 createEventHandler，再分发到各 handler 函数。
 */

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { WsMessage } from "@/hooks/useWebSocket";
import type { TokenUsageState,
  ChatMessage,
} from "../types";
import type { CommandApproval } from "../useChatSession";
import type { RelayData } from "@/lib/apiClient";
import type { TypewriterApi } from "../useTypewriter";
import type { FormSpecData } from "../formTypes";

export interface EventHandlerCtx {
  // ── 状态 setter ──
  setChatHistory: Dispatch<SetStateAction<ChatMessage[]>>;
  setStatusText: (s: string) => void;
  setStatusPhase: (p: string) => void;
  setIsLoading: (b: boolean) => void;
  setIsLoadingSession: (b: boolean) => void;
  setTokenUsage: Dispatch<SetStateAction<TokenUsageState>>;
  setReasoning: (s: string | ((prev: string) => string)) => void;
  setWorkspace: (s: string) => void;
  setWorkspaces: (s: string[]) => void;
  setCurrentGroupId: (s: string | null) => void;
  setLiveRelay: (r: RelayData | null) => void;
  setFocusRelayId: (s: string | null) => void;
  setDeletedRelayId: (s: string | null) => void;
  setHasRelay: (b: boolean) => void;
  setEditMode: (m: "auto" | "manual") => void;
  setIsCompacting: (b: boolean) => void;
  setCompactingMessage: (s: string | null) => void;
  setCompactionNeeded: (n: { currentTokens: number; maxTokens: number; percent: number } | null) => void;
  setCompactionMigrated: (m: { newSessionId: string; parentSessionId?: string } | null) => void;
  setCreditBudgetPaused: (n: { spent: number; threshold: number; usage?: string } | null) => void;
  setPendingPaths: (p: string[]) => void;
  setPendingDiffs: (d: Record<string, { oldContent: string; newContent: string }>) => void;
  setPendingExpanded: (b: boolean) => void;
  setUndoNotice: (n: { id: number; text: string } | null) => void;
  setToolConfirm: (c: { toolName: string; title: string; kind?: string } | null) => void;
  setAskUser: (a: AskUserRequest | null) => void;
  setFormRequest: (r: FormRequest | null) => void;
  /** 会话记忆的最新内容（模型写入或用户导入之后推送） */
  setMemory: (m: string) => void;
  /** 记忆的历史版本（新的在前），响应 get_memory_history */
  setMemoryHistory: (v: MemoryVersion[]) => void;
  setWaitingInputIds: (s: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  setCommandApprovals: (c: Record<string, CommandApproval> | ((prev: Record<string, CommandApproval>) => Record<string, CommandApproval>)) => void;
  setCommandRiskNotice: (c: { id?: string; command: string; reason: string } | null) => void;
  setContextOverflow: (b: boolean) => void;
  setToolHistoryMismatch: (m: { model: string } | null) => void;

  // ── refs（跨事件共享的可变状态） ──
  cancelled: MutableRefObject<boolean>;
  cancelledTurnMsgId: MutableRefObject<string | null>;
  /**
   * 用户主动取消时（同步）记录其轮次；用于忽略已被新一轮超越的迟到收尾事件。
   * 装配后**不再清空**（同一轮取消的收尾事件不止一条，清早了后面的就无从判断），
   * 直到下一次用户取消把它覆盖。判据见 isStaleCancelledTurnEnd。
   */
  cancelledTurnGeneration: MutableRefObject<number | null>;
  turnGeneration: MutableRefObject<number>;
  /** 当前轮的开始时间（sendNow 时写入）。用于判断一条终态事件是否可能属于当前轮。 */
  turnStartTime: MutableRefObject<number>;
  /**
   * 本轮用户消息的 id（sendNow 时写入，与 user_message 一起发给后端的 clientMessageId）。
   *
   * 后端会把同一个 id 原样带回在收尾事件上（stream_end / turn_cancelled —— 见 agentSession.send）。
   * 有了它就不必再用时间线去猜"这条终态事件属于哪一轮"，直接比 id 即可（治本）。
   * 事件不带该字段时（老后端 / 历史会话）退回 turnStartTime 那套推断（高可用、向后兼容）。
   */
  currentTurnClientMessageId: MutableRefObject<string | null>;
  modelRef: MutableRefObject<string>;
  statusPhaseRef: MutableRefObject<string>;
  toolResultResetTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  compactionMigratedRef: MutableRefObject<{ newSessionId: string; parentSessionId?: string } | null>;
  /**
   * 本面板已"拥有"的会话 id（与 useChatSession 内同一个 ref）。
   * session_created 时需在此认领新会话，使随后 sessionId prop 变化触发的加载 effect
   * 命中"自己创建、非重连"的跳过分支，避免误把正在流式输出的首条消息 reset 掉。
   */
  ownedSessionId: MutableRefObject<string | null>;
  onSessionCreatedRef: MutableRefObject<(id: string) => void>;
  onCompactionMigratedRef: MutableRefObject<((id: string) => void) | undefined>;
  /** 会话分叉完成回调：新会话只带记忆，上层刷新会话列表并切到新会话 */
  onSessionForkedRef: MutableRefObject<((newSessionId: string, sourceId?: string) => void) | undefined>;

  // ── 打字机 API ──
  typewriter: TypewriterApi;

  // ── 杂项 ──
  clientId: string;
  send: (cmd: Record<string, unknown>) => void;
  finishLoading: () => void;
}

/** ask_user 里的单个问题。 */
export interface AskUserQuestionData {
  question: string;
  options: { id: string; label: string; description?: string }[];
  /** true=多选（checkbox），false=单选（radio） */
  multi: boolean;
  /** 是否允许用户自己输入「其他」 */
  allowOther: boolean;
}

/** ask_user 问答请求：Agent 一次抛 1~N 个问题，等用户逐题单选/多选作答。 */
export interface AskUserRequest {
  toolCallId: string;
  questions: AskUserQuestionData[];
}

/** ask_form 表单请求：Agent 交付一张声明式表单，等用户填写后提交。 */
export interface FormRequest {
  toolCallId: string;
  spec: FormSpecData;
}

export type { WsMessage };

/** 记忆的一个历史版本：content 是它被 source 改写之前的完整内容 */
export interface MemoryVersion {
  at: number;
  source: "model" | "auto" | "user" | "import" | "restore" | string;
  content: string;
}
