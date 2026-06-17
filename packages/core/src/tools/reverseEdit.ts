/**
 * reverseEdit —— 编辑撤销引擎（纯函数，零形态依赖，可独立单测）
 *
 * 设计目标（商业化稳定性优先：漏撤可接受，撤错绝不可接受）：
 * 撤销不是「整文件写回旧内容」（会抹掉接受后 AI/用户在别处的后续改动），
 * 而是「上下文指纹包夹」的精确反向应用：
 *
 *   编辑落地时记录每个改动块的 { oldStr, newStr, beforeContext, afterContext }，
 *   其中 beforeContext + newStr + afterContext 在落地后的文件里是一段真实连续子串。
 *
 *   撤销时在【当前文件】里查找 needle = beforeContext + newStr + afterContext：
 *     - 恰好 1 处命中 → 把其中的 newStr 换回 oldStr（即整段换成 before+old+after）
 *     - 0 处 / ≥2 处   → 判失败（文件已变化 / 无法安全定位），绝不猜测
 *
 * 优点：
 *   - 不依赖行号，规避后续编辑导致的行号漂移误判
 *   - needle 比单独的 newStr 长且独特，显著降低误匹配概率
 *   - 天然支持 newStr="" 的纯删除撤销（靠 before+after 相邻指纹定位插入点）
 *
 * 多块原子性：一组 hunks 按逆序反向应用，任一块定位失败则整体放弃、文件保持不动，
 * 避免半截撤销把文件留在不一致状态。
 */

import type { EditHunk } from "../host/edits.js";

/** 撤销锚点上下文取多少行（before/after 各取的最大行数） */
const ANCHOR_LINES = 3;

/** 反向应用结果 */
export interface ReverseApplyResult {
  ok: boolean;
  /** 成功时为撤销后的文件内容（保持原换行风格） */
  content?: string;
  /** 失败时的轻提示文案 */
  reason?: string;
}

/** 取字符串末尾最多 n 行（紧贴末端、行对齐），用于 beforeContext */
export function lastNLines(s: string, n: number): string {
  if (n <= 0 || s.length === 0) return "";
  let newlines = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === "\n") {
      newlines++;
      if (newlines > n) return s.slice(i + 1);
    }
  }
  return s; // 不足 n 行：返回整段
}

/** 取字符串开头最多 n 行（紧贴开头、行对齐），用于 afterContext */
export function firstNLines(s: string, n: number): string {
  if (n <= 0 || s.length === 0) return "";
  let newlines = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") {
      newlines++;
      if (newlines >= n) return s.slice(0, i);
    }
  }
  return s; // 不足 n 行：返回整段
}

/**
 * 计算一处改动的撤销锚点上下文。
 * @param newContent 编辑落地后的【完整文件内容】（已 CRLF 归一化为 \n）
 * @param newStrStart newStr 在 newContent 中的起始字符下标
 * @param newStrLen   newStr 的字符长度
 * @returns before/after 上下文指纹（均为归一化文本，与 newStr 在 newContent 中物理连续）
 */
export function computeAnchorContext(
  newContent: string,
  newStrStart: number,
  newStrLen: number,
): { beforeContext: string; afterContext: string } {
  const before = newContent.slice(0, newStrStart);
  const after = newContent.slice(newStrStart + newStrLen);
  return {
    beforeContext: lastNLines(before, ANCHOR_LINES),
    afterContext: firstNLines(after, ANCHOR_LINES),
  };
}

/** 统计 needle 在 haystack 中出现的次数（不重叠） */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * 反向单个 hunk：在 work 中把 newStr 换回 oldStr。
 * 渐进式定位（兼顾唯一性与对相邻无关改动的鲁棒性）：
 *   1. 先用「上下文指纹包夹」needle = before+new+after，恰好 1 处命中即替换（最稳）；
 *   2. 若 0 处（说明附近上下文被其它编辑改动）且 newStr 非空，退化为只定位 newStr 自身，
 *      仅当其在全文【唯一】时才替换（避免误改）；
 *   3. 其余情况（多处命中 / newStr 为空且指纹失配 / newStr 找不到）一律保守失败。
 * @returns 成功返回替换后的内容，失败返回 null
 */
function reverseOneHunk(work: string, h: EditHunk): string | null {
  const full = h.beforeContext + h.newStr + h.afterContext;
  if (full.length > 0) {
    const c = countOccurrences(work, full);
    if (c === 1) return work.replace(full, h.beforeContext + h.oldStr + h.afterContext);
    if (c > 1) return null; // 指纹仍不唯一 → 保守失败
    // c === 0：上下文被相邻改动影响，尝试只定位 newStr
  }
  if (h.newStr.length > 0) {
    const c = countOccurrences(work, h.newStr);
    if (c === 1) return work.replace(h.newStr, h.oldStr);
    return null; // 0 处（真的没了）或多处（无法区分）→ 保守失败
  }
  return null; // newStr 为空（纯删除）且指纹失配 → 无法安全定位
}

/**
 * 把一组 hunks 从内容中反向撤销（newStr → oldStr），逆序应用、整组原子。
 * @param content 当前文件内容（任意换行风格）
 * @param hunks   编辑落地时记录的改动块（按应用先后顺序）
 * @returns 成功返回撤销后的内容；失败返回 reason，且不产生任何内容
 */
export function reverseApplyHunks(content: string, hunks: EditHunk[]): ReverseApplyResult {
  if (!hunks || hunks.length === 0) {
    return { ok: false, reason: "没有可撤销的改动记录" };
  }
  const hasCRLF = content.includes("\r\n");
  let work = hasCRLF ? content.replace(/\r\n/g, "\n") : content;

  // 逆序撤销：后接受/后应用的改动先撤，避免相邻块上下文相互干扰
  for (let i = hunks.length - 1; i >= 0; i--) {
    const next = reverseOneHunk(work, hunks[i]);
    if (next === null) {
      return { ok: false, reason: "无法安全撤销这一次：它所依赖的上下文已因其它撤销/改动而变化。同一文件的多次改动请按从新到旧的顺序撤销。" };
    }
    work = next;
  }

  return { ok: true, content: hasCRLF ? work.replace(/\n/g, "\r\n") : work };
}
