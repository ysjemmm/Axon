/**
 * Anthropic Messages 策略：封装 Anthropic 原生 /v1/messages 协议。
 *
 * 适用场景：provider 的端点只提供 Anthropic 原生 Messages API，没有 OpenAI 兼容的
 * /v1/chat/completions 转换层（多数"中转站"两者都有，走 chat 协议即可；只有极少数
 * 纯原生代理才需要这个策略）。
 *
 * 与 ChatCompletionsStrategy / ResponsesStrategy 的关系：三者都实现同一个 LLMStrategy
 * 接口，对上层 agentSession 完全透明——上层始终用 Chat 格式维护 messages 历史，
 * 三种策略各自负责把它转换成协议原生格式，再把响应转换回统一的 LLMTurnResult。
 *
 * 认证：x-api-key 请求头 + anthropic-version 请求头（而非 OpenAI 的 Authorization: Bearer）。
 * 不复用 OpenAI SDK：协议形态（请求体结构、SSE 事件类型、工具调用表示）与 Chat Completions
 * 完全不同，硬套 OpenAI SDK 只会两头不讨好，直接用原生 fetch + 手写 SSE 解析更清晰。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { LLMStrategy, RunTurnParams, LLMTurnResult, NormalizedToolCall, ToolDef } from "./types.js";
import { sanitizeToolPairing } from "../messageSanitizer.js";
import { normalizeFinishReason } from "./finishReasonMapper.js";

/** Anthropic Messages API 版本号（协议必填请求头） */
const ANTHROPIC_VERSION = "2023-06-01";

/** 未显式指定时的输出 token 上限（Anthropic max_tokens 是协议必填字段，没有"不限"选项） */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** Anthropic 内容块（请求侧：文本 / 图片 / 工具调用 / 工具结果） */
type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export class AnthropicMessagesStrategy implements LLMStrategy {
  readonly name = "anthropic_messages";

  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async runTurn(params: RunTurnParams): Promise<LLMTurnResult> {
    const { model, messages, tools, signal, callbacks, temperature, maxOutputTokens } = params;

    const { system, anthropicMessages } = this.convertMessages(messages);
    const hasTools = tools.length > 0;

    const url = this.baseUrl.replace(/\/+$/, "") + "/messages";
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      messages: anthropicMessages,
      stream: true,
      ...(system ? { system } : {}),
      ...(hasTools ? { tools: this.convertTools(tools) } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Anthropic Messages API 请求失败：HTTP ${res.status} ${res.statusText}${errText ? ` - ${errText}` : ""}`);
    }

    return this.parseStream(res.body, callbacks);
  }

  /** 解析 Anthropic Messages API 的 SSE 流，产出标准化 LLMTurnResult */
  private async parseStream(body: ReadableStream<Uint8Array>, callbacks: RunTurnParams["callbacks"]): Promise<LLMTurnResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let content = "";
    let stopReason: string | null = null;
    let usage: LLMTurnResult["usage"];
    // 按内容块 index 累积（text 块合并进 content；tool_use 块单独累积参数 JSON 片段）
    const toolByIndex = new Map<number, { id: string; name: string; arguments: string; announced: boolean }>();

    const handleEvent = (eventType: string, data: any): void => {
      switch (eventType) {
        case "content_block_start": {
          const block = data.content_block;
          if (block?.type === "tool_use") {
            toolByIndex.set(data.index, { id: block.id || "", name: block.name || "", arguments: "", announced: false });
            if (block.name) {
              const rec = toolByIndex.get(data.index)!;
              rec.announced = true;
              callbacks.onToolCallDetected(block.name, rec.id || undefined);
            }
          }
          break;
        }
        case "content_block_delta": {
          const delta = data.delta;
          if (delta?.type === "text_delta" && delta.text) {
            content += delta.text;
            callbacks.onTextDelta(delta.text);
          } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const rec = toolByIndex.get(data.index);
            if (rec) rec.arguments += delta.partial_json;
          } else if (delta?.type === "thinking_delta" && delta.thinking) {
            // 扩展思考模式（extended thinking）：Anthropic 的思考内容独立于正文
            callbacks.onReasoningDelta(delta.thinking);
          }
          break;
        }
        case "message_delta": {
          if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
          if (data.usage) {
            usage = {
              promptTokens: data.usage.input_tokens ?? usage?.promptTokens ?? 0,
              completionTokens: data.usage.output_tokens ?? 0,
              totalTokens: (data.usage.input_tokens ?? usage?.promptTokens ?? 0) + (data.usage.output_tokens ?? 0),
              cachedTokens: data.usage.cache_read_input_tokens ?? 0,
            };
          }
          break;
        }
        case "message_start": {
          const msgUsage = data.message?.usage;
          if (msgUsage) {
            usage = {
              promptTokens: msgUsage.input_tokens ?? 0,
              completionTokens: msgUsage.output_tokens ?? 0,
              totalTokens: (msgUsage.input_tokens ?? 0) + (msgUsage.output_tokens ?? 0),
              cachedTokens: msgUsage.cache_read_input_tokens ?? 0,
            };
          }
          break;
        }
        case "error": {
          const msg = data.error?.message || "Anthropic 流式响应返回错误事件";
          throw new Error(msg);
        }
        default:
          break;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE 帧以空行分隔；每帧内 "event: xxx" + "data: {...}"
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        let eventType = "";
        let dataLine = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
        }
        if (!eventType || !dataLine) continue;
        try {
          handleEvent(eventType, JSON.parse(dataLine));
        } catch (err) {
          // 单帧解析失败不应中断整个流（防御性丢弃该帧）
          console.warn("[anthropic] SSE 帧解析失败（忽略）:", (err as Error).message);
        }
      }
    }

    const toolCalls: NormalizedToolCall[] = [];
    for (const t of toolByIndex.values()) {
      if (!t.name) continue;
      toolCalls.push({ id: t.id || `call_${Date.now()}`, name: t.name, arguments: t.arguments || "{}" });
    }

    // stop_reason 映射到 Chat Completions 词表，复用同一套归一化规则
    const rawFinishReason = this.mapStopReason(stopReason, toolCalls.length > 0);
    const normalizedFinishReason = normalizeFinishReason(rawFinishReason);

    return { content, toolCalls, finishReason: rawFinishReason, normalizedFinishReason, usage };
  }

  /** Anthropic stop_reason → Chat Completions 风格 finishReason（复用 normalizeFinishReason 词表） */
  private mapStopReason(stopReason: string | null, hasToolCalls: boolean): string | null {
    if (hasToolCalls) return "tool_calls";
    switch (stopReason) {
      case "end_turn":
      case "stop_sequence":
        return "stop";
      case "max_tokens":
        return "length";
      case "tool_use":
        return "tool_calls";
      case "refusal":
        return "content_filter";
      default:
        return stopReason; // 未知值原样传递，normalizeFinishReason 会保守归为 error
    }
  }

  /**
   * 把上层维护的 Chat 格式 messages 转成 Anthropic 的 system + messages。
   * - system 消息合并为顶层 system 字段（Anthropic 不支持 system role 消息）
   * - assistant 的 tool_calls → tool_use 内容块
   * - role:tool 的结果 → user 消息里的 tool_result 内容块（Anthropic 要求工具结果放在 user turn）
   * - 多模态 image_url → image 内容块（data: URL 转 base64 块，普通 URL 转 url 块）
   */
  private convertMessages(messages: ChatCompletionMessageParam[]): { system: string; anthropicMessages: AnthropicMessage[] } {
    // 发送前清洗：保证 tool_calls 与 tool 结果严格配对，避免协议层错位。
    const cleaned = sanitizeToolPairing(messages);

    const systemParts: string[] = [];
    const result: AnthropicMessage[] = [];

    for (const msg of cleaned) {
      const role = (msg as any).role;

      if (role === "system") {
        const text = this.extractText(msg.content);
        if (text) systemParts.push(text);
        continue;
      }

      if (role === "tool") {
        // 工具结果必须放进 user turn 的 tool_result 块；Anthropic 要求紧跟在对应 tool_use 之后，
        // 且同一批工具结果应合并进一条 user 消息（多个 tool_result 块），否则某些实现会报格式错误。
        const block: AnthropicContentBlock = {
          type: "tool_result",
          tool_use_id: (msg as any).tool_call_id || "",
          content: this.extractText(msg.content) || "",
        };
        const last = result[result.length - 1];
        if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) {
          last.content.push(block);
        } else {
          result.push({ role: "user", content: [block] });
        }
        continue;
      }

      if (role === "assistant") {
        const blocks: AnthropicContentBlock[] = [];
        const text = this.extractText(msg.content);
        if (text) blocks.push({ type: "text", text });
        const toolCalls = (msg as any).tool_calls;
        if (Array.isArray(toolCalls)) {
          for (const tc of toolCalls) {
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(tc.function?.arguments || "{}");
            } catch {
              input = {};
            }
            blocks.push({ type: "tool_use", id: tc.id || "", name: tc.function?.name || "", input });
          }
        }
        if (blocks.length > 0) result.push({ role: "assistant", content: blocks });
        continue;
      }

      if (role === "user") {
        if (Array.isArray(msg.content)) {
          const parts = msg.content as any[];
          const blocks: AnthropicContentBlock[] = [];
          for (const part of parts) {
            if (part.type === "text") {
              blocks.push({ type: "text", text: part.text || "" });
            } else if (part.type === "image_url" && part.image_url?.url) {
              blocks.push(this.convertImage(part.image_url.url));
            }
          }
          result.push({ role: "user", content: blocks });
        } else {
          const text = this.extractText(msg.content);
          result.push({ role: "user", content: text });
        }
        continue;
      }
    }

    return { system: systemParts.join("\n\n"), anthropicMessages: result };
  }

  /** data: URL → base64 图片块；普通 http(s) URL → url 图片块 */
  private convertImage(url: string): AnthropicContentBlock {
    const dataMatch = /^data:([^;]+);base64,(.+)$/.exec(url);
    if (dataMatch) {
      return { type: "image", source: { type: "base64", media_type: dataMatch[1], data: dataMatch[2] } };
    }
    return { type: "image", source: { type: "url", url } };
  }

  /** 提取消息文本内容（兼容字符串和多模态数组） */
  private extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((part: any) => (part?.type === "text" ? part.text || "" : "")).join("");
    }
    return "";
  }

  /** Chat 工具定义（function 包裹）→ Anthropic 工具定义（input_schema 平铺） */
  private convertTools(tools: ToolDef[]): AnthropicToolDef[] {
    return tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }
}
