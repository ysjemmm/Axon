/**
 * ImageViewer —— 通用图片查看器（输入框图片 / 历史消息图片共用）
 *
 * 受控组件：由 ChatPanel 持有 images + index，本组件只负责展示与交互。
 * 支持：上一张/下一张切换、放大缩小、旋转、拖动平移、复制、键盘快捷键。
 *
 * 快捷键：←/→ 切图，+/- 缩放，R 旋转，0 复位，Esc 关闭。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { ChevronLeft, ChevronRight, Copy, Download, RotateCcw, RotateCw, X, ZoomIn, ZoomOut } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const SCALE_STEP = 1.25;
const ROTATE_STEP = 90;

function imageExtension(src: string): string {
  const mime = /^data:image\/([^;,]+)/i.exec(src)?.[1]?.toLowerCase();
  if (mime === "jpeg") return "jpg";
  if (mime === "svg+xml") return "svg";
  return mime || "png";
}

export interface ImageViewerProps {
  open: boolean;
  images: string[];
  index: number;
  /** 切换图片（上一张/下一张）时回调，由父组件更新 index */
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

export function ImageViewer({ open, images, index, onIndexChange, onClose }: ImageViewerProps) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "ok" | "err">("idle");
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const total = images.length;
  const src = images[index];

  const resetTransform = useCallback(() => {
    setScale(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
  }, []);

  const zoomIn = useCallback(() => setScale((s) => Math.min(MAX_SCALE, s * SCALE_STEP)), []);
  const zoomOut = useCallback(() => setScale((s) => Math.max(MIN_SCALE, s / SCALE_STEP)), []);
  const rotateLeft = useCallback(() => setRotation((r) => r - ROTATE_STEP), []);
  const rotateRight = useCallback(() => setRotation((r) => r + ROTATE_STEP), []);

  const goPrev = useCallback(() => {
    if (total <= 1) return;
    onIndexChange((index - 1 + total) % total);
  }, [index, total, onIndexChange]);

  const goNext = useCallback(() => {
    if (total <= 1) return;
    onIndexChange((index + 1) % total);
  }, [index, total, onIndexChange]);

  // 打开 / 切换图片时复位缩放、旋转与位移
  useEffect(() => {
    resetTransform();
  }, [open, index, resetTransform]);

  // 键盘快捷键（Esc 关闭由 Dialog 负责）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          goPrev();
          break;
        case "ArrowRight":
          e.preventDefault();
          goNext();
          break;
        case "+":
        case "=":
          e.preventDefault();
          zoomIn();
          break;
        case "-":
        case "_":
          e.preventDefault();
          zoomOut();
          break;
        case "0":
          e.preventDefault();
          resetTransform();
          break;
        case "r":
        case "R":
          e.preventDefault();
          rotateRight();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, goPrev, goNext, zoomIn, zoomOut, rotateRight, resetTransform]);

  useEffect(
    () => () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const copyImage = async () => {
    if (!src) return;
    const setStatus = (v: "ok" | "err") => {
      setCopyStatus(v);
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopyStatus("idle"), 1800);
    };
    try {
      const res = await fetch(src);
      const blob = await res.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      setStatus("ok");
    } catch {
      // fetch 对 data URL 在个别环境会失败，回退到手动解析
      try {
        const parts = src.split(",");
        const mime = parts[0].match(/:(.*?);/)?.[1] || "image/png";
        const binary = atob(parts[1]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: mime });
        await navigator.clipboard.write([new ClipboardItem({ [mime]: blob })]);
        setStatus("ok");
      } catch (err) {
        setStatus("err");
        console.warn("[axon] 复制图片失败:", err);
      }
    }
  };

  const downloadImage = () => {
    if (!src) return;
    const anchor = document.createElement("a");
    anchor.href = src;
    anchor.download = `axon-image-${index + 1}.${imageExtension(src)}`;
    anchor.click();
  };

  const onWheel = (e: ReactWheelEvent) => {
    if (e.deltaY < 0) zoomIn();
    else zoomOut();
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (scale <= 1) return;
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    setDragging(true);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
  };

  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };

  const btn =
    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs bg-muted hover:bg-muted/80 text-foreground transition-colors data-[status=ok]:bg-foreground/10 data-[status=ok]:text-foreground data-[status=err]:bg-red-500/15 data-[status=err]:text-red-600 dark:data-[status=err]:text-red-400";
  const iconBtn =
    "flex items-center justify-center px-2.5 py-1.5 rounded-md text-xs bg-muted hover:bg-muted/80 text-foreground transition-colors";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        className="w-[min(88vw,1080px)] max-w-[92vw] sm:max-w-none p-0 gap-0 bg-background/95 border-border shadow-xl flex flex-col overflow-hidden"
        showCloseButton={false}
        // 没有描述性文案，显式置空避免 radix 在开发态输出 a11y 警告
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">图片预览</DialogTitle>
        {src && (
          <>
            {/* 顶部：计数 + 关闭 */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/60">
              <span className="text-xs text-muted-foreground tabular-nums">
                {index + 1} / {total}
              </span>
              <button
                onClick={onClose}
                className="flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                title="关闭（Esc）"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 图片舞台 */}
            <div
              className={`relative flex items-center justify-center overflow-hidden select-none ${
                scale > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-default"
              }`}
              style={{ height: "min(70vh, 720px)" }}
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onDoubleClick={resetTransform}
              onContextMenu={(event) => event.preventDefault()}
            >
              <img
                src={src}
                alt=""
                draggable={false}
                className="max-w-full max-h-full object-contain rounded-lg transition-transform duration-100"
                style={{
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale}) rotate(${rotation}deg)`,
                }}
              />

              {total > 1 && (
                <>
                  <button
                    onClick={goPrev}
                    className="absolute left-2 top-1/2 -translate-y-1/2 flex items-center justify-center w-8 h-8 rounded-full bg-background/80 border border-border shadow-sm text-foreground hover:bg-background transition-colors"
                    title="上一张（←）"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button
                    onClick={goNext}
                    className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center justify-center w-8 h-8 rounded-full bg-background/80 border border-border shadow-sm text-foreground hover:bg-background transition-colors"
                    title="下一张（→）"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </>
              )}
            </div>

            {/* 工具栏 */}
            <div className="flex flex-wrap items-center justify-center gap-2 px-3 py-2 border-t border-border/60">
              <button onClick={zoomOut} className={iconBtn} title="缩小（-）">
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <button onClick={resetTransform} className={btn} title="重置缩放与旋转（0）">
                {Math.round(scale * 100)}%
              </button>
              <button onClick={zoomIn} className={iconBtn} title="放大（+）">
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
              <button onClick={rotateLeft} className={iconBtn} title="向左旋转 90°">
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
              <button onClick={rotateRight} className={iconBtn} title="向右旋转 90°（R）">
                <RotateCw className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={copyImage}
                className={btn}
                data-status={copyStatus === "idle" ? undefined : copyStatus}
                title="复制图片到剪贴板"
              >
                <Copy className="w-3.5 h-3.5" />
                <span>{copyStatus === "ok" ? "已复制" : copyStatus === "err" ? "复制失败" : "复制图片"}</span>
              </button>
              <button onClick={downloadImage} className={btn} title="下载图片">
                <Download className="w-3.5 h-3.5" />
                <span>下载图片</span>
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
