/**
 * Chat Completions 策略：封装 OpenAI /chat/completions 协议。
 *
 * 适用于所有兼容 Chat Completions 的 provider（GLM、Claude 等）。
 * 无状态：每回合发送完整 messages 数组，agent loop 由上层手动驱动。
 */

import OpenAI from "openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { LLMStrategy, RunTurnParams, LLMTurnResult, NormalizedToolCall } from "./types.js";

export class ChatCompletionsStrategy implements LLMStrategy {
  readonly name = "chat_completions";

  constructor(private client: OpenAI) {}

  async runTurn(params: RunTurnParams): Promise<LLMTurnResult> {
    const { model, messages, tools, signal, callbacks, temperature } = params;

    // 🔍 调试：检查最后一条 user 消息的 content 格式（排查图片是否到达 LLM）
    // 仅在设置 AXON_LLM_DEBUG 环境变量时输出，避免污染 Extension Host 控制台。
    if (process.env["AXON_LLM_DEBUG"]) {
      const lastUser = [...messages].reverse().find(m => m.role === "user");
      if (lastUser) {
        const contentPreview = typeof lastUser.content === "string"
          ? `string(${lastUser.content.length} chars)`
          : `array(${Array.isArray(lastUser.content) ? lastUser.content.length : 0} parts)`;
        console.log(`[llm-debug] model=${model}, lastUser.content=${contentPreview}`);
      }
    }

    // 多模态降级：如果消息中含 image_url 但模型可能不支持（非 GPT/Claude/Qwen），
    // 把 image_url 部分剥离，只保留文字 + 提示"图片无法显示"
    const safeMessages = messages.map((m) => {
      if (!m) return m; // 防御：消息为 undefined/null 时保持原样（应由上层 sanitize 保证不出现，此处兜底）
      if (m.role === "user" && Array.isArray(m.content)) {
        const parts = m.content as any[];
        const hasImage = parts.some((p) => p.type === "image_url");
        if (hasImage && !/^(gpt|claude|qwen)/i.test(model)) {
          // 模型不支持图片，降级为纯文本
          const textParts = parts.filter((p) => p.type === "text").map((p) => p.text || "");
          const text = textParts.join("\n") + "\n\n[用户附带了图片，但当前模型不支持查看图片内容]";
          return { ...m, content: text };
        }
      }
      return m;
    });

    // ── Prompt Caching ──────────────────────────────────────────────
    // 标记稳定前缀（system prompt + 除最后 2 条外的历史消息）为可缓存。
    // DeepSeek/GLM/Claude 等均支持 OpenAI 兼容的 cache_control 参数。
    // 命中缓存时 prefill 阶段跳过 → TTFT 降低 5-10 倍。
    //
    // 策略：倒数第 3 条消息打一个 cache breakpoint（覆盖 system + 绝大部分历史），
    // 倒数第 1 条（最新 user 消息）不打（每轮都变）。
    // 仅在消息数 > 6 时生效（太短的消息不值得打缓存标记）。
    const cachedMessages = safeMessages.length > 6
      ? applyCacheBreakpoints(safeMessages)
      : safeMessages;

    // 无工具时不传 tools/tool_choice（如强制总结收尾场景）
    const hasTools = tools.length > 0;
    // DeepSeek 经中转网关并发调用工具时，容易产出空/重复 tool_call id 与交错的参数 JSON，
    // 导致下一轮请求 tool_calls 与 tool 结果配对失败、网关 400（tool_id xxx）。
    // 对 deepseek 关闭并行工具调用（一次一个），从源头规避。其它网关（如 glm 中转）收到该
    // 专有参数会断流，故仅对 deepseek 下发。
    const isDeepSeek = /deepseek/i.test(model);
    // stream_options（include_usage）是 OpenAI 专有参数。经中转网关的非 OpenAI 原生模型
    // （deepseek / glm 等）收到后可能断流或返回格式异常的 chunk，故仅对原生 OpenAI（GPT 系）
    // 及确认兼容的 provider 下发。
    const isNativeOpenAI = /^(gpt|o1|o3|o4)/i.test(model);
    const stream: any = await this.client.chat.completions.create(
      {
        model,
        messages: cachedMessages,
        ...(hasTools
          ? {
              tools: tools as ChatCompletionTool[],
              tool_choice: "auto", // 不发 parallel_tool_calls：OpenAI 专有参数，部分兼容网关（如 glm-5.1 中转）收到会断流(unexpected EOF)；OpenAI 有 tools 时本就默认并行
              ...(isDeepSeek ? { parallel_tool_calls: false } : {}),
            }
          : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        stream: true,
        // 让流式响应在末尾附带真实 token 用量（精确值，替代上层字符数估算）。
        // 仅对 OpenAI 原生模型下发；中转网关模型（glm/deepseek）不兼容该参数，会断流。
        ...(isNativeOpenAI ? { stream_options: { include_usage: true } } : {}),
      },
      { signal },
    );

    let content = "";
    let finishReason: string | null = null;
    let usage: LLMTurnResult["usage"];
    // 按 index 累积工具调用（chat 协议下工具参数分多个 chunk 流式到达）
    const toolAcc: Array<{ id: string; name: string; arguments: string; announced: boolean }> = [];

    for await (const chunk of stream) {
      // usage chunk：通常是最后一个 chunk，choices 可能为空数组或 undefined
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens ?? 0,
          completionTokens: chunk.usage.completion_tokens ?? 0,
          totalTokens: chunk.usage.total_tokens ?? 0,
          // 提示缓存命中 token（prompt_tokens_details.cached_tokens）——缓存部分计费打折
          cachedTokens: (chunk.usage as any).prompt_tokens_details?.cached_tokens ?? 0,
        };
      }
      // ⚠️ 防御：部分中转站（Anthropic 原生格式）返回的 chunk 没有 choices 字段，
      // 直接 chunk.choices[0] 会报 "Cannot read properties of undefined (reading '0')"
      const choices = (chunk as any).choices;
      if (!Array.isArray(choices) || choices.length === 0) {
        // 尝试 Anthropic 格式兜底
        const anthropicContent = (chunk as any).content;
        const anthropicDelta = (chunk as any).delta;
        if (Array.isArray(anthropicContent)) {
          for (const part of anthropicContent) {
            if (part.type === "text" && part.text) {
              content += part.text;
              callbacks.onTextDelta(part.text);
            }
          }
        }
        if (anthropicDelta?.text) {
          content += anthropicDelta.text;
          callbacks.onTextDelta(anthropicDelta.text);
        }
        if ((chunk as any).stop_reason) finishReason = (chunk as any).stop_reason;
        continue;
      }
      const choice = choices[0];
      const delta = choice?.delta;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (!delta) continue;

      // 思考过程
      const reasoning = (delta as any).reasoning_content || (delta as any).reasoning;
      if (reasoning) callbacks.onReasoningDelta(reasoning);

      // 正文
      if (delta.content) {
        content += delta.content;
        callbacks.onTextDelta(delta.content);
      }

      // 工具调用累积
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolAcc[idx]) {
            toolAcc[idx] = { id: tc.id || "", name: tc.function?.name || "", arguments: "", announced: false };
          }
          if (tc.id) toolAcc[idx].id = tc.id;
          if (tc.function?.name) {
            toolAcc[idx].name = tc.function.name;
            // 工具名首次确定 → 通知上层显示 pending 卡片
            if (!toolAcc[idx].announced && toolAcc[idx].name) {
              toolAcc[idx].announced = true;
              callbacks.onToolCallDetected(toolAcc[idx].name, toolAcc[idx].id || undefined);
            }
          }
          if (tc.function?.arguments) toolAcc[idx].arguments += tc.function.arguments;
        }
      }
    }

    const toolCalls: NormalizedToolCall[] = [];
    const seenIds = new Set<string>();
    for (let i = 0; i < toolAcc.length; i++) {
      const t = toolAcc[i];
      if (!t || !t.name) continue;
      // 保证 id 非空且唯一：部分网关（如 deepseek 并发调用）会漏发或重复 tool_call id，
      // 直接透传会让 assistant.tool_calls 与 tool 结果配对失败 → 下一轮请求 400。
      let id = t.id && t.id.trim() ? t.id.trim() : `call_${Date.now()}_${i}`;
      if (seenIds.has(id)) id = `${id}_${i}`;
      seenIds.add(id);
      toolCalls.push({ id, name: t.name, arguments: t.arguments || "{}" });
    }

    return { content, toolCalls, finishReason, usage };
  }
}

// ═══════════════════════════════════════════════════════════════
//  Prompt Caching 辅助
// ═══════════════════════════════════════════════════════════════

/**
 * 给稳定前缀打 cache_control breakpoint。
 *
 * 策略：打两个 breakpoint，最大化缓存命中率：
 * - breakpoint A：消息总长的 1/4 处（覆盖 system prompt + 早期历史）
 * - breakpoint B：倒数第 3 条（覆盖绝大部分历史，只留最新 2 条变化）
 * 双 breakpoint 让 API 提供商有更灵活的缓存粒度——即使前缀有微小变化（如早期消息被裁剪），
 * breakpoint A 之后的缓存仍然有效。
 */
function applyCacheBreakpoints(messages: any[]): any[] {
  if (messages.length <= 6) return messages;

  const result = [...messages];
  const breakpoints = new Set<number>();

  // breakpoint A：1/4 处
  breakpoints.add(Math.floor(result.length * 0.25));
  // breakpoint B：倒数第 3 条
  breakpoints.add(result.length - 3);

  for (const idx of breakpoints) {
    if (idx < 1 || idx >= result.length - 1) continue;
    const msg = result[idx];
    if (!msg || typeof msg.content !== "string") continue;
    result[idx] = {
      ...msg,
      content: [
        { type: "text", text: msg.content, cache_control: { type: "ephemeral" } },
      ],
    };
  }

  return result;
}
