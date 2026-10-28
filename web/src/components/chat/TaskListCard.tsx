/**
 * update_tasks 的渲染：一张勾选清单卡片。
 *
 * 每次调用都渲染「这一刻的完整清单」，所以对话往下读就能看到进度一步步推进
 * （清单本身就是调用参数，历史恢复时同样能画出来，不需要额外的事件或存储）。
 *
 * 三种状态的图标刻意区分形状而不只是颜色：完成 = 实心对勾，进行中 = 实线圆圈，未开始 = 虚线圆圈。
 */

import { Loader2, X } from "lucide-react";
import type { ToolCallData } from "@/components/ToolCallItem";

type TaskStatus = "pending" | "in_progress" | "completed";
interface TaskItem { title: string; status: TaskStatus }

/** 与后端 parseTaskArgs 同样宽松：status 认几种常见写法，title 认 content / subject 别名 */
function readTasks(args: Record<string, unknown> | undefined): TaskItem[] {
  let raw = args?.tasks;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  const out: TaskItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const title = String(obj.title ?? obj.content ?? obj.subject ?? "").trim();
    if (!title) continue;
    const s = String(obj.status ?? "pending").toLowerCase().replace(/[\s-]/g, "_");
    const status: TaskStatus = s === "completed" || s === "done" || s === "complete" ? "completed"
      : s === "in_progress" || s === "doing" || s === "active" || s === "running" ? "in_progress" : "pending";
    out.push({ title, status });
  }
  return out;
}

function StatusIcon({ status }: { status: TaskStatus }) {
  const common = "w-4 h-4 shrink-0 mt-px";
  if (status === "completed") {
    return (
      <svg viewBox="0 0 16 16" className={`${common} text-muted-foreground`} aria-label="已完成">
        <circle cx="8" cy="8" r="7" fill="currentColor" />
        <path d="M4.8 8.2l2.1 2.1 4.3-4.5" fill="none" stroke="var(--background)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "in_progress") {
    return (
      <svg viewBox="0 0 16 16" className={`${common} text-foreground`} aria-label="进行中">
        <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" className={`${common} text-muted-foreground/70`} aria-label="未开始">
      <circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.2 2" />
    </svg>
  );
}

export function TaskListCard({ tool }: { tool: ToolCallData }) {
  const tasks = readTasks(tool.args);

  // 参数还在流式生成：先占一行，参数到了再换成清单
  if (tasks.length === 0) {
    const failed = tool.status === "error";
    return (
      <div className="my-0.5 flex items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground/60">
        {failed ? <X className="w-3.5 h-3.5 text-red-500" /> : <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        <span>{failed ? "任务清单更新失败" : "正在更新任务清单…"}</span>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-xl border border-border bg-background px-3.5 py-2.5" role="list" aria-label="任务清单">
      {tasks.map((task, index) => (
        <div key={`${index}-${task.title}`} role="listitem" className="flex items-start gap-2.5 py-1 text-[13px] leading-5">
          <StatusIcon status={task.status} />
          <span className={task.status === "completed" ? "text-muted-foreground" : "text-foreground"}>{task.title}</span>
        </div>
      ))}
    </div>
  );
}
