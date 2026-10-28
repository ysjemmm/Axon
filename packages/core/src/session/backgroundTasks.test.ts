import { describe, expect, it } from "vitest";
import { BackgroundTaskTracker, backgroundNoticeLabel, formatBackgroundNotice, type BackgroundTaskNotice } from "./backgroundTasks.js";
import type { BackgroundProcessInfo, HostProcessManager, ProcessExitEvent } from "../host/index.js";

function fakeManager() {
  const listeners = new Set<(e: ProcessExitEvent) => void>();
  const procs = new Map<string, BackgroundProcessInfo & { output: string }>();
  let n = 0;
  const manager: HostProcessManager = {
    start: async (command, opts) => {
      const id = `bg-${++n}`;
      procs.set(id, { terminalId: id, command, cwd: opts.cwd, status: "running", startedAt: 1000, output: "" });
      return { terminalId: id, reused: false };
    },
    getOutput: async (id, lines) => {
      const p = procs.get(id);
      if (!p) return null;
      const out = lines ? p.output.split("\n").slice(-lines).join("\n") : p.output;
      return { output: out, status: p.status, exitCode: p.exitCode ?? null };
    },
    stop: async (id) => { const p = procs.get(id); if (p) p.status = "stopped"; return !!p; },
    list: async () => [...procs.values()],
    onExit: (l) => { listeners.add(l); return () => listeners.delete(l); },
  };
  const exit = (id: string, code: number, output = "done") => {
    const p = procs.get(id)!;
    Object.assign(p, { status: "exited", exitCode: code, endedAt: 1000 + 192_000, output });
    for (const l of listeners) l({ terminalId: id, status: "exited", exitCode: code });
  };
  return { manager, exit };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("后台任务通知", () => {
  it("notify=true 的进程退出时通知，带退出码、用时和最后的输出", async () => {
    const { manager, exit } = fakeManager();
    const tracker = new BackgroundTaskTracker(manager);
    const notices: BackgroundTaskNotice[] = [];
    tracker.onNotice = (n) => notices.push(n);
    const procs = tracker.wrap();
    const { terminalId } = await procs.start("npm test", { cwd: "/repo", notify: true });
    exit(terminalId, 1, "line1\nFAIL src/a.test.ts");
    await tick();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ command: "npm test", exitCode: 1, tail: "line1\nFAIL src/a.test.ts" });
    expect(backgroundNoticeLabel(notices[0])).toBe("后台任务结束：npm test（退出码 1，用时 3 分 12 秒）");
    expect(formatBackgroundNotice(notices[0])).toContain("不是用户输入");
    expect((await tracker.list())[0].notify).toBe(true);
  });

  it("没要求通知的、被主动停止的不通知", async () => {
    const { manager, exit } = fakeManager();
    const tracker = new BackgroundTaskTracker(manager);
    let count = 0;
    tracker.onNotice = () => { count++; };
    const procs = tracker.wrap();
    const dev = await procs.start("npm run dev", { cwd: "/repo" });
    exit(dev.terminalId, 1);
    const build = await procs.start("npm run build", { cwd: "/repo", notify: true });
    exit(build.terminalId, 0);
    const stopped = await procs.start("make", { cwd: "/repo", notify: true });
    await procs.stop(stopped.terminalId);
    exit(stopped.terminalId, 143);
    await tick();
    expect(count).toBe(1); // 只有 build 那个
  });

  it("Agent 自己用 get_process_output 读到已退出，就不再通知", async () => {
    const { manager, exit } = fakeManager();
    const tracker = new BackgroundTaskTracker(manager);
    let count = 0;
    tracker.onNotice = () => { count++; };
    const procs = tracker.wrap();
    const { terminalId } = await procs.start("pytest", { cwd: "/r", notify: true });
    // 进程已结束、结束事件还没到时 Agent 先读到了结束状态
    Object.assign((await manager.list())[0], { status: "exited", exitCode: 0 });
    await procs.getOutput(terminalId);
    exit(terminalId, 0);
    await tick();
    expect(count).toBe(0);
  });
});
