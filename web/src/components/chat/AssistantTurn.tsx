import { memo, useMemo, useState } from "react";
import { Code } from "lucide-react";
import { AxonLogo } from "@/components/AxonLogo";
import type { ChatMessage, TextSegment } from "./types";
import { formatElapsed } from "./format";
import { renderSegments } from "./renderSegments";

function AssistantTurnImpl({
  message,
  onAcceptEdit,
  onRejectEdit,
  onUndoEdit,
}: {
  message: ChatMessage;
  onAcceptEdit?: (path: string) => void;
  onRejectEdit?: (path: string) => void;
  onUndoEdit?: (path: string) => void;
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
    () => renderSegments(segments, message.streaming, onAcceptEdit, onRejectEdit, onUndoEdit),
    [segments, message.streaming, onAcceptEdit, onRejectEdit, onUndoEdit],
  );

  const uncertain = message.turnStatus === "cancelled" || message.turnStatus === "error";

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 mb-2.5">
        <AxonLogo size={22} animate={!!message.streaming} />
        <span className="text-sm font-semibold text-foreground">Axon</span>
        {!message.streaming && rawContent && (
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <Code className="w-3 h-3" />
            {showRaw ? "Rendered" : "Raw"}
          </button>
        )}
      </div>

      <div className="min-w-0">
        {showRaw ? (
          <pre className="text-xs bg-zinc-100 dark:bg-zinc-800 rounded-md p-3 overflow-x-auto whitespace-pre-wrap font-mono text-zinc-800 dark:text-zinc-200">
            {rawContent}
          </pre>
        ) : (
          <div className="space-y-1">{renderedSegments}</div>
        )}

        {!message.streaming && message.turnStats && (
          <div className="mt-3 text-[11px] text-muted-foreground">
            {message.turnStats.creditDetail ? (
              <span className="relative inline-flex cursor-default border-b border-dotted border-muted-foreground/40 group/credits">
                Credits: {(message.turnStats.credits ?? 0).toFixed(2)}
                {uncertain ? "(?)" : ""}
                <span className="pointer-events-none absolute bottom-full left-0 z-50 mb-2 hidden rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs leading-relaxed text-white shadow-xl group-hover/credits:block">
                  <span className="flex flex-col">
                    <span className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 whitespace-nowrap">
                      <span className="text-white/70">Memory</span>
                      <span className="text-right">
                        {(message.turnStats.creditDetail.memoryTokens ?? 0).toLocaleString()} tokens
                      </span>
                      <span className="text-white/70">System</span>
                      <span className="text-right">
                        {(message.turnStats.creditDetail.systemTokens ?? 0).toLocaleString()} tokens
                      </span>
                      <span className="text-white/70">Question</span>
                      <span className="text-right">
                        {(message.turnStats.creditDetail.questionTokens ?? message.turnStats.creditDetail.inputTokens).toLocaleString()} tokens
                      </span>
                      <span className="text-white/70">Output</span>
                      <span className="text-right">
                        {message.turnStats.creditDetail.outputTokens.toLocaleString()} tokens
                      </span>
                    </span>
                    <span className="mt-1 text-center text-[9px] text-white/50">
                      Token split is approximate.
                    </span>
                  </span>
                </span>
              </span>
            ) : (
              <span>
                Credits: {(message.turnStats.credits ?? 0).toFixed(2)}
                {uncertain ? "(?)" : ""}
              </span>
            )}
            {" · "}Elapsed: {formatElapsed(message.turnStats.elapsed)}
            {uncertain ? "(?)" : ""}
            {message.turnStats.model ? ` · ${message.turnStats.model}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}

export const AssistantTurn = memo(AssistantTurnImpl, (prev, next) => prev.message === next.message);
