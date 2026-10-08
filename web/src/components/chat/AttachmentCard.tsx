/**
 * AttachmentCard —— 输入区附件卡片（图片 / 文件 / 处理中 共用一套外形）
 *
 * 为什么只留一个组件：之前图片预览、处理中占位、已上传文件是三份各写各的 JSX，
 * 改了其中一处另外两处不会跟着变（实际踩过：只改了处理中，上传完成后仍是横条）。
 * 外形（尺寸、圆角、边框、类型角标、移除按钮、波纹层）全部收在这里，
 * 调用方只决定"里面放什么"。
 *
 * ── 排版取舍（刻意做减法，改之前先读）──
 * 文件卡片只呈现两件事：文件名 + 格式。不放文件图标，也不显示体积：
 * · 图标在左下角已有格式角标的前提下是重复信息，两者都在时卡片显得很挤；
 * · 体积对"我拖进去的这个文件对不对"这个判断毫无帮助，是纯噪音。
 * 文件名左上对齐、允许折行（最多两行），因为长文件名的区分度往往在后半段，
 * 居中单行截断会把 `2024-对账-最终版.xlsx` 截成一模一样的几张卡片。
 */

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { canPreviewFiles, requestFilePreview } from "./filePreview";

interface AttachmentCardProps {
  children: ReactNode;
  /** 处理中：叠加波纹动画层 */
  processing?: boolean;
  /** 移除回调；不传则不显示移除按钮 */
  onRemove?: () => void;
  removeLabel?: string;
  title?: string;
  /** 图片等需要内容铺满整张卡片时传 true（不留内边距） */
  bleed?: boolean;
  /**
   * 点击卡片预览。传绝对路径 —— 预览窗开在 workbench 层，由宿主按路径读盘。
   * 没有磁盘路径的附件（如仅存在内存里的小文件）不传，卡片就不可点。
   */
  previewPath?: string;
}

export function AttachmentCard({ children, processing = false, onRemove, removeLabel = "移除", title, bleed = false, previewPath }: AttachmentCardProps) {
  // 浏览器形态没有宿主可以读盘，此时卡片不做成可点（避免点了没反应）
  const clickable = !!previewPath && canPreviewFiles();
  return (
    <div
      // 正方形 112px：比原先 144×112 的横向比例更接近 Claude 的观感，
      // 一行能并排更多张，也不会让单个附件在输入框里显得笨重。
      className={`group relative size-28 shrink-0 overflow-hidden rounded-xl border border-border bg-muted/20 shadow-sm transition-colors ${processing ? "axon-attachment-processing" : ""} ${clickable ? "cursor-pointer hover:border-foreground/30 hover:bg-muted/40" : ""}`}
      title={title}
      aria-busy={processing || undefined}
      onClick={clickable ? () => requestFilePreview(previewPath!) : undefined}
      onKeyDown={clickable ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          requestFilePreview(previewPath!);
        }
      } : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? `预览 ${title || previewPath}` : undefined}
    >
      {processing && <div className="axon-attachment-processing__wave" aria-hidden="true" />}
      <div className={`relative z-[1] h-full w-full ${bleed ? "" : "p-2.5"}`}>
        {children}
      </div>
      {onRemove && (
        <button
          type="button"
          // 编辑器内使用时阻止 mousedown 抢焦点，否则点叉会先让编辑器失焦再删节点
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          className="absolute right-1 top-1 z-[3] flex size-5 items-center justify-center rounded-full border border-border bg-background/90 text-muted-foreground opacity-0 shadow-sm backdrop-blur-sm transition-all hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
          title={removeLabel}
          aria-label={removeLabel}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

/** 文件格式角标：卡片左下角的小圆角标签 */
export function AttachmentBadge({ children }: { children: ReactNode }) {
  return (
    // self-start 不能省：父级是 flex 列，子项默认 align-items:stretch，
    // 不加这个角标会被拉成整行宽的灰条（而不是贴左的小标签）。
    <span className="self-start rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-4 tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * 文件类卡片的主体：文件名在上（可折行），格式角标贴底。
 * processing 时把角标换成「读取中」，位置不变，处理完成替换成真实卡片时不跳位。
 */
export function FileCardBody({ name, badge, processing = false }: { name: string; badge: string; processing?: boolean }) {
  return (
    <div className="flex h-full flex-col justify-between gap-1">
      {/* line-clamp-2：长文件名折两行后再截断，保留结尾的版本/日期等区分信息 */}
      <span className="line-clamp-2 break-all pr-4 text-left text-[11px] font-medium leading-[1.35] text-foreground/85">
        {name}
      </span>
      <AttachmentBadge>{processing ? "读取中" : badge}</AttachmentBadge>
    </div>
  );
}
