/**
 * Chat Completions 策略：封装 OpenAI /chat/completions 协议。
 *
 * 适用于所有兼容 Chat Completions 的 provider（GLM、Claude 等）。
 * 无状态：每回合发送完整 messages 数组，agent loop 由上层手动驱动。
 */

import OpenAI from "openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { LLMStrategy, RunTurnParams, LLMTurnResult, NormalizedToolCall } from "./types.js";
import { normalizeFinishReason } from "./finishReasonMapper.js";
import { supportsThinking, supportsCacheControl } from "./thinkingSupport.js";
import { parseDsmlToolCalls, looksLikeDsmlStart } from "./dsmlParser.js";

/**
 * 归一化 Chat 兼容网关的文本增量。
 *
 * 标准 OpenAI 只返回 content 字符串；Claude/推理模型中转站还常见：
 * - reasoning_content / reasoning / analysis / thinking 字符串；
 * - channel="analysis" + content 字符串；
 * - content 为结构化 parts（analysis/reasoning/thinking 与 text 混排）。
 *
 * 若不在这里分流，analysis 会落进正文，表现为英文内心 OS 直接显示给用户；部分
 * 网关返回结构化 parts 时还会被隐式转成 "[object Object]" 或整段丢失。
 */
function extractChatDeltaText(delta: any): { reasoning: string; text: string } {
  let reasoning = "";
  let text = "";

  const explicitReasoning = delta?.reasoning_content ?? delta?.reasoning ?? delta?.analysis ?? delta?.thinking;
  if (typeof explicitReasoning === "string") reasoning += explicitReasoning;

  const content = delta?.content;
  if (typeof content === "string") {
    const channel = String(delta?.channel ?? delta?.type ?? "").toLowerCase();
    if (channel === "analysis" || channel === "reasoning" || channel === "thinking") reasoning += content;
    else text += content;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (!part) continue;
      const partType = String(part.type ?? part.channel ?? "text").toLowerCase();
      const value = typeof part.text === "string"
        ? part.text
        : typeof part.content === "string"
          ? part.content
          : typeof part.analysis === "string"
            ? part.analysis
            : typeof part.reasoning === "string"
              ? part.reasoning
              : typeof part.thinking === "string"
                ? part.thinking
                : "";
      if (!value) continue;
      if (partType.includes("analysis") || partType.includes("reasoning") || partType.includes("thinking")) reasoning += value;
      else text += value;
    }
  }

  return { reasoning, text };
}

export class ChatCompletionsStrategy implements LLMStrategy {
  readonly name = "chat_completions";

  constructor(private client: OpenAI) {}

  async runTurn(params: RunTurnParams): Promise<LLMTurnResult> {
    const { model, messages, tools, signal, callbacks, temperature, maxOutputTokens, think, effort, modelSupportsThinking } = params;
    const modelSupportsCacheControl = params.modelSupportsCacheControl;
    const modelSupportsVision = params.modelSupportsVision;

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

    // 多模态降级：如果消息中含 image_url 但模型声明不支持图片（vision === false），
    // 把 image_url 部分剥离，只保留文字 + 提示"图片无法显示"。
    // 用声明判断而非模型名正则硬猜——declaredVisionFor 能精确覆盖自定义 provider 模型。
    const safeMessages = messages.map((m) => {
      if (!m) return m; // 防御：消息为 undefined/null 时保持原样（应由上层 sanitize 保证不出现，此处兜底）
      if (m.role === "user" && Array.isArray(m.content)) {
        const parts = m.content as any[];
        const hasImage = parts.some((p) => p.type === "image_url");
        if (hasImage && modelSupportsVision === false) {
          // 模型不支持图片，降级为纯文本
          const textParts = parts.filter((p) => p.type === "text").map((p) => p.text || "");
          const text = textParts.join("\n");
          // 识图兜底已经把图片转成文字描述（text 里含描述标记）时，不追加"无法显示"提示
          const hasFallbackDesc = text.includes("[图片内容描述");
          return { ...m, content: hasFallbackDesc ? text : text + "\n\n[用户附带了图片，但当前模型不支持查看图片内容]" };
        }
      }
      return m;
    });

    // ── Prompt Caching ──────────────────────────────────────────────
    // OpenAI GPT / o 系列采用自动 Prompt Caching：服务端按逐 token 一致的稳定前缀自动命中，
    // 不需要、也不应把消息改写成 Anthropic 风格的 cache_control content part。
    // 其它明确声明 cacheControl=true 的兼容端点继续使用 ephemeral breakpoint。
    const isNativeOpenAI = /^(gpt|o1|o3|o4)/i.test(model);
    const usesExplicitCacheBreakpoints = !isNativeOpenAI
      && supportsCacheControl(model, modelSupportsCacheControl);
    const requestMessages = usesExplicitCacheBreakpoints
      ? applyCacheBreakpoints(safeMessages)
      : safeMessages;

    // 无工具时不传 tools/tool_choice（如强制总结收尾场景）
    const hasTools = tools.length > 0;
    // DeepSeek 经中转网关并发调用工具时，容易产出空/重复 tool_call id 与交错的参数 JSON，
    // 导致下一轮请求 tool_calls 与 tool 结果配对失败、网关 400（tool_id xxx）。
    // 对 deepseek 关闭并行工具调用（一次一个），从源头规避。其它网关（如 glm 中转）收到该
    // 专有参数会断流，故仅对 deepseek 下发。
    const isDeepSeek = /deepseek/i.test(model);
    const isQwen = /qwen/i.test(model);
    const isGLM = /glm/i.test(model);
    const isQwen37Plus = /qwen(?:3\.7|37)/i.test(model);
    const isDeepSeek4Plus = /deepseek(?:-?v?4|4)/i.test(model);
    const isGLM52Plus = /glm(?:-?5\.[2-9]|-?[6-9]|52)/i.test(model);
    // ── 思考：能力判定与参数编码是两件事，分开处理 ──
    //
    // 能力（这个模型到底支不支持思考）统一走 supportsThinking：声明优先、启发式兜底。
    // 本文件不再自己猜——早先这里是 /glm-?5/ 之类的散装正则，每加一个模型要改三个 strategy。
    // think 省略时按 true 处理：内部调用（压缩摘要 / Relay 评审）不传，行为与开关引入前一致。
    const canThink = think !== false && supportsThinking(model, modelSupportsThinking);
    // 编码（这家 API 要哪个参数名）仍然是厂商相关的，只能按厂商分支：
    // · 智谱 GLM 家族要 thinking:{type:"enabled"}，否则思考会混进 content 被当成正文输出
    // · qwen/deepseek/glm5.2+ 要 reasoning_effort
    // ⚠️ 已声明支持思考、但厂商不在下列任何分支里的模型（如中转站自定义名）不会下发任何
    // 思考参数——宁可少一个能力，也不猜一个可能让网关断流的参数名。要支持新厂商请在此加分支。
    const isGLM5Thinking = canThink && isGLM;
    // stream_options（include_usage）是 OpenAI 专有参数。经中转网关的非 OpenAI 原生模型
    // （deepseek / glm 等）收到后可能断流或返回格式异常的 chunk，故仅对原生 OpenAI（GPT 系）
    // 及确认兼容的 provider 下发。
    // 「会下发 reasoning_effort 的厂商族」单列：开启与关闭两个分支共用，
    // 免得两处各写一遍正则、日后改一处漏一处。
    const effortFamilies = isQwen37Plus || isDeepSeek4Plus || isGLM52Plus;
    // 支持思考的模型就应该下发 reasoning_effort，否则端点可能不分离思考内容，
    // 导致 reasoning 混进正文（kiro-reverse 等中转站需要这个参数来开启 thinking）。
    // 有用户选择的 effort 值就用它；没有就给 "high" 作为安全默认。
    const enableReasoningEffort = canThink;
    const effectiveEffort = effort || "high";
    // ── 显式关闭思考 ──
    // 「不发参数」不等于「让它别想」。实测 deepseek-v4-flash @ 企业网关（A/B 对照）：
    // 不带任何思考参数时端点仍返回 reasoning_content（172 字）且 usage.reasoning_tokens=51
    // —— 它照旧在想、照旧计费，只是我们既看不到（不转发给前端）又用不上（不入历史、不回传），
    // 于是每轮推理链从零重建，表现为反复重述同一结论、重搜同一个东西。
    // 加上 reasoning_effort:"none" 后 reasoning_content 消失（thinking:{type:"disabled"} 亦有效）。
    // 参数名刻意与「开启」分支对称复用：为同一厂商引入第二个参数名，正是本文件反复
    // 强调过的风险（网关不认的参数可能直接断流）。
    const thinkingDisabled = think === false && supportsThinking(model, modelSupportsThinking);
    const stream: any = await this.client.chat.completions.create(
      {
        model,
        messages: requestMessages,
        ...(hasTools
          ? {
              tools: tools as ChatCompletionTool[],
              tool_choice: "auto", // 不发 parallel_tool_calls：OpenAI 专有参数，部分兼容网关（如 glm-5.1 中转）收到会断流(unexpected EOF)；OpenAI 有 tools 时本就默认并行
              ...(isDeepSeek ? { parallel_tool_calls: false } : {}),
            }
          : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxOutputTokens !== undefined ? { max_tokens: maxOutputTokens } : {}),
        // Qwen 模型抑制重复退化：frequency_penalty 是 OpenAI 标准参数，所有兼容网关都支持。
        // ⚠️ 不要加 repetition_penalty——它是 HuggingFace/vLLM 专有参数，中转网关收到会直接断流。
        ...(isQwen
          ? { frequency_penalty: 0.3 }
          : {}),
        // GLM-5 系列：开启思考模式，让 API 把思考内容分离到 reasoning_content 字段，
        // 避免思考过程混进 content 被当作正文输出（智谱官方要求成对下发的参数）。
        ...(isGLM5Thinking ? { thinking: { type: "enabled" } } : {}),
        // 部分 thinking 模型支持 reasoning_effort，用于控制隐藏思考强度。
        // 只下发 Provider 配置中由用户实际选中的值；未选择时不猜默认值。
        // OpenAI SDK 把值限制成官方联合类型；自定义中转站可能接受其它字符串，
        // Provider 配置就是用户对该端点的明确声明，因此这里只在 SDK 类型层放宽，运行时原样透传。
        ...(enableReasoningEffort ? { reasoning_effort: effectiveEffort as any } : {}),
        // 显式关闭思考（见 thinkingDisabled）。只在「开启时确实会下发参数」的分支上对称地关，
        // 免得给本就不支持思考的模型塞无关参数。
        ...(thinkingDisabled && isGLM ? { thinking: { type: "disabled" } } : {}),
        // "none" 需窄化断言：SDK（openai ^4.80）的 ReasoningEffort 只收录了 low/medium/high，
        // 尚未跟上 API。实测该端点接受 "none" 且能真正停掉思考（不带参数时它照旧在想并计费）。
        // 刻意继续用 reasoning_effort 而非改成 thinking —— 与上面的「开启」分支保持同一参数名，
        // 不为同一厂商引入第二种写法。
        ...(thinkingDisabled && effortFamilies ? { reasoning_effort: "none" as unknown as "high" } : {}),
        // 兜底：非特定厂商族的 thinking 模型关闭思考时也下发 "none"，
        // 确保端点真的停掉推理，而不是继续隐式思考并计费。
        ...(thinkingDisabled && !effortFamilies && !isGLM ? { reasoning_effort: "none" as unknown as "high" } : {}),
        stream: true,
        // 让流式响应在末尾附带真实 token 用量（精确值，替代上层字符数估算）。
        // 仅对 OpenAI 原生模型下发；中转网关模型（glm/deepseek）不兼容该参数，会断流。
        ...(isNativeOpenAI ? { stream_options: { include_usage: true } } : {}),
      },
      { signal },
    );

    let content = "";
    // reasoning_content 不用于前端正文展示，但带 tool_calls 时必须原样写回下一轮 assistant 消息。
    // 只在模型实际返回时占用内存；think=false 且端点遵守关闭参数时保持空串。
    let reasoningContent = "";
    let finishReason: string | null = null;
    let usage: LLMTurnResult["usage"];
    // 按 index 累积工具调用（chat 协议下工具参数分多个 chunk 流式到达）
    const toolAcc: Array<{ id: string; name: string; arguments: string; announced: boolean }> = [];
    // DSML 工具调用（deepseek 文本协议）：流式阶段检测到 DSML 块开头后，把后续文本
    // 累积进 dsmlBuffer 而非作为正文发送，流结束后统一解析成工具调用。
    let dsmlActive = false;
    let dsmlBuffer = "";

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
      // 少数兼容网关即使请求 stream=true，也会在最终块返回 choice.message 而非 choice.delta。
      const delta = choice?.delta ?? choice?.message;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (!delta) continue;

      const extracted = extractChatDeltaText(delta);

      // 思考过程
      const reasoning = extracted.reasoning;
      if (reasoning) {
        reasoningContent += reasoning;
        callbacks.onReasoningDelta(reasoning);
      }

      // 正文
      if (extracted.text) {
        if (dsmlActive) {
          // 已在 DSML 工具调用块内：文本累积到 dsmlBuffer，不作为正文发送
          dsmlBuffer += extracted.text;
        } else {
          content += extracted.text;
          // deepseek 用 DSML 文本协议输出工具调用时，content 会以 "<|DSML|tool_calls>" 开头。
          // 检测到即切换 DSML 模式，避免原始 token 泄漏给前端。
          if (isDeepSeek && looksLikeDsmlStart(content.replace(/｜/g, "|").trimStart())) {
            dsmlActive = true;
            dsmlBuffer = content;
            content = "";
          } else {
            callbacks.onTextDelta(extracted.text);
          }
        }
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

    // DSML 工具调用兜底：deepseek 没有走标准 function calling、而是把工具调用以
    // "<|DSML|tool_calls>" 文本吐进 content 时，标准 toolCalls 为空，需要从文本解析。
    let dsmlDetected = false;
    if (toolCalls.length === 0 && isDeepSeek) {
      const source = dsmlActive ? dsmlBuffer : content;
      const parsed = parseDsmlToolCalls(source);
      if (parsed && parsed.calls.length > 0) {
        dsmlDetected = true;
        const base = Date.now();
        for (let i = 0; i < parsed.calls.length; i++) {
          toolCalls.push({
            id: `call_${base}_${i}`,
            name: parsed.calls[i].name,
            arguments: parsed.calls[i].arguments,
          });
        }
        content = parsed.cleanText;
      } else if (dsmlActive) {
        // 进入了 DSML 模式但解析失败：把 dsmlBuffer 回填为正文，至少不丢内容
        dsmlDetected = true;
        content = dsmlBuffer;
      }
    }

    // 归一化结束原因（并存字段）：有工具调用时优先按 tool_calls 语义，否则按原始 finishReason 归一化。
    const normalizedFinishReason = normalizeFinishReason(toolCalls.length > 0 ? "tool_calls" : finishReason);

    return {
      content,
      reasoningContent: reasoningContent || undefined,
      toolCalls,
      finishReason,
      normalizedFinishReason,
      dsmlDetected,
      usage,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
//  Prompt Caching 辅助
// ═══════════════════════════════════════════════════════════════

/**
 * 给稳定前缀打 cache_control breakpoint（显式缓存的兼容端点，如 Qwen / GLM）。
 *
 * 三个断点，位置都跟着「内容边界」走，而不是按消息条数比例算（比例位置每次请求都在挪，等于没打）：
 *   · 开头那段系统提示词的最后一条 —— 整段会话都稳定
 *   · 上一条用户消息 —— 上一轮写下的缓存，本轮第一次请求就能命中
 *   · 最后一条消息 —— 本轮后续每一步都在它之上续写
 * 会话一开始就打（早先要攒够 6 条才打，头几次请求的 1 万多 token 系统提示词全按原价）。
 * content 为数组（多模态）的给最后一段加标记；content 为空的（只有 tool_calls 的 assistant）跳过、往前找。
 */
export function applyCacheBreakpoints(messages: any[]): any[] {
  const result = [...messages];
  const mark = (idx: number): boolean => {
    const msg = result[idx];
    if (!msg) return false;
    if (typeof msg.content === "string" && msg.content) {
      result[idx] = { ...msg, content: [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }] };
      return true;
    }
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      const parts = [...msg.content];
      parts[parts.length - 1] = { ...parts[parts.length - 1], cache_control: { type: "ephemeral" } };
      result[idx] = { ...msg, content: parts };
      return true;
    }
    return false;
  };
  // 1. 开头系统提示词段的最后一条
  let sys = -1;
  while (sys + 1 < result.length && result[sys + 1]?.role === "system") sys++;
  if (sys >= 0) mark(sys);
  // 2. 最后一条（没内容就往前找最近一条有内容的）
  let last = result.length - 1;
  while (last > sys && !mark(last)) last--;
  // 3. 最后那条之前的上一条用户消息
  for (let i = last - 1; i > sys; i--) {
    if (result[i]?.role === "user" && mark(i)) break;
  }
  return result;
}
