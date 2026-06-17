/**
 * 文件修改 Diff 弹窗
 * - 支持「双栏」（split：左旧右新）与「单栏」（unified：增删合并）两种视图
 * - 基于 LCS 算法做行级对比
 */

import { useState, useMemo, useEffect, useRef, memo } from "react";
import { Columns2, AlignJustify, Maximize2, Minimize2 } from "lucide-react";
import hljs from "highlight.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** 根据文件路径推断 highlight.js 语言 */
function detectLang(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", java: "java", kt: "kotlin", go: "go", rs: "rust",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", cs: "csharp",
    rb: "ruby", php: "php", swift: "swift", sh: "bash", bash: "bash",
    json: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
    html: "xml", xml: "xml", css: "css", scss: "scss", less: "less",
    sql: "sql", md: "markdown", vue: "xml", dockerfile: "dockerfile",
  };
  const lang = map[ext];
  return lang && hljs.getLanguage(lang) ? lang : undefined;
}

/** 对单行做语法高亮，返回 HTML 字符串 */
function highlightLine(text: string, lang?: string): string {
  if (!text) return "&nbsp;";
  if (lang) {
    try {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // fallback 到转义
    }
  }
  // 无语言或失败：转义后原样输出
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type DiffOp = "add" | "del" | "ctx";
interface DiffLine {
  type: DiffOp;
  text: string;
  oldNo?: number;
  newNo?: number;
  html?: string; // 预先计算好的高亮 HTML，避免渲染时重复 highlight
}

/** 行级 diff（基于 LCS） */
function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const m = a.length, n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0, j = 0, oldNo = 0, newNo = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      oldNo++; newNo++;
      result.push({ type: "ctx", text: a[i], oldNo, newNo });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      oldNo++;
      result.push({ type: "del", text: a[i], oldNo });
      i++;
    } else {
      newNo++;
      result.push({ type: "add", text: b[j], newNo });
      j++;
    }
  }
  while (i < m) { oldNo++; result.push({ type: "del", text: a[i++], oldNo }); }
  while (j < n) { newNo++; result.push({ type: "add", text: b[j++], newNo }); }
  return result;
}

/** 将 diff 行列表折叠：只保留变更行附近的上下文（前后各 CONTEXT_LINES 行），中间折叠 */
const CONTEXT_LINES = 3;

type DiffChunk =
  | { type: "lines"; lines: DiffLine[] }
  | { type: "collapsed"; count: number; startIdx: number };

function collapseLines(lines: DiffLine[]): DiffChunk[] {
  if (lines.length === 0) return [];
  // 标记每行是否应该可见（是变更行 或 在变更行附近 CONTEXT_LINES 范围内）
  const visible = new Uint8Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== "ctx") {
      const start = Math.max(0, i - CONTEXT_LINES);
      const end = Math.min(lines.length - 1, i + CONTEXT_LINES);
      for (let j = start; j <= end; j++) visible[j] = 1;
    }
  }
  // 按可见性分段
  const chunks: DiffChunk[] = [];
  let i = 0;
  while (i < lines.length) {
    if (visible[i]) {
      const start = i;
      while (i < lines.length && visible[i]) i++;
      chunks.push({ type: "lines", lines: lines.slice(start, i) });
    } else {
      const start = i;
      while (i < lines.length && !visible[i]) i++;
      chunks.push({ type: "collapsed", count: i - start, startIdx: start });
    }
  }
  return chunks;
}

const lineBg = (t: DiffOp) =>
  t === "add" ? "bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-400"
  : t === "del" ? "bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-400"
  : "bg-popover text-foreground/80";

/** 单栏视图：增删上下文按顺序合并，远离变更的行默认折叠 */
const UnifiedView = memo(function UnifiedView({ lines }: { lines: DiffLine[] }) {
  const initialChunks = useMemo(() => collapseLines(lines), [lines]);
  const [chunks, setChunks] = useState(initialChunks);
  // lines 变化时重置折叠状态
  useEffect(() => { setChunks(initialChunks); }, [initialChunks]);

  const expand = (chunkIdx: number) => {
    setChunks((prev) => {
      const chunk = prev[chunkIdx];
      if (chunk.type !== "collapsed") return prev;
      const EXPAND_BATCH = 20; // 每次最多展开 20 行
      const next = [...prev];
      if (chunk.count <= EXPAND_BATCH) {
        // 行数少，直接全部展开
        next[chunkIdx] = { type: "lines", lines: lines.slice(chunk.startIdx, chunk.startIdx + chunk.count) };
      } else {
        // 展开前 20 行，剩余仍折叠
        const expandedLines = lines.slice(chunk.startIdx, chunk.startIdx + EXPAND_BATCH);
        const remaining: DiffChunk = { type: "collapsed", count: chunk.count - EXPAND_BATCH, startIdx: chunk.startIdx + EXPAND_BATCH };
        next.splice(chunkIdx, 1, { type: "lines", lines: expandedLines }, remaining);
      }
      return next;
    });
  };

  let firstChangeMarked = false;
  return (
    <pre className="text-xs font-mono leading-relaxed hljs !bg-transparent min-w-fit">
      {chunks.map((chunk, ci) => {
        if (chunk.type === "collapsed") {
          return (
            <div
              key={`c-${ci}`}
              onClick={() => expand(ci)}
              className="flex items-center justify-center py-1 text-xs text-muted-foreground hover:bg-muted/40 cursor-pointer border-y border-border/30 select-none"
            >
              ··· 展开 {chunk.count} 行 ···
            </div>
          );
        }
        return chunk.lines.map((ln, li) => {
          const sign = ln.type === "add" ? "+" : ln.type === "del" ? "-" : " ";
          const isFirstChange = !firstChangeMarked && ln.type !== "ctx";
          if (isFirstChange) firstChangeMarked = true;
          return (
            <div key={`${ci}-${li}`} className={`flex ${lineBg(ln.type)}`} {...(isFirstChange ? { "data-first-change": "" } : {})}>
              <span className="select-none w-10 shrink-0 text-right pr-2 opacity-50 bg-muted/40">{ln.oldNo ?? ""}</span>
              <span className="select-none w-10 shrink-0 text-right pr-2 opacity-50 bg-muted/40">{ln.newNo ?? ""}</span>
              <span className="select-none w-4 shrink-0 text-center opacity-60">{sign}</span>
              <span
                className="whitespace-pre-wrap break-all flex-1 pr-3"
                dangerouslySetInnerHTML={{ __html: ln.html ?? "&nbsp;" }}
              />
            </div>
          );
        });
      })}
    </pre>
  );
});

/** 双栏视图：左旧、右新两列独立渲染，空白处斜纹连续，远离变更的行默认折叠 */
const SplitView = memo(function SplitView({ lines }: { lines: DiffLine[] }) {
  // 把 diff 序列对齐成左右两列的行
  const allRows = useMemo(() => {
    const rows: { left?: DiffLine; right?: DiffLine; isChange: boolean }[] = [];
    let k = 0;
    while (k < lines.length) {
      const ln = lines[k];
      if (ln.type === "ctx") {
        rows.push({ left: ln, right: ln, isChange: false });
        k++;
      } else {
        const dels: DiffLine[] = [];
        const adds: DiffLine[] = [];
        while (k < lines.length && lines[k].type === "del") dels.push(lines[k++]);
        while (k < lines.length && lines[k].type === "add") adds.push(lines[k++]);
        const max = Math.max(dels.length, adds.length);
        for (let r = 0; r < max; r++) {
          rows.push({ left: dels[r], right: adds[r], isChange: true });
        }
      }
    }
    return rows;
  }, [lines]);

  // 折叠：标记可见行
  const initialChunks = useMemo(() => {
    type RowChunk = { type: "rows"; rows: typeof allRows } | { type: "collapsed"; count: number; startIdx: number };
    const visible = new Uint8Array(allRows.length);
    for (let i = 0; i < allRows.length; i++) {
      if (allRows[i].isChange) {
        const start = Math.max(0, i - CONTEXT_LINES);
        const end = Math.min(allRows.length - 1, i + CONTEXT_LINES);
        for (let j = start; j <= end; j++) visible[j] = 1;
      }
    }
    const chunks: RowChunk[] = [];
    let i = 0;
    while (i < allRows.length) {
      if (visible[i]) {
        const start = i;
        while (i < allRows.length && visible[i]) i++;
        chunks.push({ type: "rows", rows: allRows.slice(start, i) });
      } else {
        const start = i;
        while (i < allRows.length && !visible[i]) i++;
        chunks.push({ type: "collapsed", count: i - start, startIdx: start });
      }
    }
    return chunks;
  }, [allRows]);

  const [chunks, setChunks] = useState(initialChunks);
  useEffect(() => { setChunks(initialChunks); }, [initialChunks]);

  const expand = (ci: number) => {
    setChunks((prev) => {
      const chunk = prev[ci];
      if (chunk.type !== "collapsed") return prev;
      const EXPAND_BATCH = 20;
      const next = [...prev];
      if (chunk.count <= EXPAND_BATCH) {
        next[ci] = { type: "rows", rows: allRows.slice(chunk.startIdx, chunk.startIdx + chunk.count) };
      } else {
        const expandedRows = allRows.slice(chunk.startIdx, chunk.startIdx + EXPAND_BATCH);
        const remaining = { type: "collapsed" as const, count: chunk.count - EXPAND_BATCH, startIdx: chunk.startIdx + EXPAND_BATCH };
        next.splice(ci, 1, { type: "rows", rows: expandedRows }, remaining);
      }
      return next;
    });
  };

  // 单格渲染
  const Cell = ({ ln, side }: { ln?: DiffLine; side: "left" | "right" }) => {
    if (!ln) {
      return <div className="flex-1 min-w-0 self-stretch" style={hatchStyle} />;
    }
    const no = side === "left" ? ln.oldNo : ln.newNo;
    const sign = ln.type === "add" ? "+" : ln.type === "del" ? "-" : " ";
    return (
      <div className={`flex-1 min-w-0 flex items-start ${lineBg(ln.type)}`}>
        <span className="select-none w-10 shrink-0 text-right pr-2 opacity-50 bg-muted/40 self-stretch flex items-start justify-end pt-0.5">{no ?? ""}</span>
        <span className="select-none w-4 shrink-0 text-center opacity-60 pt-0.5">{sign}</span>
        <span
          className="whitespace-pre-wrap break-all flex-1 min-w-0 pr-3 pt-0.5"
          dangerouslySetInnerHTML={{ __html: ln.html ?? "&nbsp;" }}
        />
      </div>
    );
  };

  const hatchStyle: React.CSSProperties = {
    backgroundImage:
      "repeating-linear-gradient(-45deg, color-mix(in oklch, var(--muted-foreground) 35%, transparent) 0, color-mix(in oklch, var(--muted-foreground) 35%, transparent) 1px, transparent 1px, transparent 8px)",
  };

  let firstChangeMarked = false;

  return (
    <pre className="text-xs font-mono leading-relaxed hljs !bg-transparent w-full">
      {chunks.map((chunk, ci) => {
        if (chunk.type === "collapsed") {
          return (
            <div
              key={`c-${ci}`}
              onClick={() => expand(ci)}
              className="flex items-center justify-center py-1 text-xs text-muted-foreground hover:bg-muted/40 cursor-pointer border-y border-border/30 select-none"
            >
              ··· 展开 {chunk.count} 行 ···
            </div>
          );
        }
        return chunk.rows.map((row, ri) => {
          const isFirst = !firstChangeMarked && row.isChange;
          if (isFirst) firstChangeMarked = true;
          return (
            <div key={`${ci}-${ri}`} className="flex w-full" {...(isFirst ? { "data-first-change": "" } : {})}>
              <Cell ln={row.left} side="left" />
              <div className="w-px bg-border shrink-0" />
              <Cell ln={row.right} side="right" />
            </div>
          );
        });
      })}
    </pre>
  );
});

interface DiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  path: string;
  oldContent: string;
  newContent: string;
}

export function DiffDialog({ open, onOpenChange, path, oldContent, newContent }: DiffDialogProps) {
  const [mode, setMode] = useState<"split" | "unified">("split");
  const [fullscreen, setFullscreen] = useState(false);
  // 延迟渲染重内容：弹窗先弹出（轻量），下一帧再渲染 diff 行，避免点击后卡顿几秒
  const [contentReady, setContentReady] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const lang = useMemo(() => detectLang(path), [path]);
  // diff 计算 + 逐行语法高亮一次性完成并缓存，渲染/全屏切换时不再重复高亮
  const lines = useMemo(() => {
    const raw = computeLineDiff(oldContent, newContent);
    for (const ln of raw) {
      ln.html = highlightLine(ln.text, lang);
    }
    return raw;
  }, [oldContent, newContent, lang]);
  const added = useMemo(() => lines.filter((l) => l.type === "add").length, [lines]);
  const removed = useMemo(() => lines.filter((l) => l.type === "del").length, [lines]);

  // 打开时延迟一帧渲染内容，让 Dialog 动画先跑起来
  useEffect(() => {
    if (open) {
      const id = requestAnimationFrame(() => setContentReady(true));
      return () => cancelAnimationFrame(id);
    }
    setContentReady(false);
  }, [open]);

  // 内容渲染后自动滚动到第一处变更
  useEffect(() => {
    if (!contentReady) return;
    requestAnimationFrame(() => {
      const el = scrollContainerRef.current?.querySelector("[data-first-change]");
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "instant" });
      }
    });
  }, [contentReady]);

  // 默认 70% 视口；全屏时几乎占满。用 ! 覆盖 shadcn 默认的 sm:max-w-sm 和 grid
  const sizeClass = fullscreen
    ? "!max-w-[98vw] w-[98vw] h-[96vh]"
    : "!max-w-[70vw] w-[70vw] h-[70vh]";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={`${sizeClass} !flex flex-col gap-0 p-0 overflow-hidden`}
      >
        <DialogHeader className="px-4 py-3 pr-12 border-b border-border space-y-0 shrink-0">
          <div className="flex items-center justify-between gap-4">
            <DialogTitle className="text-sm font-mono truncate">{path}</DialogTitle>
            <div className="flex items-center gap-3 shrink-0">
              {/* 增删统计 */}
              <div className="flex items-center gap-2 text-xs">
                <span className="text-green-600">+{added}</span>
                <span className="text-red-500">-{removed}</span>
              </div>
              {/* 视图切换 */}
              <div className="flex items-center rounded-md border border-border overflow-hidden">
                <button
                  onClick={() => setMode("split")}
                  title="双栏"
                  className={`flex items-center gap-1 px-2 py-1 text-xs transition-colors ${mode === "split" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
                >
                  <Columns2 className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setMode("unified")}
                  title="单栏"
                  className={`flex items-center gap-1 px-2 py-1 text-xs transition-colors ${mode === "unified" ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50"}`}
                >
                  <AlignJustify className="w-3.5 h-3.5" />
                </button>
              </div>
              {/* 全屏切换 */}
              <button
                onClick={() => setFullscreen((v) => !v)}
                title={fullscreen ? "退出全屏" : "全屏"}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              >
                {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </DialogHeader>
        {/* diff 内容区 + 右侧 minimap */}
        <div className="flex-1 min-h-0 flex">
          {/* 主内容滚动区 */}
          <div ref={scrollContainerRef} className="flex-1 min-h-0 overflow-auto bg-muted/20">
            {contentReady
              ? (mode === "split" ? <SplitView lines={lines} /> : <UnifiedView lines={lines} />)
              : <div className="flex items-center justify-center h-full text-sm text-muted-foreground">加载中...</div>}
          </div>
          {/* 右侧 minimap（仅当内容可滚动时显示） */}
          {contentReady && lines.length > 50 && <DiffMinimap lines={lines} scrollContainerRef={scrollContainerRef} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 右侧 minimap：基于实际 DOM 位置绘制变更色带 + 可拖动视口指示器 */
function DiffMinimap({ lines, scrollContainerRef }: { lines: DiffLine[]; scrollContainerRef: React.RefObject<HTMLDivElement | null> }) {
  const mapRef = useRef<HTMLDivElement>(null);
  const [viewportRatio, setViewportRatio] = useState({ top: 0, height: 1 });
  // 色带：基于 DOM 实际位置计算的变更区间
  const [markers, setMarkers] = useState<{ top: number; height: number; type: "add" | "del" }[]>([]);
  const dragging = useRef(false);

  // 扫描 DOM 中变更行的实际位置，生成色带标记
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const computeMarkers = () => {
      const scrollH = container.scrollHeight;
      if (scrollH <= 0) return;
      // 找到所有带背景色的变更行（green/red bg class）
      const addEls = container.querySelectorAll("[class*='bg-green']");
      const delEls = container.querySelectorAll("[class*='bg-red']");
      const result: { top: number; height: number; type: "add" | "del" }[] = [];

      const processEls = (els: NodeListOf<Element>, type: "add" | "del") => {
        els.forEach((el) => {
          const htmlEl = el as HTMLElement;
          const top = htmlEl.offsetTop / scrollH;
          const height = Math.max(htmlEl.offsetHeight / scrollH, 0.002); // 最小 0.2%
          result.push({ top, height, type });
        });
      };
      processEls(addEls, "add");
      processEls(delEls, "del");
      setMarkers(result);
    };

    // 延迟一帧确保 DOM 渲染完毕
    const id = requestAnimationFrame(computeMarkers);
    return () => cancelAnimationFrame(id);
  }, [lines, scrollContainerRef]);

  // 监听滚动容器，更新视口指示器位置
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      if (scrollHeight <= 0) return;
      setViewportRatio({
        top: scrollTop / scrollHeight,
        height: Math.min(1, clientHeight / scrollHeight),
      });
    };
    update();
    container.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(container);
    return () => { container.removeEventListener("scroll", update); ro.disconnect(); };
  }, [scrollContainerRef]);

  // 点击/拖动 minimap 跳转
  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    jumpTo(e);
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    jumpTo(e);
  };
  const handlePointerUp = () => { dragging.current = false; };

  const jumpTo = (e: React.PointerEvent) => {
    const container = scrollContainerRef.current;
    const map = mapRef.current;
    if (!container || !map) return;
    const rect = map.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    const targetScroll = ratio * container.scrollHeight - container.clientHeight / 2;
    container.scrollTop = Math.max(0, targetScroll);
  };

  return (
    <div
      ref={mapRef}
      className="w-4 shrink-0 border-l border-border bg-muted/30 relative cursor-pointer select-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {/* 基于 DOM 位置的变更标记 */}
      {markers.map((m, i) => (
        <div
          key={i}
          className={`absolute left-0.5 right-0.5 ${m.type === "add" ? "bg-green-500/80" : "bg-red-500/80"}`}
          style={{ top: `${m.top * 100}%`, height: `max(2px, ${m.height * 100}%)` }}
        />
      ))}
      {/* 视口指示器 */}
      <div
        className="absolute left-0 right-0 border border-foreground/30 bg-foreground/10 rounded-sm"
        style={{ top: `${viewportRatio.top * 100}%`, height: `${viewportRatio.height * 100}%` }}
      />
    </div>
  );
}
