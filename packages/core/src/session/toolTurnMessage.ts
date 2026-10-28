/**
 * 工具轮 assistant 消息的字段策略（单一来源）
 *
 * ── 为什么单独抽出来 ──
 * 这三个字段的分工是隐形的，改错一次不会有类型错误、不会有测试失败，只会让用户在
 * 重启 IDE 后看到"工具之间的文字全没了"。曾经就是这么坏的：为了治模型反复重述开场白，
 * 把 content / displayContent / runtimeContent 一起清空，注释还写着"前端展示不受影响"。
 *
 * ── 三个字段各自的用途，不要合并 ──
 * · content：落盘的对话内容。工具轮必须为 null —— 历史里累积的"我先摸清 Y 再动手"
 *   这类过渡叙述会成为少样本范例，模型下一轮照抄同一句式，于是每轮开头都是一字不差的重述。
 * · displayContent：界面展示的正文。PromptBuilder 组请求时只把【当前用户回合】的这段
 *   作为 content 回传给模型（让它一轮之内保持边做边说），之前回合的一律剥掉。
 *   重启 IDE 后前端靠它还原工具之间的文字 —— 实时渲染走的是 stream_delta，那是内存态，
 *   重启即失，所以展示用的正文必须落盘。
 * · runtimeContent：介于两者之间的"给模型但截断/清洗过"的版本，当前一律不用（保持 null）。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/** 工具轮消息里 tool_calls 的形状（与 provider 协议一致） */
export interface ToolCallShape {
  id: string;
  name: string;
  arguments: string;
}

/** 构造一条「带 tool_calls 的 assistant 消息」 */
export function buildToolTurnAssistantMessage(input: {
  /** 本回合模型输出的正文（可能为空：纯工具轮压根没有说话） */
  text: string;
  toolCalls: ToolCallShape[];
  /** DeepSeek 等 reasoning 模型要求带 tool_calls 的历史原样回传思考字段 */
  reasoningContent?: string;
  /** Anthropic extended thinking 的签名块，下一轮必须原样回传 */
  anthropicThinkingBlocks?: { thinking: string; signature?: string }[];
}): ChatCompletionMessageParam {
  const prose = typeof input.text === "string" && input.text.trim() ? input.text : null;
  return {
    role: "assistant",
    // 模型上下文：清空。见文件头注释，这是治重复的必要条件。
    content: null,
    ...(input.reasoningContent ? { reasoning_content: input.reasoningContent } : {}),
    ...(input.anthropicThinkingBlocks && input.anthropicThinkingBlocks.length > 0
      ? { anthropic_thinking_blocks: input.anthropicThinkingBlocks }
      : {}),
    // 界面展示：保留原文。重启后工具之间那几段话就是靠它还原的。
    displayContent: prose,
    // 不参与模型上下文，恒为 null。
    runtimeContent: null,
    tool_calls: input.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments },
    })),
  } as ChatCompletionMessageParam;
}
