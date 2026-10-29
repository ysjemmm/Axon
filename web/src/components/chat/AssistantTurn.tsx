import { TurnUsageLabel } from "./TurnUsageLabel";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { Code } from "lucide-react";
import { AxonSpark } from "@/components/AxonSpark";
import type { ChatMessage, TextSegment } from "./types";
import { formatElapsed } from "./format";
import { MessageTime } from "./MessageTime";
import { Clock, Coins, Cpu, GitFork, Timer } from "lucide-react";
import { metaItemClass, metaTooltipClass } from "./turnMetaStyles";

/** 底部元信息行的图标：小、细、比文字再淡一点 */
const META_ICON = "size-3 shrink-0 opacity-70";
import { renderSegments } from "./renderSegments";

/**
 * 运行中计时格式：随耗时递进切换单位，避免长任务显示一串难读的纯秒数。
 * < 1 秒：毫秒；< 1 分钟：秒；< 1 小时：分+秒；< 1 天：时+分+秒；
 * < 1 月（按 30 天）：日+时+分；更久：月+日+时。
 */
function formatLiveElapsed(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h ${minutes}m ${seconds}s`;
  const hours = totalHours % 24;
  const totalDays = Math.floor(totalHours / 24);
  if (totalDays < 30) return `${totalDays}d ${hours}h ${minutes}m`;
  const days = totalDays % 30;
  const months = Math.floor(totalDays / 30);
  return `${months}mo ${days}d ${hours}h`;
}

/** AI 运行计时：每 100ms 刷新，和左侧 AxonSpark 同步带轻微呼吸动画。 */
function LiveElapsedTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(() => Math.max(0, Date.now() - startedAt));

  useEffect(() => {
    const tick = () => setElapsed(Math.max(0, Date.now() - startedAt));
    tick();
    const timer = window.setInterval(tick, 100);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <span className="ml-1 text-[10px] tabular-nums text-muted-foreground/55 animate-pulse" title="本次任务已运行时长">
      {formatLiveElapsed(elapsed)}
    </span>
  );
}

/**
 * AI 回复的头部：品牌图标 + 名称 +（本轮进行中时）实时状态文字。
 *
 * 单独导出是为了让"AI 还没开始输出"的那一小段（用户消息刚发出、stream_start 未到）
 * 也能用同一个头部渲染在消息流末尾，视觉上与真正的回复无缝衔接——
 * 而不是像早先那样把状态挤在输入框上方的状态条里。
 */
export function AssistantTurnHeader({
  streaming,
  liveStatus,
  startedAt,
  children,
}: {
  streaming?: boolean;
  liveStatus?: string;
  /** 本次任务的本地起始时间戳；仅 streaming 时显示实时计时 */
  startedAt?: number;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 mb-2.5">
      <AxonSpark size={20} animate={!!streaming} />
      {/* 品牌名只在终态出现。进行中那一栏的位置留给状态文字（"思考中…"/"正在回复…"），
          两者都摆上去就是一行三段并列，信息密度高而没多给信息——进行中用户要看的是进度，
          不是"这是谁在说话"（会话里只有一个 AI）。 */}
      {!streaming && (
        <span className="text-sm font-semibold text-foreground">Axon</span>
      )}
      {/* 状态文字用"高光扫过"，而不是早先的 animate-pulse。
          pulse 拉的是整段文字的 opacity（1↔0.5），属于全局明暗振荡，与图标动画周期错相时
          会周期性地一起变暗——那就是最初"隔一段时间闪一下"的来源之一。
          扫光只让一条窄高光带平移过去，底色恒定，因此不与图标叠出节拍。配色见 index.css。 */}
      {liveStatus && (
        <span className="text-xs truncate max-w-[240px] axon-text-shimmer">
          {liveStatus}
        </span>
      )}
      {streaming && typeof startedAt === "number" && startedAt > 0 && <LiveElapsedTimer startedAt={startedAt} />}
      {children}
    </div>
  );
}

function AssistantTurnImpl({
  message,
  liveStatus,
  startedAt,
  onAcceptEdit,
  onRejectEdit,
  onUndoEdit,
  onForkFromMessage,
}: {
  message: ChatMessage;
  /** 本轮进行中的状态文字；仅最后一条 assistant 消息在流式期间会收到 */
  liveStatus?: string;
  /** 本次任务起点；仅当前流式回复传入 */
  startedAt?: number;
  onAcceptEdit?: (path: string) => void;
  onRejectEdit?: (path: string) => void;
  onUndoEdit?: (path: string) => void;
  /** 从这里分叉：带上此前的对话另起一个会话 */
  onForkFromMessage?: (message: ChatMessage) => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const segments = message.segments || [];

  const rawContent = useMemo(
    () =>
      segments
        .filter((s): s is TextSegment => s.type === "text")
        .map((s) => s.content)
        .join("")
        .trim(),
    [segments],
  );

  const renderedSegments = useMemo(
    () => renderSegments(segments, message.streaming, onAcceptEdit, onRejectEdit, onUndoEdit, { groupActivity: true }),
    [segments, message.streaming, onAcceptEdit, onRejectEdit, onUndoEdit],
  );

  const uncertain = message.turnStatus === "cancelled" || message.turnStatus === "error";

  return (
    <div className="group/assistant flex flex-col">
      <AssistantTurnHeader streaming={message.streaming} liveStatus={liveStatus} startedAt={startedAt}>
        {!message.streaming && rawContent && (
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <Code className="w-3 h-3" />
            {showRaw ? "Rendered" : "Raw"}
          </button>
        )}
      </AssistantTurnHeader>

      <div className="min-w-0">
        {showRaw ? (
          <pre className="text-xs bg-zinc-100 dark:bg-zinc-800 rounded-md p-3 overflow-x-auto whitespace-pre-wrap font-mono text-zinc-800 dark:text-zinc-200">
            {rawContent}
          </pre>
        ) : (
          <div className="axon-turn-body">{renderedSegments}</div>
        )}

        {!message.streaming && message.turnStats && (
          <div className="mt-3 flex min-h-5 flex-wrap items-center gap-x-3.5 gap-y-1 font-sans text-[11.5px] leading-none text-muted-foreground/75 tabular-nums animate-rise-in">
            {message.turnStats.completedAt ? (
              <span className={metaItemClass}>
                <Clock className={META_ICON} />
                <MessageTime at={message.turnStats.completedAt} />
              </span>
            ) : null}
            <TurnUsageLabel stats={message.turnStats} uncertain={uncertain} icon={<Coins className={META_ICON} />} />
            {message.turnStats.modelName || message.turnStats.model ? (
              <span className={`${metaItemClass} group/model-meta max-w-[220px]`}>
                <Cpu className={META_ICON} />
                <span className="truncate">{message.turnStats.modelName || message.turnStats.model}</span>
                {message.turnStats.effort && <span className="rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">{message.turnStats.effort}</span>}
                <span className={`${metaTooltipClass} group-hover/model-meta:block`}>
                  <span className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 whitespace-nowrap">
                    <span className="text-muted-foreground">Provider</span>
                    <span className="text-right">{message.turnStats.providerName || "未知"}</span>
                    <span className="text-muted-foreground">模型</span>
                    <span className="text-right font-mono text-[11px]">{message.turnStats.model || "—"}</span>
                    <span className="text-muted-foreground">思考强度</span>
                    <span className="text-right">{message.turnStats.effort || "关闭"}</span>
                  </span>
                </span>
              </span>
            ) : null}
            {uncertain && (
              <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10.5px] text-amber-700 dark:text-amber-400">
                {message.turnStatus === "cancelled" ? "已中断" : "出错"}
              </span>
            )}
            {/* 用时和分叉是次要信息：悬停这条回复时才出现，不占平时的视线 */}
            <span className="ml-auto flex items-center gap-2.5 opacity-0 transition-opacity duration-150 group-hover/assistant:opacity-100 focus-within:opacity-100">
              <span className={metaItemClass} title="这轮回复的总用时">
                <Timer className={META_ICON} />
                {formatElapsed(message.turnStats.elapsed)}
              </span>
              {!message.archived && onForkFromMessage && (
                <button
                  type="button"
                  onClick={() => onForkFromMessage(message)}
                  title="从这里分叉（带上此前的对话）"
                  className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground/75 transition-colors hover:bg-muted hover:text-foreground"
                >
                  <GitFork className={META_ICON} />
                  分叉
                </button>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// liveStatus 也要参与比较，否则状态文字变化（思考中→正在读取文件…）不会重渲染。
// 只有最后一条 assistant 消息会拿到非 undefined 的 liveStatus，历史消息不受影响。
export const AssistantTurn = memo(
  AssistantTurnImpl,
  (prev, next) =>
    prev.message === next.message &&
    prev.liveStatus === next.liveStatus &&
    prev.onForkFromMessage === next.onForkFromMessage,
);
