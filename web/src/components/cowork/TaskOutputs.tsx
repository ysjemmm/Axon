/**
 * TaskOutputs —— 任务产出文件的可点开行
 *
 * 为什么要有这个：Agent 做完事会在回复正文里写一句"结果已保存到 C:\out\汇总.xlsx"，
 * 但那只是一段文字 —— 用户还得自己去资源管理器里翻。办公场景里"做好的东西在哪、
 * 能不能马上看一眼"就是任务的终点，所以把产出单独提出来做成可点开的行。
 *
 * 点击走和附件卡片同一套预览（workbench 层的原生浮层，支持 XLSX/DOCX/PDF/图片等），
 * 不另造一套。
 */

import { FileText } from "lucide-react";
import { canPreviewFiles, requestFilePreview } from "@/components/chat/filePreview";
import { attachmentTypeLabel } from "@/components/chat/attachmentType";
import type { OutputFile } from "./restoreOutputs";

interface TaskOutputsProps {
  /** 文件的绝对路径列表。某一项为空串表示「只知道文件名、没有路径」（老会话） */
  paths?: string[];
  /** AI 登记且经磁盘校验的产出；不用于用户上传附件 */
  files?: OutputFile[];
  /**
   * 文件名兜底（与 paths 一一对应）。
   * 本次修复之前存下的会话只有文件名没有路径，此时仍要把名字显示出来 ——
   * 显示一个不可点的卡片，比什么都不显示好。
   */
  fallbackNames?: string[];
  /**
   * 放在用户气泡内部时传 true。
   *
   * 气泡本身是 muted 底色，卡片再用 bg-background + border-border 会糊成一片
   * （同色系叠同色系）。此时改用半透明白底 + 更淡的边，才能从气泡里"浮"出来。
   */
  onBubble?: boolean;
}

function baseName(rawPath: string): string {
  return rawPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() || rawPath;
}

/** 请求查看 AI 对某文件的改动（原稿 vs 现文件对比，由宿主渲染） */
function requestCoworkChanges(path: string, snapshotDir: string): void {
  (window as unknown as { __axonVSCode?: { postMessage: (m: unknown) => void } })
    .__axonVSCode?.postMessage({ type: "cowork_get_changes", path, snapshotDir });
}

export function TaskOutputs({ paths = [], files, fallbackNames, onBubble = false }: TaskOutputsProps) {
  // 两个来源取较长的那个：路径缺失时靠 fallbackNames 撑出条目数
  const count = Math.max(paths.length, files?.length || 0, fallbackNames?.length || 0);
  if (count === 0) return null;
  // 浏览器形态没有宿主可以读盘，做成可点就是点了没反应，此时降级为纯展示
  const hostCanPreview = canPreviewFiles();

  return (
    <div className="flex flex-wrap gap-1.5">
      {Array.from({ length: count }, (_, i) => {
        const path = files?.[i]?.path || paths[i] || "";
        const kind = files?.[i]?.kind;
        const snapshotDir = files?.[i]?.snapshotDir;
        const name = path ? baseName(path) : (fallbackNames?.[i] || "");
        if (!name) return null;
        // 没有路径就点不了（老会话）：给个不可点的卡片而不是假的可点卡片
        const clickable = hostCanPreview && !!path;
        return (
          <button
            key={path || `name-${i}-${name}`}
            type="button"
            disabled={!clickable}
            onClick={clickable ? () => requestFilePreview(path) : undefined}
            title={clickable ? `预览 ${path}` : name}
            // 仅 AI 明确声明的类型着色；用户附件和未标类型的旧产出保持中性。
            className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px] text-foreground transition-colors disabled:cursor-default ${
              onBubble
                ? "axon-bubble-chip"
                : kind === "created" ? "axon-output-chip axon-output-chip--created"
                  : kind === "edited" ? "axon-output-chip axon-output-chip--edited"
                    : "axon-output-chip axon-output-chip--unknown"
            }`}
          >
            <FileText className={`h-3.5 w-3.5 shrink-0 ${onBubble ? "text-muted-foreground" : ""}`} />
            <span className="truncate">{name}</span>
            {kind === "edited" && snapshotDir && (
              <span
                role="button"
                tabIndex={0}
                className="ml-1 shrink-0 rounded px-1 text-[10px] font-medium text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
                title="查看 AI 改了什么（原稿对比）"
                onClick={(e) => {
                  e.stopPropagation();
                  requestCoworkChanges(path, snapshotDir);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.stopPropagation();
                    requestCoworkChanges(path, snapshotDir);
                  }
                }}
              >
                查看改动
              </span>
            )}
            <span
              className={`shrink-0 rounded px-1 py-px text-[10px] font-semibold uppercase leading-4 tracking-wide ${
                onBubble ? "text-muted-foreground" : "axon-output-chip-badge"
              }`}
              style={onBubble ? { background: "color-mix(in oklab, var(--foreground) 9%, transparent)" } : undefined}
            >
              {attachmentTypeLabel({ name, kind: "file" })}
            </span>
          </button>
        );
      })}
    </div>
  );
}
