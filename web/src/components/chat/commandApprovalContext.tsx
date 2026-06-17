/**
 * 命令审批 Context —— 把"未信任命令的内联审批"状态从会话层透传到对话流里的命令卡片。
 *
 * 设计：审批不再用独立模态弹窗，而是内联在 execute_command 卡片下方（Reject / 信任 / 运行）。
 * 为避免一路 prop drilling（ChatPanel → MessageBubble → AssistantTurn → renderSegments → ToolCallItem），
 * 用 Context 把"按 toolCallId 索引的待审批项 + 决策回调"下发，ToolCallItem 直接消费。
 */

import { createContext, useContext } from "react";

/** 三档信任建议（来自后端 buildTrustOptions） */
export interface CommandTrustOption {
  choice: "exact" | "prefix" | "all";
  pattern: string;
  label: string;
}

/** 用户对一次命令授权的决策（once=仅本次运行，reject=拒绝，其余=加入白名单） */
export type CommandDecision = { choice: "exact" | "prefix" | "all" | "once" | "reject"; pattern?: string; target?: "user" | "workspace"; editedCommand?: string };

/** 一条待审批命令（按 toolCallId 索引） */
export interface CommandApprovalEntry {
  requestId: string;
  command: string;
  options: CommandTrustOption[];
}

interface CommandApprovalCtxValue {
  /** 按触发命令的 toolCallId 索引的待审批项 */
  approvals: Record<string, CommandApprovalEntry>;
  /** 对某个工具调用作出审批决策 */
  onApprove: (toolCallId: string, decision: CommandDecision) => void;
}

export const CommandApprovalContext = createContext<CommandApprovalCtxValue>({
  approvals: {},
  onApprove: () => { /* 默认空实现 */ },
});

/**
 * 在工具卡片里读取本次工具调用的待审批项。
 * @returns 有待审批则返回 { options, approve }，否则 null。
 */
export function useCommandApproval(toolCallId: string): { options: CommandTrustOption[]; approve: (d: CommandDecision) => void } | null {
  const ctx = useContext(CommandApprovalContext);
  const entry = toolCallId ? ctx.approvals[toolCallId] : undefined;
  if (!entry) {
    return null;
  }
  return {
    options: entry.options,
    approve: (decision) => ctx.onApprove(toolCallId, decision),
  };
}
