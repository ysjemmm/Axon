/**
 * 思考段（reasoning）的归属与落位规则。
 *
 * 背景：思考块的协议身份是「轮次:协议块号」——归属只认 key，不看 streaming 标志
 * （streaming 只表达 UI 折叠，会被工具卡片/stream_start 提前置 false）。
 *
 * 但「一轮内模型先出正文、之后又继续吐思考」是真实存在的：Chat Completions 的
 * reasoning_content 是单一无分块流（strategy 不提供 partIndex/itemId），前端算出的 key
 * 恒为 `r{轮}:0`。此时若仍把新思考并回本轮正文之前那个块，用户看到的就是
 * 「正文已经输出完并停了，上面的思考却还在长」——像是没有新建思考块放在下面。
 *
 * 因此规则细化为：同一 key 的思考块一旦被后续内容（正文/工具卡片）打断，
 * 之后同样 key 的思考必须另起一块（key 加 `#n` 后缀），并落到消息末尾。
 *
 * 抽成纯函数是为了能脱离 React/浏览器单独验证（见修复时的验证脚本）。
 */

import type { Segment } from "./types";

/** 判断段的 key 是否属于同一「基础块」：baseKey 本身，或它的派生分段 `baseKey#n` */
export function isSameReasoningFamily(segKey: string | undefined, baseKey: string): boolean {
  if (!segKey) return false;
  return segKey === baseKey || segKey.startsWith(`${baseKey}#`);
}

/** 为一个新的分段生成 key：该基础块的首个分段用 baseKey，之后依次 baseKey#1、#2… */
export function nextReasoningKey(segments: Segment[], baseKey: string): string {
  let n = 0;
  for (const s of segments) {
    if (s.type === "reasoning" && isSameReasoningFamily(s.key, baseKey)) n++;
  }
  return n === 0 ? baseKey : `${baseKey}#${n}`;
}

/**
 * 定位一条思考增量应落到哪里：
 * - `{ kind: "append", index }` —— 命中的块就在消息末尾，直接追加（思考仍在连续输出）
 * - `{ kind: "new", key }` —— 需要新建一块（未命中，或命中的块已被后续内容打断）
 */
export function locateReasoning(
  segments: Segment[],
  baseKey: string,
): { kind: "append"; index: number } | { kind: "new"; key: string } {
  let idx = -1;
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (s.type === "reasoning" && isSameReasoningFamily(s.key, baseKey)) { idx = i; break; }
  }
  // 命中的块不在末尾 → 它之后已经有正文/工具等内容，说明这波思考是在正文之后恢复的
  if (idx >= 0 && idx === segments.length - 1) return { kind: "append", index: idx };
  return { kind: "new", key: nextReasoningKey(segments, baseKey) };
}
