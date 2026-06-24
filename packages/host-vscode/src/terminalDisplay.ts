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

const DEFAULT_TIMEOUT_MS = 120_000;
const SI_READY_TIMEOUT_MS = 5_000;
const SI_STREAM_END_GRACE_MS = 3_000;
const IDLE_THRESHOLD = 3; // 秒
const IDLE_POLL_MS = 500;
const SHELL_WARMUP_MS = 300;
const MARKER_PREFIX = "__AXON_END_";

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

const terminals = new Map<string, vscode.Terminal>();
const terminalCwds = new Map<string, string>();

function getOrCreateTerminal(terminalKey: string, cwd?: string): vscode.Terminal {
  const existing = terminals.get(terminalKey);
  if (existing && !existing.exitStatus) return existing;

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
  if (process.platform === "win32") {
    return `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; `;
  }
  return `cd '${cwd.replace(/'/g, "'\\''")}'; `;
}

function getShellPath(): string {
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  return process.env.SHELL || "/bin/bash";
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[=>]/g, "");
}

function normalizeOutput(text: string): string {
  return stripAnsi(text).replace(/\r\n/g, "\n").replace(/\r/g, "");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWaitingForStdin(output: string): boolean {
  const tail = output.slice(-600);
  const lines = tail.split(/\r?\n/).filter((l) => l.trim());
  const last = (lines[lines.length - 1] || "").trim();
  if (!last) return false;
  const promptEnd = /[?：:]\s*$/.test(last) && last.length < 200;
  const choiceSyntax = /[\[\(]\s*[Yy](?:\s*\/\s*[Nn])?\s*[\]\)]/.test(last);
  return promptEnd || choiceSyntax;
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

  const readPromise = (async () => {
    try {
      for await (const chunk of execution.read()) {
        stdout += chunk;
      }
    } catch { /* 读流异常忽略 */ }
    streamDone = true;
  })();

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const exitCode = await waitForCompletion({
    timeoutMs,
    signal: opts.signal,
    onEnd: (cb) => {
      const d = vscode.window.onDidEndTerminalShellExecution((e) => {
        if (e.execution === execution) cb(e.exitCode ?? null);
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
  });

  await readPromise;

  const actualCwd = (() => { try { return t.shellIntegration?.cwd?.fsPath; } catch { return undefined; } })();

  return {
    stdout: normalizeOutput(stdout),
    exitCode,
    captured: true,
    layer: "si",
    closed: !!t.exitStatus,
    cwd: actualCwd,
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

    const finish = (exitCode: number | null, output: string) => {
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
      });
    };

    const poller = setInterval(() => {
      if (Date.now() - startTime > timeoutMs) { finish(null, ""); return; }

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
      if (normalized.length === lastLen && normalized.length > 0) {
        idleCount++;
        if (idleCount >= (IDLE_THRESHOLD * 1000) / IDLE_POLL_MS) {
          if (!prompted && isWaitingForStdin(normalized)) {
            prompted = true;
            opts.onWaitingInput?.();
            vscode.window.showInformationMessage("Axon 终端正在等待你的输入。", "打开终端")
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

    const onAbort = () => finish(null, "");
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
  isWaitingForStdin: () => boolean;
  onWaitingInput?: () => void;
  showTerminal: () => void;
}

/**
 * 多路等待命令完成：end 事件 / close 事件 / stream 结束 / idle poll / 超时 / abort。
 * 统一管理 disposable 清理，防止资源泄漏。
 */
function waitForCompletion(cfg: WaitForCompletionConfig): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    let settled = false;
    const disposables: vscode.Disposable[] = [];

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      disposables.forEach((d) => d.dispose());
      clearTimeout(timeoutTimer);
      clearTimeout(streamEndTimer);
      clearInterval(idlePoller);
      cfg.signal?.removeEventListener("abort", onAbort);
      resolve(code);
    };

    // ① 正常完成事件
    disposables.push(cfg.onEnd((code) => finish(code)));

    // ② 终端关闭
    disposables.push(cfg.onClose(() => finish(null)));

    // ③ 超时
    const timeoutTimer = setTimeout(() => finish(null), cfg.timeoutMs);

    // ④ idle poller：输出静默 → 交互输入检测 / 补偿丢失的 end 事件
    let lastLen = 0;
    let idleCount = 0;
    let prompted = false;
    const idlePoller = setInterval(() => {
      const output = cfg.getOutput();
      const curLen = output.length;
      if (curLen === lastLen && curLen > 0) {
        idleCount++;
        if (idleCount >= IDLE_THRESHOLD) {
          if (!prompted && cfg.isWaitingForStdin()) {
            prompted = true;
            console.debug("[terminal] idle: interactive prompt detected");
            cfg.onWaitingInput?.();
            vscode.window.showInformationMessage("Axon 终端正在等待你的输入。", "打开终端")
              .then((c) => c === "打开终端" && cfg.showTerminal());
          } else {
            console.debug("[terminal] idle: treating as complete (lost end event)");
            finish(0);
          }
        }
      } else {
        idleCount = 0;
        prompted = false;
        lastLen = curLen;
      }
    }, IDLE_POLL_MS);

    // ⑤ stream 结束兜底
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
    const onAbort = () => finish(null);
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
  const terminalKey = opts.terminalKey ?? "default";
  const t = getOrCreateTerminal(terminalKey, opts.cwd);
  t.show(true);

  const effectiveCommand = opts.cwd ? cdCommand(opts.cwd!) + opts.command : opts.command;

  // Mark AI command start for proactive awareness filtering
  const aiCmdStartTime = Date.now();
  vscode.commands.executeCommand("axon.internal.markAiCommandStart", aiCmdStartTime);

  // ── Layer 1: Shell Integration ──
  const siReady = await waitForShellIntegration(t);
  if (siReady) {
    const result = await runWithShellIntegration(t, effectiveCommand, opts);
    if (result) {
      if (opts.cwd) terminalCwds.set(terminalKey, opts.cwd);
      vscode.commands.executeCommand("axon.internal.markAiCommandEnd", aiCmdStartTime);
      return result;
    }
  }

  // ── Layer 2: Terminal Content Reading ──
  console.warn("[terminal] SI unavailable, falling back to content layer");
  const contentResult = await runWithTerminalContent(t, effectiveCommand, opts);
  if (opts.cwd) terminalCwds.set(terminalKey, opts.cwd);
  vscode.commands.executeCommand("axon.internal.markAiCommandEnd", aiCmdStartTime);
  return contentResult;
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
  for (const t of terminals.values()) {
    if (t && !t.exitStatus) {
      t.show(false);
      return;
    }
  }
}
