/**
 * VSCodeCommandRunner —— HostCommandRunner 实现（进程内 IDE 形态）
 *
 * 命令直接在用户可见的 "Axon" 集成终端里执行（对齐 Kiro 体验）：
 * - 用户全程可见命令输出，可交互输入（Read-Host、npm init 等）
 * - 用 Shell Integration API 捕获输出和退出码回填给 Agent
 * - Shell Integration 不可用时退化为"只执行不捕获"，提示 Agent 让用户去终端看结果
 * - 同一终端的命令串行执行（队列），防止并发命令互相中断
 * - 每条命令无条件 cd 到目标 cwd，不信任终端当前目录状态
 */

import type { HostCommandRunner, ExecOptions, ExecResult } from "@axon/core";
import { runInTerminalCaptured } from "./terminalDisplay.js";

let cmdSeq = 0;

export class VSCodeCommandRunner implements HostCommandRunner {
  // 命令队列：正常命令串行执行，避免同一终端上的命令互相干扰。
  private queue: Promise<unknown> = Promise.resolve();

  // 每个 session（即每个 VSCodeCommandRunner 实例）独享一个终端。
  // 同一 session 内的所有 turn 复用同一个终端，不同 session 各自独立互不干扰。
  private terminalKey = `axon-${++cmdSeq}-${Date.now().toString(36)}`;

  /** 派生独立实例：子 Agent 各占一个终端，不与父 Agent 的终端串行排队。 */
  fork(): HostCommandRunner {
    return new VSCodeCommandRunner();
  }

  async exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    // 串行化：每条命令排队等待前一条完成后再执行
    const task = this.queue.then(async () => {
      const result = await runInTerminalCaptured(command, opts.cwd, opts.timeoutMs, opts.signal, this.terminalKey, opts.onWaitingInput);

      // 超时：terminalDisplay 已向原终端发送 Ctrl+C。Shell 可能仍在收尾，因此原终端
      // 继续保持 busy；但队列必须立刻放行，下一条命令会由终端池分配全新的终端执行，
      // 不能因一条无法确认退出的命令把整个 session 永久堵住。
      if (result.reason === "timeout") {
        return {
          stdout: result.stdout || "已向终端发送 Ctrl+C 请求终止该命令。原终端可能仍在收尾，后续命令将使用新的 Axon 终端执行。",
          stderr: "命令执行超时，已请求终止。",
          timedOut: true,
          exitCode: result.exitCode,
          cwd: result.cwd,
          cancelReason: result.cancelReason,
          reason: "timeout",
          terminalId: this.terminalKey,
        } satisfies ExecResult;
      }

      // Shell Integration 不可用：命令已在终端执行，但拿不到输出
      if (!result.captured) {
        return {
          stdout:
            "（命令已在 Axon 终端中执行。当前终端未启用 Shell Integration，无法自动捕获输出——" +
            "请查看终端面板了解执行结果，或提示用户在终端中查看/操作。）",
          stderr: "",
          timedOut: false,
          exitCode: 0,
          cwd: result.cwd,
        } satisfies ExecResult;
      }

      // 终端被用户关闭：命令被强制终止
      if (result.closed) {
        return {
          stdout: result.stdout || "",
          stderr: "终端已被关闭，命令被终止。",
          timedOut: false,
          exitCode: 1,
          cwd: result.cwd,
        } satisfies ExecResult;
      }

      // 细分结束原因：优先透传终端层已判定的 reason（超时/取消等），
      // 不能把 exitCode === null 一律当成超时，也不能把超时误判成 unknown_exit。
      // （timeout 已在上面分支提前返回，这里剩余类型不含 timeout，无需再判 timedOut）
      const reason: ExecResult["reason"] = result.reason
        ?? (result.cancelReason === "terminal_stuck_waiting_input" ? "terminal_stuck_waiting_input"
          : result.cancelReason === "aborted" ? "aborted"
            : result.exitCode === null ? "unknown_exit"
              : "completed");
      return {
        stdout: result.stdout,
        stderr: "",
        timedOut: false,
        exitCode: result.exitCode,
        cwd: result.cwd,
        cancelReason: result.cancelReason,
        reason,
      } satisfies ExecResult;
    });

    // 不允许一次执行失败或超时毒化后续队列；超时后的旧终端由终端池保持 busy，
    // 下一条命令会自动取得新终端，而不会和旧命令混跑。
    this.queue = task.catch(() => undefined);

    return task;
  }
}
