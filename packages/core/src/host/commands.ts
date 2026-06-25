/**
 * 命令执行抽象（执行端 ① 的一部分）
 *
 * 把 tools.ts 中 execute_command 用到的 child_process.exec + PowerShell UTF-8 包装
 * 收敛到这里。注意职责边界：
 * - 危险命令检测（detectDangerousCommand）是【与形态无关的安全策略】，留在 core，
 *   在调用 host.commands.exec 之前执行。host 实现只负责“把命令跑起来并回收输出”。
 * - 不同形态可有不同执行体：
 *   · NodeAgentHost：exec + shell 包装（现有逻辑）
 *   · VSCodeAgentHost：可选用集成终端（vscode.Terminal）或仍走 child_process
 */

/** 命令执行选项 */
export interface ExecOptions {
  /** 工作目录（绝对路径） */
  cwd: string;
  /** 超时毫秒数；超时后实现应终止进程并在结果中标记 timedOut */
  timeoutMs: number;
  /** 可选中断信号（用户取消时停止等待） */
  signal?: AbortSignal;
  /** 检测到命令可能在等待 stdin 输入的回调（终端静默但命令未结束） */
  onWaitingInput?: () => void;
}

/** 命令执行结果（标准化，不抛超时异常，由 timedOut 标记） */
export interface ExecResult {
  stdout: string;
  stderr: string;
  /** 是否因超时被终止 */
  timedOut: boolean;
  /** 进程退出码；超时或异常终止时可能为 null */
  exitCode: number | null;
  /** 命令执行后终端的实际工作目录（用于同步 agentSession.terminalCwd） */
  cwd?: string;
  /** 终端层主动取消原因（如 PowerShell 续行/等待输入导致自动 Ctrl+C） */
  cancelReason?: "terminal_stuck_waiting_input" | "aborted";
}

/** Agent 可用的命令执行能力 */
export interface HostCommandRunner {
  /**
   * 执行一条 shell 命令并回收全部输出。
   * 实现需自行处理平台编码问题（如 Windows 下 PowerShell 的 UTF-8 链路）。
   * 不应在“命令以非零码退出”时抛错——把退出码与 stderr 一并返回，交由 core 决定如何反馈模型。
   * 仅在无法启动进程等基础设施级故障时才抛错。
   */
  exec(command: string, opts: ExecOptions): Promise<ExecResult>;
}
