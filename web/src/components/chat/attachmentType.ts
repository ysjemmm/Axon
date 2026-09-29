import type { AttachedFile } from "./types";

/** data URL → 简短图片类型标签 */
export function imageTypeLabel(src: string): string {
  const mime = /^data:image\/([^;,]+)/i.exec(src)?.[1]?.toLowerCase();
  if (!mime) return "IMG";
  if (mime === "jpeg") return "JPG";
  if (mime === "svg+xml") return "SVG";
  return mime.toUpperCase().slice(0, 5);
}

/** 文件/上下文 → 简短类型标签 */
export function attachmentTypeLabel(file: Pick<AttachedFile, "name" | "kind">): string {
  switch (file.kind) {
    case "folder": return "文件夹";
    case "terminal": return "终端";
    case "editor": return "代码";
    case "diagnostics": return "诊断";
  }
  const clean = file.name.split(/[?#]/)[0];
  const ext = /\.([a-z0-9]{1,8})$/i.exec(clean)?.[1];
  return ext ? ext.toUpperCase() : "文件";
}

/** 柔和的左下角类型徽标：覆盖在缩略图上时仍清晰，但不抢内容。 */
export const ATTACHMENT_BADGE_CLASS =
  "absolute bottom-2 left-2 rounded-md border border-border/70 bg-background/90 px-1.5 py-0.5 " +
  "text-[11px] font-semibold leading-4 text-foreground shadow-sm backdrop-blur-sm";
