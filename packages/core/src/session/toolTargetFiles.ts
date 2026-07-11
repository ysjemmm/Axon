import type { AgentHost } from "../host/index.js";

/**
 * 提取写文件工具的目标文件列表（供快照/回滚使用）。
 *
 * 从 agentSession 尾部抽出的纯协作函数，保持行为完全一致：
 * - str_replace / create_file → 单文件
 * - apply_patch → 从 patch 头中提取多个文件
 */
export async function extractTargetFiles(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  host: AgentHost,
  workspaces?: string[],
): Promise<string[]> {
  const { resolveInWorkspaces } = await import("../tools/search.js");
  switch (toolName) {
    case "str_replace":
    case "create_file": {
      const p = args.path as string;
      if (!p) return [];
      try {
        const resolved = await resolveInWorkspaces(p, cwd, host, workspaces);
        return [resolved];
      } catch {
        return [];
      }
    }
    case "apply_patch": {
      const patch = args.patch as string;
      if (!patch) return [];
      const paths: string[] = [];
      const fileHeaders = patch.match(/\*\*\* (?:Update File|Add File): (.+)/g);
      if (fileHeaders) {
        for (const h of fileHeaders) {
          const p = h.replace(/\*\*\* (?:Update File|Add File): /, "").trim();
          try {
            const resolved = await resolveInWorkspaces(p, cwd, host, workspaces);
            paths.push(resolved);
          } catch {
            /* skip */
          }
        }
      }
      return paths;
    }
    default:
      return [];
  }
}
