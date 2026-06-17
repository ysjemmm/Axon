import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const DEFAULT_TOOL_ERROR =
  "[系统提示：该工具调用的结果已丢失（可能是会话历史损坏或消息链断裂导致）。" +
  "请重新尝试该操作，不要假设它已成功执行。]";

export function sanitizeToolPairing(
  messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];
  let i = 0;

  while (i < messages.length) {
    const m = messages[i] as any;

    // ── 非 assistant+tool_calls 消息 ──────────────────────────────────
    if (!(m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0)) {
      if (m.role !== "tool") result.push(m); // 孤立 tool 消息直接丢弃
      i++;
      continue;
    }

    // ── assistant with tool_calls ─────────────────────────────────────

    // 1. 过滤无效 ID（null / undefined / 非 string）
    const validCalls: any[] = m.tool_calls.filter(
      (tc: any) => typeof tc.id === "string" && tc.id.length > 0
    );

    // 没有任何合法 tool_call → 降级为普通 assistant 消息
    if (validCalls.length === 0) {
      const { tool_calls, ...rest } = m;
      result.push(rest as ChatCompletionMessageParam);
      i++;
      continue;
    }

    // 2. 收集紧跟在后面的所有 tool 消息
    let j = i + 1;
    const toolResultMap = new Map<string, ChatCompletionMessageParam>();
    while (j < messages.length && (messages[j] as any).role === "tool") {
      const tm = messages[j] as any;
      if (typeof tm.tool_call_id === "string" && !toolResultMap.has(tm.tool_call_id)) {
        toolResultMap.set(tm.tool_call_id, tm);
      }
      j++;
    }

    // 3. 推入 assistant（只含合法 tool_calls）
    result.push(
      validCalls.length === m.tool_calls.length
        ? m
        : { ...m, tool_calls: validCalls }
    );

    // 4. 每个 tool_call 必须有对应 tool 消息，缺什么补什么
    for (const tc of validCalls) {
      result.push(
        toolResultMap.get(tc.id) ?? {
          role: "tool",
          tool_call_id: tc.id,
          content: DEFAULT_TOOL_ERROR,
        } as ChatCompletionMessageParam
      );
    }

    i = j; // 跳过已消费的 tool 消息
  }

  return result;
}