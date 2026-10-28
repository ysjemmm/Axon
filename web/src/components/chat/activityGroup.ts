/**
 * 活动折叠组 —— 把「两段正文之间连续的工具 / 思考行」收进一个大折叠行。
 *
 * 一轮 agent 循环里常常是「思考 → 搜索 → 思考 → 读文件 → 思考 → 跑命令……」交替十几行，
 * 平铺出来正文被淹没。这里按段切出这样的连续区间，渲染层（renderSegments）把它们包进
 * ActivityGroup：外层一行标题（模型生成的一句话 summary，没有时显示统计），点开才是明细。
 *
 * ── 与后端分组规则必须一致（packages/core/src/session/toolGroupSummary.ts）──
 * 后端按同样的规则逐轮追踪分组、生成 summary，并按组内第一个工具调用 id 回推。
 * 规则对不上时最坏只是 summary 挂不上（标题退回统计），因为这里在整组里查找 summary。
 */

import type { Segment, ToolSegment } from "./types";
import { BROWSER_TOOL_NAMES } from "@/components/ToolCallItem";

/** 至少这么多个工具调用才包成折叠组（与后端 MIN_GROUP_TOOLS 一致） */
export const MIN_GROUP_TOOLS = 2;

/**
 * 不收进折叠组的工具（与后端 UNGROUPED_TOOLS 一致）：编辑要确认 / 撤销，产物和图片是交付物，
 * ask_user / ask_form 等用户作答，Skill / Power / Relay 有自己的卡片——必须留在外面让用户看见。
 */
const UNGROUPED_TOOLS = new Set([
  "str_replace", "create_file", "apply_patch",
  "create_artifact", "edit_artifact", "render_media", "generate_image", "report_outputs",
  "ask_user", "ask_form",
  "use_skill", "activate_power", "update_memory",
  "delegate_task",
]);

export function isGroupableTool(name: string): boolean {
  return !UNGROUPED_TOOLS.has(name) && !name.startsWith("relay_");
}

function isGroupable(seg: Segment): boolean {
  if (seg.type === "reasoning") return true;
  return seg.type === "tool" && isGroupableTool(seg.name);
}

export interface ActivityRun {
  /** 起始下标（含） */
  start: number;
  /** 结束下标（不含） */
  end: number;
}

/**
 * 找出可以包成折叠组的连续区间。
 * 输入必须是 renderSegments 已过滤过的段（hidden 工具、弱内容正文、空思考已剔除），
 * 否则这些不渲染的段会把区间切碎。
 */
export function findActivityRuns(segments: readonly Segment[]): ActivityRun[] {
  const runs: ActivityRun[] = [];
  let i = 0;
  while (i < segments.length) {
    if (!isGroupable(segments[i])) {
      i++;
      continue;
    }
    const start = i;
    let tools = 0;
    while (i < segments.length && isGroupable(segments[i])) {
      if (segments[i].type === "tool") tools++;
      i++;
    }
    if (tools >= MIN_GROUP_TOOLS) runs.push({ start, end: i });
  }
  return runs;
}

/** 组内的统计文案：「读取 5 个文件 · 搜索 3 次 · 执行 2 条命令」 */
export function summarizeRunStats(tools: readonly ToolSegment[]): string {
  const files = new Set<string>();
  let reads = 0;
  let searches = 0;
  let commands = 0;
  let webSearches = 0;
  let webFetches = 0;
  let browser = 0;
  let others = 0;
  for (const t of tools) {
    switch (t.name) {
      case "read_file": {
        reads++;
        const p = typeof t.args?.path === "string" ? (t.args.path as string) : "";
        if (p) files.add(p);
        break;
      }
      case "search":
      case "list_dir":
        searches++;
        break;
      case "execute_command":
      case "start_process":
        commands++;
        break;
      case "web_search":
        webSearches++;
        break;
      case "web_fetch":
        webFetches++;
        break;
      default:
        if (BROWSER_TOOL_NAMES.has(t.name)) browser++;
        else others++;
    }
  }
  const parts: string[] = [];
  if (reads) parts.push(`读取 ${files.size || reads} 个文件`);
  if (searches) parts.push(`搜索 ${searches} 次`);
  if (commands) parts.push(`执行 ${commands} 条命令`);
  if (webSearches) parts.push(`联网搜索 ${webSearches} 次`);
  if (webFetches) parts.push(`打开 ${webFetches} 个网页`);
  if (browser) parts.push(`浏览器操作 ${browser} 次`);
  if (others) parts.push(`其他工具 ${others} 次`);
  return parts.join(" · ");
}
