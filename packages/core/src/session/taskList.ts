/**
 * 任务清单（update_tasks）：多步任务的轻量进度清单。
 *
 * 与 Relay 的分工：Relay 是重量级工作流（需求 / 设计 / 计划三份文档、确认门、子 Agent 执行、跨会话推进）；
 * 任务清单只是「这一轮要做的几步」，模型每完成一步就勾掉，用户在对话里实时看到进度。
 *
 * ── 为什么每次传完整清单，而不是 create / update 增量操作 ──
 * 增量操作要求模型记住每一项的 id 并且不出错；DeepSeek / Qwen 这类模型长任务中途很容易拿错 id、
 * 重复创建。整份替换没有这个问题，一份清单通常只有几十个 token。
 *
 * ── 清单存在哪 ──
 * 每次调用的参数本身就留在历史的 assistant 消息里（前端也据此渲染卡片），不另外落盘。
 * 会话在内存里保留最新一份；历史被压缩掉之后，由 PromptBuilder 把未完成的清单重新注入给模型。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TaskItem {
  title: string;
  status: TaskStatus;
}

export const UPDATE_TASKS_TOOL = "update_tasks";
const MAX_TASKS = 30;
const MAX_TITLE = 200;
const STATUSES: TaskStatus[] = ["pending", "in_progress", "completed"];

/** 宽松解析：status 认几种常见写法，标题去空白、截断；解析不出返回 error 给模型看 */
export function parseTaskArgs(args: Record<string, unknown>): { tasks?: TaskItem[]; error?: string } {
  let raw = args.tasks;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return { error: "tasks 必须是数组" }; }
  }
  if (!Array.isArray(raw)) return { error: "tasks 必须是数组，每项包含 title 与 status" };
  if (raw.length > MAX_TASKS) return { error: `任务最多 ${MAX_TASKS} 项，请合并成更粗粒度的步骤` };
  const tasks: TaskItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const title = String(obj.title ?? obj.content ?? obj.subject ?? "").trim().slice(0, MAX_TITLE);
    if (!title) continue;
    const s = String(obj.status ?? "pending").toLowerCase().replace(/[\s-]/g, "_");
    const status: TaskStatus = STATUSES.includes(s as TaskStatus)
      ? (s as TaskStatus)
      : s === "done" || s === "complete" ? "completed" : s === "doing" || s === "active" || s === "running" ? "in_progress" : "pending";
    tasks.push({ title, status });
  }
  if (tasks.length === 0) return { error: "tasks 为空：至少给出一项带 title 的任务；要清空清单请把所有任务标为 completed" };
  return { tasks };
}

/** 工具回执：一句话进度 + 下一步提示（不复述整份清单，模型刚刚自己写过） */
export function taskUpdateResult(tasks: TaskItem[]): string {
  const done = tasks.filter((t) => t.status === "completed").length;
  const active = tasks.filter((t) => t.status === "in_progress");
  const notes: string[] = [];
  if (active.length > 1) notes.push(`同时有 ${active.length} 项进行中，建议一次只推进一项`);
  if (done === tasks.length) return `任务清单已更新：${tasks.length} 项全部完成。`;
  const next = active[0] ?? tasks.find((t) => t.status === "pending");
  return `任务清单已更新：${done}/${tasks.length} 完成${next ? `，接下来：${next.title}` : ""}。${notes.length ? `（${notes.join("；")}）` : ""}`;
}

/** 从历史里找最后一次 update_tasks 调用的清单 */
export function latestTasksFromMessages(messages: ChatCompletionMessageParam[]): TaskItem[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const calls = (messages[i] as { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (let j = calls.length - 1; j >= 0; j--) {
      if (calls[j]?.function?.name !== UPDATE_TASKS_TOOL) continue;
      try {
        const parsed = parseTaskArgs(JSON.parse(calls[j].function?.arguments || "{}"));
        if (parsed.tasks) return parsed.tasks;
      } catch { /* 参数损坏：继续往前找 */ }
    }
  }
  return null;
}

/** 历史被压缩后重新注入的文案；全部完成时返回 null（不再提醒） */
export function formatTasksForModel(tasks: TaskItem[]): string | null {
  if (tasks.every((t) => t.status === "completed")) return null;
  const mark: Record<TaskStatus, string> = { completed: "[x]", in_progress: "[>]", pending: "[ ]" };
  return "【任务清单】你此前用 update_tasks 建立的清单（早先的对话已压缩，这是最新状态）。继续按它推进，进度变化时调用 update_tasks 更新：\n"
    + tasks.map((t) => `${mark[t.status]} ${t.title}`).join("\n");
}
