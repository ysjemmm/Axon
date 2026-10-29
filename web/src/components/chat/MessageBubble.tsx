/**
 * 单条聊天消息渲染：用户消息（右侧气泡）/ AI 回复（AssistantTurn）
 * 从原 ChatPanel.tsx 拆出。
 */

import { memo, useState } from "react";
import { Bell, Check, ChevronDown, Copy, Feather, FileText, Pencil, X } from "lucide-react";
import type { AttachedFile, ChatMessage } from "./types";
import { formatFileSize } from "./format";
import { AssistantTurn } from "./AssistantTurn";
import { FileTag } from "./FileTag";
import { ATTACHMENT_BADGE_CLASS, attachmentTypeLabel, imageTypeLabel } from "./attachmentType";

const USER_MESSAGE_COLLAPSE_CHARS = 700;
const USER_MESSAGE_COLLAPSE_LINES = 10;

function userMessageText(message: ChatMessage): string {
  if (message.userSegments && message.userSegments.length > 0) {
    return message.userSegments.map((seg) => seg.type === "text" ? seg.text : seg.tag.name).join("");
  }
  return message.content || "";
}

/** data URL → Blob。fetch 对 data URL 在个别环境会失败，回退到手动解析（与 ImageViewer 同款）。 */
async function dataUrlToBlob(src: string): Promise<Blob> {
  try {
    const res = await fetch(src);
    return await res.blob();
  } catch {
    const parts = src.split(",");
    const mime = parts[0].match(/:(.*?);/)?.[1] || "image/png";
    const binary = atob(parts[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
}

/**
 * 复制一条消息：文本与图片一起进剪贴板。
 *
 * ⚠️ 必须走 clipboard.write + ClipboardItem——writeText 只能写纯文本，图片带不进去，
 * 这正是"复制不会把图片复制上"的原因。
 *
 * 注意：一次 write 里同一 MIME 类型只有最后一项生效，所以多图消息只能带上最后一张。
 * 这是 Clipboard API 自身的限制，不是这里的选择。
 * write 不可用（或图片读取失败）时退回纯文本，保证文字仍然复制得到。
 */
async function copyMessage(text: string, images: string[]): Promise<void> {
  if (images.length > 0 && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      const items: ClipboardItem[] = [];
      if (text) items.push(new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }) }));
      for (const src of images) {
        const blob = await dataUrlToBlob(src);
        if (blob.size > 0) items.push(new ClipboardItem({ [blob.type || "image/png"]: blob }));
      }
      if (items.length > 0) {
        await navigator.clipboard.write(items);
        return;
      }
    } catch (err) {
      console.warn("[axon] 复制消息（含图片）失败，退回纯文本:", err);
    }
  }
  await navigator.clipboard.writeText(text);
}

function MessageBubbleImpl({ message, liveStatus, startedAt, onAcceptEdit, onRejectEdit, onUndoEdit, onQuoteToInput, onEditUserMessage, onImagePreview, onForkFromMessage, replyingToMessageId }: { message: ChatMessage; liveStatus?: string; /** 当前运行任务起点；仅流式回复传入 */ startedAt?: number; onAcceptEdit?: (path: string) => void; onRejectEdit?: (path: string) => void; onUndoEdit?: (path: string) => void; onQuoteToInput?: (message: ChatMessage) => void; onEditUserMessage?: (messageId: string, content: string, images?: string[], attachedFiles?: AttachedFile[]) => void; onImagePreview?: (images: string[], index: number) => void; /** 从这条 AI 回复分叉（带上此前的对话） */ onForkFromMessage?: (message: ChatMessage) => void; replyingToMessageId?: string }) {
  const [userExpanded, setUserExpanded] = useState(false);
  const [editingUser, setEditingUser] = useState(false);
  const [draftUserText, setDraftUserText] = useState("");
  const [draftImages, setDraftImages] = useState<string[]>([]);
  const [draftFiles, setDraftFiles] = useState<AttachedFile[]>([]);

  // 系统消息（压缩提示等）：居中浅色文本行；带压缩摘要的可以点开查看
  if ((message as any).role === "system") {
    if (message.summary) {
      return (
        <div className="flex flex-col items-center py-1">
          <button
            onClick={() => setUserExpanded((v) => !v)}
            className="text-[11px] text-muted-foreground/60 bg-muted/30 hover:bg-muted/50 hover:text-muted-foreground px-3 py-0.5 rounded-full transition-colors"
          >
            {message.content} · {userExpanded ? "收起摘要" : "查看摘要"}
          </button>
          {userExpanded && (
            <div className="mt-2 w-full max-w-[640px] rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">
              {message.summary}
            </div>
          )}
        </div>
      );
    }
    return (
      <div className="flex justify-center py-1">
        <span className="text-[11px] text-muted-foreground/60 bg-muted/30 px-3 py-0.5 rounded-full">
          {message.content}
        </span>
      </div>
    );
  }

  // 后台任务结束通知：这一轮由系统发起，不是用户说的话，画成一行通知而不是右侧气泡
  if (message.role === "user" && message.backgroundNotice) {
    const failed = message.backgroundNotice.tasks.some((t) => t.exitCode !== null && t.exitCode !== 0);
    return (
      <div className="flex justify-center py-1">
        <span
          className={`inline-flex max-w-full items-center gap-1.5 truncate rounded-full px-3 py-0.5 text-[11px] ${failed ? "bg-red-500/10 text-red-600 dark:text-red-400" : "bg-muted/40 text-muted-foreground"}`}
          title={message.backgroundNotice.tasks.map((t) => t.command).join("\n")}
        >
          <Bell className="h-3 w-3 shrink-0" />
          <span className="truncate">{message.backgroundNotice.label}</span>
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
                onClick={async (e) => {
                  // 先取 currentTarget：await 之后合成事件的 currentTarget 可能已失效
                  const btn = e.currentTarget;
                  await copyMessage(plainText, message.images ?? []);
                  btn.setAttribute("data-copied", "true");
                  setTimeout(() => btn.removeAttribute("data-copied"), 1500);
                }}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/80 data-[copied]:text-foreground"
                title="复制"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              {!message.archived && <button
                onClick={() => {
                  setDraftUserText(plainText);
                  setDraftImages(message.images ? [...message.images] : []);
                  setDraftFiles(message.attachedFiles ? [...message.attachedFiles] : []);
                  setEditingUser(true);
                }}
                className={`p-1 rounded ${message.id !== replyingToMessageId ? "text-muted-foreground hover:text-foreground hover:bg-muted/80" : "text-muted-foreground/40 cursor-not-allowed"}`}
                title={message.id === replyingToMessageId ? "AI 正在回复此消息，暂不可编辑" : "编辑这条消息"}
                disabled={message.id === replyingToMessageId}
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>}
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
            <div className="min-w-[360px] max-w-[680px]">
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
                className="w-full h-[100px] resize-none overflow-y-auto rounded-lg border border-border bg-background px-3 py-2 text-[14px] leading-relaxed outline-none focus:ring-1 focus:ring-primary/40"
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
                <div className="flex gap-3 flex-wrap mb-3">
                  {message.images.map((img, i) => (
                    <button
                      type="button"
                      key={i}
                      onClick={() => onImagePreview?.(message.images!, i)}
                      onContextMenu={(event) => event.preventDefault()}
                      className="relative overflow-hidden rounded-xl border border-border bg-background/60 p-1 shadow-sm hover:border-foreground/20 hover:shadow-md transition-all"
                      title="点击查看大图"
                    >
                      <img src={img} alt="" className="w-60 max-w-[65vw] h-44 object-contain rounded-lg" />
                      <span className={ATTACHMENT_BADGE_CLASS}>{imageTypeLabel(img)}</span>
                    </button>
                  ))}
                </div>
              )}
              {hasSegments ? (
                <div className="relative">
                  <p className={`text-[14px] whitespace-pre-wrap leading-[1.5] overflow-hidden ${collapsed ? "max-h-40" : ""}`}>
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
                        <div key={i} className="relative flex min-h-20 w-52 items-center gap-3 rounded-xl bg-background/60 border border-border p-3 shadow-sm">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                            <FileText className="w-5 h-5 text-muted-foreground" />
                          </div>
                          <div className="min-w-0">
                            <div className="text-[13px] font-medium truncate" title={f.name}>{f.name}</div>
                            <div className="mt-1 text-[10px] text-muted-foreground">{formatFileSize(f.size)}</div>
                          </div>
                          <span className="absolute bottom-2 left-3 rounded-md border border-border bg-background px-1.5 py-px text-[10px] font-semibold text-muted-foreground">
                            {attachmentTypeLabel(f)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {message.content && (
                    <div className="relative">
                      <p className={`text-[14px] whitespace-pre-wrap leading-relaxed overflow-hidden ${collapsed ? "max-h-40" : ""}`}>{message.content}</p>
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
  //
  // 「分叉」只挂在 assistant 消息上（用户消息没有可截断的回复点）。
  // 流式中的回合不给入口：此刻后端还在往 messages 里追加这一轮的工具结果，
  // 截出来的历史可能停在一个半截工具轮上，语义也不明确（用户想分的是"这条回复"，
  // 而它还没说完）。取消 / 失败这种终态可以分叉 —— 那一轮已经落盘，截过去是完整的一轮。
  return (
    <div className="group/fork">
      <AssistantTurn
        message={message}
        liveStatus={liveStatus}
        startedAt={startedAt}
        onAcceptEdit={onAcceptEdit}
        onRejectEdit={onRejectEdit}
        onUndoEdit={onUndoEdit}
        onForkFromMessage={onForkFromMessage}
      />
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleImpl, (prev, next) => prev.message === next.message && prev.replyingToMessageId === next.replyingToMessageId && prev.liveStatus === next.liveStatus && prev.startedAt === next.startedAt);
