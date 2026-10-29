/**
 * 后台任务完成提醒：右下角卡片，最多三张。显示结果摘要，点「查看」打开那条会话。
 * 不自动消失——后台任务一跑就是几十分钟，用户回来时提醒还得在。
 */

import { CheckCircle2, CircleStop, X, XCircle } from "lucide-react";
import { agentTaskName, type AgentTask } from "@/lib/agentTasks";

export function AgentTaskToasts({ tasks, onOpen, onDismiss }: { tasks: AgentTask[]; onOpen: (task: AgentTask) => void; onDismiss: (task: AgentTask) => void }) {
  if (tasks.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-[min(340px,calc(100vw-32px))] flex-col gap-2">
      {tasks.map((task) => {
        const Icon = task.status === "done" ? CheckCircle2 : task.status === "failed" ? XCircle : CircleStop;
        const tone = task.status === "done" ? "text-emerald-600 dark:text-emerald-400" : task.status === "failed" ? "text-red-600 dark:text-red-400" : "text-muted-foreground";
        const label = task.status === "done" ? "后台任务完成" : task.status === "failed" ? "后台任务出错" : "后台任务已停止";
        return (
          <div key={task.id} role="status" className="pointer-events-auto rounded-xl border border-border bg-background p-3 shadow-xl">
            <div className="flex items-start gap-2.5">
              <Icon className={`mt-0.5 size-4 shrink-0 ${tone}`} />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-muted-foreground">{label}</div>
                <div className="truncate text-[13px] font-medium text-foreground" title={agentTaskName(task)}>{agentTaskName(task)}</div>
                {task.summary && <p className="mt-1 line-clamp-3 text-[12px] leading-relaxed text-foreground/75">{task.summary}</p>}
                <div className="mt-2 flex gap-2">
                  <button onClick={() => onOpen(task)} className="rounded-md bg-primary px-2.5 py-1 text-[12px] font-medium text-primary-foreground hover:opacity-90">查看</button>
                  <button onClick={() => onDismiss(task)} className="rounded-md px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-muted/60 hover:text-foreground">知道了</button>
                </div>
              </div>
              <button onClick={() => onDismiss(task)} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground" aria-label="关闭">
                <X className="size-3.5" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
