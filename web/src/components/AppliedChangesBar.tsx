/**
 * AppliedChangesBar —— 本会话文件改动面板（输入框上方「N 已应用」按钮弹出的浮层内容）
 *
 * 两个视图：
 *   · 文件：待确认的改动单独成块放最上面（带全部接受 / 拒绝）；已应用的逐行列出——
 *     文件名 + 所在目录（淡色）+ 增删行数，查看改动 / 撤销在悬停时出现，整行点击即查看改动
 *   · 快照：每轮改动前的快照时间线，可回滚到任一快照
 * 文件多（> 8）时才出现搜索框，平时不占位置。
 */

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { Check, Clock, ExternalLink, GitCompare, Loader2, RotateCcw, Search, Undo2, X } from "lucide-react";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import type { ChatMessage } from "./chat/types";
import { openDiff as openDiffView, openMergedDiff, usePanelClientId, type DiffRef } from "@/lib/openDiff";

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
  /** 工作区根目录：文件目录按相对路径显示 */
  workspaces?: string[];
  onClose?: () => void;
}

interface ChangeFile {
  path: string;
  status: "pending" | "applied";
  editId?: string;
  reverted?: boolean;
  undoable?: boolean;
  oldContent?: string;
  newContent?: string;
  /** 最早 / 最近一次改动的引用：正文被省略（bodyOmitted）时靠它们的 editId 按需取回 */
  firstRef?: DiffRef;
  lastRef?: DiffRef;
}

type TabKey = "changes" | "rollback";

/** 文件多到这个数才显示搜索框 */
const SEARCH_THRESHOLD = 8;

/** 从 "turn-10" 提取数字，用于排序 */
function turnNum(id: string): number {
  const m = id.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/** 粗略的增删行数：按行做多重集合差（不求最优对齐，够用来给个量级） */
function lineStats(oldContent?: string, newContent?: string): { added: number; removed: number } | null {
  if (oldContent === undefined && newContent === undefined) return null;
  const a = (oldContent ?? "").split("\n");
  const b = (newContent ?? "").split("\n");
  if (oldContent === undefined || oldContent === "") return { added: newContent ? b.length : 0, removed: 0 };
  const count = new Map<string, number>();
  for (const l of a) count.set(l, (count.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of b) {
    const n = count.get(l) ?? 0;
    if (n > 0) count.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of count.values()) removed += n;
  return { added, removed };
}

/** 路径 → { 文件名, 相对工作区的目录 } */
function splitPath(path: string, workspaces: string[]): { name: string; dir: string } {
  const norm = path.replace(/\\/g, "/");
  const root = workspaces.map((w) => w.replace(/\\/g, "/").replace(/\/$/, "")).filter((w) => norm.startsWith(`${w}/`)).sort((x, y) => y.length - x.length)[0];
  const rel = root ? norm.slice(root.length + 1) : norm;
  const idx = rel.lastIndexOf("/");
  return { name: idx >= 0 ? rel.slice(idx + 1) : rel, dir: idx >= 0 ? rel.slice(0, idx) : "" };
}

export function AppliedChangesBar({
  chatHistory,
  pendingPaths,
  pendingDiffs,
  onAcceptAll,
  onRejectAll,
  onUndo,
  onListSnapshots,
  onRestoreSnapshot,
  workspaces = [],
  onClose,
}: AppliedChangesBarProps) {
  const [tab, setTab] = useState<TabKey>("changes");
  const [search, setSearch] = useState("");
  const clientId = usePanelClientId();

  const panelRef = useRef<HTMLDivElement>(null);
  /**
   * 面板高度只增不减：切换「文件 / 快照」、输入筛选时内容变少，面板若跟着缩，
   * 它是从底部按钮向上弹出的，顶边会整个往下掉。打开期间记住出现过的最大高度作为下限。
   */
  const [lockHeight, setLockHeight] = useState(0);
  const hover = useHoverHighlight();
  const holdHeight = useCallback(() => {
    const h = panelRef.current?.offsetHeight ?? 0;
    setLockHeight((prev) => Math.max(prev, h));
  }, []);
  const switchTab = useCallback((t: TabKey) => {
    holdHeight();
    hover.onPointerLeave();
    setTab(t);
    setSearch("");
  }, [holdHeight, hover.onPointerLeave]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);

  // ── 快照事件监听 ──
  useEffect(() => {
    const listener = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.type === "snapshots_listed") {
        const snaps = (msg.snapshots || []) as Snapshot[];
        // 前端兜底排序：按 createdAt 倒序，时间相同按 turn 序号倒序
        snaps.sort((a, b) => (a.createdAt !== b.createdAt ? b.createdAt - a.createdAt : turnNum(b.id) - turnNum(a.id)));
        setSnapshots(snaps);
      }
      if (msg?.type === "snapshot_restored") {
        setRestoring(null);
        if (msg.ok && onListSnapshots) onListSnapshots();
      }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [onListSnapshots]);

  // 打开面板时拉一次快照
  useEffect(() => {
    onListSnapshots?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRestore = useCallback((id: string) => {
    setRestoring(id);
    onRestoreSnapshot?.(id);
  }, [onRestoreSnapshot]);

  // ── 文件改动提取 ──
  const { pendingFiles, appliedFiles } = useMemo(() => {
    const pendingSet = new Set(pendingPaths);
    const map = new Map<string, ChangeFile>();
    for (const msg of chatHistory) {
      if (msg.role !== "assistant" || !msg.segments) continue;
      for (const seg of msg.segments) {
        if (seg.type !== "tool" || seg.status !== "success") continue;
        const collect = (path: string, editId?: string, reverted?: boolean, undoable?: boolean, oldContent?: string, newContent?: string, ref?: DiffRef) => {
          if (pendingSet.has(path)) return;
          const existing = map.get(path);
          if (existing) {
            // 同一文件多次编辑：取最早 oldContent + 最新 newContent，撤销状态取最新
            if (oldContent !== undefined) existing.oldContent = existing.oldContent ?? oldContent;
            if (newContent !== undefined) existing.newContent = newContent;
            if (ref) existing.lastRef = ref;
            existing.reverted = reverted ?? existing.reverted;
            existing.undoable = undoable ?? existing.undoable;
            if (editId) existing.editId = editId;
          } else {
            map.set(path, { path, editId, status: "applied", reverted, undoable, oldContent, newContent, firstRef: ref, lastRef: ref });
          }
        };
        if (seg.diff?.path) collect(seg.diff.path, seg.diff.editId, seg.reverted, seg.undoable, seg.diff.oldContent, seg.diff.newContent, seg.diff as DiffRef);
        if (seg.diffs) for (const d of seg.diffs) collect(d.path, d.editId, seg.reverted, seg.undoable, d.oldContent, d.newContent, d as DiffRef);
      }
    }
    // 最近改的排在前面
    const applied = Array.from(map.values()).reverse();
    const pending: ChangeFile[] = pendingPaths.map((p) => ({
      path: p, status: "pending" as const, oldContent: pendingDiffs[p]?.oldContent, newContent: pendingDiffs[p]?.newContent,
    }));
    return { pendingFiles: pending, appliedFiles: applied };
  }, [chatHistory, pendingPaths, pendingDiffs]);

  const stats = useMemo(() => {
    const m = new Map<string, { added: number; removed: number } | null>();
    for (const f of [...pendingFiles, ...appliedFiles]) m.set(f.path, f.reverted ? null : lineStats(f.oldContent, f.newContent));
    return m;
  }, [pendingFiles, appliedFiles]);
  const totals = useMemo(() => {
    let added = 0, removed = 0, known = false;
    for (const s of stats.values()) if (s) { added += s.added; removed += s.removed; known = true; }
    return known ? { added, removed } : null;
  }, [stats]);

  const q = search.trim().toLowerCase();
  const match = (f: ChangeFile) => !q || f.path.toLowerCase().includes(q);
  const filteredPending = pendingFiles.filter(match);
  const filteredApplied = appliedFiles.filter(match);
  const filteredSnapshots = !q ? snapshots : snapshots.filter((s) => s.label.toLowerCase().includes(q));

  const totalChanges = pendingFiles.length + appliedFiles.length;
  const hasRollback = !!onListSnapshots;
  const showSearch = tab === "changes" ? totalChanges > SEARCH_THRESHOLD : snapshots.length > SEARCH_THRESHOLD;

  const openDiff = (file: ChangeFile) => {
    // 从会话快照恢复的历史改动没有正文：按最早 / 最近两次改动的 editId 取回再打开
    if (file.firstRef?.bodyOmitted && file.lastRef) {
      void openMergedDiff(clientId, file.path, file.firstRef, file.lastRef);
      return;
    }
    if (file.oldContent === undefined && file.newContent === undefined) { openFile(file.path); return; }
    void openDiffView(clientId, { path: file.path, oldContent: file.oldContent, newContent: file.newContent });
  };
  const openFile = (path: string) => {
    (window as { __axonVSCode?: { postMessage: (m: unknown) => void } }).__axonVSCode?.postMessage({ type: "open_file", path });
  };

  return (
    <div ref={panelRef} style={lockHeight ? { minHeight: lockHeight } : undefined} className="flex max-h-[min(60vh,480px)] flex-col overflow-hidden rounded-xl border border-border bg-background text-[12.5px] shadow-xl">
      {/* ── 头部：标题 + 统计 + 视图切换 ── */}
      <div className="flex items-center gap-3 border-b border-border/70 px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-foreground">本会话改动</div>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
            <span>{totalChanges} 个文件</span>
            {totals && (
              <>
                <span className="text-emerald-600 dark:text-emerald-400">+{totals.added}</span>
                <span className="text-red-600 dark:text-red-400">−{totals.removed}</span>
              </>
            )}
          </div>
        </div>
        {hasRollback && (
          <div className="flex shrink-0 rounded-lg bg-muted/60 p-0.5 text-[11.5px]">
            {(["changes", "rollback"] as const).map((t) => (
              <button
                key={t}
                onClick={() => switchTab(t)}
                className={`rounded-md px-2.5 py-1 transition-colors ${tab === t ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
              >
                {t === "changes" ? "文件" : "快照"}
              </button>
            ))}
          </div>
        )}
        {onClose && (
          <button onClick={onClose} className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground" aria-label="关闭">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {showSearch && (
        <div className="px-3 pb-0.5 pt-2.5">
          <div className="flex items-center gap-1.5 rounded-md border border-border/70 px-2 py-1">
            <Search className="h-3 w-3 shrink-0 text-muted-foreground/60" />
            <input
              value={search}
              onChange={(e) => { holdHeight(); setSearch(e.target.value); }}
              placeholder={tab === "changes" ? "按文件名或路径筛选" : "筛选快照"}
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground/50"
            />
            {search && <button onClick={() => setSearch("")} className="text-muted-foreground/60 hover:text-foreground"><X className="h-3 w-3" /></button>}
          </div>
        </div>
      )}

      <div ref={hover.containerRef} onPointerOver={hover.onPointerOver} onPointerLeave={hover.onPointerLeave} className="relative min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        {/* 悬停高亮：一块背景在行之间滑动，而不是每行各自闪一下 */}
        <div ref={hover.highlightRef} aria-hidden className="pointer-events-none absolute left-0 top-0 rounded-md bg-foreground/[0.06] opacity-0 transition-[transform,height,width,opacity] duration-150 ease-out" />
        {tab === "changes" && (
          <>
            {filteredPending.length > 0 && (
              <div className="mx-1.5 mb-1.5 mt-0.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] py-1">
                <div className="flex items-center gap-2 px-2.5 py-1">
                  <span className="flex-1 text-[11.5px] font-medium text-amber-700 dark:text-amber-400">{pendingFiles.length} 个改动待确认</span>
                  <button onClick={onRejectAll} className="rounded-md px-2 py-0.5 text-[11.5px] text-muted-foreground hover:bg-muted/70 hover:text-foreground">全部拒绝</button>
                  <button onClick={onAcceptAll} className="inline-flex items-center gap-1 rounded-md bg-foreground px-2 py-0.5 text-[11.5px] text-background hover:opacity-90"><Check className="h-3 w-3" />全部接受</button>
                </div>
                {filteredPending.map((f) => (
                  <FileRow key={`p-${f.path}`} file={f} workspaces={workspaces} stat={stats.get(f.path)} onOpenDiff={() => openDiff(f)} onOpenFile={() => openFile(f.path)} />
                ))}
              </div>
            )}
            {filteredApplied.map((f) => (
              <FileRow key={`a-${f.path}`} file={f} workspaces={workspaces} stat={stats.get(f.path)} onOpenDiff={() => openDiff(f)} onOpenFile={() => openFile(f.path)}>
                {f.undoable && !f.reverted && (
                  <button onClick={(e) => { e.stopPropagation(); onUndo(f.path); }} className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground" aria-label="撤销这个文件的改动">
                    <Undo2 className="h-3 w-3" />撤销
                  </button>
                )}
              </FileRow>
            ))}
            {filteredPending.length + filteredApplied.length === 0 && (
              <div className="py-6 text-center text-[11.5px] text-muted-foreground">{q ? "没有匹配的文件" : "这个会话还没有改动文件"}</div>
            )}
          </>
        )}

        {tab === "rollback" && (
          snapshots.length === 0 ? (
            <div className="py-6 text-center text-[11.5px] text-muted-foreground">还没有快照（AI 改文件前会自动保存一份）</div>
          ) : (
            <div className="relative px-1.5 py-1">
              <div className="absolute bottom-3 left-[13px] top-3 w-px bg-border" />
              {filteredSnapshots.map((snap, idx) => {
                const current = idx === 0 && !q;
                return (
                  <div key={snap.id} data-hover-row className="group relative flex items-center gap-2.5 rounded-md py-1.5 pl-1 pr-1.5">
                    <span className={`relative z-10 ml-[3px] size-2 shrink-0 rounded-full ring-2 ring-background ${current ? "bg-primary" : "bg-muted-foreground/40"}`} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-foreground/90">{snap.label}</div>
                      <div className="mt-0.5 flex items-center gap-1 text-[10.5px] text-muted-foreground tabular-nums">
                        <Clock className="h-2.5 w-2.5" />
                        {new Date(snap.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                        {snap.files.length > 0 && <span>· {snap.files.length} 个文件</span>}
                      </div>
                    </div>
                    {current ? (
                      <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10.5px] text-primary">当前</span>
                    ) : (
                      <button
                        onClick={() => handleRestore(snap.id)}
                        disabled={restoring !== null}
                        className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100 disabled:opacity-50"
                      >
                        {restoring === snap.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                        回滚到这里
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>
    </div>
  );
}

/** 文件行：整行点击查看改动；打开文件 / 撤销等操作悬停时出现 */
function FileRow({ file, workspaces, stat, onOpenDiff, onOpenFile, children }: {
  file: ChangeFile;
  workspaces: string[];
  stat?: { added: number; removed: number } | null;
  onOpenDiff: () => void;
  onOpenFile: () => void;
  children?: React.ReactNode;
}) {
  const { name, dir } = splitPath(file.path, workspaces);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpenDiff}
      onKeyDown={(e) => { if (e.key === "Enter") onOpenDiff(); }}
      aria-label={`${file.path}，点击查看改动`}
      data-hover-row
      className={`group relative flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[5px] ${file.reverted ? "opacity-55" : ""}`}
    >
      <FileTypeIcon fileName={name} />
      <span className={`shrink-0 truncate text-foreground ${file.reverted ? "line-through" : ""}`} style={{ maxWidth: "55%" }}>{name}</span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70" dir="rtl" style={{ textAlign: "left" }}>
        {dir && <bdi>{dir}</bdi>}
      </span>
      {file.reverted ? (
        <span className="shrink-0 text-[10.5px] text-muted-foreground">已撤销</span>
      ) : stat ? (
        <span className="shrink-0 text-[11px] tabular-nums group-hover:hidden">
          <span className="text-emerald-600 dark:text-emerald-400">+{stat.added}</span>{" "}
          <span className="text-red-600 dark:text-red-400">−{stat.removed}</span>
        </span>
      ) : null}
      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
        {children}
        <button onClick={(e) => { e.stopPropagation(); onOpenDiff(); }} className="rounded p-1 text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground" aria-label="查看改动">
          <GitCompare className="h-3.5 w-3.5" />
        </button>
        <button onClick={(e) => { e.stopPropagation(); onOpenFile(); }} className="rounded p-1 text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground" aria-label="打开文件">
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
  );
}

/**
 * 列表的悬停高亮：一块共用的背景跟着指针在行（data-hover-row）之间滑动、移出列表时淡出。
 * 位置直接改 DOM，不触发 React 渲染。
 */
function useHoverHighlight() {
  const containerRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const onPointerOver = useCallback((e: React.PointerEvent) => {
    const box = containerRef.current;
    const hl = highlightRef.current;
    const row = (e.target as Element).closest<HTMLElement>("[data-hover-row]");
    if (!box || !hl || !row || !box.contains(row)) return;
    const b = box.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const x = r.left - b.left + box.scrollLeft;
    const y = r.top - b.top + box.scrollTop;
    const shown = hl.style.opacity === "1";
    // 从隐藏状态出现时直接落在这一行，不从上一次的位置滑过来
    if (!shown) hl.style.transition = "none";
    hl.style.transform = `translate(${x}px, ${y}px)`;
    hl.style.width = `${r.width}px`;
    hl.style.height = `${r.height}px`;
    if (!shown) { void hl.offsetHeight; hl.style.transition = ""; }
    hl.style.opacity = "1";
  }, []);
  const onPointerLeave = useCallback(() => {
    if (highlightRef.current) highlightRef.current.style.opacity = "0";
  }, []);
  return { containerRef, highlightRef, onPointerOver, onPointerLeave };
}
