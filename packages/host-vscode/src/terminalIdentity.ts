/**
 * Axon 终端身份标记
 *
 * 为什么单独一个模块：窗口里的 Axon 终端由两条互不相关的路径创建——
 * - terminalDisplay：execute_command 的「命令终端」（名字 "Axon"）
 * - processes：start_process 的「后台进程终端」（名字 "Axon: <命令>"）
 *
 * 两者都是 Axon 创建的、都带 AXON_AI_TERMINAL 标记，但语义完全不同：命令终端空闲时可以
 * 被复用，后台进程终端通常正跑着 dev server / watch，绝不能被当成空闲终端占用。
 *
 * 而「这个终端忙不忙」只存在于各自的内存 map 里，窗口重载后就丢了。重载后要判断
 * 「面板里这些 Axon 终端哪个没在用」，只能回到 vscode.window.terminals 按创建时的标记
 * 重新识别——所以标记必须写进创建选项（creationOptions 会随终端一起被 VS Code 恢复），
 * 由本模块统一读写，不让两处各写一套字符串。
 */

import * as vscode from "vscode";

/** 「这是 Axon 创建的终端」。所有 Axon 终端都必须带。 */
export const AXON_TERMINAL_ENV = "AXON_AI_TERMINAL";

/** 终端用途标记，取值见下面两个常量。用来区分命令终端与后台进程终端。 */
export const AXON_TERMINAL_KIND_ENV = "AXON_TERMINAL_KIND";

export const AXON_TERMINAL_KIND_COMMAND = "command";
export const AXON_TERMINAL_KIND_PROCESS = "process";

/** 命令终端名（execute_command）。旧终端没有用途标记时的识别兜底。 */
const COMMAND_TERMINAL_NAME = "Axon";

/** 后台进程终端名前缀（start_process）。 */
const PROCESS_TERMINAL_NAME_PREFIX = "Axon: ";

/** 读取终端的创建环境变量（终端被重载恢复后 creationOptions 仍然可用）。 */
function creationEnv(terminal: vscode.Terminal): Record<string, string | null | undefined> {
  const options = terminal.creationOptions as { env?: Record<string, string | null | undefined> } | undefined;
  return options?.env ?? {};
}

/**
 * 是否由 Axon 创建。
 *
 * 顺序：用途标记 → AXON_AI_TERMINAL 标记 → 终端名兜底。
 *
 * 名字兜底是给「重载后恢复的旧终端」准备的：早期版本只写了 AXON_AI_TERMINAL，万一创建
 * 选项没被完整恢复，仅凭名字仍能认出来，重启后才不会继续重复开终端。代价是用户自己起一个
 * 恰好叫 "Axon" 的终端会被误认——这个代价可以接受。
 */
export function isAxonTerminal(terminal: vscode.Terminal): boolean {
  const env = creationEnv(terminal);
  if (env[AXON_TERMINAL_KIND_ENV]) return true;
  if (env[AXON_TERMINAL_ENV] === "1") return true;
  return terminal.name === COMMAND_TERMINAL_NAME || terminal.name.startsWith(PROCESS_TERMINAL_NAME_PREFIX);
}

/**
 * 是否是 start_process 的后台进程终端。
 * 命中即视为「在用」——它上面的进程通常还活着，不能被命令执行借用。
 */
export function isAxonProcessTerminal(terminal: vscode.Terminal): boolean {
  const kind = creationEnv(terminal)[AXON_TERMINAL_KIND_ENV];
  if (kind === AXON_TERMINAL_KIND_PROCESS) return true;
  if (kind === AXON_TERMINAL_KIND_COMMAND) return false;
  // 没有用途标记（重载恢复的旧终端）→ 按名字区分
  return terminal.name.startsWith(PROCESS_TERMINAL_NAME_PREFIX);
}

/** 是否是 execute_command 的命令终端（空闲时可被复用）。 */
export function isAxonCommandTerminal(terminal: vscode.Terminal): boolean {
  return isAxonTerminal(terminal) && !isAxonProcessTerminal(terminal);
}

/** 命令终端的创建环境变量片段。 */
export function commandTerminalEnv(extra?: Record<string, string>): Record<string, string> {
  return {
    [AXON_TERMINAL_ENV]: "1",
    [AXON_TERMINAL_KIND_ENV]: AXON_TERMINAL_KIND_COMMAND,
    ...extra,
  };
}

/** 后台进程终端的创建环境变量片段。 */
export function processTerminalEnv(extra?: Record<string, string>): Record<string, string> {
  return {
    [AXON_TERMINAL_ENV]: "1",
    [AXON_TERMINAL_KIND_ENV]: AXON_TERMINAL_KIND_PROCESS,
    ...extra,
  };
}
