/**
 * TerminalDisplay —— 管理一个 "Axon" 可见终端，在终端里真正执行 Agent 的命令
 *
 * 设计：
 * - 按 terminalKey 隔离终端，不同 session 的命令不混在同一个终端里
 * - 同一 terminalKey 内复用终端，cwd 变化时用 cd 切换目录
 * - 终端被用户关闭后下次命令时自动重建
 * - 命令直接在终端里执行（用户全程可见、可交互输入）
 * - 用 Shell Integration API 捕获输出和退出码；不可用时回退到"只执行不捕获"
 */

import * as vscode from "vscode";

/** terminalKey → 该 key 专属的终端实例 */
const terminals = new Map<string, vscode.Terminal>();
/** terminalKey → 该 key 对应终端的当前 cwd */
const terminalCwds = new Map<string, string>();

/** 获取或创建指定 key 的终端实例 */
function getOrCreateTerminal(terminalKey: string, cwd?: string): vscode.Terminal {
  const existing = terminals.get(terminalKey);
  if (existing && !existing.exitStatus) {
    return existing;
  }
  const t = vscode.window.createTerminal({
    name: "Axon",
    iconPath: new vscode.ThemeIcon("sparkle"),
    cwd: cwd || undefined,
    env: { GIT_PAGER: "cat", AXON_AI_TERMINAL: "1" },
  });
  terminals.set(terminalKey, t);
  terminalCwds.delete(terminalKey);
  return t;
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

/** 根据操作系统生成 cd 命令（PowerShell on Windows，cd 带引号 + drive switch） */
function cdCommand(cwd: string): string {
  const isWindows = process.platform === "win32";
  if (isWindows) {
    return `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; `;
  }
  return `cd '${cwd.replace(/'/g, "'\\''")}'; `;
}

export interface TerminalRunResult {
  stdout: string;
  exitCode: number | null;
  /** shell integration 不可用、无法捕获输出（命令已执行但拿不到结果） */
  captured: boolean;
  /** 终端被用户手动关闭（命令被强制终止） */
  closed?: boolean;
  /** 命令执行后终端的实际工作目录（从 shell integration 获取） */
  cwd?: string;
}

/**
 * 在 "Axon" 终端里执行命令并尽力捕获输出。
 * - shell integration 可用：捕获完整输出 + 退出码
 * - 不可用：仅执行（sendText），返回 captured=false
 * - cwd 不同时先 cd 切换再执行，始终复用同一终端
 * @param terminalKey 终端隔离键（不同 key 用不同终端，同一 key 复用）
 * @param onWaitingInput 检测到命令可能在等待 stdin 输入的回调
 * @param signal 可选中断信号（用户取消时停止等待）
 */
export async function runInTerminalCaptured(
  command: string,
  cwd?: string,
  timeoutMs = 120_000,
  signal?: AbortSignal,
  terminalKey = "default",
  onWaitingInput?: () => void,
): Promise<TerminalRunResult> {
  const notifyWaiting = () => onWaitingInput?.();
  const t = getOrCreateTerminal(terminalKey, cwd);
  t.show(true); // 聚焦终端，让用户看到交互提示（如 Y/N、密码等）

  // 无条件 cd 到目标 cwd：不信任 prevCwd 缓存（AI 或脚本可能已改变终端实际目录）
  const needCd = !!cwd;
  if (cwd) {
    terminalCwds.set(terminalKey, cwd);
  }
  const effectiveCommand = needCd ? cdCommand(cwd!) + command : command;

  // Mark AI command start for proactive awareness filtering (by timestamp)
  const aiCmdStartTime = Date.now();
  vscode.commands.executeCommand('axon.internal.markAiCommandStart', aiCmdStartTime);

  const hasShellIntegration = await waitForShellIntegration(t);

  // Shell Integration 不可用：退化为只执行不捕获
  if (!hasShellIntegration || !t.shellIntegration) {
    t.sendText(effectiveCommand);
    // Mark end immediately (no way to track completion without shell integration)
    vscode.commands.executeCommand('axon.internal.markAiCommandEnd', aiCmdStartTime);
    return { stdout: "", exitCode: null, captured: false };
  }

  const si = t.shellIntegration;
  const execution = si.executeCommand(effectiveCommand);

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
    // 读流关闭后静默 3s → 判断是否为交互式等待输入：
    //   是 → 通知前端呼吸灯，不 finish（等用户在终端操作或超时兜底）
    //   否 → finish(0)，视为命令已完成（end 事件丢失的补偿）
    let lastStdoutLen = 0;
    let idleCount = 0;
    let prompted = false;
    const IDLE_THRESHOLD = 3;
    const idlePoller = setInterval(() => {
      const curLen = stdout.length;
      if (curLen === lastStdoutLen && curLen > 0) {
        idleCount++;
        if (idleCount >= IDLE_THRESHOLD) {
          if (!prompted && isWaitingForStdin(stdout)) {
            // 命令在等用户输入：通知 + 呼吸灯，不 finish
            prompted = true;
            console.log("[terminal] 检测到交互提示 → 通知前端呼吸灯, stdout 末尾:", JSON.stringify(stdout.slice(-200)));
            notifyWaiting();
            vscode.window.showInformationMessage(
              "Axon 终端正在等待你的输入。请切换到终端面板操作。",
              "打开终端",
            ).then((choice) => {
              if (choice === "打开终端") t.show(true);
            });
          } else {
            // 正常命令已完成：finish(0) 补偿丢失的 end 事件
            console.log("[terminal] idle poll: no new output for 3s, treating as complete, stdout 末尾:", JSON.stringify(stdout.slice(-100)));
            finish(0);
          }
        }
      } else {
        idleCount = 0;
        prompted = false;
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

  // 尝试从 shell integration 获取终端当前真实工作目录
  let actualCwd: string | undefined;
  try { actualCwd = t.shellIntegration?.cwd?.fsPath; } catch { /* 忽略 */ }

  return { stdout: cleaned, exitCode, captured: true, closed, cwd: actualCwd };
}

/**
 * 判断命令输出末尾是否看起来像在等待 stdin 输入。
 *
 * 启发式：取输出末尾最后一行，如果它很短（<200字符）且：
 * - 以 ? / : / ：结尾（提问或冒号提示），或
 * - 包含 [Y/N] / [y/N] / (Y/n) 等常见选择语法
 * 则很可能在等待用户输入。
 *
 * 这不是硬编码文案——是基于"交互提示的形状特征"来判断。
 */
function isWaitingForStdin(output: string): boolean {
  const tail = output.slice(-600);
  const lines = tail.split(/\r?\n/).filter(l => l.trim());
  const last = (lines[lines.length - 1] || "").trim();
  if (!last) return false;
  // 短行 + 结尾是 ? / : / ：→ 提问/冒号提示
  const promptEnd = /[?：:]\s*$/.test(last) && last.length < 200;
  // 常见的 Y/N 选择括号语法
  const choiceSyntax = /[\[\(]\s*[Yy](?:\s*\/\s*[Nn])?\s*[\]\)]/.test(last);
  return promptEnd || choiceSyntax;
}

/** 去除 ANSI 转义序列与终端控制字符 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "");
}

/** 聚焦 "Axon" 终端（从前端"打开终端"按钮触发） */
export function focusTerminal(): void {
  // 找到第一个存活终端并聚焦
  for (const t of terminals.values()) {
    if (t && !t.exitStatus) {
      t.show(false);
      return;
    }
  }
}
