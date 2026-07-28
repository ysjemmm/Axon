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
import { supportsThinking } from "./thinkingSupport.js";
import {
  emptyRawUsage,
  mergeRawUsage,
  normalizeAnthropicUsage,
  estimateAnthropicPromptTokens,
} from "./anthropicUsage.js";

/** Anthropic Messages API 版本号（协议必填请求头） */
const ANTHROPIC_VERSION = "2023-06-01";

/** 未显式指定时的输出 token 上限（Anthropic max_tokens 是协议必填字段，没有"不限"选项） */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** 启用 extended thinking 时的 max_tokens 上限（需大于 budget_tokens） */
const THINKING_MAX_OUTPUT_TOKENS = 16384;

/** extended thinking 的 budget_tokens（思考预算） */
const THINKING_BUDGET_TOKENS = 10000;

/**
 * 能力判定统一走 supportsThinking（声明优先、启发式兜底）。
 * 本文件不再自己维护模型名正则——早先那份枚举漏掉了 claude-opus-5，
 * 目录里的旗舰模型反而拿不到思考能力，且漏判不报错、只是静默少个能力。
 */

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

/** 图片尺寸检查结果缓存：key = base64 前缀（截断，避免超长 key）。
 *  同一张图在多轮请求里只解码一次 header，不重复全量 decode。 */
const _imageDimCache = new Map<string, { width: number; height: number } | null>();

/** 纯 JS 解析 PNG/JPEG/WebP 的宽高（不依赖外部库，用于检查是否超 2000px）。
 *  性能：只解码 header 所需的前缀字节，不全量 decode 整张图；并按前缀缓存结果。 */
function decodeImageDimensions(mediaType: string, base64Data: string): { width: number; height: number } | null {
  // 缓存 key 用前 128 字符前缀 + 长度（足够区分不同图，又不占内存）
  const cacheKey = base64Data.length + ":" + base64Data.slice(0, 128);
  const cached = _imageDimCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = decodeImageDimensionsUncached(mediaType, base64Data);
  // 控制缓存规模：超过 200 条时清空（LLM 会话图片数量有限，简单策略即可）
  if (_imageDimCache.size > 200) _imageDimCache.clear();
  _imageDimCache.set(cacheKey, result);
  return result;
}

function decodeImageDimensionsUncached(mediaType: string, base64Data: string): { width: number; height: number } | null {
  try {
    // PNG / WebP 的尺寸都在文件极前部，只需解码前缀；
    // JPEG 的 SOF 段可能靠后，但极少超过前 128KB，取前缀足以覆盖绝大多数图片。
    // 前缀长度按 base64→字节 3/4 比例反推：128KB 字节 ≈ 175000 base64 字符。
    const prefixLen = Math.min(base64Data.length, 175000);
    // base64 必须按 4 字符对齐解码，向下取整到 4 的倍数
    const aligned = prefixLen - (prefixLen % 4);
    const bin = Buffer.from(base64Data.slice(0, aligned), "base64");
    if (mediaType === "image/png" && bin.length > 24) {
      if (bin[0] === 0x89 && bin[1] === 0x50) {
        return { width: bin.readUInt32BE(16), height: bin.readUInt32BE(20) };
      }
    }
    if ((mediaType === "image/jpeg" || mediaType === "image/jpg") && bin.length > 4) {
      let i = 2;
      while (i < bin.length - 9) {
        if (bin[i] !== 0xFF) { i++; continue; }
        const marker = bin[i + 1];
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { width: bin.readUInt16BE(i + 7), height: bin.readUInt16BE(i + 5) };
        }
        const segLen = bin.readUInt16BE(i + 2);
        i += 2 + segLen;
      }
    }
    if (mediaType === "image/webp" && bin.length > 30) {
      if (bin.slice(12, 16).toString("ascii") === "VP8 ") {
        return { width: bin.readUInt16LE(26) + 1, height: bin.readUInt16LE(28) + 1 };
      }
    }
  } catch { /* ignore parse errors */ }
  return null;
}

/** 只提示一次：端点在 message_start 报了缓存却给 input_tokens=0，说明它的 input_tokens 不是 prompt 大小 */
let _warnedUsageSemantics = false;
function warnUsageSemanticsOnce(raw: unknown, estimate: number): void {
  if (_warnedUsageSemantics) return;
  _warnedUsageSemantics = true;
  console.warn(
    "[anthropic-usage] 端点在 message_start 报了缓存字段却给 input_tokens=0，" +
      "说明其 input_tokens 不代表 prompt 大小（疑似网关自己的计费口径）；" +
      "上下文占用已改用 cache_read + cache_creation，否则会随缓存命中量虚高。" +
      `raw=${JSON.stringify(raw)} 本地粗估（仅供参考）=${estimate}`,
  );
}

export class AnthropicMessagesStrategy implements LLMStrategy {
  readonly name = "anthropic_messages";

  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async runTurn(params: RunTurnParams): Promise<LLMTurnResult> {
    const { model, messages, tools, signal, callbacks, temperature, maxOutputTokens, think, modelSupportsThinking } = params;

    const { system, anthropicMessages } = this.convertMessages(messages);
    const hasTools = tools.length > 0;
    const anthropicTools = hasTools ? this.convertTools(tools) : [];
    // 本地粗估本次请求的 prompt 规模：用于识别中转站返回的 usage 是"原生相加"还是"已含缓存"语义
    // （见 anthropicUsage.ts）。只做判别，不参与计费。
    const estimatedPromptTokens = estimateAnthropicPromptTokens(system, anthropicMessages, anthropicTools);

    const url = this.baseUrl.replace(/\/+$/, "") + "/messages";
    // 用户关掉思考 → 不下发 thinking（连带恢复 temperature 生效、max_tokens 回到常规默认）。
    // think 省略时按 true 处理：内部调用（压缩摘要 / Relay 评审）不传，行为与开关引入前一致。
    const useThinking = think !== false && supportsThinking(model, modelSupportsThinking);
    const effectiveMaxTokens = useThinking
      ? Math.max(maxOutputTokens ?? THINKING_MAX_OUTPUT_TOKENS, THINKING_BUDGET_TOKENS + 1024)
      : (maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);

    const body: Record<string, unknown> = {
      model,
      max_tokens: effectiveMaxTokens,
      messages: anthropicMessages,
      stream: true,
      ...(system ? { system } : {}),
      ...(hasTools ? { tools: anthropicTools } : {}),
      // extended thinking 要求 temperature=1 或不传；启用时忽略外部 temperature
      ...(useThinking ? {} : (temperature !== undefined ? { temperature } : {})),
      ...(useThinking ? { thinking: { type: "enabled", budget_tokens: THINKING_BUDGET_TOKENS } } : {}),
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

    return this.parseStream(res.body, callbacks, estimatedPromptTokens);
  }

  /** 解析 Anthropic Messages API 的 SSE 流，产出标准化 LLMTurnResult */
  private async parseStream(
    body: ReadableStream<Uint8Array>,
    callbacks: RunTurnParams["callbacks"],
    estimatedPromptTokens = 0,
  ): Promise<LLMTurnResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let content = "";
    let stopReason: string | null = null;
    // 原始 usage 字段逐事件累积，语义解释统一放到流结束后做一次
    // （中途"边合并边解释"正是上下文占比被重复累加的根因，见 anthropicUsage.ts）
    const rawUsage = emptyRawUsage();
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
            // 扩展思考模式（extended thinking）：Anthropic 的思考内容独立于正文。
            //
            // 必须把 data.index（content block 索引）作为 partIndex 透传：一次响应里可以有
            // 多个 thinking 块（thinking → tool_use → thinking），块号是协议原生的身份标识。
            // 丢掉它，前端就只能靠"谁还在 streaming"猜某段增量属于哪个思考块——任何提前到达
            // 的事件（如流式阶段就发出的工具卡片）都会把这个推断打翻，表现为一排并列的空"思考过程"。
            callbacks.onReasoningDelta(delta.thinking, data.index);
          }
          break;
        }
        case "message_delta": {
          if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
          if (data.usage) {
            if (process.env["AXON_LLM_DEBUG"]) console.log("[anthropic-usage] message_delta.usage =", JSON.stringify(data.usage));
            mergeRawUsage(rawUsage, data.usage);
          }
          break;
        }
        case "message_start": {
          const msgUsage = data.message?.usage;
          if (msgUsage) {
            if (process.env["AXON_LLM_DEBUG"]) console.log("[anthropic-usage] message_start.usage =", JSON.stringify(msgUsage));
            mergeRawUsage(rawUsage, msgUsage, true);
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

    // 判别只看 usage 自身的确定性特征，不掺入 estimatedPromptTokens——后者仅用于日志诊断
    const normalized = normalizeAnthropicUsage(rawUsage);
    if (normalized?.semantics === "cache_only") {
      warnUsageSemanticsOnce(rawUsage, estimatedPromptTokens);
    }
    if (normalized && process.env["AXON_LLM_DEBUG"]) {
      console.log(
        `[anthropic-usage] raw=${JSON.stringify(rawUsage)} 本地粗估=${estimatedPromptTokens} → 语义=${normalized.semantics} 上下文=${normalized.promptTokens}`,
      );
    }
    const usage: LLMTurnResult["usage"] = normalized
      ? {
          promptTokens: normalized.promptTokens,
          completionTokens: normalized.completionTokens,
          totalTokens: normalized.totalTokens,
          cachedTokens: normalized.cachedTokens,
        }
      : undefined;

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

  /** data: URL -> base64 图片块；普通 http(s) URL -> url 图片块.
   *  超 2000px 的图片降级为文字提示（Anthropic 多图请求限制 2000px，否则 400）。
   */
  private convertImage(url: string): AnthropicContentBlock {
    const dataMatch = /^data:([^;]+);base64,(.+)$/.exec(url);
    if (dataMatch) {
      const mediaType = dataMatch[1];
      const base64Data = dataMatch[2];
      const dims = decodeImageDimensions(mediaType, base64Data);
      if (dims && (dims.width > 2000 || dims.height > 2000)) {
        console.warn(`[anthropic] image ${dims.width}x${dims.height} exceeds 2000px limit, downgraded`);
        return { type: "text", text: `[image omitted: ${dims.width}x${dims.height} exceeds 2000px limit]` };
      }
      return { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } };
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
