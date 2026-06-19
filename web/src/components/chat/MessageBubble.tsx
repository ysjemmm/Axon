/**
 * 单条聊天消息渲染：用户消息（右侧气泡）/ AI 回复（AssistantTurn）
 * 从原 ChatPanel.tsx 拆出。
 */

import { memo } from "react";
import { Copy, Feather, FileText } from "lucide-react";
import type { ChatMessage } from "./types";
import { formatFileSize } from "./format";
import { AssistantTurn } from "./AssistantTurn";
import { FileTag } from "./FileTag";

function MessageBubbleImpl({ message, onAcceptEdit, onRejectEdit, onUndoEdit, onQuoteToInput, onImagePreview }: { message: ChatMessage; onAcceptEdit?: (path: string) => void; onRejectEdit?: (path: string) => void; onUndoEdit?: (path: string) => void; onQuoteToInput?: (message: ChatMessage) => void; onImagePreview?: (src: string) => void }) {
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
    if (!message.content && (!message.images || message.images.length === 0) && !hasFiles && !hasSegments) return null;
    return (
      <div className="group/user flex items-start flex-row-reverse">
        <div className="relative rounded-xl px-3 py-1.5 max-w-[85%] bg-muted border border-border/70 text-foreground shadow-sm">
          {/* Hover 操作按钮 */}
          {(message.content || hasSegments || (message.images && message.images.length > 0)) && (
            <div className="absolute -left-16 bottom-0 flex items-center gap-0.5 opacity-0 group-hover/user:opacity-100 transition-opacity">
              <button
                onClick={(e) => {
                  navigator.clipboard.writeText(message.content || "");
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
                onClick={() => onQuoteToInput?.(message)}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/80"
                title="引用到输入框"
              >
                <Feather className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
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
            // 富文本：文本 + 内联 tag pill（与输入时一致）
            <p className="text-[13px] whitespace-pre-wrap leading-[1.5]">
              {message.userSegments!.map((seg, i) =>
                seg.type === "text" ? <span key={i}>{seg.text}</span> : <FileTag key={i} data={{ name: seg.tag.name, path: seg.tag.name, content: seg.tag.content, kind: seg.tag.kind }} />,
              )}
            </p>
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
              {message.content && <p className="text-[13px] whitespace-pre-wrap leading-relaxed">{message.content}</p>}
            </>
          )}
        </div>
      </div>
    );
  }

  // AI 回复：品牌头 + segments 混排
  return <AssistantTurn message={message} onAcceptEdit={onAcceptEdit} onRejectEdit={onRejectEdit} onUndoEdit={onUndoEdit} />;
}

export const MessageBubble = memo(MessageBubbleImpl, (prev, next) => prev.message === next.message);
