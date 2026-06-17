/**
 * 消息配对清洗器 - 保证 tool_calls 与 tool 结果严格配对，移除孤儿，避免 API 400。
 *
 * 从 agentSession.ts 抽离。被 buildRequestMessages 在每次发请求前调用，
 * 兜底已损坏的历史会话数据不再 400。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * 清洗消息列表：
 * - 带 tool_calls 的 assistant：只保留那些"紧随其后连续出现对应 tool 结果"的 tool_call；
 *   若一个都不剩，则降级为普通 assistant 文本消息（或在无内容时丢弃）。
 * - role:tool 结果：只保留那些属于当前 assistant(tool_calls) 连续结果段的；
 *   孤儿 / 被打散 / 跨段漂移的 tool 结果全部丢弃。
 * 不修改原数组，返回新数组。
 */
export function sanitizeToolPairing(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as any;
    const role = m.role;

    if (role === "assistant" && Array.isArray(m.tool_calls)) {
      const expectedIds = new Set<string>(
        m.tool_calls
          .map((tc: any) => tc.id)
          .filter((id: unknown) => typeof id === "string")
      );

      const keptToolMessages: ChatCompletionMessageParam[] = [];
      const respondedIds = new Set<string>();
      let j = i + 1;

      while (j < messages.length) {
        const next = messages[j] as any;
        if (next.role !== "tool") break;

        const toolCallId = next.tool_call_id;
        if (
          typeof toolCallId === "string" &&
          expectedIds.has(toolCallId) &&
          !respondedIds.has(toolCallId)
        ) {
          keptToolMessages.push(next);
          respondedIds.add(toolCallId);
        }
        j++;
      }

      const keptToolCalls = m.tool_calls.filter((tc: any) => respondedIds.has(tc.id));
      if (keptToolCalls.length > 0) {
        result.push({ ...m, tool_calls: keptToolCalls });
        result.push(...keptToolMessages);
      } else if (m.content) {
        result.push({ role: "assistant", content: m.content } as ChatCompletionMessageParam);
      }

      i = j - 1;
      continue;
    }

    if (role === "tool") {
      continue;
    }

    result.push(messages[i]);
  }

  return result;
}
