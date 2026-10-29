/**
 * 后台任务面板：AI 用 start_process 启动的进程（开发服务器、长时间测试 / 构建 / 数据处理）。
 *
 * 输入区工具栏上的一个小按钮，有后台任务时才出现；运行中的数量直接写在按钮上。
 * 点开是任务列表：状态、命令、所属会话、用时、是否「结束时通知 AI」，可以看输出、停止。
 * 列表跨所有活跃会话 —— 切到别的会话时，之前会话启动的服务器还在跑，也要看得见、停得掉。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bell, ChevronRight, Loader2, RefreshCw, Server, Square } from "lucide-react";
import { useSessionEvents } from "@/hooks/useSessionEvents";
import type { WsMessage } from "@/hooks/useWebSocket";
import { commandPreview } from "@/lib/commandPreview";

export interface BackgroundTask {
  terminalId: string;
  command: string;
  cwd: string;
  status: "running" | "exited" | "stopped";
  exitCode?: number | null;
  startedAt?: number;
  endedAt?: number;
  notify: boolean;
  sessionId: string;
  sessionTitle?: string;
}

interface TaskOutput {
  output: string;
  status: string;
  exitCode: number | null;
  loading: boolean;
}

const taskKey = (t: Pick<BackgroundTask, "sessionId" | "terminalId">) => `${t.sessionId}:${t.terminalId}`;

function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分 ${sec % 60} 秒`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}

function useBackgroundTasks({ clientId, connected, send }: { clientId: string; connected: boolean; send: (cmd: Record<string, unknown>) => void }) {
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [outputs, setOutputs] = useState<Record<string, TaskOutput>>({});

  useEffect(() => {
    if (connected) send({ type: "list_background_tasks", clientId });
  }, [clientId, connected, send]);

  useSessionEvents(clientId, (msg: WsMessage) => {
    const m = msg as WsMessage & { tasks?: BackgroundTask[]; sessionId?: string; terminalId?: string; output?: string; status?: string; exitCode?: number | null };
    if (m.type === "background_tasks" && Array.isArray(m.tasks)) {
      setTasks(m.tasks);
    } else if (m.type === "background_task_output" && m.sessionId && m.terminalId) {
      setOutputs((prev) => ({ ...prev, [`${m.sessionId}:${m.terminalId}`]: { output: m.output ?? "", status: m.status ?? "", exitCode: m.exitCode ?? null, loading: false } }));
    }
  });

  const loadOutput = useCallback((task: BackgroundTask) => {
    setOutputs((prev) => ({ ...prev, [taskKey(task)]: { ...(prev[taskKey(task)] ?? { output: "", status: "", exitCode: null }), loading: true } }));
    send({ type: "get_background_task_output", clientId, sessionId: task.sessionId, terminalId: task.terminalId });
  }, [clientId, send]);

  const stop = useCallback((task: BackgroundTask) => {
    send({ type: "stop_background_task", clientId, sessionId: task.sessionId, terminalId: task.terminalId });
  }, [clientId, send]);

  return { tasks, outputs, loadOutput, stop };
}

function StatusDot({ task }: { task: BackgroundTask }) {
  if (task.status === "running") return <span className="relative mt-1.5 flex size-2 shrink-0"><span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60" /><span className="relative inline-flex size-2 rounded-full bg-emerald-500" /></span>;
  const failed = task.status === "exited" && task.exitCode !== 0 && task.exitCode !== null && task.exitCode !== undefined;
  return <span className={`mt-1.5 size-2 shrink-0 rounded-full ${failed ? "bg-red-500" : "bg-muted-foreground/40"}`} />;
}

function statusText(task: BackgroundTask, now: number): string {
  const elapsed = task.startedAt ? formatDuration((task.endedAt ?? now) - task.startedAt) : "";
  if (task.status === "running") return elapsed ? `运行中 · ${elapsed}` : "运行中";
  if (task.status === "stopped") return elapsed ? `已停止 · 运行了 ${elapsed}` : "已停止";
  const code = task.exitCode === null || task.exitCode === undefined ? "退出码未知" : `退出码 ${task.exitCode}`;
  return elapsed ? `已结束 · ${code} · 用时 ${elapsed}` : `已结束 · ${code}`;
}

function TaskRow({ task, output, now, onLoad, onStop }: { task: BackgroundTask; output?: TaskOutput; now: number; onLoad: () => void; onStop: () => void }) {
  const [open, setOpen] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (open && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [open, output?.output]);
  return (
    <div className="border-b border-border/60 px-3 py-2 last:border-b-0">
      <div className="flex items-start gap-2">
        <StatusDot task={task} />
        <div className="min-w-0 flex-1">
          <button onClick={() => { const next = !open; setOpen(next); if (next) onLoad(); }} className="flex w-full min-w-0 items-center gap-1 text-left">
            <ChevronRight className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
            <code className="truncate font-mono text-[12px] text-foreground" title={task.command}>{commandPreview(task.command) || task.command}</code>
          </button>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 pl-4 text-[11px] text-muted-foreground">
            <span>{statusText(task, now)}</span>
            {task.notify && <span className="inline-flex items-center gap-0.5" title="结束时会自动通知 AI"><Bell className="h-3 w-3" />结束时通知 AI</span>}
            {task.sessionTitle && <span className="truncate" title={task.sessionTitle}>· {task.sessionTitle}</span>}
          </div>
        </div>
        {task.status === "running" && (
          <button onClick={onStop} className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-destructive" title="停止这个任务" aria-label="停止">
            <Square className="h-3 w-3" fill="currentColor" />
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 pl-4">
          <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
            <span className="truncate" title={task.cwd}>{task.cwd}</span>
            <button onClick={onLoad} className="inline-flex shrink-0 items-center gap-1 hover:text-foreground">
              {output?.loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}刷新
            </button>
          </div>
          <pre ref={preRef} className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground/90">
            {output?.output || (output?.loading ? "读取中…" : "（暂无输出）")}
          </pre>
        </div>
      )}
    </div>
  );
}

export function BackgroundTasksButton({ clientId, connected, send }: { clientId: string; connected: boolean; send: (cmd: Record<string, unknown>) => void }) {
  const { tasks, outputs, loadOutput, stop } = useBackgroundTasks({ clientId, connected, send });
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** 面板位置（fixed 坐标）：贴着按钮上沿，左右夹在视口内 */
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const running = tasks.filter((t) => t.status === "running").length;

  const place = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(420, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setPos({ left, bottom: window.innerHeight - rect.top + 8, width });
  }, []);

  // 打开时每秒刷新用时；点外面关闭；窗口尺寸变化时跟着按钮重新定位
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", place);
    return () => { clearInterval(timer); document.removeEventListener("mousedown", onDown); window.removeEventListener("resize", place); };
  }, [open, place]);

  if (tasks.length === 0) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => { setNow(Date.now()); place(); setOpen((v) => !v); }}
        className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] transition-colors hover:bg-muted/60 ${running > 0 ? "text-foreground" : "text-muted-foreground"}`}
        title={running > 0 ? `${running} 个后台任务运行中` : "后台任务"}
        aria-label="后台任务"
      >
        <Server className="h-3.5 w-3.5" />
        {running > 0 && <span className="tabular-nums">{running}</span>}
      </button>
      {/* 挂到 body 上：输入框容器是 overflow-hidden（圆角裁切），面板放在里面会被整个裁掉，只剩一点阴影 */}
      {open && pos && createPortal(
        <div ref={panelRef} style={{ left: pos.left, bottom: pos.bottom, width: pos.width }} className="fixed z-[70] overflow-hidden rounded-xl border border-border bg-background shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-[12px] font-medium text-foreground">后台任务</span>
            <span className="text-[11px] text-muted-foreground">{running > 0 ? `${running} 个运行中` : "都已结束"}</span>
          </div>
          <div className="max-h-[360px] overflow-y-auto">
            {tasks.map((task) => (
              <TaskRow key={taskKey(task)} task={task} now={now} output={outputs[taskKey(task)]} onLoad={() => loadOutput(task)} onStop={() => stop(task)} />
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
