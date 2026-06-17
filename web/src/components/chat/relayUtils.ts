/**
 * Relay 工作流工具相关辅助
 * 从原 ChatPanel.tsx 拆出。
 */

/** Relay 工作流工具名集合（这些工具的"正经展示"在右侧 Relay 面板，对话流里只做精简提示） */
export const RELAY_TOOL_NAMES = new Set([
  "relay_create",
  "relay_save_doc",
  "relay_advance",
  "relay_update_task",
  "relay_review_task",
  "parallel_research",
]);

/** 是否为 Relay 工作流工具 */
export function isRelayTool(name: string): boolean {
  return RELAY_TOOL_NAMES.has(name);
}

/** Relay 工具的占位标签（拿不到真实结果文本时的兜底） */
export function relayToolLabel(name: string): string {
  switch (name) {
    case "relay_create": return "已创建 Relay 长任务";
    case "relay_save_doc": return "已更新阶段文档";
    case "relay_advance": return "已推进阶段";
    case "relay_update_task": return "已更新任务状态";
    case "relay_review_task": return "已完成两阶段评审";
    case "parallel_research": return "已完成并行调研";
    default: return "Relay 操作";
  }
}

/** 取文本首行（去掉 markdown 强调符号、截断到合理长度），用于卡片单行描述 */
export function firstLine(text: string): string {
  const line = (text || "").split("\n").find((l) => l.trim()) || "";
  return line.replace(/[*_`#]/g, "").trim().slice(0, 80);
}
