/**
 * UnifiedStatusBar —— 输入框上方的文件改动汇总条
 *
 * 只负责文件改动汇总（如 "4 changes · View all"），点击展开 AppliedChangesBar。
 *
 * AI 执行状态（图标 + "思考中…"）曾经也在这里（左半边），现已移到 AI 回复消息的头部
 * ——见 chat/AssistantTurn.tsx 的 AssistantTurnHeader。状态贴着回复本身更符合直觉，
 * 也避免了"消息在上方、状态在输入框上方"的割裂感。
 */

import { useState, useMemo } from "react";
import { FileText, ChevronDown } from "lucide-react";
import { AppliedChangesBar } from "./AppliedChangesBar";
import type { ChatMessage } from "./chat/types";

interface UnifiedStatusBarProps {
  mode: "agent" | "quest";
  chatHistory: ChatMessage[];
  pendingPaths: string[];
  pendingDiffs: Record<string, { oldContent: string; newContent: string }>;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onUndo: (path: string) => void;
  onListSnapshots?: () => void;
  onRestoreSnapshot?: (id: string) => void;
}

export function UnifiedStatusBar({
  mode,
  chatHistory,
  pendingPaths,
  pendingDiffs,
  onAcceptAll,
  onRejectAll,
  onUndo,
  onListSnapshots,
  onRestoreSnapshot,
}: UnifiedStatusBarProps) {
  const [expanded, setExpanded] = useState(false);

  // 计算文件改动数量
  const { totalChanges, pendingCount, appliedCount } = useMemo(() => {
    const pendingCount = pendingPaths.length;
    const assistantMsgs = chatHistory.filter((m) => m.role === "assistant" && m.segments);
    const appliedSet = new Set<string>();
    for (const msg of assistantMsgs) {
      for (const seg of msg.segments!) {
        if (seg.type !== "tool" || seg.status !== "success") continue;
        if (seg.diff?.path && !pendingPaths.includes(seg.diff.path)) appliedSet.add(seg.diff.path);
        if (seg.diffs) {
          for (const d of seg.diffs) {
            if (!pendingPaths.includes(d.path)) appliedSet.add(d.path);
          }
        }
      }
    }
    const appliedCount = appliedSet.size;
    return { totalChanges: pendingCount + appliedCount, pendingCount, appliedCount };
  }, [chatHistory, pendingPaths]);

  const isQuestMode = mode === "quest";
  const hasChanges = !isQuestMode && totalChanges > 0;

  // 没有改动时整条不渲染
  if (!hasChanges) return null;

  return (
    <div className="mb-1">
      {/* 一行 flex 布局，改动汇总右对齐 */}
      <div className="flex items-center justify-end px-2 py-1.5 min-h-[34px]">
        {hasChanges && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <FileText className="w-3 h-3 text-primary" />
            <span>
              {appliedCount > 0 && <span className="text-green-600">{appliedCount} 已应用</span>}
              {appliedCount > 0 && pendingCount > 0 && <span className="mx-1">·</span>}
              {pendingCount > 0 && <span className="text-amber-600">{pendingCount} 待确认</span>}
            </span>
            <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? "" : "-rotate-90"}`} />
          </button>
        )}
      </div>

      {/* 展开详情：复用 AppliedChangesBar（headless 模式，无标题栏直接展示内容） */}
      {expanded && hasChanges && (
        <AppliedChangesBar
          chatHistory={chatHistory}
          pendingPaths={pendingPaths}
          pendingDiffs={pendingDiffs}
          onAcceptAll={onAcceptAll}
          onRejectAll={onRejectAll}
          onUndo={onUndo}
          onListSnapshots={onListSnapshots}
          onRestoreSnapshot={onRestoreSnapshot}
          headless
        />
      )}
    </div>
  );
}
