/**
 * FileChangesPanel —— 并行批次的文件变更清单
 *
 * 颜色语义：
 * - 全部已落盘（无 pending）：绿色块
 * - 有待确认文件：黄色块
 * - 加强提示：明确标注"已自动写入磁盘"，每个文件支持一键回滚
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, FileCheck2, FileClock, FilePlus2, FilePen, CircleCheck, CircleAlert, Undo2, FileX2 } from "lucide-react";
import { collectFileChanges, basename, type FileChange } from "./fileChanges";
import type { ParallelBatch } from "./types";

interface FileChangesPanelProps {
  batch: ParallelBatch;
  /** 点击文件名时打开（通过宿主 postMessage） */
  onOpenFile?: (path: string) => void;
  /** 一键回滚某文件 */
  onUndoFile?: (path: string) => void;
}

export function FileChangesPanel({ batch, onOpenFile, onUndoFile }: FileChangesPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const changes = collectFileChanges(batch);

  if (changes.length === 0) return null;

  const pendingCount = changes.filter((c) => c.status === "pending").length;
  const hasPending = pendingCount > 0;
  const activeCount = changes.filter((c) => c.status !== "rejected").length;

  // 颜色主题：有待确认=黄色，全部已落盘=绿色
  const theme = hasPending
    ? {
        border: "border-amber-500/30",
        bg: "bg-amber-500/5",
        headBg: "hover:bg-amber-500/10",
        icon: <CircleAlert className="w-4 h-4 text-amber-500" />,
        text: "text-amber-600 dark:text-amber-400",
      }
    : {
        border: "border-green-500/30",
        bg: "bg-green-500/5",
        headBg: "hover:bg-green-500/10",
        icon: <CircleCheck className="w-4 h-4 text-green-500" />,
        text: "text-green-600 dark:text-green-400",
      };

  return (
    <div className={`rounded-lg border ${theme.border} ${theme.bg} overflow-hidden`}>
      {/* 头部 */}
      <button
        onClick={() => setExpanded(!expanded)}
        className={`flex items-center gap-2 w-full px-3 py-2 ${theme.headBg} transition-colors`}
      >
        {theme.icon}
        <span className={`text-xs font-medium ${theme.text}`}>
          文件变更 {activeCount} 处
          {hasPending ? ` · ${pendingCount} 待确认` : " · 已自动写入磁盘"}
        </span>
        <span className="ml-auto">
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
          )}
        </span>
      </button>

      {/* 加强提示条 + 文件列表 */}
      {expanded && (
        <div className="border-t border-border/30">
          {!hasPending && (
            <div className="flex items-start gap-1.5 px-3 py-1.5 bg-muted/20 text-[10px] text-muted-foreground">
              <CircleCheck className="w-3 h-3 text-green-500 shrink-0 mt-0.5" />
              <span>这些改动已由并行 Agent 直接写入磁盘（自动落盘）。如需撤销，点击每行的回滚按钮恢复到改动前。</span>
            </div>
          )}
          <div className="divide-y divide-border/20">
            {changes.map((change) => (
              <FileChangeRow key={change.path} change={change} onOpenFile={onOpenFile} onUndoFile={onUndoFile} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FileChangeRow({ change, onOpenFile, onUndoFile }: {
  change: FileChange;
  onOpenFile?: (path: string) => void;
  onUndoFile?: (path: string) => void;
}) {
  const reverted = change.status === "rejected";

  const statusIcon = () => {
    if (reverted) return <FileX2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />;
    switch (change.status) {
      case "saved": return <FileCheck2 className="w-3.5 h-3.5 text-green-500 shrink-0" />;
      case "pending": return <FileClock className="w-3.5 h-3.5 text-amber-500 shrink-0" />;
      default: return <FileCheck2 className="w-3.5 h-3.5 text-green-500 shrink-0" />;
    }
  };

  const actionIcon = change.action === "create"
    ? <FilePlus2 className="w-3 h-3 text-muted-foreground/60 shrink-0" />
    : <FilePen className="w-3 h-3 text-muted-foreground/60 shrink-0" />;

  return (
    <div className={`group flex items-center gap-2 px-3 py-1.5 hover:bg-muted/30 transition-colors ${reverted ? "opacity-50" : ""}`}>
      {statusIcon()}
      {actionIcon}
      <button
        onClick={() => onOpenFile?.(change.path)}
        className="flex items-center gap-2 flex-1 min-w-0 text-left"
        title={change.path}
      >
        <span className={`text-xs font-medium truncate hover:text-primary transition-colors ${reverted ? "line-through" : ""}`}>
          {basename(change.path)}
        </span>
        <span className="text-[10px] text-muted-foreground/60 truncate hidden sm:inline">
          {change.path}
        </span>
      </button>
      <span className="text-[10px] text-muted-foreground shrink-0">A{change.agentIndex + 1}</span>
      {/* 回滚按钮 */}
      {!reverted && onUndoFile && (
        <button
          onClick={(e) => { e.stopPropagation(); onUndoFile(change.path); }}
          className="shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-muted text-muted-foreground hover:text-destructive transition-all"
          title="回滚此文件（恢复到改动前）"
        >
          <Undo2 className="w-3 h-3" />
        </button>
      )}
      {reverted && (
        <span className="text-[10px] text-muted-foreground shrink-0">已回滚</span>
      )}
    </div>
  );
}
