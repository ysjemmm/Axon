/**
 * MentionEditor —— 支持内联 tag 的富文本输入（contentEditable）
 *
 * 设计要点（规避中文 IME / React 重渲染冲突）：
 * - 非受控：文本由浏览器原生维护，React 不在输入时重写 innerHTML。
 * - tag 以命令式 DOM 节点（contenteditable=false 的 span）插入到光标处，原子删除（Backspace 直接删整个 tag）。
 * - tag 数据存在 ref 的 Map 里（contextId → AttachedFile）；read() 时按 DOM 顺序序列化。
 * - hover 预览用 React 浮层（portal），由 pill 的命令式事件回调驱动，保留限高可滚动。
 *
 * 通过 ref 暴露命令式 API 给 ChatPanel 与斜杠命令 hook 使用。
 */

import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AttachedFile, UserSegment } from "./types";

export interface MentionEditorHandle {
  focus(): void;
  clear(): void;
  isEmpty(): boolean;
  /** 按 DOM 顺序读取：纯文本（tag 以其名称内联）+ tag 列表 + 内联片段（文本/tag） */
  read(): { text: string; tags: AttachedFile[]; segments: UserSegment[] };
  /** 当前文本节点中光标前的文本（供 “/” 触发检测） */
  textBeforeCaret(): string;
  /** 删除光标前 len 个字符（用于剥离 “/query”） */
  deleteBeforeCaret(len: number): void;
  /** 在光标处插入一个 tag，返回 contextId（内容可后续用 updateTag 补全） */
  insertTag(data: AttachedFile): string;
  /** 用 contextId 更新 tag 的名称/内容（异步内容到达时） */
  updateTag(contextId: string, patch: Partial<AttachedFile>): void;
  /** 覆盖为纯文本（断连回填用） */
  setText(text: string): void;
  /** 在末尾追加一段文本（引用到输入框用） */
  appendText(text: string): void;
  /** 在末尾追加一组内联片段（文本 + tag），用于引用整条消息 */
  appendSegments(segments: UserSegment[]): void;
}

interface MentionEditorProps {
  placeholder?: string;
  disabled?: boolean;
  /** 内容变化（输入/删除/插入 tag）时回调，传当前光标前文本用于 “/” 检测 */
  onChange?: (textBeforeCaret: string) => void;
  /** 键盘事件（回车发送、斜杠菜单导航等由父层处理） */
  onKeyDown?: (e: React.KeyboardEvent) => void;
  onPaste?: (e: React.ClipboardEvent) => void;
}

let cidSeq = 0;
const nextCid = () => `cx-${Date.now().toString(36)}-${(cidSeq++).toString(36)}`;

function iconSvg(kind: AttachedFile["kind"]): string {
  // 简洁内联 SVG（lucide 风格），避免命令式渲染 React 图标
  const stroke = `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
  const wrap = (inner: string, cls: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" class="${cls}" ${stroke}>${inner}</svg>`;
  switch (kind) {
    case "folder":
      return wrap(`<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>`, "text-primary");
    case "terminal":
      return wrap(`<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>`, "text-primary");
    case "editor":
      return wrap(`<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>`, "text-primary");
    case "diagnostics":
      return wrap(`<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>`, "text-amber-500");
    default:
      return wrap(`<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/>`, "text-muted-foreground");
  }
}

function displayName(data: AttachedFile): string {
  if (data.kind === "file" || data.kind === "folder") {
    return data.name.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || data.name;
  }
  return data.name;
}

export const MentionEditor = forwardRef<MentionEditorHandle, MentionEditorProps>(function MentionEditor(
  { placeholder, disabled, onChange, onKeyDown, onPaste },
  ref,
) {
  const editorRef = useRef<HTMLDivElement>(null);
  const dataMap = useRef<Map<string, AttachedFile>>(new Map());
  const [empty, setEmpty] = useState(true);
  const [preview, setPreview] = useState<{ data: AttachedFile; left: number; top?: number; bottom?: number } | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);

  const showPreview = useCallback((data: AttachedFile, pillEl: HTMLElement) => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    const r = pillEl.getBoundingClientRect();
    const PREVIEW_W = 340;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - PREVIEW_W - 8));
    const above = r.top > 280;
    setPreview(above ? { data, left, bottom: window.innerHeight - r.top + 6 } : { data, left, top: r.bottom + 6 });
  }, []);
  const schedulePreviewHide = useCallback(() => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setPreview(null), 120);
  }, []);

  const refreshEmpty = useCallback(() => {
    const el = editorRef.current;
    setEmpty(!el || (el.textContent ?? "").trim() === "" && !el.querySelector("[data-cid]"));
  }, []);

  /** 构建一个 tag pill 的命令式 DOM */
  const buildPill = useCallback(
    (cid: string, data: AttachedFile): HTMLSpanElement => {
      const span = document.createElement("span");
      span.dataset.cid = cid;
      span.contentEditable = "false";
      span.className =
        "inline-flex h-5 items-center gap-1 mx-0.5 rounded-md border border-border bg-muted/60 pl-1.5 pr-1 align-[-0.2em] text-xs leading-none select-none cursor-pointer";
      span.innerHTML = `${iconSvg(data.kind)}<span data-cid-name class="font-medium whitespace-nowrap"></span>`;
      const nameEl = span.querySelector("[data-cid-name]") as HTMLElement;
      nameEl.textContent = displayName(data);
      // 关闭按钮
      const close = document.createElement("button");
      close.type = "button";
      close.className =
        "flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:bg-muted hover:text-foreground";
      close.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
      close.addEventListener("mousedown", (e) => e.preventDefault());
      close.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dataMap.current.delete(cid);
        span.remove();
        refreshEmpty();
        onChange?.("");
      });
      span.appendChild(close);
      span.addEventListener("mouseenter", () => {
        const d = dataMap.current.get(cid);
        if (d) showPreview(d, span);
      });
      span.addEventListener("mouseleave", schedulePreviewHide);
      // 点击 pill 主体（排除关闭按钮）：如果名称像有效文件路径则打开文件
      span.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        const d = dataMap.current.get(cid);
        if (!d) return;
        const looksLikePath = /[/\\]/.test(d.name) || /\.\w{1,10}$/.test(d.name);
        if (!looksLikePath) return;
        const vs = (window as any).__axonVSCode;
        if (vs) vs.postMessage({ type: "open_file", path: d.name });
      });
      return span;
    },
    [onChange, refreshEmpty, showPreview, schedulePreviewHide],
  );

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    clear: () => {
      const el = editorRef.current;
      if (el) el.innerHTML = "";
      dataMap.current.clear();
      refreshEmpty();
    },
    isEmpty: () => {
      const el = editorRef.current;
      return !el || ((el.textContent ?? "").trim() === "" && !el.querySelector("[data-cid]"));
    },
    read: () => {
      const el = editorRef.current;
      const tags: AttachedFile[] = [];
      const segments: UserSegment[] = [];
      let text = "";
      const pushText = (s: string) => {
        if (!s) return;
        const last = segments[segments.length - 1];
        if (last && last.type === "text") last.text += s;
        else segments.push({ type: "text", text: s });
      };
      const walk = (node: Node) => {
        node.childNodes.forEach((child) => {
          if (child.nodeType === Node.TEXT_NODE) {
            const s = child.nodeValue ?? "";
            text += s;
            pushText(s);
          } else if (child.nodeName === "BR") {
            text += "\n";
            pushText("\n");
          } else if (child instanceof HTMLElement && child.dataset.cid) {
            const d = dataMap.current.get(child.dataset.cid);
            if (d) {
              text += displayName(d);
              tags.push(d);
              segments.push({ type: "tag", tag: d });
            }
          } else if (child instanceof HTMLElement) {
            if (child.nodeName === "DIV" && text && !text.endsWith("\n")) {
              text += "\n";
              pushText("\n");
            }
            walk(child);
          }
        });
      };
      if (el) walk(el);
      // 去掉首尾纯空白文本片段，但保留中间结构
      const trimmedSegs = segments
        .map((s) => s)
        .filter((s, i) => !(s.type === "text" && s.text.trim() === "" && (i === 0 || i === segments.length - 1)));
      return { text: text.trim(), tags, segments: trimmedSegs };
    },
    textBeforeCaret: () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return "";
      const node = sel.focusNode;
      if (!node || node.nodeType !== Node.TEXT_NODE) return "";
      return (node.nodeValue ?? "").slice(0, sel.focusOffset);
    },
    deleteBeforeCaret: (len: number) => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const node = sel.focusNode;
      const offset = sel.focusOffset;
      if (!node || node.nodeType !== Node.TEXT_NODE) return;
      const value = node.nodeValue ?? "";
      const start = Math.max(0, offset - len);
      node.nodeValue = value.slice(0, start) + value.slice(offset);
      const range = document.createRange();
      range.setStart(node, start);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    },
    insertTag: (data: AttachedFile) => {
      const el = editorRef.current;
      if (!el) return "";
      const cid = nextCid();
      dataMap.current.set(cid, data);
      const pill = buildPill(cid, data);
      const space = document.createTextNode("\u00A0"); // 尾随空格，方便光标落在 tag 之后继续输入
      const sel = window.getSelection();
      let range: Range;
      if (sel && sel.rangeCount > 0 && el.contains(sel.focusNode)) {
        range = sel.getRangeAt(0);
        range.deleteContents();
      } else {
        range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
      }
      range.insertNode(space);
      range.insertNode(pill);
      // 光标落到尾随空格之后
      const after = document.createRange();
      after.setStartAfter(space);
      after.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(after);
      el.focus();
      refreshEmpty();
      onChange?.("");
      return cid;
    },
    updateTag: (contextId: string, patch: Partial<AttachedFile>) => {
      const cur = dataMap.current.get(contextId);
      if (!cur) return;
      const next = { ...cur, ...patch };
      dataMap.current.set(contextId, next);
      const el = editorRef.current;
      const pill = el?.querySelector(`[data-cid="${contextId}"] [data-cid-name]`) as HTMLElement | null;
      if (pill) pill.textContent = displayName(next);
    },
    setText: (text: string) => {
      const el = editorRef.current;
      if (!el) return;
      el.textContent = text;
      dataMap.current.clear();
      refreshEmpty();
      el.focus();
    },
    appendText: (text: string) => {
      const el = editorRef.current;
      if (!el) return;
      const prefix = (el.textContent ?? "").trim() ? "\n" : "";
      el.appendChild(document.createTextNode(prefix + text));
      // 光标移到末尾
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      el.focus();
      refreshEmpty();
    },
    appendSegments: (segments: UserSegment[]) => {
      const el = editorRef.current;
      if (!el) return;
      if ((el.textContent ?? "").trim() || el.querySelector("[data-cid]")) {
        el.appendChild(document.createTextNode("\n"));
      }
      for (const seg of segments) {
        if (seg.type === "text") {
          el.appendChild(document.createTextNode(seg.text));
        } else {
          const cid = nextCid();
          dataMap.current.set(cid, seg.tag);
          el.appendChild(buildPill(cid, seg.tag));
          el.appendChild(document.createTextNode("\u00A0"));
        }
      }
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      el.focus();
      refreshEmpty();
    },
  }));

  /** 拦截粘贴：纯文本插入光标处（保护内部 tag、阻止外部富文本样式渗入） */
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    onPaste?.(e);
    if (e.defaultPrevented) return;

    const plainText = e.clipboardData.getData("text/plain");
    if (!plainText) return;

    e.preventDefault();

    const el = editorRef.current;
    if (!el) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return;

    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(plainText));
    const after = document.createRange();
    after.setStartAfter(range.endContainer);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);

    refreshEmpty();
    onChange?.("");
  }, [onPaste, refreshEmpty, onChange]);

  return (
    <div className="relative flex-1 min-w-[140px]">
      <div
        ref={editorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        onInput={() => {
          refreshEmpty();
          const sel = window.getSelection();
          const node = sel?.focusNode;
          const before = node && node.nodeType === Node.TEXT_NODE ? (node.nodeValue ?? "").slice(0, sel!.focusOffset) : "";
          onChange?.(before);
        }}
        onKeyDown={onKeyDown}
        onPaste={handlePaste}
        className="max-h-[104px] min-h-[44px] overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-[1.5] focus:outline-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]"
      />
      {empty && (
        <div className="pointer-events-none absolute left-0 top-0 select-none text-[13px] leading-[1.5] text-muted-foreground">
          {placeholder}
        </div>
      )}
      {preview &&
        createPortal(
          <div
            style={{ position: "fixed", left: preview.left, top: preview.top, bottom: preview.bottom, width: 340, zIndex: 9999 }}
            className="max-w-[80vw] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
            onMouseEnter={() => {
              if (hideTimer.current) window.clearTimeout(hideTimer.current);
            }}
            onMouseLeave={schedulePreviewHide}
          >
            <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5 text-[11px] text-muted-foreground">
              <span className="truncate font-medium" title={preview.data.name}>
                {preview.data.name}
              </span>
            </div>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 text-[11px] leading-relaxed text-foreground/90">
              {preview.data.content || "（无内容）"}
            </pre>
          </div>,
          document.body,
        )}
    </div>
  );
});
