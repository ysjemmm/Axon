/**
 * FileTag —— 通用文件/文件夹引用标签（内联 pill）
 *
 * 统一能力：
 * 1. hover 弹出限高可滚动的 tooltip（文件内容预览 / 文件夹清单）—— portal+fixed 不受裁剪
 * 2. 点击通过 postMessage 在 VS Code 编辑器区打开文件
 *
 * 使用场景：用户气泡、工具卡片、AI 回复内引用到文件的地方。
 * 输入区 pill 因 contentEditable 限制用命令式渲染（MentionEditor 内部自行实现同等功能）。
 */

import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, FileCode, Folder, Bug, Terminal as TerminalIcon } from "lucide-react";

export interface FileTagData {
  /** 展示名称（可以是文件名、相对路径、标签） */
  name: string;
  /** 完整路径（用于点击跳转），缺省时用 name */
  path?: string;
  /** hover 预览内容 */
  content?: string;
  /** 类型（决定图标样式） */
  kind?: "file" | "folder" | "terminal" | "editor" | "diagnostics";
  /** 可选行号（跳转 + 展示用） */
  startLine?: number;
  endLine?: number;
}

function tagIcon(kind?: string) {
  switch (kind) {
    case "folder": return <Folder className="h-3.5 w-3.5 shrink-0 text-primary" />;
    case "terminal": return <TerminalIcon className="h-3.5 w-3.5 shrink-0 text-primary" />;
    case "editor": return <FileCode className="h-3.5 w-3.5 shrink-0 text-primary" />;
    case "diagnostics": return <Bug className="h-3.5 w-3.5 shrink-0 text-amber-500" />;
    default: return <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
}

function displayName(data: FileTagData): string {
  const raw = data.name || data.path || "";
  if (data.kind === "file" || data.kind === "folder" || !data.kind) {
    return raw.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || raw;
  }
  return raw;
}

function looksLikePath(name: string): boolean {
  return /[/\\]/.test(name) || /\.\w{1,10}$/.test(name);
}

const PREVIEW_WIDTH = 340;

export function FileTag({ data }: { data: FileTagData }) {
  const ref = useRef<HTMLSpanElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  const show = useCallback(() => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (!data.content) return; // 无内容则不弹预览
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - PREVIEW_WIDTH - 8));
    const placeAbove = r.top > 280;
    setPos(placeAbove ? { left, bottom: window.innerHeight - r.top + 6 } : { left, top: r.bottom + 6 });
  }, [data.content]);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setPos(null), 120);
  }, []);

  const clickable = looksLikePath(data.path || data.name);

  const handleClick = () => {
    if (!clickable) return;
    const vs = (window as any).__axonVSCode;
    if (vs) vs.postMessage({ type: "open_file", path: data.path || data.name, startLine: data.startLine, endLine: data.endLine });
  };

  return (
    <span
      ref={ref}
      onClick={clickable ? handleClick : undefined}
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
      className={`inline-flex h-5 items-center gap-1 mx-0.5 rounded-md border border-border bg-background/60 px-1.5 align-[-0.2em] text-xs leading-none ${clickable ? "cursor-pointer hover:bg-muted/60 transition-colors" : ""}`}
    >
      {tagIcon(data.kind)}
      <span className="whitespace-nowrap font-medium">{displayName(data)}</span>

      {pos && data.content &&
        createPortal(
          <div
            style={{ position: "fixed", left: pos.left, top: pos.top, bottom: pos.bottom, width: PREVIEW_WIDTH, zIndex: 9999 }}
            className="max-w-[80vw] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
            onMouseEnter={() => { if (hideTimer.current) window.clearTimeout(hideTimer.current); }}
            onMouseLeave={scheduleHide}
          >
            <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5 text-[11px] text-muted-foreground">
              {tagIcon(data.kind)}
              <span className="truncate font-medium" title={data.path || data.name}>{data.path || data.name}</span>
            </div>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 text-[11px] leading-relaxed text-foreground/90">
              {data.content}
            </pre>
          </div>,
          document.body,
        )}
    </span>
  );
}
