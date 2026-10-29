/**
 * wait_process 的等待逻辑：轮询进程状态直到全部结束、超时、被取消，或调用方要求提前返回（用户插话）。
 * 主会话与子 Agent 共用；主会话额外支持「不传 terminalId 就等所有该等的任务」和插话唤醒。
 */

import type { HostProcessManager } from "../host/index.js";

export interface ProcessWaitResult {
  terminalId: string;
  status: "running" | "exited" | "stopped" | "missing";
  exitCode: number | null;
  output: string;
}

export interface ProcessWaitOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** 返回 true 时提前结束等待（如用户发来了新消息） */
  interrupt?: () => boolean;
  /** 每次取多少行输出 */
  tailLines?: number;
  /** 轮询间隔 */
  pollMs?: number;
}

export const WAIT_DEFAULT_MINUTES = 30;
export const WAIT_MAX_MINUTES = 120;

export function waitTimeoutMs(raw: unknown): number {
  const minutes = typeof raw === "number" && raw > 0 ? Math.min(raw, WAIT_MAX_MINUTES) : WAIT_DEFAULT_MINUTES;
  return minutes * 60_000;
}

export async function waitForProcesses(
  processes: Pick<HostProcessManager, "getOutput">,
  ids: string[],
  opts: ProcessWaitOptions,
): Promise<{ results: ProcessWaitResult[]; reason: "done" | "timeout" | "aborted" | "interrupted" }> {
  const deadline = Date.now() + opts.timeoutMs;
  const poll = opts.pollMs ?? 1000;
  const read = async () => Promise.all(ids.map(async (terminalId): Promise<ProcessWaitResult> => {
    const out = await processes.getOutput(terminalId, opts.tailLines ?? 40).catch(() => null);
    if (!out) return { terminalId, status: "missing", exitCode: null, output: "" };
    return { terminalId, status: out.status, exitCode: out.exitCode, output: (out.output ?? "").trimEnd() };
  }));
  for (;;) {
    // getOutput 读到「已结束」时追踪器会记为 Agent 已知，不再另发通知——在回复里等到了结果，正该如此
    const results = await read();
    if (results.every((r) => r.status !== "running")) return { results, reason: "done" };
    if (opts.signal?.aborted) return { results, reason: "aborted" };
    if (opts.interrupt?.()) return { results, reason: "interrupted" };
    if (Date.now() >= deadline) return { results, reason: "timeout" };
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, poll);
      opts.signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}

/** 给模型看的等待结果 */
export function formatWaitResult(
  out: { results: ProcessWaitResult[]; reason: "done" | "timeout" | "aborted" | "interrupted" },
  labels: Map<string, string> = new Map(),
): string {
  const lines: string[] = [];
  if (out.reason === "interrupted") lines.push("用户发来了新消息，先停下等待去看用户说了什么（进程没有停，仍在后台运行）。处理完如果还需要结果，再次调用 wait_process。");
  if (out.reason === "timeout") lines.push("等待超时，下面还在运行的任务没有被停止。可以再次 wait_process 继续等，或用 get_process_output 看进度。");
  if (out.reason === "aborted") lines.push("等待已取消。");
  for (const r of out.results) {
    const name = labels.get(r.terminalId) ?? r.terminalId;
    const state = r.status === "running" ? "仍在运行"
      : r.status === "exited" ? `已结束，退出码 ${r.exitCode ?? "未知"}`
      : r.status === "stopped" ? "已被停止"
      : "找不到这个进程";
    lines.push("", `■ ${name}（terminalId: ${r.terminalId}）：${state}`);
    if (r.output) lines.push("最后的输出：", "```", r.output, "```");
  }
  return lines.join("\n").trim();
}
