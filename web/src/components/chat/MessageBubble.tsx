/**
 * 单条聊天消息渲染：用户消息（右侧气泡）/ AI 回复（AssistantTurn）
 * 从原 ChatPanel.tsx 拆出。
 */

import { memo, useState } from "react";
import { Check, ChevronDown, Copy, Feather, FileText, Pencil, X } from "lucide-react";
import type { AttachedFile, ChatMessage } from "./types";
import { formatFileSize } from "./format";
import { AssistantTurn } from "./AssistantTurn";
import { FileTag } from "./FileTag";

const USER_MESSAGE_COLLAPSE_CHARS = 700;
const USER_MESSAGE_COLLAPSE_LINES = 10;

function userMessageText(message: ChatMessage): string {
  if (message.userSegments && message.userSegments.length > 0) {
    return message.userSegments.map((seg) => seg.type === "text" ? seg.text : seg.tag.name).join("");
  }
  return message.content || "";
}

function MessageBubbleImpl({ message, onAcceptEdit, onRejectEdit, onUndoEdit, onQuoteToInput, onEditUserMessage, onImagePreview }: { message: ChatMessage; onAcceptEdit?: (path: string) => void; onRejectEdit?: (path: string) => void; onUndoEdit?: (path: string) => void; onQuoteToInput?: (message: ChatMessage) => void; onEditUserMessage?: (messageId: string, content: string, images?: string[], attachedFiles?: AttachedFile[]) => void; onImagePreview?: (src: string) => void }) {
  const [userExpanded, setUserExpanded] = useState(false);
  const [editingUser, setEditingUser] = useState(false);
  const [draftUserText, setDraftUserText] = useState("");
  const [draftImages, setDraftImages] = useState<string[]>([]);
  const [draftFiles, setDraftFiles] = useState<AttachedFile[]>([]);

  // 系统消息（压缩提示等）：居中浅色文本行
  if ((message as any).role === "system") {
    return (
      <div className="flex justify-center py-1">
        <span className="text-[11px] text-muted-foreground/60 bg-muted/30 px-3 py-0.5 rounded-full">
          {message.content}
        </span>
      </div>
    );
  }

  // 用户消息：右侧气泡
  if (message.role === "user") {
    const hasFiles = message.attachedFiles && message.attachedFiles.length > 0;
    const hasSegments = !!message.userSegments && message.userSegments.length > 0;
    const plainText = userMessageText(message);
    const shouldCollapse =
      plainText.length > USER_MESSAGE_COLLAPSE_CHARS ||
      plainText.split(/\r\n|\r|\n/).length > USER_MESSAGE_COLLAPSE_LINES;
    const collapsed = shouldCollapse && !userExpanded;
    if (!message.content && (!message.images || message.images.length === 0) && !hasFiles && !hasSegments) return null;
    return (
      <div className="group/user flex items-start flex-row-reverse">
        <div className="relative rounded-xl px-3 py-1.5 max-w-[85%] bg-muted border border-border/70 text-foreground shadow-sm">
          {/* Hover 操作按钮 */}
          {(message.content || hasSegments || (message.images && message.images.length > 0)) && (
            <div className="absolute -left-16 bottom-0 flex items-center gap-0.5 opacity-0 group-hover/user:opacity-100 transition-opacity">
              <button
                onClick={(e) => {
                  navigator.clipboard.writeText(plainText);
                  const btn = e.currentTarget;
                  btn.setAttribute("data-copied", "true");
                  setTimeout(() => btn.removeAttribute("data-copied"), 1500);
                }}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/80 data-[copied]:text-green-500"
                title="复制"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => {
                  setDraftUserText(plainText);
                  setDraftImages(message.images ? [...message.images] : []);
                  setDraftFiles(message.attachedFiles ? [...message.attachedFiles] : []);
                  setEditingUser(true);
                }}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/80"
                title="编辑这条消息"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => onQuoteToInput?.(message)}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/80"
                title="引用到输入框"
              >
                <Feather className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {editingUser ? (
            <div className="min-w-[260px] max-w-[520px]">
              {/* 编辑态：图片缩略图（可删除） */}
              {draftImages.length > 0 && (
                <div className="flex gap-2 flex-wrap mb-2">
                  {draftImages.map((img, i) => (
                    <div key={i} className="relative group/edit-img">
                      <img src={img} alt="" className="max-w-32 max-h-20 object-contain rounded-lg" />
                      <button
                        type="button"
                        onClick={() => setDraftImages((prev) => prev.filter((_, idx) => idx !== i))}
                        className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover/edit-img:opacity-100 transition-opacity"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {/* 编辑态：附件 pill（可删除） */}
              {draftFiles.length > 0 && (
                <div className="flex gap-2 flex-wrap mb-2">
                  {draftFiles.map((f, i) => (
                    <div key={i} className="relative group/edit-file">
                      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-background/60 border border-border max-w-[200px] pr-6">
                        <FileText className="w-4 h-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <div className="text-xs font-medium truncate">{f.name}</div>
                          <div className="text-[10px] text-muted-foreground">{formatFileSize(f.size)}</div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setDraftFiles((prev) => prev.filter((_, idx) => idx !== i))}
                        className="absolute top-1 right-1 w-4 h-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover/edit-file:opacity-100 transition-opacity"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                value={draftUserText}
                onChange={(e) => setDraftUserText(e.target.value)}
                className="w-full min-h-[80px] resize-y rounded-lg border border-border bg-background px-2 py-1.5 text-[13px] leading-relaxed outline-none focus:ring-1 focus:ring-primary/40"
                autoFocus
              />
              <div className="mt-1.5 flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditingUser(false)}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                >
                  <X className="w-3 h-3" />取消
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = draftUserText.trimEnd();
                    onEditUserMessage?.(message.id, next, draftImages, draftFiles);
                    setEditingUser(false);
                  }}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground hover:opacity-90"
                >
                  <Check className="w-3 h-3" />保存
                </button>
              </div>
            </div>
          ) : (
            <>
              {message.images && message.images.length > 0 && (
                <div className="flex gap-2 flex-wrap mb-2">
                  {message.images.map((img, i) => (
                    <img
                      key={i}
                      src={img}
                      alt=""
                      className="max-w-48 max-h-32 object-contain rounded-lg cursor-zoom-in hover:opacity-90 transition-opacity"
                      onDoubleClick={() => onImagePreview?.(img)}
                      title="双击放大"
                    />
                  ))}
                </div>
              )}
              {hasSegments ? (
                <div className="relative">
                  <p className={`text-[13px] whitespace-pre-wrap leading-[1.5] overflow-hidden ${collapsed ? "max-h-40" : ""}`}>
                    {message.userSegments!.map((seg, i) =>
                      seg.type === "text" ? <span key={i}>{seg.text}</span> : <FileTag key={i} data={{ name: seg.tag.name, path: seg.tag.name, content: seg.tag.content, kind: seg.tag.kind }} />,
                    )}
                  </p>
                  {collapsed && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-muted to-transparent" />}
                </div>
              ) : (
                <>
                  {hasFiles && (
                    <div className="flex gap-2 flex-wrap mb-2">
                      {message.attachedFiles!.map((f, i) => (
                        <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-background/60 border border-border max-w-[200px]">
                          <FileText className="w-4 h-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0">
                            <div className="text-xs font-medium truncate">{f.name}</div>
                            <div className="text-[10px] text-muted-foreground">{formatFileSize(f.size)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {message.content && (
                    <div className="relative">
                      <p className={`text-[13px] whitespace-pre-wrap leading-relaxed overflow-hidden ${collapsed ? "max-h-40" : ""}`}>{message.content}</p>
                      {collapsed && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-muted to-transparent" />}
                    </div>
                  )}
                </>
              )}
            </>
          )}
          {shouldCollapse && (
            <button
              type="button"
              onClick={() => setUserExpanded((v) => !v)}
              className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <ChevronDown className={`w-3 h-3 transition-transform ${userExpanded ? "rotate-180" : ""}`} />
              {userExpanded ? "收起" : "展开完整消息"}
            </button>
          )}
        </div>
      </div>
    );
  }

  // AI 回复：品牌头 + segments 混排
  return <AssistantTurn message={message} onAcceptEdit={onAcceptEdit} onRejectEdit={onRejectEdit} onUndoEdit={onUndoEdit} />;
}

export const MessageBubble = memo(MessageBubbleImpl, (prev, next) => prev.message === next.message);
