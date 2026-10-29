/** 后台 Agent 任务（与后端 core/session/agentTasks.ts 一致） */
export interface AgentTask {
  id: string;
  prompt: string;
  title?: string;
  status: "running" | "done" | "failed" | "stopped";
  startedAt: number;
  endedAt?: number;
  step?: string;
  summary?: string;
  model: string;
  provider: string;
  workspace?: string;
  unread?: boolean;
}

/** 在面板里打开某条会话（后台任务的「打开」、完成提醒的「查看」用）：detail = { sessionId } */
export const OPEN_SESSION_EVENT = "axon:open-session";

export function openSessionInPanel(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: { sessionId } }));
}

/** 任务在列表里的名字：自动标题，没有就取任务原文第一行 */
export function agentTaskName(task: AgentTask): string {
  const first = task.prompt.split(/\r?\n/).find((l) => l.trim()) ?? "";
  return task.title || (first.length > 60 ? `${first.slice(0, 60)}…` : first) || "后台任务";
}
