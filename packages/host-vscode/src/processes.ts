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
  ProcessExitEvent,
} from "@axon/core";
import { interruptTimedOutTask, timedOutRegistry } from "./terminalDisplay.js";
import { processTerminalEnv } from "./terminalIdentity.js";

interface ProcEntry {
  terminalId: string;
  command: string;
  cwd: string;
  terminal: vscode.Terminal;
  buffer: string;
  status: BackgroundProcessStatus;
  exitCode: number | null;
  /** AI 是否已读过它的输出：决定这个「已退出」的终端能否在下次新建终端时被回收 */
  readByAgent: boolean;
  startedAt: number;
  endedAt?: number;
}

/** 单进程输出缓冲上限（字符）：约 256KB，超出后保留尾部 */
const MAX_BUFFER_CHARS = 256 * 1024;

export class VSCodeProcessManager implements HostProcessManager {
  private readonly procs = new Map<string, ProcEntry>();
  private counter = 0;
  private closeDisposable: vscode.Disposable | null = null;
  private readonly exitListeners = new Set<(event: ProcessExitEvent) => void>();

  constructor() {
    // 用户手动关闭终端时，把对应进程标记为 stopped
    this.closeDisposable = vscode.window.onDidCloseTerminal((t) => {
      for (const entry of this.procs.values()) {
        if (entry.terminal === t && entry.status === "running") {
          this.finish(entry, "stopped", t.exitStatus?.code ?? null);
        }
      }
    });
  }

  onExit(listener: (event: ProcessExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => { this.exitListeners.delete(listener); };
  }

  /** 进程结束只通知一次（结束事件和关闭终端可能先后到达） */
  private finish(entry: ProcEntry, status: "exited" | "stopped", exitCode: number | null): void {
    if (entry.endedAt) return;
    entry.endedAt = Date.now();
    if (entry.status === "running") entry.status = status;
    entry.exitCode = exitCode;
    const event: ProcessExitEvent = { terminalId: entry.terminalId, status: entry.status === "stopped" ? "stopped" : "exited", exitCode };
    for (const listener of this.exitListeners) {
      try { listener(event); } catch { /* 订阅方的异常不影响进程管理 */ }
    }
  }

  async start(command: string, opts: StartProcessOptions): Promise<StartProcessResult> {
    // 复用：相同命令 + 相同 cwd 且仍在运行
    for (const entry of this.procs.values()) {
      if (entry.command === command && entry.cwd === opts.cwd && entry.status === "running") {
        entry.terminal.show(false);
        return { terminalId: entry.terminalId, reused: true };
      }
    }

    // 真要新建终端了：顺手把「已退出且已被 AI 读过」的旧进程终端收掉，避免面板越堆越多。
    // 只碰这类终端——进程确实退出（end 事件）才说明它此刻没在执行命令；输出已被读过，
    // 说明不再需要从终端面板看它（缓冲还在，get_process_output 随时可查）。
    // 正在跑的、以及已退出但还没读过的（进程崩了时用户往往要先看一眼报错）都不动。
    this.reclaimExitedTerminals();

    const terminalId = `bg-${++this.counter}`;
    const label = command.length > 40 ? command.slice(0, 40) + "…" : command;
    const terminal = vscode.window.createTerminal({
      name: `Axon: ${label}`,
      cwd: opts.cwd,
      iconPath: new vscode.ThemeIcon("server-process"),
      env: processTerminalEnv(),
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
      readByAgent: false,
      startedAt: Date.now(),
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
    // 结束事件可能早于输出流读完：等流读完再通知，通知里带的最后几行才完整
    let ended: number | null | undefined;
    let drained = false;
    const endDisposable = vscode.window.onDidEndTerminalShellExecution((e) => {
      if (e.execution === execution) {
        ended = e.exitCode ?? null;
        endDisposable.dispose();
        if (drained) this.finish(entry, "exited", ended ?? null);
        else setTimeout(() => this.finish(entry, "exited", ended ?? null), 1500);
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
    drained = true;
    if (ended !== undefined) this.finish(entry, "exited", ended);
  }

  /**
   * 回收已退出的进程终端（dispose 终端，保留 entry 与缓冲）。
   *
   * 触发时机刻意选在「马上要新建终端之前」：不主动清屏，只在确实又要多开一个终端时收敛，
   * 这样面板里的 "Axon: <命令>" 终端数量大致等于「在跑的进程数 + 1」。
   *
   * 判定条件缺一不可，且都指向「绝对没在执行命令」：
   * - status === "exited"：进程自己发了结束事件；running 的一律不碰，哪怕它看起来没输出；
   * - readByAgent：AI 已经读过输出，回收不损失它需要的信息（缓冲仍在，可继续查询）；
   * - exitStatus 为空：终端本身已经随进程结束关闭时无需再 dispose。
   * 进程终端与命令终端互不认领（命令终端的认领逻辑显式排除后台进程终端），
   * 所以这里不会波及任何正在执行命令的命令终端。
   */
  private reclaimExitedTerminals(): void {
    for (const entry of this.procs.values()) {
      if (entry.status !== "exited") continue;
      if (!entry.readByAgent) continue;
      if (entry.terminal.exitStatus) continue;
      try {
        entry.terminal.dispose();
      } catch {
        /* 终端可能已被用户关闭，忽略 */
      }
    }
  }

  async getOutput(terminalId: string, lines?: number): Promise<ProcessOutputResult | null> {
    const entry = this.procs.get(terminalId);
    if (entry) {
      entry.readByAgent = true;
      let output = entry.buffer;
      if (typeof lines === "number" && lines > 0) {
        const all = output.split("\n");
        output = all.slice(Math.max(0, all.length - lines)).join("\n");
      }
      return { output, status: entry.status, exitCode: entry.exitCode };
    }

    // execute_command 超时但仍在运行的命令（见 terminalDisplay.timedOutRegistry）
    const timed = timedOutRegistry.get(terminalId);
    if (timed) {
      let output = timed.buffer;
      if (typeof lines === "number" && lines > 0) {
        const all = output.split("\n");
        output = all.slice(Math.max(0, all.length - lines)).join("\n");
      }
      return { output, status: timed.status, exitCode: timed.exitCode };
    }
    return null;
  }

  async stop(terminalId: string): Promise<boolean> {
    const entry = this.procs.get(terminalId);
    if (entry) {
      entry.status = "stopped";
      this.finish(entry, "stopped", null);
      try {
        entry.terminal.dispose();
      } catch {
        /* 忽略 */
      }
      return true;
    }
    return interruptTimedOutTask(terminalId);
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
