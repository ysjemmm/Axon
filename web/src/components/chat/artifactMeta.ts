/**
 * artifactMeta —— 产物卡片的展示规则（纯函数，无 React 依赖）
 *
 * 卡片有四种状态，判定集中在这里，组件只负责按状态画：
 *   - generating：模型还在写（工具调用参数在流式生成，或已排队未执行）
 *   - failed：工具执行失败（入参不合法 / 写盘失败），没有 artifact 可展示
 *   - ready：已落盘，有 artifact，可以预览
 *   - missing：工具标记成功却没带 artifact（旧版本数据或异常）——不能画一张点不开的假卡片
 */

import { isToolInFlight } from "@/components/ToolCallItem";
import type { ArtifactInfo, ArtifactType, ToolSegment } from "./types";

export type ArtifactCardState = "generating" | "failed" | "ready" | "missing";

export function resolveArtifactCardState(seg: Pick<ToolSegment, "status" | "artifact">): ArtifactCardState {
  if (seg.artifact) return "ready";
  // 直接用 ToolCallItem 的判定，不另抄一份状态集合——两边词表一旦漂移，卡片会卡在「生成中」
  if (isToolInFlight(seg.status)) return "generating";
  if (seg.status === "error" || seg.status === "cancelled") return "failed";
  return "missing";
}

/** 类型 → 卡片角标文字 */
const TYPE_LABEL: Record<ArtifactType, string> = {
  html: "网页",
  svg: "SVG",
  markdown: "文档",
  code: "代码",
  text: "文本",
  gif: "GIF",
  mp4: "视频",
};

export function artifactTypeLabel(type: ArtifactType, language?: string): string {
  if (type === "code" && language) return language.toUpperCase().slice(0, 8);
  return TYPE_LABEL[type] ?? "文件";
}

/**
 * 能不能在浏览器里直接打开。html / svg 浏览器原生就能渲染；
 * markdown / 代码 / 文本在浏览器里只会显示源码，没有「浏览器预览」的意义，不提供入口。
 */
export function canOpenInBrowser(type: ArtifactType): boolean {
  return type === "html" || type === "svg";
}

/** 卡片副标题：「版本 · 大小」，首版不显示版本号 */
export function artifactSubtitle(artifact: Pick<ArtifactInfo, "size" | "version">, formatSize: (n: number) => string): string {
  const parts: string[] = [];
  if (artifact.version > 1) parts.push(`第 ${artifact.version} 版`);
  parts.push(formatSize(artifact.size));
  return parts.join(" · ");
}

function fileNameOf(path: unknown): string {
  return typeof path === "string" ? path.split("/").pop()?.split("\\").pop() || path : "";
}

/** 从调用参数里取标题：生成中还没有 artifact 时，用它先把标题显示出来（edit_artifact 没有标题，用文件名） */
export function pendingArtifactTitle(args: Record<string, unknown> | undefined): string {
  const title = typeof args?.title === "string" ? args.title.trim() : "";
  return title || fileNameOf(args?.path) || "产物";
}

/** 生成中的提示语：渲染动画要几十秒，要和"写文档"的提示区分开，否则用户以为卡住了 */
export function pendingArtifactHint(toolName: string): string {
  if (toolName === "render_media") return "正在渲染动画，可能需要一会儿…";
  return toolName === "edit_artifact" ? "正在修改产物…" : "正在生成产物…";
}

/** 产物 / 技能资料读取工具的卡片文案；不是这两个工具返回 null */
export function artifactReadDescription(toolName: string, args: Record<string, unknown> | undefined): string | null {
  const name = fileNameOf(args?.path);
  if (toolName === "read_artifact") return name ? `已读取产物 ${name}` : "已列出产物";
  if (toolName === "read_skill_file") return name ? `已读取技能资料 ${name}` : "已读取技能资料";
  return null;
}
