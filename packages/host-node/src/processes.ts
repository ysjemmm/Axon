/**
 * NodeProcessManager —— 基于 child_process.spawn 的 HostProcessManager 实现
 *
 * 用于 web / cli / server 形态跑「常驻进程」（开发服务器、watch 等）：
 * - start：spawn 一个 PowerShell 子进程（UTF-8 链路，对齐 NodeCommandRunner），立即返回 terminalId
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
} from "@axon/core";

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
}

/** 单进程输出缓冲上限（字符）：约 256KB，超出后保留尾部 */
const MAX_BUFFER_CHARS = 256 * 1024;

export class NodeProcessManager implements HostProcessManager {
  private readonly procs = new Map<string, ProcEntry>();
  private counter = 0;

  async start(command: string, opts: StartProcessOptions): Promise<StartProcessResult> {
    // 复用：相同命令 + 相同 cwd 且仍在运行 → 不重复启动
    for (const entry of this.procs.values()) {
      if (entry.command === command && entry.cwd === opts.cwd && entry.status === "running") {
        return { terminalId: entry.terminalId, reused: true };
      }
    }

    const terminalId = `bg-${++this.counter}`;
    // PowerShell UTF-8 包装，与 NodeCommandRunner 一致，避免中文乱码
    const wrapped =
      `chcp 65001 > $null; ` +
      `[Console]::InputEncoding = [System.Text.Encoding]::UTF8; ` +
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ` +
      `${command}`;

    const child = spawn("powershell.exe", ["-NoProfile", "-Command", wrapped], {
      cwd: opts.cwd,
      windowsHide: true,
      // 独立进程组，便于停止时连同子进程一起终止
      detached: false,
    });

    const entry: ProcEntry = {
      terminalId,
      command,
      cwd: opts.cwd,
      child,
      buffer: "",
      status: "running",
      exitCode: null,
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
      entry.status = "exited";
    });
    child.on("exit", (code) => {
      // 已被 stop 主动终止的进程保持 stopped 状态，不覆写
      if (entry.status !== "stopped") entry.status = "exited";
      entry.exitCode = code;
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
      // Windows 下用 taskkill 终止整棵进程树（PowerShell 起的 node/vite 是子进程）
      if (entry.child.pid) {
        spawn("taskkill", ["/pid", String(entry.child.pid), "/t", "/f"], { windowsHide: true });
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
    }));
  }
}

/** 去除 ANSI 转义序列与回车符（与 VSCode 终端捕获保持一致口径） */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "");
}
