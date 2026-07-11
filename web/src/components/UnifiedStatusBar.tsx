/**
 * UnifiedStatusBar —— 输入框上方的紧凑状态条
 *
 * 将 Loading 指示器与文件改动汇总合并为一行：
 * - 左侧：AI 执行状态（呼吸灯动画 + 状态文字），不执行时隐藏
 * - 右侧：文件改动汇总（如 "4 changes · View all"），点击展开 AppliedChangesBar
 *
 * Loading 始终保持 DOM 存在（hidden 控制），避免 CSS animation 被打断。
 */

import { useState, useMemo } from "react";
import { FileText, ChevronDown } from "lucide-react";
import { AppliedChangesBar } from "./AppliedChangesBar";
import type { ChatMessage } from "./chat/types";

interface UnifiedStatusBarProps {
  isLoading: boolean;
  statusText: string;
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
  isLoading,
  statusText,
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

  // 两侧都没内容时不渲染
  if (!isLoading && !hasChanges) return null;

  return (
    <div className="mb-1">
      {/* 紧凑状态条：一行 flex 布局 */}
      <div className="flex items-center justify-between px-2 py-1.5 min-h-[34px]">
        {/* 左侧：Loading 状态指示（DOM 始终存在，hidden 控制显隐，CSS animation 不中断） */}
        <div className={`flex items-center gap-2.5 text-muted-foreground text-sm ${isLoading ? "" : "invisible"}`}>
          <svg width="24" height="24" viewBox="0 0 40 40" className="shrink-0">
            <circle cx="20" cy="20" r="17" fill="#6366f1" className="breath-origin" style={{ animation: "breath 2.5s ease-in-out infinite" }} />
            <circle cx="20" cy="20" r="13" fill="white" stroke="#1e1b4b" strokeWidth="1.5" />
            <ellipse cx="15" cy="19" rx="2" ry="2.5" fill="#6366f1" style={{ transformOrigin: "15px 19px", animation: "blink 3s ease-in-out infinite" }} />
            <ellipse cx="25" cy="19" rx="2" ry="2.5" fill="#6366f1" style={{ transformOrigin: "25px 19px", animation: "blink 3s ease-in-out 0.12s infinite" }} />
          </svg>
          <span className="animate-pulse truncate max-w-[200px]">{statusText}</span>
        </div>

        {/* 右侧：文件改动汇总 */}
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
