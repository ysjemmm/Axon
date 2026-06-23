/**
 * 纯函数工具：从 useChatSession 提取的无状态辅助函数。
 */

import type { AttachedFile, ChatMessage, TextSegment, ToolSegment, UserSegment } from "./types";
import type { ToolStatus } from "@/components/ToolCallItem";
import { formatToolDescription, fallbackIntent, formatLineSuffix } from "@/components/ToolCallItem";
import { isRelayTool, relayToolLabel, firstLine } from "./relayUtils";

/** 取一个工具段的编辑单元列表 {path, editId}（editId 由后端随 diff 下发，前端不推导） */
export function segEditUnits(seg: { diff?: { path: string; editId?: string }; diffs?: { path: string; editId?: string }[] }): { path: string; editId?: string }[] {
  const units: { path: string; editId?: string }[] = [];
  if (seg.diff?.path) units.push({ path: seg.diff.path, editId: seg.diff.editId });
  if (seg.diffs) for (const d of seg.diffs) if (d.path) units.push({ path: d.path, editId: d.editId });
  return units;
}

/** 这些工具的结果文本要作为卡片下层"输出"展示（后台进程 / 浏览器类）。execute_command 单独处理。 */
export const OUTPUT_TOOLS = new Set([
  "start_process", "get_process_output", "get_browser_logs", "get_browser_network",
  "get_browser_storage", "browser_eval", "browser_get_html", "open_browser",
]);

/** 工具名 → 底部状态指示器文案（后端 status 事件可能滞后/缺失时按工具名兜底） */
export function toolPhaseText(name: string): string {
  switch (name) {
    case "read_file": return "正在读取文件...";
    case "create_file": return "正在创建文件...";
    case "str_replace": return "正在编辑文件...";
    case "apply_patch": return "正在应用补丁...";
    case "execute_command": return "正在执行命令...";
    case "search": return "正在搜索...";
    case "list_dir": return "正在浏览目录...";
    case "check_diagnostics": return "正在检查语法...";
    case "web_search": return "正在联网搜索...";
    case "web_fetch": return "正在抓取网页...";
    default: return name.startsWith("mcp__") ? "正在调用工具..." : "处理中...";
  }
}

/** 从 path 提取 basename */
export function extractBasename(p: unknown): string | null {
  return typeof p === "string" && p ? (p.split("/").pop()?.split("\\").pop() || null) : null;
}

export {
  formatToolDescription,
  fallbackIntent,
  formatLineSuffix,
  isRelayTool,
  relayToolLabel,
  firstLine,
};

export type {
  ToolStatus,
};

export type {
  AttachedFile,
  ChatMessage,
  TextSegment,
  ToolSegment,
  UserSegment,
};
