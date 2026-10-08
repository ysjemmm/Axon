/**
 * ProcessingAttachmentCard —— 附件读取 / 图片压缩期间的占位卡片
 *
 * 外形完全交给 AttachmentCard（与已上传的图片、文件卡片同尺寸同结构），
 * 这里只负责"处理中"的内容与波纹层，保证处理完成替换成真实卡片时不跳位。
 */

import { AttachmentCard, AttachmentBadge, FileCardBody } from "./AttachmentCard";
import { attachmentTypeLabel } from "./attachmentType";

export interface ProcessingAttachment {
  id: string;
  name: string;
  kind: "image" | "file";
  size: number;
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
    <AttachmentCard
      processing
      onRemove={() => onRemove(attachment.id)}
      removeLabel={`取消处理 ${attachment.name}`}
      title={`${attachment.name} 正在处理`}
    >
      {isImage ? (
        // 图片还没压缩完、拿不到缩略图，只能用文案占位；与文件卡片同一套排版
        <div className="flex h-full flex-col justify-between gap-1">
          <span className="line-clamp-2 break-all pr-4 text-left text-[11px] font-medium leading-[1.35] text-foreground/85">
            {attachment.name}
          </span>
          <AttachmentBadge>处理中</AttachmentBadge>
        </div>
      ) : (
        <FileCardBody
          name={attachment.name}
          badge={attachmentTypeLabel({ name: attachment.name, kind: "file" })}
          processing
        />
      )}
    </AttachmentCard>
  );
}
