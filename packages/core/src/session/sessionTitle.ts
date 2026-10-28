/**
 * 会话标题：自动生成与去重。
 *
 * ── 省略号 ──
 * 自动标题取首条消息前 30 个字，早先截断后拼的是三个英文句点 "..."，于是双击重命名时
 * 输入框里也带着 "..."。现在用单个省略号字符 "…"；前端重命名时会去掉它再让用户编辑。
 *
 * ── 重名 ──
 * 会话列表只按标题区分，两个同名会话无从分辨（同一句开场白开两个会话很常见）。
 * 自动标题和手动重命名都与其它会话去重：重名时在末尾加「 (2)」「 (3)」……
 * 占位标题「新对话」不参与去重，它只是还没起名。
 */

import type { SessionStorage } from "../storage/types.js";

export const PLACEHOLDER_TITLE = "新对话";
const AUTO_TITLE_MAX = 30;

/** 由首条消息生成自动标题：合并空白与换行，超长截断并加省略号 */
export function autoSessionTitle(source: string): string {
  const oneLine = (source || "").replace(/\s+/g, " ").trim();
  if (!oneLine) return PLACEHOLDER_TITLE;
  return oneLine.length > AUTO_TITLE_MAX ? `${oneLine.slice(0, AUTO_TITLE_MAX)}…` : oneLine;
}

/** 与已有标题去重：重名时依次尝试「 (2)」「 (3)」…；占位标题不去重 */
export function uniqueSessionTitle(title: string, existing: Iterable<string>): string {
  const base = title.trim();
  if (!base || base === PLACEHOLDER_TITLE) return base || PLACEHOLDER_TITLE;
  const taken = new Set([...existing].map((t) => (t || "").trim()));
  if (!taken.has(base)) return base;
  // 已经带了序号（如「方案 (2)」再次撞名）时从序号继续，而不是叠成「方案 (2) (2)」
  const m = /^(.*) \((\d+)\)$/.exec(base);
  const stem = m ? m[1] : base;
  for (let n = m ? Number(m[2]) + 1 : 2; n < 1000; n++) {
    const candidate = `${stem} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem} (${Date.now()})`;
}

/** 其它会话（排除自己）当前使用的标题 */
async function otherTitles(storage: SessionStorage, selfId?: string): Promise<string[]> {
  const sessions = await storage.listSessions().catch(() => []);
  return sessions.filter((s) => s.id !== selfId).map((s) => s.title);
}

/** 生成与其它会话不重名的自动标题 */
export async function uniqueAutoTitle(storage: SessionStorage, source: string, selfId?: string): Promise<string> {
  return uniqueSessionTitle(autoSessionTitle(source), await otherTitles(storage, selfId));
}

/**
 * 手动重命名：去重后落盘，返回最终标题（可能带了序号），调用方据此更新界面。
 * 空标题不改，返回 null。
 */
export async function renameSessionTitle(storage: SessionStorage, id: string, title: string): Promise<string | null> {
  const trimmed = (title || "").trim();
  if (!trimmed) return null;
  const finalTitle = uniqueSessionTitle(trimmed, await otherTitles(storage, id));
  await storage.updateSession(id, { title: finalTitle });
  return finalTitle;
}
