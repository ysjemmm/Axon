/**
 * 运行环境描述：操作系统与命令行 shell。
 *
 * 系统提示里曾写死「PowerShell 语法」，于是在 macOS / Linux 上模型总是先写一条 PowerShell
 * 命令、失败一次、看到 execute_command 的错误提示才改用 Unix 写法——每次都白白多一轮。
 * 现在提示（PromptBuilder 的 env 注入、子 Agent 系统提示）与命令失败提示共用这里的描述，
 * 一开始就告诉模型该用哪种写法。
 */

export interface ShellEnvironment {
  /** 操作系统的展示名 */
  os: string;
  /** shell 及写法提示，直接拼进提示词 */
  shell: string;
}

export function describeShellEnvironment(platform: NodeJS.Platform = process.platform): ShellEnvironment {
  if (platform === "win32") {
    return { os: "Windows", shell: "PowerShell（用 Get-ChildItem、Get-Content 等 PowerShell 写法，不要用 ls -la、cat、grep 这类 Unix 命令）" };
  }
  if (platform === "darwin") {
    return { os: "macOS", shell: "zsh / bash（Unix 写法）" };
  }
  return { os: "Linux", shell: "bash（Unix 写法）" };
}

/** 本地日期 YYYY-MM-DD（星期几）：让模型判断「最近」「今年」、核对时效性信息时有锚点 */
export function formatLocalDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const week = "日一二三四五六"[now.getDay()];
  return `${y}-${m}-${d}（星期${week}）`;
}

/** 运行环境提示：commands=false 时（问答模式、不执行命令）只给日期 */
export function buildEnvironmentNotice(opts: { commands: boolean; now?: Date; platform?: NodeJS.Platform }): string {
  const date = formatLocalDate(opts.now);
  if (!opts.commands) return `【运行环境】今天是 ${date}。`;
  const env = describeShellEnvironment(opts.platform);
  return `【运行环境】操作系统 ${env.os}；终端 shell 为 ${env.shell}。今天是 ${date}。`;
}
