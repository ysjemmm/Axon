/**
 * ArtifactCard —— AI 交付的产物卡片
 *
 * 为什么要单独一张卡片，而不是沿用普通工具卡片：工具卡片讲的是「AI 做了一个动作」，
 * 产物是「AI 交给你一样东西」。用户要的是一眼看出这是什么、点一下就能看到它，
 * 而不是读一行「已调用 create_artifact」。
 *
 * ── 排版取舍（改之前先读）──
 * 参照 Claude 的产物卡：左侧一个固定的图标方块作视觉锚点，中间标题 + 一行元信息，
 * 右侧一个「打开」按钮。三者的层级靠字号和明度拉开，不靠边框和底色堆叠——
 * 卡片本身已经在一个边框里，内部再画分隔线只会显得碎。
 *
 * 四种状态（判定见 artifactMeta.resolveArtifactCardState）：
 *   生成中 → 骨架态，标题先出来，让用户知道在做什么
 *   已就绪 → 整卡可点，右侧显示「打开」
 *   失败   → 说明原因，不留一张点不开的卡
 *   缺失   → 成功却没有产物数据（旧数据 / 异常），如实说明，不画假卡片
 */

import { AlertCircle, FileCode2, FileText, Globe, Image as ImageIcon, Loader2, FileType2 } from "lucide-react";
import type { ToolSegment, ArtifactType } from "./types";
import { canPreviewFiles, requestFilePreview } from "./filePreview";
import { formatFileSize } from "./format";
import {
  artifactSubtitle,
  artifactTypeLabel,
  pendingArtifactTitle,
  resolveArtifactCardState,
} from "./artifactMeta";

/** 各类型的图标。选的是「内容是什么」而不是「文件扩展名」 */
function TypeIcon({ type, className }: { type: ArtifactType; className?: string }) {
  switch (type) {
    case "html": return <Globe className={className} />;
    case "svg": return <ImageIcon className={className} />;
    case "markdown": return <FileText className={className} />;
    case "code": return <FileCode2 className={className} />;
    default: return <FileType2 className={className} />;
  }
}

/** 卡片外形：宽度收在 420px，太宽会让「标题—按钮」之间的空隙显得空 */
const CARD_BASE = "my-2 flex w-full max-w-[420px] items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors";
/** 左侧图标方块：固定尺寸，是整张卡的视觉锚点 */
const ICON_BOX = "flex size-11 shrink-0 items-center justify-center rounded-lg";

export function ArtifactCard({ seg }: { seg: ToolSegment }) {
  const state = resolveArtifactCardState(seg);
  const artifact = seg.artifact;

  if (state === "generating") {
    return (
      <div className={`${CARD_BASE} border-border/70 bg-muted/20`} aria-busy="true">
        <div className={`${ICON_BOX} bg-muted`}>
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-foreground">{pendingArtifactTitle(seg.args)}</div>
          <div className="mt-0.5 text-[12px] text-muted-foreground">正在生成产物…</div>
        </div>
      </div>
    );
  }

  if (state === "failed" || state === "missing" || !artifact) {
    return (
      <div className={`${CARD_BASE} border-destructive/30 bg-destructive/5`} role="status">
        <div className={`${ICON_BOX} bg-destructive/10`}>
          <AlertCircle className="size-4 text-destructive" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium text-foreground">{pendingArtifactTitle(seg.args)}</div>
          <div className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">
            {state === "failed"
              ? (seg.userMessage || seg.description || "产物未能生成")
              : "产物信息缺失，无法预览"}
          </div>
        </div>
      </div>
    );
  }

  // 浏览器形态没有宿主可以读盘，此时不做成可点（避免点了没反应）
  const clickable = canPreviewFiles();
  const typeLabel = artifactTypeLabel(artifact.type, artifact.language);
  const meta = `产物 · ${artifactSubtitle(artifact, formatFileSize)}`;

  const body = (
    <>
      <div className={`${ICON_BOX} bg-primary/[0.08] text-primary`}>
        <TypeIcon type={artifact.type} className="size-[18px]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium leading-5 text-foreground" title={artifact.title}>
          {artifact.title}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[12px] leading-4 text-muted-foreground">
          <span className="truncate">{meta}</span>
          <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] font-semibold tracking-wide">
            {typeLabel}
          </span>
        </div>
      </div>
      {/* 右侧按钮只是视觉锚，真正的点击目标是整张卡（button 里不能再嵌 button） */}
      <span
        aria-hidden="true"
        className={`shrink-0 rounded-md border px-2.5 py-1 text-[12px] font-medium ${
          clickable
            ? "border-border text-foreground/80 group-hover/artifact:border-foreground/40 group-hover/artifact:text-foreground"
            : "border-border/60 text-muted-foreground/60"
        }`}
      >
        打开
      </span>
    </>
  );

  if (!clickable) {
    return (
      <div className={`${CARD_BASE} border-border/70 bg-background`} title={artifact.path}>
        {body}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => requestFilePreview(artifact.path)}
      className={`${CARD_BASE} group/artifact cursor-pointer border-border/70 bg-background hover:border-foreground/25 hover:bg-muted/30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}
      title={`预览 ${artifact.path}`}
      aria-label={`预览产物：${artifact.title}`}
    >
      {body}
    </button>
  );
}
