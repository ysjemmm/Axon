/**
 * EventHandlerCtx —— 所有事件 handler 模块的共享上下文。
 *
 * 包含 handleEvent 内部引用的全部 set* 函数、refs 和常量。
 * 主 hook 构建 ctx 后传给 createEventHandler，再分发到各 handler 函数。
 */

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { WsMessage } from "@/hooks/useWebSocket";
import type {
  ChatMessage,
} from "../types";
import type { CommandApproval } from "../useChatSession";
import type { RelayData } from "@/lib/apiClient";
import type { TypewriterApi } from "../useTypewriter";

export interface EventHandlerCtx {
  // ── 状态 setter ──
  setChatHistory: Dispatch<SetStateAction<ChatMessage[]>>;
  setStatusText: (s: string) => void;
  setStatusPhase: (p: string) => void;
  setIsLoading: (b: boolean) => void;
  setIsLoadingSession: (b: boolean) => void;
  setTokenUsage: Dispatch<SetStateAction<{ used: number; max: number; cumulative: number }>>;
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
  setCompactionNeeded: (n: { currentTokens: number; maxTokens: number; percent: number } | null) => void;
  setCompactionMigrated: (m: { newSessionId: string; parentSessionId?: string } | null) => void;
  setPendingPaths: (p: string[]) => void;
  setPendingDiffs: (d: Record<string, { oldContent: string; newContent: string }>) => void;
  setPendingExpanded: (b: boolean) => void;
  setUndoNotice: (n: { id: number; text: string } | null) => void;
  setToolConfirm: (c: { toolName: string; title: string; kind?: string } | null) => void;
  setWaitingInputIds: (s: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  setCommandApprovals: (c: Record<string, CommandApproval> | ((prev: Record<string, CommandApproval>) => Record<string, CommandApproval>)) => void;
  setCommandBlocked: (c: { requestId?: string; command: string; reason: string; dangerous?: boolean } | null) => void;

  // ── refs（跨事件共享的可变状态） ──
  cancelled: MutableRefObject<boolean>;
  cancelledTurnMsgId: MutableRefObject<string | null>;
  turnGeneration: MutableRefObject<number>;
  modelRef: MutableRefObject<string>;
  statusPhaseRef: MutableRefObject<string>;
  toolResultResetTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  compactionMigratedRef: MutableRefObject<{ newSessionId: string; parentSessionId?: string } | null>;
  onSessionCreatedRef: MutableRefObject<(id: string) => void>;
  onCompactionMigratedRef: MutableRefObject<((id: string) => void) | undefined>;

  // ── 打字机 API ──
  typewriter: TypewriterApi;

  // ── 杂项 ──
  clientId: string;
  send: (cmd: Record<string, unknown>) => void;
  finishLoading: () => void;
}

export type { WsMessage };
