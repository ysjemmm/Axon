/**
 * AI 回复 turn 渲染：品牌头 + segments 混排 + 底部统计（Credits / 耗时）
 * 从原 ChatPanel.tsx 拆出。
 */

import { memo, useMemo, useState } from "react";
import { Code } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AxonLogo } from "@/components/AxonLogo";
import type { ChatMessage, TextSegment } from "./types";
import { formatElapsed } from "./format";
import { renderSegments } from "./renderSegments";

function AssistantTurnImpl({ message, onAcceptEdit, onRejectEdit, onUndoEdit }: { message: ChatMessage; onAcceptEdit?: (path: string) => void; onRejectEdit?: (path: string) => void; onUndoEdit?: (path: string) => void }) {
  const [showRaw, setShowRaw] = useState(false);
  const segments = message.segments || [];

  // 拼接所有 text segment 的原始内容（用于"原始"按钮）
  const rawContent = useMemo(() => segments
    .filter((s): s is TextSegment => s.type === "text")
    .map((s) => s.content)
    .join("")
    .trim(), [segments]);

  const renderedSegments = useMemo(
    () => renderSegments(segments, message.streaming, onAcceptEdit, onRejectEdit, onUndoEdit),
    [segments, message.streaming, onAcceptEdit, onRejectEdit, onUndoEdit],
  );

  return (
    <div className="flex flex-col">
      {/* 第一行：图标 + Axon 名 + 原始按钮 */}
      <div className="flex items-center gap-2 mb-2.5">
        <AxonLogo size={22} animate={!!message.streaming} />
        <span className="text-sm font-semibold text-foreground">Axon</span>
        {!message.streaming && rawContent && (
          <button
            onClick={() => setShowRaw(!showRaw)}
            className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            <Code className="w-3 h-3" />
            {showRaw ? "渲染" : "原始"}
          </button>
        )}
      </div>

      {/* 第二行：内容区（占满整宽，无左缩进） */}
      <div className="min-w-0">
        {showRaw ? (
          <pre className="text-xs bg-zinc-100 dark:bg-zinc-800 rounded-md p-3 overflow-x-auto whitespace-pre-wrap font-mono text-zinc-800 dark:text-zinc-200">
            {rawContent}
          </pre>
        ) : (
          <div className="space-y-1">
            {renderedSegments}
          </div>
        )}

        {/* 底部统计 */}
        {!message.streaming && message.turnStats && (
          <div className="mt-3 text-[11px] text-muted-foreground">
            {message.turnStats.creditDetail ? (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-default border-b border-dotted border-muted-foreground/40">
                      Credits: {(message.turnStats.credits ?? 0).toFixed(2)}{message.turnStatus === "cancelled" || message.turnStatus === "error" ? "(?)" : ""}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" align="start" className="text-xs leading-relaxed">
                    <div className="flex flex-col">
                    <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 whitespace-nowrap">
                      <span className="text-background/60">记忆</span>
                      <span className="text-right">{(message.turnStats.creditDetail.memoryTokens ?? 0).toLocaleString()} tokens</span>
                      <span className="text-background/60">system</span>
                      <span className="text-right">{(message.turnStats.creditDetail.systemTokens ?? 0).toLocaleString()} tokens</span>
                      <span className="text-background/60">本次提问</span>
                      <span className="text-right">{(message.turnStats.creditDetail.questionTokens ?? message.turnStats.creditDetail.inputTokens).toLocaleString()} tokens</span>
                      <span className="text-background/60">输出</span>
                      <span className="text-right">{message.turnStats.creditDetail.outputTokens.toLocaleString()} tokens</span>
                    </div>
                    <div className="text-center text-[9px] text-background/40 mt-1">拆分为近似，总输入精确</div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : (
              <span>
                Credits: {(message.turnStats.credits ?? 0).toFixed(2)}{message.turnStatus === "cancelled" || message.turnStatus === "error" ? "(?)" : ""}
              </span>
            )}
            {" · "}耗时: {formatElapsed(message.turnStats.elapsed)}{message.turnStatus === "cancelled" || message.turnStatus === "error" ? "(?)" : ""}{message.turnStats.model ? ` · ${message.turnStats.model}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}

export const AssistantTurn = memo(AssistantTurnImpl, (prev, next) => prev.message === next.message);
