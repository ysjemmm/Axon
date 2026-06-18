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
function getOrCreateTerminal(terminalKey: string): vscode.Terminal {
  const existing = terminals.get(terminalKey);
  if (existing && !existing.exitStatus) {
    return existing;
  }
  const t = vscode.window.createTerminal({
    name: "Axon",
    iconPath: new vscode.ThemeIcon("sparkle"),
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
}

/**
 * 在 "Axon" 终端里执行命令并尽力捕获输出。
 * - shell integration 可用：捕获完整输出 + 退出码
 * - 不可用：仅执行（sendText），返回 captured=false
 * - cwd 不同时先 cd 切换再执行，始终复用同一终端
 * @param terminalKey 终端隔离键（不同 key 用不同终端，同一 key 复用）
 * @param signal 可选中断信号（用户取消时停止等待）
 */
export async function runInTerminalCaptured(
  command: string,
  cwd?: string,
  timeoutMs = 120_000,
  signal?: AbortSignal,
  terminalKey = "default",
): Promise<TerminalRunResult> {
  const t = getOrCreateTerminal(terminalKey);
  t.show(false); // 显示但不聚焦，方便用户观察

  const prevCwd = terminalCwds.get(terminalKey);
  const needCd = cwd && cwd !== prevCwd;
  if (needCd) {
    terminalCwds.set(terminalKey, cwd!);
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
    // 当读流已关闭（readPromise 完成）且持续 3 秒无新输出时，视为命令已结束。
    // 这是对 onDidEndTerminalShellExecution 不可靠时的降级补偿，不替代它。
    // 但要排除交互式命令等输入的场景——输出以交互提示结尾时不是"完成"，不能自动结束。
    let lastStdoutLen = 0;
    let idleCount = 0;
    let prompted = false;
    const IDLE_THRESHOLD = 3; // 连续 3 次（每次 1s）无新输出
    const idlePoller = setInterval(() => {
      const curLen = stdout.length;
      if (curLen === lastStdoutLen && curLen > 0) {
        idleCount++;
        if (idleCount >= IDLE_THRESHOLD) {
          // 检查输出末尾是否为交互式等待输入提示（如 Y/N、密码等）
          if (looksLikeInteractivePrompt(stdout) && !prompted) {
            prompted = true;
            console.log("[terminal] 检测到交互式等待输入，已通知用户");
            vscode.window.showInformationMessage(
              "Axon 终端正在等待你的输入。请切换到「Axon」终端面板操作。",
              "打开终端",
            ).then((choice) => {
              if (choice === "打开终端") t.show(true);
            });
            // 不 finish：命令仍在等待输入，让超时机制兜底
            return;
          }
          console.log("[terminal] idle poll triggered: no new output for 3s after stream activity, treating as complete");
          finish(0);
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

/** 检测输出末尾是否为交互式等待输入提示 */
function looksLikeInteractivePrompt(output: string): boolean {
  // 取末尾 300 字符检查，取行尾最后几个非空行
  const tail = output.slice(-500);
  const lines = tail.split(/\r?\n/).filter((l) => l.trim());
  const last = (lines[lines.length - 1] || "").trim();
  if (!last) return false;
  // 常见交互式提示模式（中/英）
  const patterns = [
    /终止批处理操作吗/i,
    /是否.*[?？]/,
    /继续.*[?？]/,
    /Do you want to continue/i,
    /Proceed.*\[.*Y.*N/i,
    /Are you sure/i,
    /confirm/i,
    /password[:：]/i,
    /请输入/i,
    /按.*键.*继续/i,
    /Press.*key.*continue/i,
    /\(Y\/N\)/i,
    /\(y\/n\)/,
    /\[Y\/N\]/i,
    /\(yes\/no\)/i,
  ];
  return patterns.some((p) => p.test(last));
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
