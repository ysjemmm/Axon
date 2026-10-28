/**
 * ActivityGroup —— 连续工具 / 思考行的大折叠行（分组规则见 activityGroup.ts）。
 *
 * 标题优先级：模型生成的一句话 summary > 进行中时的当前动作 > 统计。
 * 统计常驻右侧（标题本身就是统计时不重复）。
 *
 * 展开规则：
 * · 默认收起。进行中也收起——标题实时显示当前动作，用户想看明细自己点开。
 * · 组内有命令在等审批 / 等输入时强制展开：审批按钮内联在命令卡片下方，收起就点不到了。
 * · 内容用 grid 0fr/1fr 折叠而不是卸载：明细里的卡片各自有展开状态，卸载会全部丢失。
 */

import { useContext, useState, type ReactNode } from "react";
import { ChevronRight, Layers, Loader2 } from "lucide-react";
import { isToolInFlight } from "@/components/ToolCallItem";
import { CommandApprovalContext } from "./commandApprovalContext";
// 带 Rules 后缀：同目录的 ActivityGroup.tsx 与它只差大小写，大小写不敏感的文件系统会认错文件
import { summarizeRunStats } from "./activityGroupRules";
import type { ToolSegment } from "./types";

export function ActivityGroup({ tools, live, children }: {
  /** 组内的工具段（用于统计、summary、审批检测） */
  tools: ToolSegment[];
  /** 这一组是否还在进行（所在消息流式中，且是最后一个节点） */
  live: boolean;
  /** 明细：renderSegments 照常渲染出的节点 */
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const { approvals, waitingInputIds } = useContext(CommandApprovalContext);

  const needsUser = tools.some((t) => approvals[t.id] || waitingInputIds.has(t.id));
  const open = expanded || needsUser;

  const inFlight = tools.some((t) => isToolInFlight(t.status));
  const failed = tools.filter((t) => t.status === "error").length;
  const summary = tools.find((t) => t.groupSummary)?.groupSummary;
  const stats = summarizeRunStats(tools);
  const current = live && inFlight
    ? [...tools].reverse().find((t) => isToolInFlight(t.status))?.description
    : undefined;
  const title = summary || current || stats;

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={open}
        className={`group/activity flex w-full items-center gap-1.5 py-0.5 text-left text-xs min-w-0 cursor-pointer transition-colors ${
          open ? "text-muted-foreground" : "text-muted-foreground/80"
        } hover:text-foreground`}
      >
        {live && inFlight
          ? <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin opacity-70" />
          : <Layers className="w-3.5 h-3.5 shrink-0 opacity-70" />}
        <span className="min-w-0 truncate">{title}</span>
        {title !== stats && stats && (
          <>
            <span className="shrink-0 opacity-40">·</span>
            <span className="shrink min-w-0 truncate text-[11px] opacity-60">{stats}</span>
          </>
        )}
        {failed > 0 && (
          <span className="shrink-0 text-[11px] text-destructive">{failed} 次失败</span>
        )}
        <ChevronRight
          className={`w-3.5 h-3.5 shrink-0 opacity-50 transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
        />
      </button>
      <div
        className="grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
        aria-hidden={!open}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="ml-[7px] mt-0.5 pl-3 border-l border-border">{children}</div>
        </div>
      </div>
    </div>
  );
}
