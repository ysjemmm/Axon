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
  // 每个 runner 实例独立 terminalKey，保证不同 session 不共享终端
  private terminalKey = `axon-${++cmdSeq}-${Date.now().toString(36)}`;
  // 命令队列：同一终端的命令必须串行执行，防止并发中断
  private queue: Promise<unknown> = Promise.resolve();

  async exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    // 串行化：每条命令排队等待前一条完成后再执行
    const task = this.queue.then(async () => {
      const result = await runInTerminalCaptured(command, opts.cwd, opts.timeoutMs, opts.signal, this.terminalKey, opts.onWaitingInput);

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

      // 超时：exitCode 为 null 表示命令在超时窗口内未结束（可能仍在终端运行）
      const timedOut = result.exitCode === null;
      return {
        stdout: result.stdout,
        stderr: "",
        timedOut,
        exitCode: timedOut ? null : result.exitCode,
        cwd: result.cwd,
      } satisfies ExecResult;
    });

    // 更新队列头（不管成功失败，后续命令都能继续执行）
    this.queue = task.catch(() => {});

    return task;
  }
}
