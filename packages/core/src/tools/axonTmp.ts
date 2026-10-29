/**
 * AI 的临时文件目录：<工作区>/.axon/tmp/
 *
 * 模型经常为了验证、排查写一次性脚本（verify-xxx.cjs 之类）。写在项目目录里，
 * 它们会混进用户的改动列表、可能被提交，还越积越多。放到 .axon/tmp/：
 *   · 仍在项目内：脚本能照常引用项目依赖（node_modules 向上查找）
 *   · .axon/.gitignore 忽略它，不进 git
 *   · 直接写盘、不走改动审阅，不出现在改动列表里
 *   · 超过 TMP_MAX_AGE_MS 的文件在下次写临时文件时顺手清掉
 */

import { join } from "node:path";
import type { AgentHost } from "../host/index.js";
import { ensureAxonGitignore } from "../wiki/wikiStore.js";

/** 临时文件保留多久 */
const TMP_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export function axonTmpDir(workspace: string): string {
  return join(workspace, ".axon", "tmp");
}

/** 路径是否在某个 .axon/tmp/ 下（相对 / 绝对、正反斜杠都认） */
export function isAxonTmpPath(path: unknown): boolean {
  return typeof path === "string" && /(^|[\\/])\.axon[\\/]tmp[\\/]/.test(path);
}

/** 确保 .axon/.gitignore 忽略 tmp/ */
export async function ensureAxonLocalIgnore(host: AgentHost, workspace: string): Promise<void> {
  try {
    await ensureAxonGitignore(host, workspace);
  } catch { /* 忽略规则写不进去不影响写临时文件本身 */ }
}

/** 清掉过期的临时文件（只看第一层文件；失败静默） */
export async function pruneAxonTmp(host: AgentHost, workspace: string, now: number = Date.now()): Promise<number> {
  const dir = axonTmpDir(workspace);
  let removed = 0;
  try {
    for (const e of await host.fs.readdir(dir)) {
      if (!e.isFile) continue;
      const p = join(dir, e.name);
      const st = await host.fs.stat(p);
      if (st && typeof st.mtimeMs === "number" && now - st.mtimeMs > TMP_MAX_AGE_MS) {
        await host.fs.remove(p);
        removed++;
      }
    }
  } catch { /* 目录不存在等 */ }
  return removed;
}
