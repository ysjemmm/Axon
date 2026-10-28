/**
 * 一个 Cowork 会话里的任务列表。
 *
 * 结果优先：任务做完后先给「产出文件 + 核对」，说明文字放在后面，并且默认收起长说明——
 * 办公用户要的是那份表，以及能不能信它，过程是其次的。
 */

import { useState } from "react";
import { ChevronDown, Repeat2, Sparkles } from "lucide-react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { CheckList } from "./CheckList";
import { TaskOutputs } from "./TaskOutputs";
import { TaskStatusLine } from "./TaskStatusLine";
import type { CoworkTask } from "./useCoworkSession";

/** 说明文字超过这么多字时默认收起（有产出或核对时才收；纯问答的回复就是结果本身） */
const COLLAPSE_CHARS = 280;

function Reply({ task }: { task: CoworkTask }) {
  const hasResult = task.outputs.length > 0 || task.checks.length > 0;
  const long = task.reply.length > COLLAPSE_CHARS;
  const [open, setOpen] = useState(!(hasResult && long && task.status === "done"));
  if (!task.reply) return null;
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="mt-2 inline-flex items-center gap-1 px-1 text-[12px] text-muted-foreground hover:text-foreground">
        <ChevronDown className="h-3.5 w-3.5" />查看处理说明
      </button>
    );
  }
  return (
    <div className="mt-2 px-1 text-[13px] leading-relaxed">
      <MarkdownRenderer content={task.reply} />
    </div>
  );
}

interface TaskThreadProps {
  tasks: CoworkTask[];
  /** 最后一个任务做完后的动作：自由任务「保存为流程」，流程任务「换一批文件再运行」 */
  onSaveAsFlow?: () => void;
  onRunAgain?: () => void;
  savingFlow?: boolean;
}

export function TaskThread({ tasks, onSaveAsFlow, onRunAgain, savingFlow }: TaskThreadProps) {
  const last = tasks[tasks.length - 1];
  const showActions = last?.status === "done";
  return (
    <>
      {tasks.map((task, taskIndex) => (
        <div key={task.id} className={taskIndex > 0 ? "mt-7 border-t border-border/60 pt-7" : ""}>
          {/* 用户的请求：居右气泡。流程任务在气泡上方标出流程名 */}
          <div className="flex flex-col items-end">
            {task.flow && (
              <span className="mb-1 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                <Repeat2 className="h-3 w-3" />{task.flow.name}
              </span>
            )}
            <div className="axon-user-bubble max-w-[80%] rounded-2xl rounded-br-md px-3.5 py-2.5">
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">{task.request}</p>
              {task.fileNames.length > 0 && (
                <div className="mt-2 flex justify-end">
                  <TaskOutputs paths={task.filePaths} fallbackNames={task.fileNames} onBubble />
                </div>
              )}
            </div>
          </div>

          {task.status !== "done" && (
            <div className="mt-2">
              <TaskStatusLine task={task} />
            </div>
          )}

          {/* 结果：产出 + 核对在前 */}
          {task.status === "done" && (task.outputs.length > 0 || task.checks.length > 0) && (
            <div className="mt-3 space-y-2 px-1">
              {task.outputs.length > 0 && <TaskOutputs files={task.outputs} />}
              <CheckList checks={task.checks} />
            </div>
          )}

          <Reply task={task} />
        </div>
      ))}

      {showActions && (onSaveAsFlow || onRunAgain) && (
        <div className="mt-4 flex flex-wrap items-center gap-2 px-1">
          {onRunAgain && (
            <button onClick={onRunAgain} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12px] text-foreground transition-colors hover:bg-muted/50">
              <Repeat2 className="h-3.5 w-3.5" />换一批文件再运行
            </button>
          )}
          {onSaveAsFlow && (
            <button onClick={onSaveAsFlow} disabled={savingFlow} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12px] text-foreground transition-colors hover:bg-muted/50 disabled:opacity-60">
              <Sparkles className="h-3.5 w-3.5" />{savingFlow ? "正在整理成流程…" : "保存为流程，下次一键运行"}
            </button>
          )}
        </div>
      )}
    </>
  );
}
