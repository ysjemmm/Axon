/**
 * Responses 策略：封装 OpenAI /responses 协议（原生 agentic loop）。
 *
 * 适用于支持 Responses API 的 provider（OpenAI / esign 网关）。相比 Chat Completions：
 * - 原生支持 reasoning（思考过程独立返回，不混在正文里）
 * - 模型更清楚自己处于"未完成的任务链"中，不易自停
 *
 * 设计：对上层保持与 ChatCompletionsStrategy 完全一致的接口。内部把上层维护的
 * Chat 格式 messages 转成 Responses 的 input 数组，输出仍是标准 LLMTurnResult。
 * 这样上层 agentSession 无需感知底层协议差异，继续用 Chat 格式维护历史。
 *
 * 注意：本策略采用"无状态"模式（每回合发送完整 input，不用 previous_response_id）。
 * 这样能复用上层既有的 messages 持久化/压缩/会话恢复逻辑，避免引入服务端状态依赖。
 * Responses API 防自停的收益主要来自其推理机制本身，无状态模式同样受益。
 */

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { LLMStrategy, RunTurnParams, LLMTurnResult, NormalizedToolCall, ToolDef } from "./types.js";
import { sanitizeToolPairing } from "../messageSanitizer.js";
import { normalizeFinishReason, mapResponsesStatusToFinishReason } from "./finishReasonMapper.js";

/** Responses API 的输入项（联合类型，覆盖普通消息 / 工具调用 / 工具结果） */
type ResponsesInputItem =
  | { role: "system" | "user" | "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

/** Responses API 的工具定义格式（function 字段平铺，无外层 function 包裹） */
interface ResponsesToolDef {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export class ResponsesStrategy implements LLMStrategy {
  readonly name = "responses";

  constructor(private client: OpenAI) {}

  async runTurn(params: RunTurnParams): Promise<LLMTurnResult> {
    const { model, messages, tools, signal, callbacks, temperature, maxOutputTokens } = params;

    const isGpt = /^gpt/i.test(model);
    // 推理模型（gpt-5.x / o1 / o3 / o4 系列）支持 reasoning summary。
    // 显式请求 summary 后，流式响应中会返回 reasoning_summary_text.delta 事件，
    // 上层 onReasoningDelta 回调接收后推送给前端展示为可折叠"思考过程"。
    // 不传该参数时模型默认不吐摘要，前端 ReasoningBlock 拿不到内容。
    const isReasoningModel = /^(gpt-5|o1|o3|o4)/i.test(model);
    const { instructions, input } = this.convertMessages(messages);
    const hasTools = tools.length > 0;
    const actionReinforcement = isGpt
      ? "【执行约束】当用户已经明确要求你修改、修复、实现、创建、删除、运行或检查某项内容时，默认直接开始执行，不要先询问‘是否开始’‘是否继续’‘确认后我就做’。只有在以下情况才允许先问用户：1. 会覆盖/删除已有内容，且用户尚未明确授权；2. 需求存在关键歧义，继续执行会走向不同结果；3. 需要用户在多个方案之间做决定。除上述情况外，直接调用工具推进任务。"
      : null;

    const stream: any = await (this.client as any).responses.create(
      {
        model,
        ...(instructions || actionReinforcement ? { instructions: [instructions, actionReinforcement].filter(Boolean).join("\n\n") } : {}),
        input,
        ...(hasTools ? { tools: this.convertTools(tools), tool_choice: "auto", parallel_tool_calls: true } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
        // 推理模型显式请求思考摘要：summary="auto" 让模型自行决定是否产出，
        // 避免简单任务也强制生成摘要浪费 token。
        ...(isReasoningModel ? { reasoning: { summary: "auto" } } : {}),
        store: false,
        stream: true,
      },
      { signal },
    );

    let content = "";
    let finishReason: string | null = null;
    let responseId: string | undefined;
    let usage: LLMTurnResult["usage"];
    // 按 output_item 的 index 累积工具调用
    const toolByIndex = new Map<number, { id: string; name: string; arguments: string; announced: boolean }>();

    for await (const event of stream) {
      const type: string = event?.type || "";

      switch (type) {
        // 正文增量
        case "response.output_text.delta":
          if (event.delta) {
            content += event.delta;
            callbacks.onTextDelta(event.delta);
          }
          break;

        // 思考过程增量（reasoning summary）
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta":
          if (event.delta) callbacks.onReasoningDelta(event.delta, event.summary_index, event.item_id);
          break;

        // 新的 output item 出现：可能是 function_call，记录其 id/name
        case "response.output_item.added": {
          const item = event.item;
          // 诊断：记录每个 output item 类型（排查文本回复为空时模型实际输出了什么类型）
          console.log(`[responses] output_item.added type=${item?.type} idx=${event.output_index}`);
          if (item?.type === "function_call") {
            const idx = event.output_index ?? toolByIndex.size;
            toolByIndex.set(idx, {
              id: item.call_id || item.id || "",
              name: item.name || "",
              arguments: "",
              announced: false,
            });
            // 工具名已知 → 立刻通知上层显示 pending 卡片
            if (item.name) {
              const rec = toolByIndex.get(idx)!;
              rec.announced = true;
              callbacks.onToolCallDetected(item.name, rec.id || undefined);
            }
          }
          break;
        }

        // 工具调用参数流式增量
        case "response.function_call_arguments.delta": {
          const idx = event.output_index ?? 0;
          const rec = toolByIndex.get(idx);
          if (rec && event.delta) rec.arguments += event.delta;
          break;
        }

        // 工具调用参数完成
        case "response.function_call_arguments.done": {
          const idx = event.output_index ?? 0;
          const rec = toolByIndex.get(idx);
          if (rec) {
            if (typeof event.arguments === "string") rec.arguments = event.arguments;
            if (!rec.announced && rec.name) {
              rec.announced = true;
              callbacks.onToolCallDetected(rec.name, rec.id || undefined);
            }
          }
          break;
        }

        // output item 完成：补全工具调用的 name/call_id（有些实现 name 在 done 时才完整）
        case "response.output_item.done": {
          const item = event.item;
          if (item?.type === "function_call") {
            const idx = event.output_index ?? 0;
            const rec = toolByIndex.get(idx) || { id: "", name: "", arguments: "", announced: false };
            if (item.call_id || item.id) rec.id = item.call_id || item.id;
            if (item.name) rec.name = item.name;
            if (typeof item.arguments === "string") rec.arguments = item.arguments;
            toolByIndex.set(idx, rec);
          }
          break;
        }

        // 响应完成
        case "response.completed":
        case "response.incomplete":
        case "response.failed": {
          const resp = event.response;
          if (resp?.id) responseId = resp.id;
          console.log(`[responses] ${type} status=${resp?.status} contentLen=${content.length} toolCalls=${toolByIndex.size}`);
          // Responses API 的 usage 字段：input_tokens / output_tokens / total_tokens
          if (resp?.usage) {
            usage = {
              promptTokens: resp.usage.input_tokens ?? 0,
              completionTokens: resp.usage.output_tokens ?? 0,
              totalTokens: resp.usage.total_tokens ?? 0,
              // 提示缓存命中的 token（input_tokens_details.cached_tokens）——缓存部分计费打折
              cachedTokens: resp.usage.input_tokens_details?.cached_tokens ?? 0,
            };
          }
          // completed=正常完成；incomplete=被截断需续写；failed=非正常中断，交给上层按异常收尾处理。
          // 映射规则收敛到 mapResponsesStatusToFinishReason 纯函数，避免散落多份、被测试锁死。
          finishReason = mapResponsesStatusToFinishReason(resp?.status);
          break;
        }

        default:
          // 诊断：记录未处理的事件类型（排查是否有正文回复走了未知事件路径）
          if (type && !type.startsWith("response.output_text.") && !type.startsWith("response.reasoning")) {
            console.log(`[responses] unhandled event: ${type}`);
          }
          break;
      }
    }

    const toolCalls: NormalizedToolCall[] = [...toolByIndex.values()]
      .filter((t) => t.name)
      .map((t) => ({ id: t.id, name: t.name, arguments: t.arguments || "{}" }));

    if (toolCalls.length > 0) finishReason = "tool_calls";

    // 归一化结束原因（并存字段）：与 finishReason 并存，不替换旧字段，供新 pipeline 逐步接管。
    const normalizedFinishReason = normalizeFinishReason(finishReason);

    return { content, toolCalls, finishReason, normalizedFinishReason, responseId, usage };
  }

  /**
   * 把上层维护的 Chat 格式 messages 转成 Responses 的 input。
   * - system 消息合并为 instructions
   * - assistant 的 tool_calls → function_call 项
   * - role:tool 的结果 → function_call_output 项
   * - 普通 user/assistant 文本 → {role, content}
   */
  private convertMessages(messages: ChatCompletionMessageParam[]): {
    instructions: string;
    input: ResponsesInputItem[];
  } {
    // 发送前清洗：保证 function_call 与 function_call_output 严格配对，避免 API 400。
    // 虽然 buildRequestMessages 已调用过 sanitizeToolPairing，但此处做防御性二次校验，
    // 防止其它调用路径绕过上层清洗直接传脏数据进来。
    const cleaned = sanitizeToolPairing(messages);

    const systemParts: string[] = [];
    const input: ResponsesInputItem[] = [];

    for (const msg of cleaned) {
      const role = (msg as any).role;

      if (role === "system") {
        const text = this.extractText(msg.content);
        if (text) systemParts.push(text);
        continue;
      }

      if (role === "tool") {
        // 工具结果
        input.push({
          type: "function_call_output",
          call_id: (msg as any).tool_call_id || "",
          output: this.extractText(msg.content) || "",
        });
        continue;
      }

      if (role === "assistant") {
        const text = this.extractText(msg.content);
        if (text) input.push({ role: "assistant", content: text });
        // assistant 的工具调用
        const toolCalls = (msg as any).tool_calls;
        if (Array.isArray(toolCalls)) {
          for (const tc of toolCalls) {
            input.push({
              type: "function_call",
              call_id: tc.id || "",
              name: tc.function?.name || "",
              arguments: tc.function?.arguments || "{}",
            });
          }
        }
        continue;
      }

      if (role === "user") {
        // user 可能是多模态数组（含图片）；Responses API 同样支持 content 数组
        if (Array.isArray(msg.content)) {
          // 包含 image_url 时，保持数组格式传递（Responses API 支持 input_image content part）
          const hasImage = (msg.content as any[]).some((p: any) => p.type === "image_url");
          if (hasImage) {
            const parts: any[] = [];
            for (const part of msg.content as any[]) {
              if (part.type === "text") {
                parts.push({ type: "input_text", text: part.text || "" });
              } else if (part.type === "image_url" && part.image_url?.url) {
                parts.push({ type: "input_image", image_url: part.image_url.url });
              }
            }
            input.push({ role: "user", content: parts } as any);
          } else {
            const text = this.extractText(msg.content);
            input.push({ role: "user", content: text });
          }
        } else {
          const text = this.extractText(msg.content);
          input.push({ role: "user", content: text });
        }
        continue;
      }
    }

    return { instructions: systemParts.join("\n\n"), input };
  }

  /** 提取消息文本内容（兼容字符串和多模态数组） */
  private extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part: any) => (part?.type === "text" ? part.text || "" : ""))
        .join("");
    }
    return "";
  }

  /** Chat 工具定义 → Responses 工具定义（function 字段平铺） */
  private convertTools(tools: ToolDef[]): ResponsesToolDef[] {
    return tools.map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
  }
}
