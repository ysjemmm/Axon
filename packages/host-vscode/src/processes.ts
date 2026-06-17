/**
 * VSCodeProcessManager —— HostProcessManager 实现（进程内 IDE 形态）
 *
 * 每个后台进程独占一个可见的 "Axon: <命令>" 集成终端：
 * - start：创建终端，用 Shell Integration 启动命令，后台异步把输出流追加进缓冲，立即返回 terminalId
 *   （不 await 执行结束——常驻进程本就不退出）。Shell Integration 不可用时退化为 sendText 只执行不捕获。
 * - getOutput：返回缓冲快照 + 状态
 * - stop：dispose 终端（连带终止其中进程）
 *
 * 与 VSCodeCommandRunner（短命令、同步等退出）互补：这里专跑开发服务器/watch。
 */

import * as vscode from "vscode";
import type {
  HostProcessManager,
  StartProcessOptions,
  StartProcessResult,
  ProcessOutputResult,
  BackgroundProcessInfo,
  BackgroundProcessStatus,
} from "@axon/core";

interface ProcEntry {
  terminalId: string;
  command: string;
  cwd: string;
  terminal: vscode.Terminal;
  buffer: string;
  status: BackgroundProcessStatus;
  exitCode: number | null;
}

/** 单进程输出缓冲上限（字符）：约 256KB，超出后保留尾部 */
const MAX_BUFFER_CHARS = 256 * 1024;

export class VSCodeProcessManager implements HostProcessManager {
  private readonly procs = new Map<string, ProcEntry>();
  private counter = 0;
  private closeDisposable: vscode.Disposable | null = null;

  constructor() {
    // 用户手动关闭终端时，把对应进程标记为 stopped
    this.closeDisposable = vscode.window.onDidCloseTerminal((t) => {
      for (const entry of this.procs.values()) {
        if (entry.terminal === t && entry.status === "running") {
          entry.status = "stopped";
          entry.exitCode = t.exitStatus?.code ?? null;
        }
      }
    });
  }

  async start(command: string, opts: StartProcessOptions): Promise<StartProcessResult> {
    // 复用：相同命令 + 相同 cwd 且仍在运行
    for (const entry of this.procs.values()) {
      if (entry.command === command && entry.cwd === opts.cwd && entry.status === "running") {
        entry.terminal.show(false);
        return { terminalId: entry.terminalId, reused: true };
      }
    }

    const terminalId = `bg-${++this.counter}`;
    const label = command.length > 40 ? command.slice(0, 40) + "…" : command;
    const terminal = vscode.window.createTerminal({
      name: `Axon: ${label}`,
      cwd: opts.cwd,
      iconPath: new vscode.ThemeIcon("server-process"),
      env: { AXON_AI_TERMINAL: "1" },
    });
    terminal.show(false);

    const entry: ProcEntry = {
      terminalId,
      command,
      cwd: opts.cwd,
      terminal,
      buffer: "",
      status: "running",
      exitCode: null,
    };
    this.procs.set(terminalId, entry);

    // 后台启动并流式读取（不阻塞 start 返回）
    void this.launch(entry, command);

    return { terminalId, reused: false };
  }

  /** 等 Shell Integration 就绪后执行命令，并在后台把输出流追加进缓冲 */
  private async launch(entry: ProcEntry, command: string): Promise<void> {
    const t = entry.terminal;
    const hasShellIntegration = await waitForShellIntegration(t);
    if (!hasShellIntegration || !t.shellIntegration) {
      // 退化：只执行不捕获，提示去终端看
      t.sendText(command);
      entry.buffer +=
        "（已在 Axon 终端启动该进程。当前终端未启用 Shell Integration，无法自动捕获输出，" +
        "请直接查看终端面板。）\n";
      return;
    }
    const execution = t.shellIntegration.executeCommand(command);
    // 监听结束（常驻进程通常不触发；触发即说明进程退出/被杀）
    const endDisposable = vscode.window.onDidEndTerminalShellExecution((e) => {
      if (e.execution === execution) {
        if (entry.status === "running") entry.status = "exited";
        entry.exitCode = e.exitCode ?? null;
        endDisposable.dispose();
      }
    });
    try {
      for await (const chunk of execution.read()) {
        entry.buffer += stripAnsi(chunk);
        if (entry.buffer.length > MAX_BUFFER_CHARS) {
          entry.buffer = entry.buffer.slice(entry.buffer.length - MAX_BUFFER_CHARS);
        }
      }
    } catch {
      /* 读流异常忽略，已收集输出仍保留 */
    }
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
      entry.terminal.dispose();
    } catch {
      /* 忽略 */
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

/** 等待终端 shell integration 就绪 */
async function waitForShellIntegration(t: vscode.Terminal, timeoutMs = 5000): Promise<boolean> {
  if (t.shellIntegration) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      disposable.dispose();
      resolve(!!t.shellIntegration);
    }, timeoutMs);
    const disposable = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === t) {
        clearTimeout(timer);
        disposable.dispose();
        resolve(true);
      }
    });
  });
}

/** 去除 ANSI 转义序列与回车符 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "");
}
