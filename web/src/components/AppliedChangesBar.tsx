/**
 * AppliedChangesBar —— 统一面板（Tab 模式）
 *
 * 展开后通过内部 Tab 切换「文件改动」和「闪电回滚」。
 * 折叠状态下只显示标题栏 + badge 概要。
 */

import { useState, useMemo, useEffect, useCallback } from "react";
import { ChevronDown, FileText, GitCompare, Undo2, Check, X, History, RotateCcw, Clock, Loader2, Search } from "lucide-react";
import { ClickableFileName } from "@/components/ToolCallItem";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import type { ChatMessage } from "./chat/types";

interface Snapshot {
  id: string;
  createdAt: number;
  label: string;
  files: string[];
}

interface AppliedChangesBarProps {
  chatHistory: ChatMessage[];
  pendingPaths: string[];
  pendingDiffs: Record<string, { oldContent: string; newContent: string }>;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onUndo: (path: string) => void;
  onListSnapshots?: () => void;
  onRestoreSnapshot?: (id: string) => void;
}

interface ChangeFile {
  path: string;
  status: "pending" | "applied";
  editId?: string;
  reverted?: boolean;
  undoable?: boolean;
  oldContent?: string;
  newContent?: string;
}

type TabKey = "changes" | "rollback";

export function AppliedChangesBar({
  chatHistory,
  pendingPaths,
  pendingDiffs,
  onAcceptAll,
  onRejectAll,
  onUndo,
  onListSnapshots,
  onRestoreSnapshot,
}: AppliedChangesBarProps) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<TabKey>("changes");
  const [search, setSearch] = useState("");

  // 切 Tab 时清空搜索词（避免跨 Tab 搜索词残留导致看起来不相关）
  const switchTab = useCallback((t: TabKey) => {
    setTab(t);
    setSearch("");
  }, []);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [snapLoaded, setSnapLoaded] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  // ── 快照事件监听 ──
  useEffect(() => {
    const listener = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === "snapshots_listed") {
        setSnapshots(msg.snapshots || []);
        setSnapLoaded(true);
      }
      if (msg?.type === "snapshot_restored") {
        setRestoring(null);
        if (msg.ok && onListSnapshots) onListSnapshots();
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [onListSnapshots]);

  // 挂载时请求快照
  useEffect(() => {
    if (onListSnapshots && !snapLoaded) {
      onListSnapshots();
      setSnapLoaded(true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRestore = useCallback((id: string) => {
    setRestoring(id);
    onRestoreSnapshot?.(id);
  }, [onRestoreSnapshot]);

  // ── 文件改动提取 ──
  const { pendingFiles, appliedFiles } = useMemo(() => {
    const assistantMsgs = chatHistory.filter((m) => m.role === "assistant" && m.segments);
    const pendingSet = new Set(pendingPaths);
    const applied: ChangeFile[] = [];
    const seen = new Set<string>();

    for (const msg of assistantMsgs) {
      for (const seg of msg.segments!) {
        if (seg.type !== "tool" || seg.status !== "success") continue;
        const collect = (path: string, editId?: string, reverted?: boolean, undoable?: boolean, oldContent?: string, newContent?: string) => {
          if (pendingSet.has(path) || seen.has(path)) return;
          seen.add(path);
          applied.push({ path, editId, status: "applied", reverted, undoable, oldContent, newContent });
        };
        if (seg.diff?.path) collect(seg.diff.path, seg.diff.editId, seg.reverted, seg.undoable, seg.diff.oldContent, seg.diff.newContent);
        if (seg.diffs) for (const d of seg.diffs) collect(d.path, d.editId, seg.reverted, seg.undoable, d.oldContent, d.newContent);
      }
    }
    const pending: ChangeFile[] = pendingPaths.map((p) => ({
      path: p, status: "pending" as const, oldContent: pendingDiffs[p]?.oldContent, newContent: pendingDiffs[p]?.newContent,
    }));
    return { pendingFiles: pending, appliedFiles: applied };
  }, [chatHistory, pendingPaths, pendingDiffs]);

  // 搜索过滤（独立 useMemo，确保 search 变化时过滤立即生效，不受流式高频更新影响）
  const filteredPending = useMemo(
    () => !search ? pendingFiles : pendingFiles.filter((f) => f.path.toLowerCase().includes(search.toLowerCase())),
    [pendingFiles, search],
  );
  const filteredApplied = useMemo(
    () => !search ? appliedFiles : appliedFiles.filter((f) => f.path.toLowerCase().includes(search.toLowerCase())),
    [appliedFiles, search],
  );
  const filteredSnapshots = useMemo(
    () => !search ? snapshots : snapshots.filter((s) => s.label.toLowerCase().includes(search.toLowerCase()) || s.id.toLowerCase().includes(search.toLowerCase())),
    [snapshots, search],
  );

  const totalChanges = pendingFiles.length + appliedFiles.length;
  const hasRollback = !!onListSnapshots;
  // 无任何内容时不显示面板
  if (totalChanges === 0 && !hasRollback) return null;
  // 有快照功能但没改动也没快照时也不显示
  if (totalChanges === 0 && snapshots.length === 0) return null;

  const openDiff = (path: string, oldContent?: string, newContent?: string) => {
    const vs = (window as any).__axonVSCode;
    if (vs) {
      const msg: Record<string, unknown> = { type: "open_diff", path };
      if (oldContent !== undefined) msg.oldContent = oldContent;
      if (newContent !== undefined) msg.newContent = newContent;
      vs.postMessage(msg);
    }
  };
  const openFile = (path: string) => {
    const vs = (window as any).__axonVSCode;
    if (vs) vs.postMessage({ type: "open_file", path });
  };

  return (
    <div className="mb-2 rounded-lg border border-border bg-popover/50 overflow-hidden text-xs">
      {/* ── 标题栏 ── */}
      <div className="flex items-center gap-1.5 px-2 py-1">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 flex-1 text-left text-foreground/80"
        >
          <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`} />
          {tab === "rollback" ? (
            <History className="w-3 h-3 shrink-0 text-primary" />
          ) : (
            <FileText className="w-3 h-3 shrink-0 text-primary" />
          )}
          <span className="font-medium">{tab === "rollback" ? "闪电回滚" : `${totalChanges} 个文件改动`}</span>
          {tab === "changes" && pendingFiles.length > 0 && (
            <span className="text-[10px] text-amber-600 bg-amber-100 dark:bg-amber-900/30 rounded-full px-1 py-px">{pendingFiles.length} 待确认</span>
          )}
          {tab === "changes" && appliedFiles.length > 0 && (
            <span className="text-[10px] text-green-600 bg-green-100 dark:bg-green-900/30 rounded-full px-1 py-px">{appliedFiles.length} 已应用</span>
          )}
          {tab === "rollback" && snapshots.length > 0 && (
            <span className="text-[10px] text-primary/70 bg-primary/10 rounded-full px-1 py-px">{snapshots.length}</span>
          )}
        </button>
        {tab === "changes" && pendingFiles.length > 0 && (
          <div className="flex items-center gap-1">
            <button onClick={onAcceptAll} className="px-1.5 py-px rounded bg-green-600 text-white text-[11px] hover:bg-green-700 transition-colors">全部接受</button>
            <button onClick={onRejectAll} className="px-1.5 py-px rounded border border-border text-[11px] text-muted-foreground hover:bg-muted/50 transition-colors">全部拒绝</button>
          </div>
        )}
      </div>

      {/* ── 展开内容 ── */}
      {expanded && (
        <>
          {/* Tab 切换条 */}
          <div className="flex border-t border-b border-border/50 bg-muted/30">
            <TabButton active={tab === "changes"} onClick={() => switchTab("changes")} icon={<FileText className="w-3 h-3" />} label="改动" badge={totalChanges} />
            {hasRollback && (
              <TabButton active={tab === "rollback"} onClick={() => switchTab("rollback")} icon={<History className="w-3 h-3" />} label="回滚" badge={snapshots.length} />
            )}
          </div>

          {/* Tab 内容 */}
          <div className="px-2.5 py-1 max-h-72 flex flex-col">
            {/* 搜索框 */}
            <div className="flex items-center gap-1 px-1.5 py-1 mb-1 rounded border border-border/50 bg-muted/30">
              <Search className="w-3 h-3 text-muted-foreground/60 shrink-0" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={tab === "changes" ? "搜索文件名…" : "搜索快照…"}
                className="flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/40"
              />
              {search && <button onClick={() => setSearch("")} className="text-muted-foreground/60 hover:text-foreground"><X className="w-3 h-3" /></button>}
            </div>

            {/* 列表（滚动区） */}
            <div className="overflow-y-auto flex-1">
              {tab === "changes" && (
                <>
                  {filteredPending.map((f) => (
                    <FileRow key={`p-${f.path}`} file={f} onOpenDiff={() => openDiff(f.path, f.oldContent, f.newContent)} onOpenFile={() => openFile(f.path)}>
                      <button onClick={onAcceptAll} className="flex items-center px-1.5 py-px rounded text-green-600 hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors shrink-0" title="接受"><Check className="w-3 h-3" /></button>
                      <button onClick={onRejectAll} className="flex items-center px-1.5 py-px rounded text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors shrink-0" title="拒绝"><X className="w-3 h-3" /></button>
                    </FileRow>
                  ))}
                  {filteredApplied.map((f) => (
                    <FileRow key={`a-${f.path}`} file={f} onOpenDiff={() => {
                      if (f.oldContent !== undefined || f.newContent !== undefined) { openDiff(f.path, f.oldContent, f.newContent); } else { openFile(f.path); }
                    }} onOpenFile={() => openFile(f.path)}>
                      {f.undoable && !f.reverted && (
                        <button onClick={() => onUndo(f.path)} className="flex items-center gap-0.5 px-1.5 py-px rounded text-amber-500 hover:text-amber-600 hover:bg-amber-500/10 transition-colors shrink-0 text-[11px]" title="撤销此文件改动"><Undo2 className="w-3 h-3" />撤销</button>
                      )}
                    </FileRow>
                  ))}
                </>
              )}

              {tab === "rollback" && (
                <>
                  {snapshots.length === 0 ? (
                    <div className="text-[10px] text-muted-foreground/50 py-2 text-center">暂无快照（AI 修改文件后自动生成）</div>
                  ) : (
                    <div className="space-y-px py-0.5">
                      {filteredSnapshots
                        .map((snap, idx) => (
                        <div key={snap.id} className="flex items-center gap-2 text-[11px] py-0.5 group">
                          <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${idx === 0 ? "bg-primary" : "bg-muted-foreground/30"}`} />
                          <span className="flex-1 text-muted-foreground truncate">{snap.label}</span>
                          <span className="flex items-center gap-0.5 text-muted-foreground/50">
                            <Clock className="w-2.5 h-2.5" />
                            {new Date(snap.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                          {idx !== 0 ? (
                            <button onClick={() => handleRestore(snap.id)} disabled={restoring !== null} className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 text-amber-500 hover:text-amber-600 hover:bg-amber-500/10 rounded px-1.5 py-px transition-all disabled:opacity-50">
                              {restoring === snap.id ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <RotateCcw className="w-2.5 h-2.5" />}
                              回滚
                            </button>
                          ) : (
                            <span className="text-[9px] text-primary/60">当前</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Tab 按钮 */
function TabButton({ active, onClick, icon, label, badge }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge: number }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1 py-1 text-[11px] transition-colors border-b-2 ${
        active ? "text-primary border-primary bg-background/50" : "text-muted-foreground border-transparent hover:text-foreground/70"
      }`}
    >
      {icon}
      <span>{label}</span>
      {badge > 0 && <span className={`text-[9px] rounded-full px-1 ${active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground/60"}`}>{badge}</span>}
    </button>
  );
}

/** 文件行 */
function FileRow({ file, onOpenDiff, onOpenFile, children }: { file: ChangeFile; onOpenDiff: () => void; onOpenFile: () => void; children?: React.ReactNode }) {
  const shortName = file.path.replace(/\\/g, "/").split("/").pop() || file.path;
  const isPending = file.status === "pending";
  return (
    <div className={`flex items-center gap-2 text-xs py-0.5 ${file.reverted ? "opacity-50" : ""}`}>
      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isPending ? "bg-amber-400" : file.reverted ? "bg-muted-foreground/30" : "bg-green-500"}`} />
      <span className="flex-1 min-w-0 inline-flex items-center gap-1 font-mono cursor-pointer" onClick={onOpenFile}>
        <FileTypeIcon fileName={shortName} />
        <ClickableFileName fileName={shortName} absPath={file.path} className="text-foreground/80 truncate" />
      </span>
      {file.reverted && <span className="text-[10px] text-muted-foreground line-through px-1">已撤销</span>}
      <button onClick={onOpenDiff} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0" title="查看改动">
        <GitCompare className="w-3.5 h-3.5" />
      </button>
      {children}
    </div>
  );
}
