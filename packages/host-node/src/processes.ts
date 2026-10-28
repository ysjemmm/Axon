/**
 * NodeProcessManager —— 基于 child_process.spawn 的 HostProcessManager 实现
 *
 * 用于 web / cli / server 形态跑「常驻进程」（开发服务器、watch 等）和会结束的后台长任务：
 * - start：Windows 上 spawn PowerShell（UTF-8 链路，对齐 NodeCommandRunner），其余平台用 /bin/sh，立即返回 terminalId
 * - 输出在后台持续写入环形缓冲（限制总量，避免长跑进程内存无限增长）
 * - getOutput：读缓冲快照；stop：杀进程树
 *
 * 不做危险命令检测/信任门——那是 core 的与形态无关安全策略，调用前已完成。
 */

import { spawn, type ChildProcess } from "node:child_process";
import type {
  HostProcessManager,
  StartProcessOptions,
  StartProcessResult,
  ProcessOutputResult,
  BackgroundProcessInfo,
  BackgroundProcessStatus,
  ProcessExitEvent,
} from "@axon/core";

const IS_WINDOWS = process.platform === "win32";

/** 单条后台进程的内部记录 */
interface ProcEntry {
  terminalId: string;
  command: string;
  cwd: string;
  child: ChildProcess;
  /** 输出缓冲（已去除部分控制字符）；超过上限时从头截断 */
  buffer: string;
  status: BackgroundProcessStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
}

/** 单进程输出缓冲上限（字符）：约 256KB，超出后保留尾部 */
const MAX_BUFFER_CHARS = 256 * 1024;

export class NodeProcessManager implements HostProcessManager {
  private readonly procs = new Map<string, ProcEntry>();
  private counter = 0;
  private readonly exitListeners = new Set<(event: ProcessExitEvent) => void>();

  onExit(listener: (event: ProcessExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  /** 进程结束只通知一次（error 和 exit 可能先后到达） */
  private finish(entry: ProcEntry, status: "exited" | "stopped", exitCode: number | null): void {
    if (entry.endedAt) return;
    entry.endedAt = Date.now();
    if (entry.status !== "stopped") entry.status = status;
    entry.exitCode = exitCode;
    const event: ProcessExitEvent = { terminalId: entry.terminalId, status: entry.status === "stopped" ? "stopped" : "exited", exitCode };
    for (const listener of this.exitListeners) {
      try { listener(event); } catch { /* 订阅方的异常不影响进程管理 */ }
    }
  }

  async start(command: string, opts: StartProcessOptions): Promise<StartProcessResult> {
    // 复用：相同命令 + 相同 cwd 且仍在运行 → 不重复启动
    for (const entry of this.procs.values()) {
      if (entry.command === command && entry.cwd === opts.cwd && entry.status === "running") {
        return { terminalId: entry.terminalId, reused: true };
      }
    }

    const terminalId = `bg-${++this.counter}`;
    let child: ChildProcess;
    if (IS_WINDOWS) {
      // PowerShell UTF-8 包装，与 NodeCommandRunner 一致，避免中文乱码
      const wrapped =
        `chcp 65001 > $null; ` +
        `[Console]::InputEncoding = [System.Text.Encoding]::UTF8; ` +
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ` +
        `${command}`;
      child = spawn("powershell.exe", ["-NoProfile", "-Command", wrapped], { cwd: opts.cwd, windowsHide: true, detached: false });
    } else {
      // 独立进程组（detached）：停止时向整组发信号，连同 sh 起的 node/vite 子进程一起结束
      child = spawn("/bin/sh", ["-c", command], { cwd: opts.cwd, detached: true });
    }

    const entry: ProcEntry = {
      terminalId,
      command,
      cwd: opts.cwd,
      child,
      buffer: "",
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
    };
    this.procs.set(terminalId, entry);

    const append = (chunk: Buffer | string) => {
      entry.buffer += stripAnsi(chunk.toString());
      if (entry.buffer.length > MAX_BUFFER_CHARS) {
        entry.buffer = entry.buffer.slice(entry.buffer.length - MAX_BUFFER_CHARS);
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      append(`\n[进程错误] ${err.message}\n`);
      this.finish(entry, "exited", null);
    });
    // close 在 stdio 全部关闭后触发，此时输出已收齐，通知里带的最后几行才完整
    child.on("close", (code) => {
      // 已被 stop 主动终止的进程保持 stopped 状态，不覆写
      this.finish(entry, "exited", code);
    });

    return { terminalId, reused: false };
  }

  async getOutput(terminalId: string, lines?: number): Promise<ProcessOutputResult | null> {
    const entry = this.procs.get(terminalId);
    if (!entry) return null;
    let output = entry.buffer;
    if (typeof lines === "number" && lines > 0) {
      const all = output.split("\n");
      output = all.slice(Math.max(0, all.length - lines)).join("\n");
    }
    return { output, status: entry.status, exitCode: entry.exitCode };
  }

  async stop(terminalId: string): Promise<boolean> {
    const entry = this.procs.get(terminalId);
    if (!entry) return false;
    entry.status = "stopped";
    try {
      // 终止整棵进程树（shell 起的 node/vite 是子进程）：Windows 用 taskkill，其余平台向进程组发信号
      if (entry.child.pid && IS_WINDOWS) {
        spawn("taskkill", ["/pid", String(entry.child.pid), "/t", "/f"], { windowsHide: true });
      } else if (entry.child.pid) {
        try { process.kill(-entry.child.pid, "SIGTERM"); } catch { entry.child.kill(); }
      } else {
        entry.child.kill();
      }
    } catch {
      try { entry.child.kill(); } catch { /* 忽略 */ }
    }
    return true;
  }

  async list(): Promise<BackgroundProcessInfo[]> {
    return Array.from(this.procs.values()).map((e) => ({
      terminalId: e.terminalId,
      command: e.command,
      cwd: e.cwd,
      status: e.status,
      exitCode: e.exitCode,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
    }));
  }
}

/** 去除 ANSI 转义序列与回车符（与 VSCode 终端捕获保持一致口径） */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "");
}
