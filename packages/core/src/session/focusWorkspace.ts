/**
 * 工作区归属判定：一个文件路径属于哪个工作区。
 *
 * 用途：多工作区会话里，"用户当前打开的文件在哪"是判断【AI 该优先看哪个工作区】的最强信号。
 * 用户绑了十几个工作区时，若不给出焦点，模型只能自己挑一个，于是出现
 * "我明明在看 A 项目的文件，它却跑去分析 B 项目"。
 *
 * 抽成纯函数是为了能脱离 AgentSession / IDE 上下文单独测试。
 */

/** 归一化：反斜杠转正斜杠 + 去掉结尾多余的斜杠（Windows 与 POSIX 统一处理） */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * 判断 filePath 位于哪个工作区内，返回命中的工作区（原样返回，保持调用方传入的写法）。
 *
 * 规则：
 * - 大小写不敏感（Windows / macOS 文件系统默认如此），`/` 与 `\` 等价；
 * - 取「最长匹配」：工作区之间可能存在父子关系（如 `d:/proj` 与 `d:/proj/sub`），
 *   只有最长者才是文件真正的归属；
 * - 边界必须是完整路径段：`d:/proj-other/a.ts` 不属于 `d:/proj`。
 *
 * @returns 命中的工作区路径；未命中返回 null
 */
export function workspaceOfPath(filePath: string, workspaces: readonly string[]): string | null {
  if (!filePath) return null;
  const target = normalizePath(filePath).toLowerCase();
  if (!target) return null;

  let best: string | null = null;
  let bestLen = -1;
  for (const ws of workspaces) {
    if (!ws) continue;
    const w = normalizePath(ws).toLowerCase();
    if (!w) continue;
    // 相等（文件恰好就是工作区根，罕见但合法）或落在其子路径下
    if (target === w || target.startsWith(`${w}/`)) {
      if (w.length > bestLen) {
        best = ws;
        bestLen = w.length;
      }
    }
  }
  return best;
}
