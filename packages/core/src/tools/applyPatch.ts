/**
 * apply_patch —— 统一 diff 风格的多处编辑应用器（纯函数，零形态依赖，可独立单测）
 *
 * 目的：大文件多处改动时，模型只输出"变更块"（每块带少量上下文行），不重述未改动内容，
 * 大幅降低输出 token / 耗时。上下文行同时充当正确性校验——块定位不到就显式失败、反馈模型重试，
 * 不会静默改错。
 *
 * 补丁信封格式（参考 Codex apply_patch，对 LLM 友好）：
 *
 *   *** Begin Patch
 *   *** Update File: path/to/file.ts
 *   @@
 *    context line（前缀空格 = 未改动）
 *   -removed line（前缀 - = 删除）
 *   +added line（前缀 + = 新增）
 *    context line
 *   @@
 *   ...更多 hunk...
 *   *** Add File: path/to/new.ts
 *   +line 1
 *   +line 2
 *   *** End Patch
 *
 * 一个 hunk 内：oldBlock = 上下文行 + 删除行（按原顺序），newBlock = 上下文行 + 新增行（按原顺序）。
 * 应用时在文件里定位 oldBlock（精确→尾空白容错），要求唯一，替换为 newBlock；多个 hunk 顺序应用。
 */

import type { EditHunk } from "../host/edits.js";
import { computeAnchorContext } from "./reverseEdit.js";

/** hunk 内单行操作 */
export interface HunkOp {
  kind: "ctx" | "del" | "add";
  content: string;
}

/** 单个变更块 */
export interface PatchHunk {
  ops: HunkOp[];
}

/** 单个文件的补丁操作 */
export interface PatchFileOp {
  type: "update" | "add";
  path: string;
  /** update：变更块列表 */
  hunks: PatchHunk[];
  /** add：新文件完整内容（按行） */
  addLines: string[];
}

/** 解析失败 / 应用失败统一抛出此错误（消息直接反馈给模型） */
export class PatchError extends Error {}

/** 把一行补丁体分类为 context/add/remove，返回 [类型, 内容] */
function classifyLine(line: string): ["ctx" | "add" | "del", string] {
  if (line === "") return ["ctx", ""]; // 空行视为空上下文
  const head = line[0];
  if (head === "+") return ["add", line.slice(1)];
  if (head === "-") return ["del", line.slice(1)];
  if (head === " ") return ["ctx", line.slice(1)];
  // 模型偶尔漏前缀：宽容地当作上下文整行（精确匹配会兜底校验）
  return ["ctx", line];
}

/**
 * 解析补丁文本为文件操作列表。
 * 容错：缺 Begin/End 标记也尽量解析；CRLF 在解析阶段归一化为 LF。
 */
export function parsePatch(patchText: string): PatchFileOp[] {
  const text = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n");
  const ops: PatchFileOp[] = [];
  let cur: PatchFileOp | null = null;
  let curHunkLines: string[] | null = null;

  const flushHunk = () => {
    if (cur && cur.type === "update" && curHunkLines && curHunkLines.length > 0) {
      const ops2: HunkOp[] = [];
      for (const l of curHunkLines) {
        const [kind, content] = classifyLine(l);
        ops2.push({ kind, content });
      }
      cur.hunks.push({ ops: ops2 });
    }
    curHunkLines = null;
  };

  for (const line of lines) {
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) {
      flushHunk();
      continue;
    }
    const updateMatch = line.match(/^\*\*\* Update File:\s*(.+?)\s*$/);
    const addMatch = line.match(/^\*\*\* Add File:\s*(.+?)\s*$/);
    if (updateMatch) {
      flushHunk();
      cur = { type: "update", path: updateMatch[1], hunks: [], addLines: [] };
      ops.push(cur);
      continue;
    }
    if (addMatch) {
      flushHunk();
      cur = { type: "add", path: addMatch[1], hunks: [], addLines: [] };
      ops.push(cur);
      continue;
    }
    if (!cur) continue; // 文件头之前的杂项行忽略
    if (cur.type === "add") {
      // Add 文件：取 + 行内容；容错地接受裸行
      const [kind, content] = classifyLine(line);
      cur.addLines.push(kind === "add" ? content : (line === "" ? "" : content));
      continue;
    }
    // update：@@ 作为 hunk 分隔
    if (line.startsWith("@@")) {
      flushHunk();
      curHunkLines = [];
      continue;
    }
    if (curHunkLines === null) curHunkLines = [];
    curHunkLines.push(line);
  }
  flushHunk();

  if (ops.length === 0) {
    throw new PatchError("补丁为空或格式无法识别：需要至少一个 '*** Update File: <path>' 或 '*** Add File: <path>' 段。");
  }
  return ops;
}

/** 某位置起 oldLines 是否与 contentLines 匹配（fuzzy=true 时忽略行尾空白） */
function matchAt(contentLines: string[], oldLines: string[], start: number, fuzzy: boolean): boolean {
  for (let k = 0; k < oldLines.length; k++) {
    const a = contentLines[start + k];
    const b = oldLines[k];
    if (a === undefined) return false;
    if (a === b) continue;
    if (fuzzy && a.replace(/\s+$/, "") === b.replace(/\s+$/, "")) continue;
    return false;
  }
  return true;
}

/** 找到 oldLines 在 contentLines 中的所有起始下标 */
function findMatches(contentLines: string[], oldLines: string[], fuzzy: boolean): number[] {
  const res: number[] = [];
  if (oldLines.length === 0) return res;
  for (let i = 0; i + oldLines.length <= contentLines.length; i++) {
    if (matchAt(contentLines, oldLines, i, fuzzy)) res.push(i);
  }
  return res;
}

/**
 * 把 hunks 顺序应用到内容上。任何 hunk 定位失败/不唯一都抛 PatchError（含定位提示）。
 * 保持文件原换行风格（CRLF/LF）。
 * @param collect 可选：按应用顺序收集每个 hunk 的撤销锚点（含上下文指纹），供撤销引擎使用
 */
export function applyHunks(content: string, hunks: PatchHunk[], path: string, collect?: EditHunk[]): string {
  const hasCRLF = content.includes("\r\n");
  const normalized = hasCRLF ? content.replace(/\r\n/g, "\n") : content;
  const contentLines = normalized.split("\n");

  hunks.forEach((hunk, hi) => {
    // 用于定位的"旧块"= 上下文 + 删除行（按原顺序）
    const oldLines = hunk.ops.filter((o) => o.kind === "ctx" || o.kind === "del").map((o) => o.content);
    if (oldLines.length === 0) {
      throw new PatchError(
        `apply_patch 失败（${path} 第 ${hi + 1} 个变更块）：该块没有任何上下文行或删除行，无法定位插入位置。` +
        `请在 + 新增行的前后至少各保留 1~3 行带空格前缀的上下文行。`,
      );
    }
    let matches = findMatches(contentLines, oldLines, false);
    if (matches.length === 0) matches = findMatches(contentLines, oldLines, true); // 尾空白容错
    if (matches.length === 0) {
      const firstAnchor = oldLines.find((l) => l.trim().length > 0)?.trim() || "";
      let nearby = "";
      if (firstAnchor) {
        const idx = contentLines.findIndex((l) => l.trim() === firstAnchor || l.includes(firstAnchor));
        if (idx >= 0) {
          const s = Math.max(0, idx - 3);
          const e = Math.min(contentLines.length, idx + oldLines.length + 5);
          nearby = `\n最相近的位置在第 ${s + 1}-${e} 行：\n\`\`\`\n${contentLines.slice(s, e).join("\n")}\n\`\`\``;
        }
      }
      throw new PatchError(
        `apply_patch 失败（${path} 第 ${hi + 1} 个变更块）：上下文未匹配到文件内容。${nearby}\n` +
        `请基于文件实际内容修正该块的上下文行（空格/缩进/换行需逐字符一致）后重试。`,
      );
    }
    if (matches.length > 1) {
      throw new PatchError(
        `apply_patch 失败（${path} 第 ${hi + 1} 个变更块）：上下文在文件中出现 ${matches.length} 次（不唯一），无法确定位置。` +
        `请为该块增加更多上下文行使其唯一后重试。`,
      );
    }
    // 应用：上下文行保留【文件原始行】（不改动未变更内容，含其尾随空白），仅落实 +/- 增删
    const start = matches[0];
    const replacement: string[] = [];
    let fileIdx = start;
    for (const op of hunk.ops) {
      if (op.kind === "ctx") { replacement.push(contentLines[fileIdx]); fileIdx++; }
      else if (op.kind === "del") { fileIdx++; }
      else { replacement.push(op.content); }
    }
    contentLines.splice(start, oldLines.length, ...replacement);

    // 收集撤销锚点：基于本块应用后的中间态，按字符偏移精确取 before/after 指纹（与 str_replace 同法）。
    // 逆序撤销保证撤销时上下文自洽。
    if (collect) {
      const oldStr = oldLines.join("\n");
      const newStr = replacement.join("\n");
      let charOffset = 0;
      for (let li = 0; li < start; li++) charOffset += contentLines[li].length + 1; // +1 为行间 \n
      const joined = contentLines.join("\n");
      const { beforeContext, afterContext } = computeAnchorContext(joined, charOffset, newStr.length);
      collect.push({ oldStr, newStr, beforeContext, afterContext });
    }
  });

  const result = contentLines.join("\n");
  return hasCRLF ? result.replace(/\n/g, "\r\n") : result;
}
