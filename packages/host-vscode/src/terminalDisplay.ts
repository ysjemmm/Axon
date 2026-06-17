/**
 * TerminalDisplay —— 管理一个 "Axon" 可见终端，在终端里真正执行 Agent 的命令
 *
 * 设计：
 * - 全局单例，整个扩展生命周期共享一个 "Axon" 终端
 * - 终端被用户关闭后下次命令时自动重建
 * - 命令直接在终端里执行（用户全程可见、可交互输入）
 * - 用 Shell Integration API 捕获输出和退出码；不可用时回退到"只执行不捕获"
 */

import * as vscode from "vscode";

let terminal: vscode.Terminal | null = null;
let terminalCwd: string | undefined;

/** 获取或创建终端实例。cwd 变了就另建新终端（旧终端保留、历史不丢） */
function getTerminal(cwd?: string): vscode.Terminal {
  if (terminal && !terminal.exitStatus && terminalCwd === cwd) {
    return terminal;
  }
  // cwd 变了或终端已关 → 新建（旧终端不 dispose，历史保留在终端标签页里）
  const label = cwd ? `Axon · ${cwd.split(/[/\\]/).pop() || cwd}` : "Axon";
  terminal = vscode.window.createTerminal({
    name: label,
    cwd,
    iconPath: new vscode.ThemeIcon("sparkle"),
    env: { GIT_PAGER: "cat", AXON_AI_TERMINAL: "1" },
  });
  terminalCwd = cwd;
  return terminal;
}

/** 等待终端的 shell integration 就绪（首次创建终端时 shell 启动需要一点时间） */
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

export interface TerminalRunResult {
  stdout: string;
  exitCode: number | null;
  /** shell integration 不可用、无法捕获输出（命令已执行但拿不到结果） */
  captured: boolean;
  /** 终端被用户手动关闭（命令被强制终止） */
  closed?: boolean;
}

/**
 * 在 "Axon" 终端里执行命令并尽力捕获输出。
 * - shell integration 可用：捕获完整输出 + 退出码
 * - 不可用：仅执行（sendText），返回 captured=false
 * @param signal 可选中断信号（用户取消时停止等待）
 */
export async function runInTerminalCaptured(
  command: string,
  cwd?: string,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<TerminalRunResult> {
  const t = getTerminal(cwd);
  t.show(false); // 显示并聚焦，方便用户交互输入

  // Mark AI command start for proactive awareness filtering (by timestamp)
  const aiCmdStartTime = Date.now();
  vscode.commands.executeCommand('axon.internal.markAiCommandStart', aiCmdStartTime);

  const hasShellIntegration = await waitForShellIntegration(t);

  // Shell Integration 不可用：退化为只执行不捕获
  if (!hasShellIntegration || !t.shellIntegration) {
    t.sendText(command);
    // Mark end immediately (no way to track completion without shell integration)
    vscode.commands.executeCommand('axon.internal.markAiCommandEnd', aiCmdStartTime);
    return { stdout: "", exitCode: null, captured: false };
  }

  const si = t.shellIntegration;
  const execution = si.executeCommand(command);

  // 并行：读取输出流 + 等待执行结束
  let stdout = "";
  const readPromise = (async () => {
    try {
      for await (const chunk of execution.read()) {
        stdout += chunk;
      }
    } catch { /* 读流异常忽略，已收集的输出仍返回 */ }
  })();

  const exitCode = await new Promise<number | null>((resolve) => {
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      endDisposable.dispose();
      closeDisposable.dispose();
      clearTimeout(timer);
      clearInterval(idlePoller);
      if (signalHandler && signal) signal.removeEventListener("abort", signalHandler);
      resolve(code);
    };
    const endDisposable = vscode.window.onDidEndTerminalShellExecution((e) => {
      if (e.execution === execution) finish(e.exitCode ?? null);
    });
    // 终端被用户手动关闭：立即完成（返回 null exitCode + 特殊标记）
    const closeDisposable = vscode.window.onDidCloseTerminal((closed) => {
      if (closed === t) finish(null);
    });
    const timer = setTimeout(() => finish(null), timeoutMs); // 超时：返回 null（命令可能仍在终端运行）

    // 辅助完成检测：PowerShell 下 Shell Integration 偶尔丢 end 事件（长命令/管道/foreach）。
    // 当读流已关闭（readPromise 完成）且持续 3 秒无新输出时，视为命令已结束。
    // 这是对 onDidEndTerminalShellExecution 不可靠时的降级补偿，不替代它。
    let lastStdoutLen = 0;
    let idleCount = 0;
    const IDLE_THRESHOLD = 3; // 连续 3 次（每次 1s）无新输出视为完成
    const idlePoller = setInterval(() => {
      const curLen = stdout.length;
      if (curLen === lastStdoutLen && curLen > 0) {
        idleCount++;
        if (idleCount >= IDLE_THRESHOLD) {
          console.log("[terminal] idle poll triggered: no new output for 3s after stream activity, treating as complete");
          finish(0); // 无法拿到真实 exitCode，降级为 0
        }
      } else {
        idleCount = 0;
        lastStdoutLen = curLen;
      }
    }, 1000);

    let signalHandler: (() => void) | null = null;
    if (signal) {
      signalHandler = () => finish(null);
      signal.addEventListener("abort", signalHandler);
    }
  });

  await readPromise;
  // 清理终端控制字符（shell integration 输出可能含 ANSI 转义序列）
  const cleaned = stripAnsi(stdout);
  // 判断终端是否被用户关闭（关闭后 terminal 的 exitStatus 存在）
  const closed = !!(t.exitStatus);

  // Mark AI command end for proactive awareness filtering
  vscode.commands.executeCommand('axon.internal.markAiCommandEnd', aiCmdStartTime);

  return { stdout: cleaned, exitCode, captured: true, closed };
}

/** 去除 ANSI 转义序列与终端控制字符 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "");
}

/** 聚焦 "Axon" 终端（从前端"打开终端"按钮触发） */
export function focusTerminal(): void {
  if (terminal && !terminal.exitStatus) {
    terminal.show(false);
  }
}
