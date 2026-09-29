import { FileText, ImageIcon, X } from "lucide-react";

export interface ProcessingAttachment {
  id: string;
  name: string;
  kind: "image" | "file";
  size: number;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function ProcessingAttachmentCard({
  attachment,
  onRemove,
}: {
  attachment: ProcessingAttachment;
  onRemove: (id: string) => void;
}) {
  const isImage = attachment.kind === "image";

  return (
    <div
      className={isImage
        ? "axon-attachment-processing relative h-[120px] w-[152px] max-w-[45vw] overflow-hidden rounded-xl border border-border bg-muted/25 shadow-sm"
        : "axon-attachment-processing relative flex h-14 w-52 max-w-[70vw] items-center gap-2.5 overflow-hidden rounded-xl border border-border bg-muted/25 px-3 shadow-sm"}
      aria-label={`${attachment.name} 正在处理`}
    >
      <div className="axon-attachment-processing__wave" aria-hidden="true" />
      <div className={isImage
        ? "relative z-[1] flex h-full flex-col items-center justify-center gap-2 text-muted-foreground"
        : "relative z-[1] flex min-w-0 flex-1 items-center gap-2.5"}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-background/70 text-muted-foreground shadow-sm backdrop-blur-sm">
          {isImage ? <ImageIcon className="size-4" /> : <FileText className="size-4" />}
        </span>
        <span className={isImage ? "max-w-[125px] truncate px-2 text-[11px] font-medium" : "min-w-0 flex-1"}>
          {isImage ? attachment.name : (
            <>
              <span className="block truncate text-xs font-medium text-foreground/80">{attachment.name}</span>
              <span className="block text-[10px] text-muted-foreground">正在读取 · {formatSize(attachment.size)}</span>
            </>
          )}
        </span>
        {isImage && <span className="text-[10px] text-muted-foreground/70">正在处理</span>}
      </div>
      <button
        type="button"
        onClick={() => onRemove(attachment.id)}
        className="absolute right-1.5 top-1.5 z-[2] flex size-5 items-center justify-center rounded-full border border-border/70 bg-background/80 text-muted-foreground opacity-0 shadow-sm backdrop-blur-sm transition-all hover:text-destructive group-hover:opacity-100"
        title="取消处理"
        aria-label={`取消处理 ${attachment.name}`}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
