/**
 * NodeCommandRunner —— 基于 child_process 的 HostCommandRunner 实现
 *
 * 迁移自 tools.ts 的 execute_command 执行体：在 Windows 下用 PowerShell + UTF-8 链路
 * （chcp 65001 + Console InputEncoding/OutputEncoding）避免中文乱码。
 *
 * 职责边界：只负责“把命令跑起来并回收输出”。危险命令检测属于与形态无关的安全策略，
 * 留在 core，在调用本实现之前完成；本实现不抛“命令非零退出”错误，而是把退出码/超时
 * 标志一并返回，交由 core 决定如何反馈模型。
 */

import { exec } from "node:child_process";
import type { HostCommandRunner, ExecOptions, ExecResult } from "@axon/core";

export class NodeCommandRunner implements HostCommandRunner {
  exec(command: string, opts: ExecOptions): Promise<ExecResult> {
    // PowerShell UTF-8 包装：三处编码统一为 UTF-8，避免 GBK/UTF-8 混读导致中文乱码
    // 同时禁用 git pager：git diff/log 等在终端里会进 less 分页器阻塞等待交互
    const wrapped =
      `chcp 65001 > $null; ` +
      `[Console]::InputEncoding = [System.Text.Encoding]::UTF8; ` +
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ` +
      `$env:GIT_PAGER='cat'; ` +
      `${command}`;

    return new Promise<ExecResult>((resolve) => {
      exec(
        wrapped,
        { cwd: opts.cwd, timeout: opts.timeoutMs, encoding: "utf-8", shell: "powershell.exe" },
        (err, stdout, stderr) => {
          const e = err as (Error & { code?: number; killed?: boolean; signal?: string }) | null;
          const timedOut = !!(e && (e.killed || e.signal === "SIGTERM"));
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            timedOut,
            exitCode: e && typeof e.code === "number" ? e.code : e ? null : 0,
          });
        },
      );
    });
  }
}
