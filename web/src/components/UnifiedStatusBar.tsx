/**
 * UnifiedStatusBar —— 输入框上方的「吉祥物 + 文件改动汇总」行
 *
 * 改动汇总（"N 已应用 / N 待确认"）现与吉祥物「Axo」合并为同一行：左侧由 `leading`
 * 传入（吉祥物 + 执行中状态文字），右侧是汇总按钮，点击展开 AppliedChangesBar。
 * 合并成一行是为了省掉原本单独占的一条 bar、让汇总紧贴输入框。
 *
 * AI 执行状态（图标 + "思考中…"）曾经也在这里（左半边），现已移到 AI 回复消息的头部
 * ——见 chat/AssistantTurn.tsx 的 AssistantTurnHeader。状态贴着回复本身更符合直觉，
 * 也避免了"消息在上方、状态在输入框上方"的割裂感。
 */

import { useState, useMemo, type ReactNode } from "react";
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
  /** 左侧内容（吉祥物 + 执行中状态文字），与右侧改动汇总同处一行 */
  leading?: ReactNode;
  /** 斜杠菜单打开时整行 invisible（不卸载），避免与弹出的菜单相撞 */
  slashOpen?: boolean;
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
  leading,
  slashOpen,
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

  return (
    <div>
      {/* 展开详情：复用 AppliedChangesBar（headless，无标题栏）。
          放在吉祥物行【上方】——汇总按钮在这行右端，展开的面板朝消息列表方向展开，
          不会把输入框夹在面板和吉祥物行之间。 */}
      {expanded && hasChanges && (
        <div className="mb-1">
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
        </div>
      )}

      {/* 吉祥物 + 汇总合并成一行：左 leading（吉祥物+状态），右汇总按钮。
          整行保持 pointer-events-none（原本吉祥物行就是为不吃点击而设），只把汇总按钮
          恢复为 pointer-events-auto——这样输入框上沿那 5px 重叠区的点击不受影响。
          竖向排布：吉祥物贴底（items-end，配 -mb-[5px] 让底部 5px 仍搭在输入框边框上），
          汇总按钮贴顶（self-start）——原本两者都垂直居中，文字刚好压在输入框上沿、显得太挤；
          贴顶后文字与输入框之间就有了间距。 */}
      <div
        className={`pointer-events-none flex items-end gap-2 pl-3 pr-2 h-[28px] -mb-[5px] z-0 select-none ${slashOpen ? "invisible" : ""}`}
      >
        <div className="flex items-center gap-2 min-w-0">{leading}</div>
        <div className="flex-1 min-w-0" />
        {hasChanges && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="pointer-events-auto self-start flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <FileText className="w-3 h-3 text-primary" />
            <span>
              {appliedCount > 0 && <span className="text-muted-foreground">{appliedCount} 已应用</span>}
              {appliedCount > 0 && pendingCount > 0 && <span className="mx-1">·</span>}
              {pendingCount > 0 && <span className="text-amber-600">{pendingCount} 待确认</span>}
            </span>
            <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? "" : "-rotate-90"}`} />
          </button>
        )}
      </div>
    </div>
  );
}
