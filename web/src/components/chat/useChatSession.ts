/**
 * useChatSession 鈥斺€?浼氳瘽鎺у埗鍣?hook锛堝浼氳瘽鐗堬級
 *
 * 浠庡師 ChatPanel.tsx 鎷嗗嚭锛氭敹绾充竴涓潰鏉匡紙ChatPanel锛夌殑銆屼細璇濅笌浼犺緭銆嶅叏閮ㄧ姸鎬佷笌閫昏緫锛?
 * - 鑱婂ぉ鍘嗗彶銆佹祦寮忔墦瀛楁満銆乼oken 鐢ㄩ噺銆佹€濊€冭繃绋嬨€佺姸鎬佹枃妗堛€佸緟纭鏀瑰姩銆佹秷鎭槦鍒椼€佸伐鍏风‘璁ら棬銆?
 *   缂栬緫妯″紡銆佸伐浣滃尯銆佹ā鍨嬨€丷elay 鍛堢幇绛変細璇濈姸鎬併€?
 * - Agent 浜嬩欢澶勭悊锛坔andleEvent锛夛細缁?useSessionEvents 鎸?clientId 璁㈤槄鏈潰鏉跨殑浜嬩欢娴併€?
 * - 鍏ョ珯鎸囦护灏佽锛坰ubmit / cancel / acceptEdits 绛夛級锛氬彂閫佹椂鑷姩甯︿笂鏈潰鏉?clientId銆?
 *
 * ChatPanel 澹冲眰鍙繚鐣欍€岃緭鍏ュ尯缂栨帓 + 瑙嗗浘 + 婊氬姩/鏂囦欢/鍥剧墖/寮圭獥銆嶏紝鐘舵€佸叏閮ㄦ潵鑷湰 hook銆?
 */

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { MODELS, findModel, getModels, useModels } from "@/components/ModelSelector";
import type { ToolStatus } from "@/components/ToolCallItem";
import { listRelays, type RelayData } from "@/lib/apiClient";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import type { AttachedFile, ChatMessage, CreditDetail, TextSegment, UserSegment } from "./types";
import type { CommandDecision } from "./commandApprovalContext";
import { STORAGE, TIMEOUT, CONTROL_CMD } from "@/lib/constants";

// 鎷嗗垎鍚庣殑妯″潡
import { createEventHandler } from "./eventHandlers";
import type { EventHandlerCtx } from "./eventHandlers/types";
import { useTypewriter } from "./useTypewriter";
import { useToolCallQueue } from "./useToolCallQueue";

const DEFAULT_MODEL_ID = "glm-4-flash";

/** 鍙戦€佺敤鎴锋秷鎭殑杞借嵎锛堢敱澹冲眰鏍规嵁杈撳叆/妯″瀷/闄勪欢璁＄畻鍚庝氦缁?hook锛?*/
export interface SubmitPayload {
  /** 鍔犲叆鑱婂ぉ鏃堕棿绾跨殑鐢ㄦ埛姘旀场 */
  userBubble: { content: string; images?: string[]; attachedFiles?: AttachedFile[]; segments?: UserSegment[] };
  /** user_message 鎸囦护瀛楁锛坱ype/clientId 鐢?hook 娉ㄥ叆锛?*/
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
    /** 浼氳瘽妯″紡 */
    mode?: "agent" | "quest";
    /** Quest 妯″紡閫夐」 */
    quest?: { think?: boolean; webSearch?: boolean };
  };
}

/** 鍛戒护淇′换鎺堟潈璇锋眰锛氭湭淇′换鍛戒护鏃跺悗绔脊鍑猴紝鍚洓妗?鍔犲叆鐧藉悕鍗?閫夐」 */
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

  // 鈹€鈹€ 浼氳瘽鐘舵€?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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
  const [workspace, setWorkspace] = useState<string>("");
  const [workspaces, setWorkspacesState] = useState<string[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const setWorkspaces = useCallback((ws: string[]) => {
    setWorkspacesState(ws);
    setWorkspacesLoaded(true);
  }, []);
  const [currentGroupId, setCurrentGroupId] = useState<string | null>(null);
  // Relay 鍛堢幇锛堜粎 hasRelay 鐢ㄤ簬椤舵爮鍛煎惛鐏紱鍏朵綑淇濈暀浠ユ壙鎺ヤ簨浠讹級
  const [, setLiveRelay] = useState<RelayData | null>(null);
  const [, setFocusRelayId] = useState<string | null>(null);
  const [, setDeletedRelayId] = useState<string | null>(null);
  const [hasRelay, setHasRelay] = useState(false);
  const [editMode, setEditMode] = useState<"auto" | "manual">(() => {
    try { return (localStorage.getItem(STORAGE.EDIT_MODE) as "auto" | "manual") || "manual"; } catch { return "manual"; }
  });
  // Quest 妯″紡寮€鍏筹細鎬濊€冭繃绋?/ 鑱旂綉鎼滅储锛堟寔涔呭寲锛?
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
  const [statusText, setStatusText] = useState("鎬濊€冧腑...");
  const [statusPhase, setStatusPhase] = useState<string>("thinking");
  const [isCompacting, setIsCompacting] = useState(false);
  /** 鑷姩鍘嬬缉瑙﹀彂鏃跺悗绔殏鍋滅瓑寰呯敤鎴烽€夋嫨锛?=75% 闃堝€硷級 */
  const [compactionNeeded, setCompactionNeeded] = useState<{ currentTokens: number; maxTokens: number; percent: number } | null>(null);
  /** 褰撳墠浼氳瘽宸茶杩佺Щ鍒版柊浼氳瘽锛堣緭鍏ユ绂佺敤锛屽睍绀鸿烦杞摼鎺ワ級 */
  const [compactionMigrated, setCompactionMigrated] = useState<{ newSessionId: string; parentSessionId?: string } | null>(null);
  const compactionMigratedRef = useRef<{ newSessionId: string; parentSessionId?: string } | null>(null);
  compactionMigratedRef.current = compactionMigrated;
  /** Credits 预算门硬暂停触发时后端暂停等待用户选择（继续/停止） */
  const [creditBudgetPaused, setCreditBudgetPaused] = useState<{ spent: number; threshold: number } | null>(null);
  const [pendingPaths, setPendingPaths] = useState<string[]>([]);
  const [pendingDiffs, setPendingDiffs] = useState<Record<string, { oldContent: string; newContent: string }>>({});
  const [pendingExpanded, setPendingExpanded] = useState(false);
  /** 鎾ら攢澶辫触鐨勮交鎻愮ず锛堣嚜鍔ㄦ秷澶憋級 */
  const [undoNotice, setUndoNotice] = useState<{ id: number; text: string } | null>(null);
  const [toolConfirm, setToolConfirm] = useState<{ toolName: string; title: string; kind?: string } | null>(null);
  // execute_command 鍗＄墖鐨?绛夊緟鐢ㄦ埛杈撳叆"鍛煎惛鐏細鎸?toolCallId 绱㈠紩
  const [waitingInputIds, setWaitingInputIds] = useState<Set<string>>(new Set());
  // 鍛戒护淇′换鎺堟潈闂細鏈俊浠诲懡浠ょ殑瀹℃壒鏀逛负鍐呰仈鍦ㄥ搴斿懡浠ゅ崱鐗囦笂锛堟棤鎰熸ā寮忥級锛屾寜 toolCallId 绱㈠紩銆?
  // 骞跺彂瀹夊叏鈥斺€攑arallel_research / 澶氫釜瀛?Agent 鍙兘鍚屾椂璇锋眰锛屽悇鑷寕鍦ㄨ嚜宸辩殑鍛戒护鍗＄墖涓娿€?
  const [commandApprovals, setCommandApprovals] = useState<Record<string, CommandApproval>>({});
  // 鍗遍櫓鍛戒护琚‖鎷︽椂缁欑敤鎴风殑鍙鎻愮ず锛堜笌缁?AI 鐨勯敊璇垎寮€锛?
  const [commandBlocked, setCommandBlocked] = useState<{ requestId?: string; command: string; reason: string; dangerous?: boolean } | null>(null);
  const [messageQueue, setMessageQueue] = useState<Array<{ id: string; payload: SubmitPayload }>>([]);

  // 鈹€鈹€ refs 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  const cancelled = useRef(false);
  /** 琚彇娑堥偅杞?assistant 娑堟伅鐨?id鈥斺€攖urn_cancelled 浜嬩欢鐢ㄦ绮剧‘瀹氫綅锛?
   *  閬垮厤绔炴€佽灏嗘柊鍚姩鐨勮疆娆℃爣涓?cancelled */
  const cancelledTurnMsgId = useRef<string | null>(null);
  const turnStartTime = useRef<number>(0);
  /** turn 浠ｆ暟璁℃暟鍣ㄢ€斺€旀瘡娆?$sendNow$ 鍚姩鏂拌疆鏃堕€掑銆傛墍鏈?assistant 娑堟伅鎵撲笂 turnGen锛?
   * 宸ュ叿缁撴灉绛夊紓姝ヤ簨浠跺彧浣滅敤浜庡悓浠?assistant锛岄槻姝㈠彇娑?A 鍚庨檲鏃х粨鏋滅┛鍒?B銆?*/
  const turnGeneration = useRef(0);
  // 鍦ㄧǔ瀹?handler 鍐呰鍙栨渶鏂板€硷紝閬垮厤鎶?handler 渚濊禆杩欎簺 state锛堜繚鎸佽闃呯ǔ瀹氾級
  const modelRef = useRef(model); modelRef.current = model;
  const statusPhaseRef = useRef(statusPhase); statusPhaseRef.current = statusPhase;
  const editModeRef = useRef(editMode); editModeRef.current = editMode;
  // tool_result 鍚庡欢杩熼噸缃姸鎬佺殑瀹氭椂鍣紙闃叉杩炵画宸ュ叿璋冪敤鏃?"鎬濊€冧腑" 闂儊锛?
  const toolResultResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 鈹€鈹€ 鎵撳瓧鏈?hook锛坆uffer/RAF/flush 閫昏緫灏佽锛?鈹€鈹€
  const typewriter = useTypewriter();
  // 鈹€鈹€ tool_call 娓叉煋闃熷垪 hook锛堝崱鐗囨寜搴忛€愪釜鍏ュ満锛?鈹€鈹€
  const toolCallQueueApi = useToolCallQueue();
  // 鍛戒护鎺堟潈闂ㄨ姹傜敤 ref 鎸佹湁锛屼緵鍙栨秷/鍥炰紶鏃惰鍙栨渶鏂版槧灏勶紝閬垮厤鍥炶皟渚濊禆 state
  const commandApprovalsRef = useRef<Record<string, CommandApproval>>({}); commandApprovalsRef.current = commandApprovals;
  const onSessionCreatedRef = useRef(onSessionCreated); onSessionCreatedRef.current = onSessionCreated;
  const onCompactionMigratedRef = useRef(onCompactionMigrated); onCompactionMigratedRef.current = onCompactionMigrated;
  /**
   * 鏈潰鏉垮凡"鎷ユ湁"锛堝凡鍔犺浇鎴栬嚜宸卞垱寤猴級鐨勪細璇?id銆?
   * 鐢ㄤ簬鍖哄垎 sessionId prop 鍙樺寲鐨勪袱绉嶆潵婧愶細
   * - 鍒囧埌涓€涓笉鍚岀殑鏃㈡湁浼氳瘽锛堥渶瑕?load_session 鎷夊巻鍙诧級
   * - 鑷繁鍒氬垱寤虹殑浼氳瘽锛坰ession_created 鎶?tab.id 浠?null 鏀规垚鏂?id锛夆€斺€旀鏃舵湰闈㈡澘宸叉寔鏈夊疄鏃剁姸鎬侊紝
   *   缁濅笉鑳介噸鏂?load_session锛屽惁鍒欎細娓呯┖姝ｅ湪娴佸紡杈撳嚭鐨勫璇濄€?
   * 鍒濆涓?null锛氶娆℃寕杞借嫢宸叉湁 sessionId锛堝埛鏂?鍘嗗彶鎵撳紑锛変粛浼氭甯稿姞杞姐€?
   */
  const ownedSessionId = useRef<string | null>(null);
  /**
   * 鏈€杩戜竴娆″凡璇锋眰 load_session 鐨勪細璇?id銆?
   * 鐢ㄦ潵閬垮厤鍚屼竴涓?session 鍦ㄥ墠绔噸娓叉煋/灞€閮ㄩ噸鎸傝浇鏃堕噸澶嶈Е鍙?load_session锛?
   * 瀵艰嚧瀹炴椂娴佸紡鐘舵€佽 session_loaded 蹇収瑕嗙洊銆?
   */
  const lastLoadedSessionId = useRef<string | null>(null);
  /**
   * 鏍囪褰撳墠杩欐 connected=true 鏄惁鐪熺殑鏄?鏂嚎鍚庨噸杩?銆?
   * 棣栨鎸傝浇涓嶆槸閲嶈繛锛涘彧鏈夌粡鍘嗚繃 connected=false 涔嬪悗鍐嶆鍙樹负 true 鎵嶇畻閲嶈繛銆?
   */
  const hasEverConnected = useRef(false);

  /** 缁撴潫褰撳墠鍔犺浇鎬侊紙鑷冲皯灞曠ず MIN_LOADING_MS锛岄伩鍏嶆瀬鐭搷搴旇 spin 闂儊鍗虫秷澶憋級 */
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

  /** 甯︽湰闈㈡澘 clientId 鐨勫彂閫?*/
  const send = useCallback((cmd: Record<string, unknown>) => {
    baseSend({ ...cmd, clientId });
  }, [baseSend, clientId]);

  // Provider/妯″瀷鐩綍寮傛鍔犺浇瀹屾垚鍚庯紝鍚屾淇褰撳墠妯″瀷鐨勬渶澶т笂涓嬫枃锛?
  // 閬垮厤閲嶅惎鍒濇湡鍏堟寜闈欐€佸厹搴?MODELS锛?28K锛夋樉绀猴紝寰呯敤鎴峰啀娆℃墜鐐规ā鍨嬫墠鍙樻纭€?
  useEffect(() => {
    const currentModel = models.find((m) => m.id === model);
    if (!currentModel?.contextWindow) return;
    setTokenUsage((prev) => (prev.max === currentModel.contextWindow ? prev : { ...prev, max: currentModel.contextWindow }));
  }, [model, models]);

  // 鈹€鈹€ 閫氱煡涓婂眰娴佸紡鐘舵€佸彉鍖栵紙渚?SessionContainer 鍐冲畾淇濇椿/鍗歌浇锛?鈹€鈹€
  useEffect(() => { onStreamingChange?.(isLoading); }, [isLoading, onStreamingChange]);

  // 鈹€鈹€ Agent 浜嬩欢澶勭悊锛堢ǔ瀹?handler锛屾寜 clientId 璁㈤槄锛?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // 鈹€鈹€ 鏋勫缓 EventHandlerCtx 鈹€鈹€
  const ctx: EventHandlerCtx = {
    setChatHistory, setStatusText, setStatusPhase, setIsLoading,
    setIsLoadingSession, setTokenUsage, setReasoning, setWorkspace, setWorkspaces,
    setCurrentGroupId, setLiveRelay, setFocusRelayId, setDeletedRelayId, setHasRelay,
    setEditMode, setIsCompacting, setCompactionNeeded, setCompactionMigrated,
    setCreditBudgetPaused,
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

  // 鈹€鈹€ 浜嬩欢澶勭悊锛堢ǔ瀹?handler锛屾寜 msg.type 璺敱鍒板悇 handler 妯″潡锛?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  const handleEvent = useMemo(
    () => createEventHandler(ctx),
    // ctx 瀛楁閮芥槸绋冲畾寮曠敤锛坲seState setter銆乽seRef锛夛紝涓嶄細鍙?
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // 鈹€鈹€ tool_call 娓叉煋闃熷垪鍖呰９鍣?鈹€鈹€
  const queuedHandleEvent = useMemo(
    () => toolCallQueueApi.wrap(handleEvent, ctx),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handleEvent],
  );

  // 鎸?clientId 璁㈤槄鏈潰鏉夸簨浠舵祦
  useSessionEvents(clientId, queuedHandleEvent);

  // 鈹€鈹€ 杩炴帴鎴愬姛 / sessionId 鍙樺寲鏃跺姞杞戒細璇?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // reconnected锛氳繛鎺?false鈫抰rue锛堝惈棣栨锛夈€傛鏃跺悗绔槸鍏ㄦ柊 hub锛堟棤浼氳瘽鐘舵€侊級锛?
  // 鍗充究鏈潰鏉?鎷ユ湁"璇ヤ細璇濅篃蹇呴』閲嶆柊 load_session 浠ラ噸寤哄悗绔姸鎬併€?
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
      // 鑷繁鍒氬垱寤虹殑浼氳瘽涓旈潪閲嶈繛锛氬凡鎸佹湁瀹炴椂鐘舵€侊紝涓嶉噸鏂板姞杞斤紙鍚﹀垯浼氭竻绌烘祦寮忚緭鍑猴級
      if (sessionId === ownedSessionId.current && !reconnected) {
        send({ type: CONTROL_CMD.SET_EDIT_MODE, mode: editModeRef.current });
        return;
      }
      // 鍚屼竴涓細璇濆湪鏈柇绾块噸杩炴椂锛岄伩鍏嶅洜缁勪欢閲嶆覆鏌?灞€閮ㄩ噸鎸傝浇鍐嶆 load_session锛?
      // 鍚﹀垯 session_loaded 浼氱敤杈冩棫蹇収瑕嗙洊鎺夋鍦ㄦ祦寮忎腑鐨勫疄鏃剁姸鎬併€?
      if (sessionId === lastLoadedSessionId.current && !reconnected) {
        ownedSessionId.current = sessionId;
        send({ type: CONTROL_CMD.SET_EDIT_MODE, mode: editModeRef.current });
        return;
      }
      // 鍒囧埌鏃㈡湁浼氳瘽 / 閲嶈繛锛氭竻绌?UI銆佽繘鍏ュ姞杞芥€併€佹媺鍘嗗彶
      ownedSessionId.current = sessionId;
      lastLoadedSessionId.current = sessionId;
      setIsLoadingSession(true);
      setChatHistory([]);
      setIsLoading(false);
      setWorkspacesLoaded(false);  // 鍔犺浇鍘嗗彶浼氳瘽鏈熼棿涔熼噸缃紝绛夊悗绔繑鍥炲伐浣滃尯鍚庡啀鍒ゆ柇
      typewriter.cancel();
      send({ type: "load_session", sessionId });
    } else {
      ownedSessionId.current = null;
      lastLoadedSessionId.current = null;
      setChatHistory([]);
      setIsLoadingSession(false);
      setWorkspacesLoaded(false);  // 鏂板紑 session 鏃堕噸缃姞杞芥爣蹇楋紝绛夊悗绔繑鍥炲伐浣滃尯鍒楄〃鍚庡啀鍒ゆ柇
      send({ type: "reset_session" });
    }
    send({ type: CONTROL_CMD.SET_EDIT_MODE, mode: editModeRef.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, sessionId]);

  // 鈹€鈹€ 宸ヤ綔鍖哄彉鍖栨椂鏌ヨ鏈畬鎴?Relay锛岀偣浜《鏍忓懠鍚哥伅 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  useEffect(() => {
    if (!workspace) return;
    let cancelledQuery = false;
    (async () => {
      try {
        const { relays } = await listRelays(workspace);
        const hasActive = relays.some((r) => r.phase !== "done");
        if (!cancelledQuery && hasActive) setHasRelay(true);
      } catch { /* 鏌ヨ澶辫触蹇界暐 */ }
    })();
    return () => { cancelledQuery = true; };
  }, [workspace]);

  // 鈹€鈹€ 杩炴帴鏂紑鏃舵敹灏?loading 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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

  // 鈹€鈹€ 闃熷垪娑堣垂锛歩sLoading 鍙?false 涓旈槦鍒楅潪绌烘椂鍙栧嚭绗竴鏉¤嚜鍔ㄥ彂閫?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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

  // 鈹€鈹€ 鍙戦€佸姩浣?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

  /** 鐪熸鎵ц鍙戦€侊細杩藉姞鐢ㄦ埛姘旀场 + 鍙?user_message + 杩涘叆鍔犺浇鎬?*/
  const sendNow = useCallback((payload: SubmitPayload) => {
    // 閫掑浠ｆ暟锛屾柊涓€杞簨浠跺彧浣滅敤浜庢湰浠ｇ殑 assistant 娑堟伅
    const gen = ++turnGeneration.current;
    // 娓呴櫎鍙栨秷鏍囪鈥斺€旀柊涓€杞紑濮嬪悗锛屼箣鍓嶅彇娑堣鐨?flag 涓嶅簲闃绘鏂颁簨浠跺鐞?
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
    // 浼樺厛鐢?payload 閲岃绠楀ソ鐨?provider锛堟潵鑷敤鎴峰湪妯″瀷閫夋嫨鍣ㄩ噷鐨勯€夋嫨锛夛紝
    // 鍥為€€鍒?session 绾х殑 providerState锛堟潵鑷?setModel锛夈€?
    const finalProvider = payload.send.provider ?? providerState;
    console.log("[axon-send] provider 璺熻釜", {
      payloadProvider: payload.send.provider,
      sessionProviderState: providerState,
      finalProvider,
      model: payload.send.model,
    });
    send({ type: CONTROL_CMD.USER_MESSAGE, ...payload.send, provider: finalProvider });
    setIsLoading(true);
    setReasoning(""); // 鏂颁竴杞紑濮嬶細娓呯┖涓婁竴杞畫鐣欑殑鎬濊€冭繃绋?
    setStatusText("鎬濊€冧腑...");
    setStatusPhase("thinking");
    turnStartTime.current = Date.now();
  }, [send]);

  /** 鎻愪氦涓€鏉＄敤鎴锋秷鎭細AI 鍥炲涓垨鍘嬬缉涓垯鎺掗槦锛屽惁鍒欑珛鍗冲彂閫併€傝繑鍥炴槸鍚﹀凡鎺掗槦銆?*/
  const submit = useCallback((payload: SubmitPayload): boolean => {
    if (isLoading || isCompacting) {
      setMessageQueue((prev) => [...prev, { id: `q-${Date.now()}`, payload }]);
      return true;
    }
    sendNow(payload);
    return false;
  }, [isLoading, isCompacting, sendNow]);

  /** 鎵嬪姩鍘嬬缉涓婁笅鏂?*/
  const compactSession = useCallback(() => {
    send({ type: "compact_session" });
  }, [send]);

  /** 鐢ㄦ埛瀵瑰帇缂╂柟寮忓仛鍑洪€夋嫨 */
  const chooseCompaction = useCallback((choice: "continue" | "new_session") => {
    send({ type: "compaction_choice", choice });
    setCompactionNeeded(null);
  }, [send]);

  /** 用户对 Credits 预算暂停做出选择（继续本轮任务 / 停止） */
  const chooseCreditBudget = useCallback((choice: "continue" | "stop") => {
    send({ type: "credit_budget_choice", choice });
    setCreditBudgetPaused(null);
  }, [send]);

  /** 瀵艰埅鍒拌縼绉荤洰鏍囨柊浼氳瘽锛堢埗缁勪欢璐熻矗鍒?tab锛?*/
  const navigateToMigratedSession = useCallback((newSessionId: string) => {
    const vscode = (window as any).__axonVSCode;
    if (vscode) vscode.postMessage({ type: "open_session", sessionId: newSessionId });
  }, []);

  /** 浠庨槦鍒楃Щ闄ゆ寚瀹氭秷鎭?*/
  const removeFromQueue = useCallback((id: string) => {
    setMessageQueue((prev) => prev.filter((m) => m.id !== id));
  }, []);

  /** 鍙栨秷褰撳墠杞锛坢odel 鐢ㄤ簬浼扮畻 credits锛夈€傚帇缂╄繘琛屼腑鏃跺拷鐣ャ€?*/
  const cancelTurn = useCallback((currentModel: string) => {
    if (isCompacting) return;
    send({ type: "cancel" });
    if (toolConfirm) {
      send({ type: "confirm_tool", confirmed: false });
      setToolConfirm(null);
    }
    // 鍙栨秷鏃舵妸鎵€鏈夋湭鍐冲懡浠ゆ巿鏉冩寜"鎷掔粷"鍥炰紶锛岄伩鍏嶅悗绔?gate锛堝惈骞跺彂瀛?Agent锛夋案涔呴樆濉?
    const pendingApprovals = commandApprovalsRef.current;
    if (Object.keys(pendingApprovals).length > 0) {
      for (const entry of Object.values(pendingApprovals)) {
        send({ type: "confirm_command", requestId: entry.requestId, choice: "reject" });
      }
      setCommandApprovals({});
    }
    cancelled.current = true;
    typewriter.cancel();
    setWaitingInputIds(new Set()); // 鍙栨秷鏃舵竻闄ゆ墍鏈夊懠鍚哥伅
    // 璁板綍琚彇娑堢殑 assistant 娑堟伅 id锛屼緵 turn_cancelled 浜嬩欢绮剧‘鍖归厤
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
        // 涔愯鎷嗗垎锛歴ystem/鏈鎻愰棶/璁板繂閮芥湁闈為浂浼扮畻锛屼笉鎶婂叏浼氳瘽 token 鍏ㄥ杩?璁板繂"銆?
        // 鐪熷疄鍊间細鍦ㄥ悗绔?turn_cancelled 浜嬩欢鍒拌揪鏃惰鐩栥€?
        const estSystemTokens = Math.min(estInputTokens, 10000); // 绯荤粺鎻愮ず + 宸ュ叿瀹氫箟鏈€灏戜篃鏈夊嚑鍗?token
        const estQuestionTokens = Math.min(estInputTokens - estSystemTokens, last.content ? Math.round(last.content.length * 0.35) : 0);
        const cancelCreditDetail: CreditDetail = {
          inputTokens: estInputTokens,
          outputTokens: estOutputTokens,
          cachedInputTokens: 0,
          inputRate: 0.14,
          outputRate: 0.44,
          tier: "浼扮畻",
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

  /** 鍒囨崲缂栬緫妯″紡 */
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

  const confirmTool = useCallback((confirmed: boolean) => {
    setToolConfirm(null);
    send({ type: "confirm_tool", confirmed });
  }, [send]);

  /** 鍥炲簲鍛戒护鎺堟潈闂細鎶婄敤鎴峰鏌愭潯鍛戒护鐨勫喅绛栧洖浼犲悗绔紝骞朵粠寰呭鎵规槧灏勪腑绉婚櫎 */
  const approveCommand = useCallback((toolCallId: string, decision: CommandDecision) => {
    const entry = commandApprovalsRef.current[toolCallId];
    if (!entry) return;
    send({ type: "confirm_command", requestId: entry.requestId, choice: decision.choice, pattern: decision.pattern, target: decision.target, editedCommand: decision.editedCommand });
    setCommandApprovals((m) => {
      const next = { ...m };
      delete next[toolCallId];
      return next;
    });
    // 鐢ㄦ埛缂栬緫浜嗗懡浠わ細涔愯鏇存柊瀵瑰簲鍗＄墖鐨勫睍绀哄懡浠わ紝閬垮厤鎵ц鏈熼棿浠嶆樉绀烘棫鍛戒护锛堢瓑鍒?tool_result 鎵嶆洿鏂颁細鏈夌┖绐楋級
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

  /** 鍏抽棴"鍗遍櫓鍛戒护琚嫤鎴?鎻愮ず锛堟嫆缁濓級锛屾垨浠嶈鎵ц */
  const respondToDangerousCommand = useCallback((requestId: string, executeAnyway: boolean) => {
    setCommandBlocked(null);
    send({ type: "confirm_command", requestId, choice: executeAnyway ? "once" : "reject" });
  }, [send]);

  /** 鍗曠函鍏抽棴鍗遍櫓鎻愮ず锛堟棤 requestId 鐨勬棫鐗堢‖鎷︼級 */
  const dismissCommandBlocked = useCallback(() => setCommandBlocked(null), []);

  /** 閫夋嫨妯″瀷锛氭寔涔呭寲 + 鏇存柊 token 涓婁笅鏂囩獥鍙?*/
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
    // Auto锛坈ontextWindow=0锛夋垨鑷畾涔夋湭鐭ョ獥鍙ｆ椂涓嶈鎶?max 鍐欐垚 0锛屼繚鐣欎笂涓€娆＄殑鏈夋晥鍊硷紱
    // 鐪熷疄绐楀彛浼氬湪鏀跺埌鍚庣 token_usage 浜嬩欢鍚庤鏍℃涓?瀹為檯閫夌敤妯″瀷"鐨勭獥鍙ｃ€?
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
    // 鐘舵€?
    chatHistory, isLoading, isLoadingSession,
    tokenUsage, reasoning, statusText,
    isCompacting, compactSession, compactionNeeded, compactionMigrated, chooseCompaction, navigateToMigratedSession,
    creditBudgetPaused, chooseCreditBudget,
    pendingPaths, pendingDiffs, pendingExpanded, setPendingExpanded,
    messageQueue, toolConfirm,
    waitingInputIds,
    commandApprovals, commandBlocked,
    editMode, workspace, workspaces, workspacesLoaded, currentGroupId, hasRelay, model, provider: providerState,
    // 鎾ら攢杞绘彁绀?
    undoNotice, setUndoNotice,
    // Quest
    mode, questThink, questWebSearch, setQuestThink, setQuestWebSearch,
    // 鍔ㄤ綔
    submit, removeFromQueue, cancelTurn,
    toggleEditMode, acceptEdits, rejectEdits, undoEdits, confirmTool,
    approveCommand, dismissCommandBlocked, respondToDangerousCommand,
    setModel, selectWorkspace, selectGroup, groupUpdated,
    // 闂數鍥炴粴
    listSnapshots: () => send({ type: "list_snapshots" }),
    restoreSnapshot: (id: string) => send({ type: "restore_snapshot", snapshotId: id }),
  };
}
