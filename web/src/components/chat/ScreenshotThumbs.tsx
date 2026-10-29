/**
 * 截图缩略图：screenshot_page 截下的图在工具行右侧、折叠行标题旁显示成小图。
 * 悬停放大预览，点击用 Axon 的看图组件（ImageViewer）打开，可左右切换同一组里的截图。
 *
 * 看图组件由 ChatPanel 持有（与消息里的图片共用一个），这里通过 ImagePreviewContext 调起，
 * 免得把回调层层透传过消息列表。
 */

import { createContext, useContext, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";

/** 打开看图组件：images 为可切换的整组图片，index 为当前这张 */
export const ImagePreviewContext = createContext<(images: string[], index: number) => void>(() => {});

/** 悬停预览的尺寸上限 */
const PREVIEW_MAX_W = 320;
const PREVIEW_MAX_H = 220;

function HoverPreview({ src, anchor }: { src: string; anchor: DOMRect }) {
  // 默认放在缩略图上方，上面放不下就放下面；水平方向尽量右对齐缩略图，但不超出视口左右边缘
  const above = anchor.top > PREVIEW_MAX_H + 16;
  const top = above ? anchor.top - 8 : anchor.bottom + 8;
  const boxW = PREVIEW_MAX_W + 10; // 图片上限 + 内边距与边框
  const left = Math.max(8, Math.min(anchor.right - boxW, window.innerWidth - boxW - 8));
  return createPortal(
    <div
      className="pointer-events-none fixed z-[80] overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-xl animate-in fade-in-0 zoom-in-95"
      style={{ left, top, transform: above ? "translateY(-100%)" : undefined }}
    >
      <img src={src} alt="截图预览" className="block rounded-md object-contain" style={{ maxWidth: PREVIEW_MAX_W, maxHeight: PREVIEW_MAX_H }} />
    </div>,
    document.body,
  );
}

/** 单张缩略图：悬停放大、点击看大图 */
export function ScreenshotThumb({ src, group, className = "" }: { src: string; group: string[]; className?: string }) {
  const open = useContext(ImagePreviewContext);
  const ref = useRef<HTMLSpanElement>(null);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const onClick = (e: MouseEvent | KeyboardEvent) => {
    // 缩略图常在可点击的折叠行里：别让点击顺带展开 / 收起那一行
    e.stopPropagation();
    setHoverRect(null);
    const list = group.length ? group : [src];
    open(list, Math.max(0, list.indexOf(src)));
  };
  return (
    <>
      {/* span 而不是 button：缩略图常放在折叠行这种本身就是按钮的元素里，button 不能嵌套 */}
      <span
        ref={ref}
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(e); } }}
        onMouseEnter={() => ref.current && setHoverRect(ref.current.getBoundingClientRect())}
        onMouseLeave={() => setHoverRect(null)}
        aria-label="查看截图"
        className={`relative block h-5 w-8 shrink-0 cursor-zoom-in overflow-hidden rounded-[4px] border border-border bg-muted/40 transition-transform hover:z-10 hover:scale-110 hover:border-foreground/30 ${className}`}
      >
        <img src={src} alt="" className="h-full w-full object-cover object-top" draggable={false} />
      </span>
      {hoverRect && <HoverPreview src={src} anchor={hoverRect} />}
    </>
  );
}

/** 一排缩略图（折叠行用）：最多显示 max 张，叠在一起，多出来的显示「+N」 */
export function ScreenshotStrip({ images, max = 3 }: { images: string[]; max?: number }) {
  const open = useContext(ImagePreviewContext);
  if (images.length === 0) return null;
  const shown = images.slice(-max); // 显示最近的几张
  const more = images.length - shown.length;
  return (
    <span className="flex shrink-0 items-center">
      {shown.map((src, i) => (
        <ScreenshotThumb key={`${i}-${src.length}`} src={src} group={images} className={i > 0 ? "-ml-2.5 ring-1 ring-background" : ""} />
      ))}
      {more > 0 && (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); open(images, 0); }}
          className="ml-1 cursor-pointer rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground hover:text-foreground"
          aria-label={`还有 ${more} 张截图`}
        >
          +{more}
        </span>
      )}
    </span>
  );
}
