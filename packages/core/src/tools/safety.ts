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
 * 危险命令检测：返回非空字符串表示命中风险规则（提示原因），空串表示未命中。
 *
 * ⚠️ 这是**风险提示**，不是放行判据——命中与否都不决定命令是否执行
 * （放行由 CommandGate 的"信任白名单 + 未信任人工确认"决定）。
 * 命中原因透传给用户，作用是让"已经信任该命令"的场景仍然看得见破坏性操作。
 */
export function detectDangerousCommand(command: string): string {
  const cmd = (command || "").trim();
  if (!cmd) return "";
  const lower = cmd.toLowerCase();

  const rules: { pattern: RegExp; reason: string }[] = [
    // Remove-Item 递归删除：两个**独立**前瞻分别要求 -Recurse 与 -Force，顺序无关。
    // 旧写法 /remove-item[^\n]*-recurse[^\n]*-force/ 要求 -Recurse 必须排在 -Force 之前，
    // 于是 `Remove-Item -Force -Recurse X` 这种同样致命的写法被静默漏报。
    { pattern: /remove-item\b(?=[^\n]*-recurse\b)(?=[^\n]*-force\b)/i, reason: "递归强制删除（Remove-Item -Recurse -Force）" },
    { pattern: /remove-item\b(?=[^\n]*-recurse\b)/i, reason: "递归删除（Remove-Item -Recurse）" },
    { pattern: /\brd\b\s+\/s|\brmdir\b\s+\/s/i, reason: "递归删除目录（rmdir /s）" },
    // rm 递归强制删除：同样容忍 -rf / -fr / -r -f / -f -r（旧写法只认合并旗标）
    { pattern: /\brm\b(?=[^\n]*\s-[a-z]*r[a-z]*\b)(?=[^\n]*\s-[a-z]*f[a-z]*\b)/i, reason: "递归强制删除（rm -rf）" },
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
