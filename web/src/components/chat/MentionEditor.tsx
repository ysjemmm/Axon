/**
 * MentionEditor —— 基于 Tiptap 的聊天输入编辑器。
 *
 * 文本和上下文块统一存入 ProseMirror 文档：
 * - 浏览器不再直接管理 contentEditable DOM，避免 IME、选区与 React 更新相互覆盖；
 * - contextTag 是原子内联节点，文件/终端/诊断块的插入、删除和 Ctrl+Z 均进入同一历史栈；
 * - 对外保持原 MentionEditorHandle，ChatPanel、斜杠命令与 Agent 选择器无需改调用方式。
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type NodeViewProps } from "@tiptap/react";
import { Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { AttachedFile, UserSegment } from "./types";

export interface MentionEditorHandle {
  focus(): void;
  clear(): void;
  isEmpty(): boolean;
  getEditorElement(): HTMLDivElement | null;
  read(): { text: string; tags: AttachedFile[]; segments: UserSegment[] };
  textBeforeCaret(): string;
  deleteBeforeCaret(len: number): void;
  insertTag(data: AttachedFile): string;
  insertAtCursor(text: string): void;
  updateTag(contextId: string, patch: Partial<AttachedFile>): void;
  setText(text: string): void;
  appendText(text: string): void;
  appendSegments(segments: UserSegment[]): void;
}

interface MentionEditorProps {
  placeholder?: string;
  disabled?: boolean;
  onChange?: (textBeforeCaret: string) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  onPaste?: (e: React.ClipboardEvent) => void;
}

let cidSeq = 0;
const nextCid = () => `cx-${Date.now().toString(36)}-${(cidSeq++).toString(36)}`;

function displayName(data: AttachedFile): string {
  if (data.kind === "file" || data.kind === "folder") {
    return data.name.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || data.name;
  }
  return data.name;
}

function tagTone(kind: AttachedFile["kind"]): string {
  if (kind === "diagnostics") return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";
  if (kind === "terminal" || kind === "editor" || kind === "folder") return "border-primary/30 bg-primary/10 text-primary";
  return "border-border bg-muted/60 text-foreground";
}

function TagNodeView({ node, deleteNode }: NodeViewProps) {
  const data = node.attrs.data as AttachedFile;
  const [preview, setPreview] = useState(false);

  const openFile = () => {
    const looksLikePath = /[/\\]/.test(data.name) || /\.\w{1,10}$/.test(data.name);
    if (!looksLikePath) return;
    const vscode = (window as any).__axonVSCode;
    if (vscode) vscode.postMessage({ type: "open_file", path: data.name });
  };

  return (
    <NodeViewWrapper as="span" className="inline-flex align-middle mx-0.5" contentEditable={false}>
      <span
        className={`inline-flex h-5 items-center gap-1 rounded-md border pl-1.5 pr-1 text-xs leading-none select-none cursor-pointer ${tagTone(data.kind)}`}
        onMouseEnter={() => setPreview(true)}
        onMouseLeave={() => setPreview(false)}
        onClick={openFile}
      >
        <span className="max-w-44 truncate font-medium">{displayName(data)}</span>
        <button
          type="button"
          contentEditable={false}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            deleteNode();
          }}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-current/60 hover:bg-background/50 hover:text-current"
          title="移除上下文"
        >
          ×
        </button>
      </span>
      {preview &&
        createPortal(
          <div
            className="fixed z-[9999] w-[340px] max-w-[80vw] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
            style={{ left: Math.max(8, Math.min(window.innerWidth - 348, 12)), bottom: 42 }}
            onMouseEnter={() => setPreview(true)}
            onMouseLeave={() => setPreview(false)}
          >
            <div className="truncate border-b border-border/60 px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground" title={data.name}>{data.name}</div>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 text-[11px] leading-relaxed text-foreground/90">{data.content || "（无内容）"}</pre>
          </div>,
          document.body,
        )}
    </NodeViewWrapper>
  );
}

const ContextTag = Node.create({
  name: "contextTag",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      contextId: { default: "" },
      data: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-context-tag]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { "data-context-tag": "true" })];
  },
  addNodeView() {
    return ReactNodeViewRenderer(TagNodeView);
  },
});

type InlineContent = Array<Record<string, unknown>>;

function textToContent(text: string): InlineContent {
  const parts = text.split(/\r\n|\r|\n/);
  const content: InlineContent = [];
  parts.forEach((part, index) => {
    if (part) content.push({ type: "text", text: part });
    if (index < parts.length - 1) content.push({ type: "hardBreak" });
  });
  return content;
}

function documentContent(text: string): Record<string, unknown> {
  const inline = textToContent(text);
  return { type: "doc", content: inline.length > 0 ? [{ type: "paragraph", content: inline }] : [{ type: "paragraph" }] };
}

export const MentionEditor = forwardRef<MentionEditorHandle, MentionEditorProps>(function MentionEditor(
  { placeholder, disabled, onChange, onKeyDown, onPaste },
  ref,
) {
  const [empty, setEmpty] = useState(true);
  const callbacksRef = useRef({ onChange, onKeyDown, onPaste });
  callbacksRef.current = { onChange, onKeyDown, onPaste };

  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false, blockquote: false, codeBlock: false, bulletList: false, orderedList: false }), ContextTag],
    content: documentContent(""),
    editable: !disabled,
    editorProps: {
      attributes: {
        class: "max-h-[104px] min-h-[44px] overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-[1.5] focus:outline-none [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]",
        role: "textbox",
        "aria-multiline": "true",
      },
      handleKeyDown: (_view, event) => {
        callbacksRef.current.onKeyDown?.(event as unknown as React.KeyboardEvent);
        return event.defaultPrevented;
      },
      handlePaste: (_view, event) => {
        const reactEvent = event as unknown as React.ClipboardEvent;
        callbacksRef.current.onPaste?.(reactEvent);
        if (event.defaultPrevented) return true;
        const plainText = event.clipboardData?.getData("text/plain");
        if (!plainText) return false;
        event.preventDefault();
        editor?.commands.insertContent(textToContent(plainText));
        return true;
      },
    },
    onUpdate: ({ editor: next }) => {
      setEmpty(next.isEmpty);
      const { $from } = next.state.selection;
      callbacksRef.current.onChange?.($from.parent.textBetween(0, $from.parentOffset, "\n", ""));
    },
  }, []);

  // disabled 变化不需要销毁编辑器，保留撤销历史与原子节点。
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  const serialize = useCallback(() => {
    if (!editor) return { text: "", tags: [] as AttachedFile[], segments: [] as UserSegment[] };
    const tags: AttachedFile[] = [];
    const segments: UserSegment[] = [];
    let text = "";
    const appendText = (value: string) => {
      if (!value) return;
      text += value;
      const last = segments[segments.length - 1];
      if (last?.type === "text") last.text += value;
      else segments.push({ type: "text", text: value });
    };
    editor.state.doc.forEach((block, blockIndex) => {
      if (blockIndex > 0) appendText("\n");
      block.descendants((node) => {
        if (node.type.name === "text") appendText(node.text || "");
        else if (node.type.name === "hardBreak") appendText("\n");
        else if (node.type.name === "contextTag") {
          const data = node.attrs.data as AttachedFile;
          if (data) {
            text += displayName(data);
            tags.push(data);
            segments.push({ type: "tag", tag: data });
          }
        }
      });
    });
    const trimmed = segments.filter((segment, index) => !(segment.type === "text" && !segment.text.trim() && (index === 0 || index === segments.length - 1)));
    return { text: text.trim(), tags, segments: trimmed };
  }, [editor]);

  useImperativeHandle(ref, () => ({
    focus: () => editor?.commands.focus("end"),
    clear: () => editor?.commands.clearContent(true),
    isEmpty: () => editor?.isEmpty ?? true,
    getEditorElement: () => (editor?.view.dom as HTMLDivElement | undefined) ?? null,
    read: serialize,
    textBeforeCaret: () => {
      if (!editor) return "";
      const { $from } = editor.state.selection;
      return $from.parent.textBetween(0, $from.parentOffset, "\n", "");
    },
    deleteBeforeCaret: (len: number) => {
      if (!editor || len <= 0) return;
      const { from } = editor.state.selection;
      editor.chain().focus().deleteRange({ from: Math.max(1, from - len), to: from }).run();
    },
    insertTag: (data: AttachedFile) => {
      if (!editor) return "";
      const contextId = nextCid();
      editor.chain().focus().insertContent([{ type: "contextTag", attrs: { contextId, data } }, { type: "text", text: " " }]).run();
      return contextId;
    },
    insertAtCursor: (text: string) => editor?.chain().focus().insertContent(textToContent(text)).run(),
    updateTag: (contextId: string, patch: Partial<AttachedFile>) => {
      if (!editor) return;
      let position: number | null = null;
      let current: AttachedFile | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "contextTag" && node.attrs.contextId === contextId) {
          position = pos;
          current = node.attrs.data as AttachedFile;
          return false;
        }
        return true;
      });
      if (position !== null && current) {
        const currentData = current as AttachedFile;
        editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { contextId, data: { ...currentData, ...patch } }));
      }
    },
    setText: (text: string) => editor?.commands.setContent(documentContent(text), { emitUpdate: true }),
    appendText: (text: string) => {
      if (!editor) return;
      const prefix = editor.isEmpty ? "" : "\n";
      editor.chain().focus("end").insertContent(textToContent(prefix + text)).run();
    },
    appendSegments: (segments: UserSegment[]) => {
      if (!editor) return;
      const content: InlineContent = [];
      if (!editor.isEmpty) content.push({ type: "hardBreak" });
      for (const segment of segments) {
        if (segment.type === "text") content.push(...textToContent(segment.text));
        else content.push({ type: "contextTag", attrs: { contextId: nextCid(), data: segment.tag } }, { type: "text", text: " " });
      }
      editor.chain().focus("end").insertContent(content).run();
    },
  }), [editor, serialize]);

  return (
    <div className="relative flex-1 min-w-[140px]">
      <EditorContent editor={editor} />
      {empty && (
        <div className="pointer-events-none absolute left-0 top-0 select-none text-[13px] leading-[1.5] text-muted-foreground">
          {placeholder}
        </div>
      )}
    </div>
  );
});
