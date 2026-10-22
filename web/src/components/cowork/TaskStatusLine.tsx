/**
 * TaskStatusLine —— Cowork 任务的进展状态行
 *
 * 替代原来那句光秃秃的「思考中…」。一行里给三段信息，各自回答一个问题：
 *   意图（这一轮要干什么）· 阶段（现在在做什么）· 耗时（跑了多久）
 *
 * 为什么耗时要单独做成组件：它每秒都在变，而任务卡片里还挂着流式累积的回复正文
 * （MarkdownRenderer 渲染开销不小）。把计时器放在这一层，秒级刷新只重渲染这一行，
 * 不会带着整条回复一起重算。
 *
 * 完成后状态行不再展示；取消和失败仍保留必要的反馈。
 */

import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { formatElapsed } from "./taskIntent";
import type { CoworkTask } from "./useCoworkSession";

/** 进行中任务的耗时刷新间隔。秒级精度，1s 足够且开销可忽略。 */
const TICK_MS = 1000;

interface TaskStatusLineProps {
  task: CoworkTask;
}

export function TaskStatusLine({ task }: TaskStatusLineProps) {
  const running = task.status === "running";

  // 进行中每秒推一次 now 触发重算；终态不启定时器。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    // 挂载时先对齐一次：从提交到这一行挂上来可能已经过了几百毫秒
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [running]);

  // startedAt 为 0 表示历史会话还原出来的卡片（没有真实计时），此时不显示耗时：
  // 编一个数字出来比不显示更糟。
  const elapsed = task.elapsedMs ?? (task.startedAt > 0 ? now - task.startedAt : 0);
  const showElapsed = task.startedAt > 0 || task.elapsedMs !== undefined;

  if (running) {
    return (
      <div className="flex items-center gap-1.5 px-1 text-[12px] text-muted-foreground">
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        <span key={task.phase} className="axon-status-fade min-w-0 truncate font-medium text-foreground/80">
          {task.phase || "思考中"}
        </span>
        {showElapsed && (
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/70">{formatElapsed(elapsed)}</span>
        )}
      </div>
    );
  }

  if (task.status === "cancelled") {
    return (
      <div className="flex items-center gap-1.5 px-1 text-[12px] text-muted-foreground">
        <X className="h-3 w-3 shrink-0" />
        <span>已停止</span>
        {showElapsed && elapsed > 0 && (
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground/70">{formatElapsed(elapsed)}</span>
        )}
      </div>
    );
  }

  // failed：错误原文可能很长（后端异常信息），整段展示而不截断，
  // 用户要靠它判断是文件格式问题还是模型/网络问题。
  return (
    <div className="flex items-start gap-1.5 px-1 text-[12px] text-destructive">
      <X className="mt-0.5 h-3 w-3 shrink-0" />
      <span className="min-w-0">{task.error || "处理失败了"}</span>
    </div>
  );
}
