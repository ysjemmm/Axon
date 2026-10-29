/**
 * 历史分叉：从「某条 AI 回复」处截断，算出新会话要继承的消息前缀。
 *
 * ── 为什么要单独一层，而不是在前端传数组下标 ──
 * 落盘的 messages 是 ChatCompletionMessageParam[]，两端口径天然不一致：
 * · 后端 assistant 消息**没有 id**（只有 user 消息带 clientMessageId、tool 消息带 tool_call_id），
 *   前端想「按被点的那条 assistant 消息定位」是拿不到稳定标识的；
 * · 前端一条 assistant 气泡实际覆盖后端一串消息（assistant + tool_calls + n 条 tool 结果 + 收尾正文），
 *   所以「气泡序号」与「数组下标」不是同一把尺子。
 *
 * 于是这里接受的是「回合锚点」：包住那条回复的那一轮，起点是它前面最近的一条用户消息。
 * 由 clientMessageId 精确定位（该 id 就是前端用户气泡的 id，见 sendNow /
 * handleSessionLoaded），定位不到时退化为「它是历史里第几条用户消息」——
 * 口径与 edit_user_message 的 userIndex 一致：只数真实用户消息，跳过截图注入。
 *
 * 输出再经 sanitizeToolPairing 清洗：截断点理论上总落在轮末，但历史本身可能是脏的
 * （早期工具结果被裁掉、旧版本落盘残留），留下「有 tool_call 没结果」的尾巴会让模型直接 400。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { filterPersistableMessages } from "./persistable.js";
import { sanitizeToolPairing } from "../messageSanitizer.js";

/** 截断锚点（与 channel/commands.ts 里 fork_session 的字段一一对应） */
export interface ForkHistoryAnchor {
  /** 回合起点用户消息的 clientMessageId */
  upToMessageId?: string;
  /** 兜底：锚点用户消息在历史里的序号（0 起，只数真实用户消息） */
  upToUserIndex?: number;
}

export type ForkHistoryResult =
  | { ok: true; messages: ChatCompletionMessageParam[] }
  | { ok: false; reason: string };

/**
 * 是否是「真实用户消息」。
 *
 * 截图注入消息也是 role=user，但它由工具在轮内塞进历史，前端不渲染成用户气泡
 * （handleSessionLoaded 里 _screenshotInjection 直接 continue）。
 * 判定它才算「一轮的起点」，否则序号与前端对不上，截断点会漂到半轮上。
 */
function isRealUserMessage(m: unknown): boolean {
  const msg = m as { role?: string; content?: unknown; _screenshotInjection?: boolean; _shownInArchive?: boolean } | null;
  // 压缩摘要同理：前端显示成「早期对话已压缩」分隔行，不算用户消息；已在压缩存档里显示过的当前请求也不显示
  return !!msg && msg.role === "user" && !msg._screenshotInjection && !msg._shownInArchive
    && !(typeof msg.content === "string" && msg.content.startsWith("[对话历史摘要]"));
}

/** 按锚点定位「第几个下标是这一轮的起点用户消息」；定位不到返回 -1 */
function resolveAnchorIndex(messages: unknown[], anchor: ForkHistoryAnchor): number {
  const id = typeof anchor.upToMessageId === "string" ? anchor.upToMessageId : "";
  if (id) {
    const byId = messages.findIndex((m) => isRealUserMessage(m) && (m as any).clientMessageId === id);
    if (byId >= 0) return byId;
    // id 匹配不上不直接失败：老会话的 user 消息可能没有 clientMessageId（该字段是后加的），
    // 压缩生成的摘要用户消息同样没有。此时靠序号兜底，见下。
  }

  const ordinal = anchor.upToUserIndex;
  if (typeof ordinal === "number" && Number.isInteger(ordinal) && ordinal >= 0) {
    let seen = -1;
    for (let i = 0; i < messages.length; i++) {
      if (!isRealUserMessage(messages[i])) continue;
      seen++;
      if (seen === ordinal) return i;
    }
  }
  return -1;
}

/**
 * 截出「截至某一轮为止」的消息前缀（含该轮的全部回复与工具调用）。
 *
 * @param sourceMessages 源会话落盘的 messages
 * @param anchor 截断锚点；两个字段都缺省时返回失败（调用方据此走「只带记忆」的老路径）
 */
export function buildForkMessages(
  sourceMessages: ChatCompletionMessageParam[] | undefined,
  anchor: ForkHistoryAnchor,
): ForkHistoryResult {
  const hasAnchor = (typeof anchor.upToMessageId === "string" && anchor.upToMessageId.length > 0)
    || typeof anchor.upToUserIndex === "number";
  if (!hasAnchor) return { ok: false, reason: "缺少分叉位置" };

  // 与落盘/加载同口径先净化：_transient（编辑失败等）与 _ephemeralInjected（单轮临时注入：
  // 反思/复盘/预算提醒）前端根本不渲染，留着会让「第 n 条用户消息」的序号整体错位。
  const messages = filterPersistableMessages(sourceMessages ?? []);
  const anchorIdx = resolveAnchorIndex(messages, anchor);
  if (anchorIdx < 0) {
    return { ok: false, reason: "找不到分叉位置，它可能已被压缩或删除" };
  }

  // 从锚点往后一直走到下一条真实用户消息之前 —— 这一整段都属于被点的那一轮
  // （assistant 叙述 + 工具调用 + tool 结果 + 收尾正文，可能有多段）。
  let end = anchorIdx + 1;
  while (end < messages.length && !isRealUserMessage(messages[end])) end++;

  // 清洗工具配对：截断点虽然总在轮末，但源历史本身可能残缺（早期工具结果被裁、旧版本残留）。
  return { ok: true, messages: sanitizeToolPairing(messages.slice(0, end)) };
}
