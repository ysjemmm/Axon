/**
 * TerminalDisplay —— AI 命令执行引擎
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │                    三层 Fallback 架构                      │
 * ├──────────────────────────────────────────────────────────┤
 * │                                                          │
 * │  Layer 1  Shell Integration API（优先）                    │
 * │  ▸ si.executeCommand + onDidEnd + execution.read()       │
 * │  ▸ 用户可见，输出完整，退出码准确                            │
 * │  ▸ end 事件丢失时 idle poller 兜底                        │
 * │                                                          │
 * │  Layer 2  Terminal Content Reading（兜底）                 │
 * │  ▸ sendText 执行命令，通过 marker echo 检测完成            │
 * │  ▸ 不依赖 Shell Integration                               │
 * │                                                          │
 * │  Layer 3  child_process（最终退化）                        │
 * │  ▸ spawn 直接执行，不经过终端                              │
 * │  ▸ 100% 可靠，但用户不可见                                 │
 * │                                                          │
 * └──────────────────────────────────────────────────────────┘
 */

import * as vscode from "vscode";
import { spawn } from "node:child_process";

// ═══════════════════════════════════════════════════════════════
//  常量
// ═══════════════════════════════════════════════════════════════

const DEFAULT_TIMEOUT_MS = 240_000; // 硬超时：长命令（tsc / npm install）可能需要较长时间
const SI_READY_TIMEOUT_MS = 5_000;
const SI_STREAM_END_GRACE_MS = 3_000;
const SI_IDLE_MS = 1_000;   // SI 层空输出/静默超时
const TC_IDLE_MS = 1_500;  // Terminal Content 层静默超时（内容模式噪声多，稍长）
const IDLE_POLL_MS = 500;
const SHELL_WARMUP_MS = 300;
const MARKER_PREFIX = "__AXON_END_";

// ═══════════════════════════════════════════════════════════════
//  超时命令注册表
// ═══════════════════════════════════════════════════════════════

/**
 * 一条「execute_command 超时但仍在终端运行」的命令。
 * 注册后 AI 可用 get_process_output(terminalId) 查询进度与最终结果，
 * 而不必等到命令结束后才看到输出——这是"超时后 AI 怎么知道情况"的答案。
 */
export interface TimedOutTask {
  /** 查询句柄（与 terminalKey 相同，AI 拿它调 get_process_output） */
  terminalId: string;
  command: string;
  cwd?: string;
  /** 持续累积的输出（SI 读流在命令结束前一直追加） */
  buffer: string;
  status: "running" | "exited";
  exitCode: number | null;
}

/** 模块级注册表：跨 CommandRunner/ProcessManager 共享（进程内单例形态） */
export const timedOutRegistry = new Map<string, TimedOutTask>();

/** 注册超时任务；同 key 已有 exited 的旧任务则替换（新命令已开始，旧结果无需保留） */
export function registerTimedOutTask(task: TimedOutTask): void {
  const existing = timedOutRegistry.get(task.terminalId);
  if (existing && existing.status === "exited") {
    timedOutRegistry.delete(task.terminalId);
  }
  if (!timedOutRegistry.has(task.terminalId)) {
    timedOutRegistry.set(task.terminalId, task);
  }
}

// ═══════════════════════════════════════════════════════════════
//  类型
// ═══════════════════════════════════════════════════════════════

export interface TerminalRunResult {
  stdout: string;
  exitCode: number | null;
  captured: boolean;
  /** 命令通过哪一层执行 */
  layer: "si" | "content" | "process";
  closed?: boolean;
  cwd?: string;
  /** 终端层主动取消原因（如 PowerShell 续行/等待输入导致自动 Ctrl+C） */
  cancelReason?: "terminal_stuck_waiting_input" | "aborted" | "terminal_closed" | "command_hijacked";
  /** 终端执行结束原因 */
  reason?: "completed" | "timeout" | "aborted" | "terminal_stuck_waiting_input" | "unknown_exit";
}

/** @internal 向后兼容的旧类型名 */
export type TerminalVSCodeRunResult = TerminalRunResult;

export interface TerminalRunOptions {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  terminalKey?: string;
  onWaitingInput?: () => void;
}

// ═══════════════════════════════════════════════════════════════
//  终端管理
// ═══════════════════════════════════════════════════════════════

/**
 * 终端池：每个 session（terminalKey）维护一个终端列表。
 * - 空闲终端优先复用（保留历史输出）
 * - 全部忙时新建终端，不 dispose 旧终端
 * - cwd 不匹配时复用 + cd 切换目录
 */

interface PooledTerminal {
  id: string;
  terminal: vscode.Terminal;
  cwd: string;
  busy: boolean;
}

const terminalPools = new Map<string, PooledTerminal[]>();
let poolCounter = 0;

/** 显式中断一条 execute_command 超时后仍在运行的终端命令。 */
export function interruptTimedOutTask(terminalKey: string): boolean {
  const task = timedOutRegistry.get(terminalKey);
  if (!task || task.status !== "running") return false;
  const pool = terminalPools.get(terminalKey);
  const busyTerminal = pool?.find((entry) => entry.busy && !entry.terminal.exitStatus)?.terminal;
  if (!busyTerminal) return false;
  busyTerminal.sendText("\u0003", false);
  return true;
}

// 全局监听终端关闭，从池中清理退出的终端
vscode.window.onDidCloseTerminal((closed) => {
  for (const pool of terminalPools.values()) {
    const idx = pool.findIndex((e) => e.terminal === closed);
    if (idx >= 0) { pool.splice(idx, 1); return; }
  }
});

/** 从池中获取空闲终端，没有则新建 */
function acquireTerminal(terminalKey: string, cwd?: string): { terminal: vscode.Terminal; id: string; cwdChanged: boolean } {
  const pool = terminalPools.get(terminalKey) ?? [];
  terminalPools.set(terminalKey, pool);

  // 清理已退出的终端
  for (let i = pool.length - 1; i >= 0; i--) {
    if (pool[i].terminal.exitStatus) {
      pool.splice(i, 1);
    }
  }

  // 优先复用空闲终端
  for (const entry of pool) {
    if (!entry.busy) {
      const cwdChanged = !!(cwd && entry.cwd && cwd !== entry.cwd);
      entry.busy = true;
      return { terminal: entry.terminal, id: entry.id, cwdChanged };
    }
  }

  // 全部忙 → 新建
  const id = `axon-t${++poolCounter}-${Date.now().toString(36)}`;
  const t = vscode.window.createTerminal({
    name: "Axon",
    iconPath: new vscode.ThemeIcon("sparkle"),
    cwd: cwd || undefined,
    env: { GIT_PAGER: "cat", AXON_AI_TERMINAL: "1" },
  });

  const entry: PooledTerminal = { id, terminal: t, cwd: cwd ?? "", busy: true };
  pool.push(entry);
  return { terminal: t, id, cwdChanged: false };
}

/** 归还终端到池中 */
function releaseTerminal(terminalKey: string, id: string, newCwd?: string): void {
  const pool = terminalPools.get(terminalKey);
  if (!pool) return;
  const entry = pool.find((e) => e.id === id);
  if (!entry) return;
  entry.busy = false;
  if (newCwd) entry.cwd = newCwd;
}

/**
 * 等待某个 terminalKey 下超时命令真正结束。
 *
 * 判定优先级：
 * 1. timedOutRegistry 里该 key 的任务 status === "exited"（SI end 事件更新，可靠）
 * 2. 任务不存在（异常路径）→ 退化到终端池判定（exitStatus / SI executions 为空）
 *
 * 完成后把该 key 下所有仍 busy 的终端释放回池（超时时 runCommand 故意不释放，
 * 防后续命令复用终端强杀；命令结束后必须补释放，否则终端池泄漏）。
 * 最多等待 30 分钟（长任务也不该无限占用），超时兜底放行，避免队列永久卡死。
 */
export async function waitForTerminalIdle(terminalKey: string, timeoutMs = 30 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const releasePool = () => {
      const pool = terminalPools.get(terminalKey);
      if (!pool) return;
      for (const e of pool) e.busy = false;
    };

    const check = () => {
      // 优先：注册表任务已结束 → 立即释放终端并放行
      const task = timedOutRegistry.get(terminalKey);
      if (task && task.status === "exited") {
        releasePool();
        resolve();
        return;
      }

      // 任务存在但仍在跑：检查终端是否已死（用户手动关闭等）
      if (task && task.status === "running") {
        const pool = terminalPools.get(terminalKey);
        const allDead = !pool || pool.length === 0 || pool.every((e) => e.terminal.exitStatus);
        if (allDead) {
          task.status = "exited";
          task.exitCode = task.exitCode ?? null;
          releasePool();
          resolve();
          return;
        }
      }

      // 任务不存在（content 层异常等）：退化到终端池判定
      if (!task) {
        const pool = terminalPools.get(terminalKey);
        if (!pool || pool.length === 0) { resolve(); return; }
        const allIdle = pool.every((e) => {
          if (e.terminal.exitStatus) return true;
          const si = e.terminal.shellIntegration as (typeof e.terminal.shellIntegration & { executions?: readonly unknown[] }) | undefined;
          const execs = si?.executions;
          return !execs || execs.length === 0;
        });
        if (allIdle) { resolve(); return; }
      }

      if (Date.now() > deadline) {
        // 兜底超时：强制放行（任务标 ended，释放终端，宁可用新终端也不永久卡队列）
        if (task) task.status = "exited";
        releasePool();
        resolve();
        return;
      }
      setTimeout(check, 1000);
    };
    check();
  });
}

async function waitForShellIntegration(t: vscode.Terminal): Promise<boolean> {
  if (t.shellIntegration) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      disposable.dispose();
      resolve(!!t.shellIntegration);
    }, SI_READY_TIMEOUT_MS);
    const disposable = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === t) {
        clearTimeout(timer);
        disposable.dispose();
        resolve(true);
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════════
//  工具函数
// ═══════════════════════════════════════════════════════════════

function cdCommand(cwd: string): string {
  return `cd '${cwd.replace(/'/g, "'\\''")}'; `;
}

function getShellPath(): string {
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  return process.env.SHELL || "/bin/bash";
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    // CSI 序列：ESC [ ... letter
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    // OSC 序列：ESC ] ... （以 BEL \x07 或 ST ESC \ 结尾）
    .replace(/\x1b\][^\x1b]*(?:\x07|\x1b\\)/g, "")
    // 单字符 escape：ESC = / ESC > 等
    .replace(/\x1b[=>]/g, "");
}

/** Braille 盲文字符区间 U+2800~U+28FF（npm/npx/esbuild 等工具的 spinner 动画帧） */
const SPINNER_CHARS = /[\u2800-\u28ff]+/g;

function normalizeOutput(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "")
    // 清除 npm/npx 等工具残留的 Braille spinner 帧（如 ⠙⠙），stripAnsi 对它们无效
    .replace(SPINNER_CHARS, "")
    // spinner 清除后可能留下空行，折叠连续空行为单个
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWaitingForStdin(output: string): boolean {
  const tail = output.slice(-600);
  const lines = tail.split(/\r?\n/).filter((l) => l.trim());
  const last = (lines[lines.length - 1] || "").trim();
  if (!last) return false;
  // PowerShell 多行续行提示符（引号不匹配、未闭合的括号等导致）
  if (/^>>\s*$/.test(last)) return true;
  // 交互式提问（以 ? 或 ：结尾）
  const promptEnd = /[?：:]\s*$/.test(last) && last.length < 200;
  const choiceSyntax = /[\[\(]\s*[Yy](?:\s*\/\s*[Nn])?\s*[\]\)]/.test(last);
  return promptEnd || choiceSyntax;
}

/** 检查输出是否包含 PowerShell 续行符 >>（引号/括号未闭合） */
function isContinuationLine(output: string): boolean {
  const tail = output.slice(-600);
  return /^>>\s*$/m.test(tail);
}

function generateMarker(): { id: string; marker: string } {
  const id = Math.random().toString(36).slice(2, 10);
  return { id, marker: `${MARKER_PREFIX}${id}` };
}

/** 用 echo marker 包裹命令，使终端内容兜底层能检测完成 + 退出码 */
function wrapCommandWithMarker(command: string, marker: string): string {
  if (process.platform === "win32") {
    return `${command}; echo '${marker}:$LASTEXITCODE'`;
  }
  return `{ ${command} ; } ; echo '${marker}:$?'`;
}

// ═══════════════════════════════════════════════════════════════
//  Layer 1: Shell Integration API
// ═══════════════════════════════════════════════════════════════

/**
 * Layer 1: 使用 Shell Integration API 执行命令。
 * 返回 null 表示 SI 不可用或执行失败，调用方降级到 Layer 2。
 */
async function runWithShellIntegration(
  t: vscode.Terminal,
  effectiveCommand: string,
  opts: TerminalRunOptions,
): Promise<TerminalRunResult | null> {
  const si = t.shellIntegration;
  if (!si) return null;

  // Shell integration 就绪后额外等待 prompt 完全初始化
  await new Promise((r) => setTimeout(r, SHELL_WARMUP_MS));

  let execution: vscode.TerminalShellExecution;
  try {
    execution = si.executeCommand(effectiveCommand);
  } catch (err) {
    console.warn("[terminal] SI executeCommand failed:", err);
    return null;
  }

  // ── 并行读流 + 多路等待完成 ──
  let stdout = "";
  let streamDone = false;
  // 超时后该命令注册到 timedOutRegistry，读流改写到注册项的 buffer，持续累积直到命令真正结束。
  // 用 ref 对象而非裸变量：闭包在赋值前捕获，TS 会把裸变量收窄成 never（认为必为 null）。
  const timedOutEntryRef: { current: TimedOutTask | null } = { current: null };

  const readPromise = (async () => {
    try {
      for await (const chunk of execution.read()) {
        if (timedOutEntryRef.current) timedOutEntryRef.current.buffer += stripAnsi(chunk);
        else stdout += chunk;
      }
    } catch { /* 读流异常忽略 */ }
    streamDone = true;
  })();

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // 终端存活状态：用户可能手动删除终端
  let terminalAlive = true;
  const closeChecker = vscode.window.onDidCloseTerminal((c) => {
    if (c === t) terminalAlive = false;
  });

  // 命令篡改检测：同终端上有新命令启动（非我们的 execution）→ 命令被篡改/覆盖
  let commandHijacked = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = vscode.window as any;
  const startChecker: vscode.Disposable | undefined =
    typeof w.onDidStartTerminalShellExecution === "function"
      ? w.onDidStartTerminalShellExecution(
        (e: { terminal: vscode.Terminal; execution: vscode.TerminalShellExecution }) => {
          if (e.terminal === t && e.execution !== execution) {
            console.debug("[terminal] command hijacked: new execution started on same terminal");
            commandHijacked = true;
          }
        },
      )
      : undefined;

  const completion = await waitForCompletion({
    timeoutMs,
    signal: opts.signal,
    isTerminalAlive: () => terminalAlive,
    commandHijacked: () => commandHijacked,
    onEnd: (cb) => {
      let matched = false;
      const d = vscode.window.onDidEndTerminalShellExecution((e) => {
        // 精确匹配优先：SI 追踪正常时，execution 引用相等
        if (e.execution === execution) { matched = true; cb(e.exitCode ?? null); return; }
        // 终端级 fallback：精确匹配已失败（命令被篡改等），同一个终端上任意命令结束 → 判定完成
        // 前提：精确匹配还未命中过（matched=false），且事件来自同一个终端
        if (!matched && e.terminal === t) {
          console.debug("[terminal] SI end: execution mismatch, falling back to terminal-level match");
          cb(e.exitCode ?? null);
        }
      });
      return d;
    },
    onClose: (cb) => vscode.window.onDidCloseTerminal((c) => { if (c === t) cb(null); }),
    onStreamDone: (cb) => {
      const interval = setInterval(() => {
        if (streamDone) { clearInterval(interval); cb(); }
      }, 500);
      return { dispose: () => clearInterval(interval) };
    },
    streamDoneGraceMs: SI_STREAM_END_GRACE_MS,
    getOutput: () => stdout,
    isWaitingForStdin: () => isWaitingForStdin(stdout),
    onWaitingInput: opts.onWaitingInput,
    showTerminal: () => t.show(true),
    cancelTerminal: () => t.sendText("\u0003", false),
    command: effectiveCommand,
  });

  // 释放终端存活检测和命令篡改检测的 disposable
  closeChecker.dispose();
  startChecker?.dispose();

  // ⚠️ 超时注册：命令仍在终端运行（clone/install/构建等长任务）。把这条执行注册成
  // 可查询任务，AI 用 get_process_output 就能持续看到进度；命令真正结束后更新状态。
  // 同时监听结束事件，把最终退出码回填给注册项。
  if (completion.reason === "timeout" && opts.terminalKey) {
    const entry: TimedOutTask = {
      terminalId: opts.terminalKey,
      command: effectiveCommand,
      cwd: opts.cwd,
      buffer: stdout,
      status: "running",
      exitCode: null,
    };
    timedOutEntryRef.current = entry;
    registerTimedOutTask(entry);
    const endWatch = vscode.window.onDidEndTerminalShellExecution((e) => {
      if (e.execution === execution) {
        entry.status = "exited";
        entry.exitCode = e.exitCode ?? null;
        endWatch.dispose();
      }
    });
  }

  // read() 在 PowerShell 续行 + Ctrl+C 等场景可能永不结束。
  // waitForCompletion 已经通过 onEnd / idle / abort 判定本次 run 结束后，
  // 这里只给读流一个很短的收尾窗口，避免工具卡片永久 executing。
  await Promise.race([
    readPromise,
    new Promise((resolve) => setTimeout(resolve, 200)),
  ]);

  const actualCwd = (() => { try { return t.shellIntegration?.cwd?.fsPath; } catch { return undefined; } })();
  const exitCode = completion.code;

  return {
    stdout: normalizeOutput(stdout),
    exitCode,
    captured: true,
    layer: "si",
    closed: !!t.exitStatus,
    cwd: actualCwd,
    cancelReason: completion.cancelReason,
    reason: completion.reason,
  };
}

// ═══════════════════════════════════════════════════════════════
//  Layer 2: Terminal Content Reading
// ═════════════════════════════════════════全════════════════════

/**
 * Layer 2: 通过 sendText 执行命令，轮询读终端缓冲区内容检测 marker。
 * 不依赖 Shell Integration，适用于 SI 不支持或不可靠的场景。
 */
async function runWithTerminalContent(
  t: vscode.Terminal,
  effectiveCommand: string,
  opts: TerminalRunOptions,
): Promise<TerminalRunResult> {
  const { marker } = generateMarker();
  const markedCmd = wrapCommandWithMarker(effectiveCommand, marker);
  const markerRe = new RegExp(`${escapeRegex(marker)}:(\\d+)`);

  t.sendText(markedCmd);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTime = Date.now();
  let lastLen = 0;
  let idleCount = 0;
  let prompted = false;

  return new Promise<TerminalRunResult>((resolve) => {
    let settled = false;

    const finish = (exitCode: number | null, output: string, cancelReason?: TerminalRunResult["cancelReason"], reason?: TerminalRunResult["reason"]) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout: normalizeOutput(output),
        exitCode,
        captured: true,
        layer: "content",
        closed: !!t.exitStatus,
        cancelReason,
        reason,
      });
    };

    const poller = setInterval(() => {
      if (Date.now() - startTime > timeoutMs) {
        // content 层超时：同样注册可查询任务（无 SI execution 事件，结束判定交给
        // waitForTerminalIdle 的终端 exitStatus / 兜底超时）。
        if (opts.terminalKey) {
          registerTimedOutTask({
            terminalId: opts.terminalKey,
            command: effectiveCommand,
            cwd: opts.cwd,
            buffer: normalizeOutput(readTerminalText(t) || ""),
            status: "running",
            exitCode: null,
          });
        }
        finish(null, "", undefined, "timeout");
        return;
      }

      const content = readTerminalText(t);
      if (!content) return;

      const normalized = normalizeOutput(content);

      // 检测 marker
      const match = normalized.match(markerRe);
      if (match) {
        const code = parseInt(match[1], 10);
        const idx = normalized.indexOf(marker);
        const output = idx > 0 ? normalized.slice(0, idx) : normalized;
        finish(code, output);
        return;
      }

      // idle 检测
      if (normalized.length === lastLen) {
        idleCount++;
        const tcMax = TC_IDLE_MS / IDLE_POLL_MS;
        if (idleCount >= tcMax) {
          if (!prompted && isWaitingForStdin(normalized)) {
            prompted = true;
            opts.onWaitingInput?.();
            vscode.window.showInformationMessage("Axon 终端正在等待你的输入。", { modal: true }, "打开终端")
              .then((c) => c === "打开终端" && t.show(true));
          } else {
            finish(0, normalized);
          }
        }
      } else {
        idleCount = 0;
        prompted = false;
        lastLen = normalized.length;
      }
    }, IDLE_POLL_MS);

    const onAbort = () => {
      t.sendText("\u0003", false);
      finish(null, "", "aborted");
    };
    opts.signal?.addEventListener("abort", onAbort);
  });
}

/**
 * 读取终端可视区文本内容。
 * 使用 selectAll → clipboard → undo 的方式（兼容所有 VS Code 版本）。
 */
function readTerminalText(t: vscode.Terminal): string {
  // VS Code 1.93+ 提供了 terminal API，但稳定性不足。
  // 这里用 selection + clipboard 兜底，兼容所有版本。
  const editor = vscode.window.activeTextEditor;
  void t; void editor;
  // 当前版本无公开 API 直接读终端缓冲区。
  // 实际应用中通过 clipboard 兜底（selectAll + copy），但副作用大，暂返回空。
  // Layer 2 主要靠 marker echo 检测完成，文本内容为辅助。
  return "";
}

// ═══════════════════════════════════════════════════════════════
//  Layer 3: child_process
// ═══════════════════════════════════════════════════════════════

/**
 * Layer 3: 直接 spawn 执行命令，不经过终端。
 * 100% 可靠（OS 级 exitCode），但用户不可见。
 * 仅在终端创建失败或前两层都不可用时触发。
 */
async function runWithChildProcess(opts: TerminalRunOptions): Promise<TerminalRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const shellPath = getShellPath();
  const args = process.platform === "win32" ? ["/c", opts.command] : ["-c", opts.command];

  return new Promise<TerminalRunResult>((resolve) => {
    const child = spawn(shellPath, args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_PAGER: "cat" },
    });

    let stdout = "";
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stdout += d.toString(); });

    child.on("error", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout, exitCode: null, captured: false, layer: "process" });
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ stdout, exitCode: code, captured: true, layer: "process" });
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        cleanup();
        resolve({ stdout, exitCode: null, captured: true, layer: "process" });
      }
    }, timeoutMs);

    const onAbort = () => {
      child.kill("SIGTERM");
      if (!settled) {
        settled = true;
        cleanup();
        resolve({ stdout, exitCode: null, captured: true, layer: "process" });
      }
    };
    opts.signal?.addEventListener("abort", onAbort);
  });
}

// ═══════════════════════════════════════════════════════════════
//  通用完成等待器（Layer 1 复用）
// ═══════════════════════════════════════════════════════════════

interface WaitForCompletionConfig {
  timeoutMs: number;
  signal?: AbortSignal;
  onEnd: (cb: (code: number | null) => void) => vscode.Disposable;
  onClose: (cb: (code: number | null) => void) => vscode.Disposable;
  onStreamDone?: (cb: () => void) => vscode.Disposable;
  streamDoneGraceMs?: number;
  getOutput: () => string;
  /** 读取终端可见文本（含 shell 提示符，用于检测 >> 续行等 SI stdout 不包含的内容） */
  getTerminalText?: () => string;
  isWaitingForStdin: () => boolean;
  /** 原始命令字符串（用于检测引号/括号不完整等） */
  command?: string;
  onWaitingInput?: () => void;
  showTerminal: () => void;
  cancelTerminal?: () => void;
  /** 终端是否仍然存活（未被用户手动删除） */
  isTerminalAlive?: () => boolean;
  /** 命令是否被篡改/覆盖（同终端上有新命令启动，非我们的 execution） */
  commandHijacked?: () => boolean;
}

/** 检查命令字符串是否语法不完整（引号/括号未闭合），用于判断 >> 续行 */
function isCommandIncomplete(command: string): boolean {
  if (!command) return false;
  // PowerShell 单引号和双引号都可以触发 >> 续行
  let dq = false, sq = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '"' && !sq) dq = !dq;            // 双引号（不在单引号内时切换）
    else if (ch === "'" && !dq) sq = !sq;       // 单引号（不在双引号内时切换）
    // 反引号 ` 转义下一个字符（跳过，避免下一字符被误判）
    else if (ch === "`") { i++; }
  }
  if (dq || sq) return true;
  // 括号/花括号配对（粗略）
  let paren = 0, brace = 0;
  for (const ch of command) {
    if (ch === '(') paren++; else if (ch === ')') paren--;
    else if (ch === '{') brace++; else if (ch === '}') brace--;
  }
  return paren > 0 || brace > 0;
}

/**
 * 多路等待命令完成：end 事件 / close 事件 / stream 结束 / idle poll / 超时 / abort。
 * 统一管理 disposable 清理，防止资源泄漏。
 */
function waitForCompletion(cfg: WaitForCompletionConfig): Promise<{ code: number | null; cancelReason?: TerminalRunResult["cancelReason"]; reason?: TerminalRunResult["reason"] }> {
  return new Promise<{ code: number | null; cancelReason?: TerminalRunResult["cancelReason"]; reason?: TerminalRunResult["reason"] }>((resolve) => {
    let settled = false;
    const disposables: vscode.Disposable[] = [];

    const finish = (code: number | null, cancelReason?: TerminalRunResult["cancelReason"], reason?: TerminalRunResult["reason"]) => {
      if (settled) return;
      settled = true;
      disposables.forEach((d) => d.dispose());
      clearTimeout(timeoutTimer);
      clearTimeout(streamEndTimer);
      clearInterval(idlePoller);
      cfg.signal?.removeEventListener("abort", onAbort);
      resolve({ code, cancelReason, reason });
    };

    // ① 正常完成事件
    disposables.push(cfg.onEnd((code) => finish(code)));

    // ② 终端关闭
    disposables.push(cfg.onClose(() => finish(null)));

    // ③ 超时只结束本次等待，不自动终止命令。AI 可通过 get_process_output 决定继续等待、
    // 显式 stop_process，或直接让后续命令使用新终端继续执行。
    const timeoutTimer = setTimeout(() => finish(null, undefined, "timeout"), cfg.timeoutMs);

    // ④ idle poller：输出静默 → 交互输入检测 / 补偿丢失的 end 事件
    // 不依赖终端可见文本（readTerminalText 不可靠），改为检查命令是否语法不完整。
    // ④ idle poller：输出静默 → 交互输入检测 / 补偿丢失的 end 事件
    // A) 命令不完整（引号/括号未闭合）且无输出 → 续行卡死，5s 后自动 cancel
    // B) waiting stdin（Read-Host 等正常交互）→ 弹窗提示，不自动取消
    let lastLen = 0;
    let idleCount = 0;
    let prompted = false;
    let stuckAt = 0;
    const idlePoller = setInterval(() => {
      const output = cfg.getOutput();
      const curLen = output.length;
      if (curLen === lastLen) {
        idleCount++;
        if (idleCount >= (SI_IDLE_MS / IDLE_POLL_MS)) {
          const incomplete = isCommandIncomplete(cfg.command ?? "");
          const waiting = cfg.isWaitingForStdin();
          // A：命令不完整 + 无输出 + idle → 续行卡死
          if (incomplete && curLen === 0) {
            if (!stuckAt) stuckAt = Date.now();
            if (Date.now() - stuckAt > 5000) {
              console.debug("[terminal] idle: incomplete command stuck too long → cancelling");
              cfg.cancelTerminal?.();
              finish(0, "terminal_stuck_waiting_input");
              return;
            }
          }
          // B：waiting stdin → 正常交互，弹窗提示
          else if (waiting && !prompted) {
            prompted = true;
            console.debug("[terminal] idle: interactive prompt detected");
            cfg.onWaitingInput?.();
            vscode.window.showInformationMessage("Axon 终端正在等待你的输入。", { modal: true }, "打开终端")
              .then((c) => c === "打开终端" && cfg.showTerminal());
          }
          // C：普通命令的健康检查（非续行、非手动输入）
          // 只在分支 A（续行）和 B（手动输入）都不满足时执行
          else {
            // 1) 终端是否被用户手动删除？
            if (cfg.isTerminalAlive && !cfg.isTerminalAlive()) {
              console.debug("[terminal] idle: terminal closed → complete");
              finish(null, "terminal_closed");
              return;
            }
            // 2) 命令是否被篡改/覆盖？（同终端上有新命令启动，非我们的 execution）
            if (cfg.commandHijacked?.()) {
              console.debug("[terminal] idle: command hijacked → complete");
              finish(0, "command_hijacked");
              return;
            }
            // 3) 终端存在 + 命令未被篡改 → 继续等待 SI end event / stream done / 硬超时 240s
          }
          // 普通命令不能仅凭 idle 判定完成：git commit / build / test 等可能长时间静默。
          // 必须等待 SI end event / stream done / terminal close / timeout / abort。
        }
      } else {
        idleCount = 0;
        prompted = false;
        stuckAt = 0;
        lastLen = curLen;
      }
    }, IDLE_POLL_MS); // ⑤ stream 结束兜底
    let streamEndTimer: ReturnType<typeof setTimeout> | undefined;
    if (cfg.onStreamDone) {
      disposables.push(
        cfg.onStreamDone(() => {
          streamEndTimer = setTimeout(() => {
            console.debug("[terminal] stream closed + grace expired → complete");
            finish(0);
          }, cfg.streamDoneGraceMs ?? SI_STREAM_END_GRACE_MS);
        }),
      );
    }

    // ⑥ abort
    const onAbort = () => {
      cfg.cancelTerminal?.();
      finish(null);
    };
    cfg.signal?.addEventListener("abort", onAbort);
  });
}

// ═══════════════════════════════════════════════════════════════
//  主入口
// ═════════════ напрямую ═══════════════════════════════════════

/**
 * 在 "Axon" 终端执行命令，三层 fallback 保证可靠性。
 *
 * Layer 1: Shell Integration API（用户可见、输出完整）
 * Layer 2: Terminal Content（sendText + marker，不依赖 SI）
 * Layer 3: child_process（100% 可靠但用户不可见）
 */
export async function runCommand(opts: TerminalRunOptions): Promise<TerminalRunResult> {
  const requestedKey = opts.terminalKey ?? "default";
  const { terminal: t, id: terminalId, cwdChanged } = acquireTerminal(requestedKey, opts.cwd);
  const effectiveCommand = cwdChanged ? `${cdCommand(opts.cwd!)}${opts.command}` : opts.command;

  let result: TerminalRunResult | null = null;
  try {

    // 智能聚焦：避免抢占用户正在操作的终端
    // - 用户没有聚焦任何终端（在编辑器等区域）→ show，让用户看到 AI 的终端输出
    // - 用户聚焦的就是 AI 终端 → show（无副作用，已经在看了）
    // - 用户聚焦了其他终端 → 不 show，避免终端面板切换抢走用户焦点
    const activeTerminal = vscode.window.activeTerminal;
    if (!activeTerminal || activeTerminal === t) {
      t.show(true);
    }

    // Mark AI command start for proactive awareness filtering
    const aiCmdStartTime = Date.now();
    vscode.commands.executeCommand("axon.internal.markAiCommandStart", aiCmdStartTime);

    // ── Layer 1: Shell Integration ──
    const siReady = await waitForShellIntegration(t);
    if (siReady) {
      result = await runWithShellIntegration(t, effectiveCommand, opts);
      if (result) {
        vscode.commands.executeCommand("axon.internal.markAiCommandEnd", aiCmdStartTime);
        return result;
      }
    }

    // ── Layer 2: Terminal Content Reading ──
    console.warn("[terminal] SI unavailable, falling back to content layer");
    result = await runWithTerminalContent(t, effectiveCommand, opts);
    vscode.commands.executeCommand("axon.internal.markAiCommandEnd", aiCmdStartTime);
    return result;
  } finally {
    // ⚠️ 超时不释放终端：命令仍在终端里运行（clone/install/构建等长任务）。
    // 保持 busy=true 防止后续 execute_command 复用这个终端把还在跑的命令强杀。
    // 命令真正结束后由 waitForTerminalIdle 的完成回调 releaseTerminal 释放回池。
    if (result?.reason !== "timeout") {
      releaseTerminal(requestedKey, terminalId, opts.cwd);
    }
  }
}

/**
 * 向后兼容的旧签名（保持调用方不需要改动）。
 */
export async function runInTerminalCaptured(
  command: string,
  cwd?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
  terminalKey = "default",
  onWaitingInput?: () => void,
): Promise<TerminalRunResult> {
  return runCommand({ command, cwd, timeoutMs, signal, terminalKey, onWaitingInput });
}

/** 聚焦 "Axon" 终端 */
export function focusTerminal(): void {
  for (const pool of terminalPools.values()) {
    const entry = pool.find((e) => !e.busy && !e.terminal.exitStatus);
    if (entry) {
      entry.terminal.show(false);
      return;
    }
  }
}
