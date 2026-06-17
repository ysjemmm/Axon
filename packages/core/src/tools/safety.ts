/**
 * 工具安全策略与遍历常量（与形态无关的纯逻辑，迁移自 tools.ts）
 *
 * 这些规则不触碰文件系统/进程，是 core 的纯逻辑：危险命令检测在调用
 * host.commands.exec 之前执行；IGNORED_DIRS 供 core 的搜索/列目录遍历使用。
 */

import { relative, isAbsolute } from "node:path";

/**
 * 工作区边界守卫：判断目标绝对路径是否落在任一工作区根之内（含等于根本身）。
 * 用于防止 `../` 路径穿越写到/读到工作区之外（提示注入、模型失误的越权访问）。
 */
export function isWithinWorkspaces(absPath: string, roots: string[]): boolean {
  return roots.some((root) => {
    const rel = relative(root, absPath);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

/**
 * 危险命令检测：返回非空字符串表示命中危险规则（拒绝理由），空串表示放行。
 * 只拦截“大范围、难以挽回”的破坏性操作，覆盖 PowerShell 与 cmd 常见写法。
 */
export function detectDangerousCommand(command: string): string {
  const cmd = (command || "").trim();
  if (!cmd) return "";
  const lower = cmd.toLowerCase();

  const rules: { pattern: RegExp; reason: string }[] = [
    { pattern: /remove-item\b[^\n]*-recurse[^\n]*-force/i, reason: "递归强制删除（Remove-Item -Recurse -Force）" },
    { pattern: /\brd\b\s+\/s|\brmdir\b\s+\/s/i, reason: "递归删除目录（rmdir /s）" },
    { pattern: /\brm\b\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)/i, reason: "递归强制删除（rm -rf）" },
    { pattern: /\brm\b\s+-rf\s+[/~]/i, reason: "对根/家目录递归删除" },
    { pattern: /\bformat\b\s+[a-z]:/i, reason: "磁盘格式化（format）" },
    { pattern: /format-volume|clear-disk/i, reason: "磁盘卷格式化/清除" },
    { pattern: /\bshutdown\b|\bstop-computer\b|\brestart-computer\b/i, reason: "关机/重启" },
    { pattern: /\b(del|erase)\b\s+\/[sq]/i, reason: "批量删除（del /s 或 /q）" },
    { pattern: /\bdd\b\s+if=.*of=\/dev\//i, reason: "向磁盘设备写入（dd）" },
  ];

  for (const rule of rules) {
    if (rule.pattern.test(lower) || rule.pattern.test(cmd)) {
      return rule.reason;
    }
  }
  return "";
}

/** 搜索/列目录时跳过的目录 */
export const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".svn", "dist", "build", ".next",
  ".venv", "venv", "__pycache__", ".cache", ".idea", ".vscode",
  "target", "out", "coverage", ".turbo",
  ".kilo", ".kiro", ".worktrees", ".history", ".cursor", ".windsurf",
]);
