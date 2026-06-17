/**
 * 待确认改动汇总条中的单个文件行：文件名（最小不重复路径，hover 显示绝对路径、可点击打开） + diff 查看 + 接受/拒绝
 * 从原 ChatPanel.tsx 拆出。
 */

import { GitCompare } from "lucide-react";
import { ClickableFileName } from "@/components/ToolCallItem";
import { FileTypeIcon } from "@/components/FileTypeIcon";

export function PendingFileRow({ path, displayName, diff, onAccept, onReject }: {
  /** 原始路径（getPendingPaths 原值，用于 diff/接受/拒绝匹配，不可改） */
  path: string;
  /** 展示用的最小不重复路径（由 disambiguatePaths 计算），缺省回退到 path 的 basename */
  displayName?: string;
  diff?: { oldContent: string; newContent: string };
  onAccept: (p: string) => void;
  onReject: (p: string) => void;
}) {
  const shownName = displayName || path.replace(/\\/g, "/").split("/").pop() || path;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="flex-1 min-w-0 inline-flex items-center gap-1 font-mono">
        <FileTypeIcon fileName={shownName} />
        <ClickableFileName fileName={shownName} absPath={path} className="text-foreground/80 truncate" />
      </span>
      {diff && (
        <button
          onClick={() => { const vs = (window as any).__axonVSCode; if (vs) vs.postMessage({ type: "open_diff", path, oldContent: diff.oldContent, newContent: diff.newContent }); }}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
          title="查看改动"
        >
          <GitCompare className="w-3.5 h-3.5" />
        </button>
      )}
      <button
        onClick={() => onAccept(path)}
        className="px-2 py-0.5 rounded text-green-600 hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors shrink-0"
        title="接受此文件"
      >
        接受
      </button>
      <button
        onClick={() => onReject(path)}
        className="px-2 py-0.5 rounded text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors shrink-0"
        title="拒绝此文件"
      >
        拒绝
      </button>
    </div>
  );
}
