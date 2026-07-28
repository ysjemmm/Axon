/**
 * 上下文规模的本地估算 —— **与协议、provider、端点全部无关**。
 *
 * ── 为什么上下文占用必须本地算，不能用 API 返回的 usage ──
 *
 * `usage.prompt_tokens` 是**端点的计费口径**，不是"我的上下文有多大"。这两个量经过中转
 * 网关之后就彻底分家了，实测证据（Axon 官方中转站 /v1/messages，claude-sonnet-5）：
 *
 *   · 小请求（真实 264 token）：message_start 报 input_tokens=286（可信），
 *     紧接着 message_delta 又报 input_tokens=6955 —— 与 prompt 无关的计费数字，虚高 26 倍。
 *   · 长会话（count_tokens 权威值 369690）：message_start 恒报 input_tokens=0，
 *     完整 prompt 被拆进 cache_read + cache_creation；但网关只缓存稳定前缀，
 *     未缓存的尾部既不进 input_tokens 也不进缓存字段 —— 合计只有 90710，漏报 3.5 倍。
 *
 * 也就是说同一个端点在不同规模下会给出方向相反的错值。想靠"解释 usage 语义"去还原真实
 * 上下文，等于猜一个网关不肯如实告知的量：每加一种解释分支，就多一种猜错的形态
 *（详见 anthropicUsage.ts 里 plain / additive / cache_only 三分支各自的翻车方式）。
 * 而且这个问题不限于 Anthropic —— 换任何中转站、任何模型都可能重演，甚至压根不返回 usage
 *（原生 OpenAI 不下发 stream_options 就没有 usage；各家中转网关行为不一）。
 *
 * 本地算则完全绕开这件事：输入就是**即将发出去的请求体**，输出是纯函数，
 * 同一份 messages 永远得到同一个数，单调、稳定、与端点无关。
 *
 * ── 精度 ──
 *
 * 实测（1394 条消息 / 128 万字符的真实会话）：本估算 382489，端点 count_tokens 权威值
 * 369690，偏差 +3.5%。对"占比显示"和"75% 压缩阈值"这两个用途完全够用——它们要的是
 * 稳定与单调，而不是精确到个位。反过来，"偶尔精确但会 3.5 倍跳变"才是真正不可用的。
 *
 * 这里刻意不引入 tiktoken 之类的真 tokenizer：各家 tokenizer 互不相同（Claude / GPT /
 * DeepSeek / GLM 都不一样），装一个也只对其中一家准，剩下的仍是估算，却换来一个原生依赖。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/** 中日韩字符（含全角标点）：token 密度远高于拉丁字母，必须分开估 */
function isCjk(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/**
 * 文本 token 估算：CJK 约 0.7 token/字符，其余（英文/代码/JSON）约 3.6 字符/token。
 *
 * 这两个系数是本模块唯一的经验值。早先仓库里散着三套不同口径（0.4/字符一刀切、
 * 0.6/字符、以及这里的分语种系数），同一段历史在不同代码路径上能算出差一倍的结果。
 */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    if (isCjk(text.charCodeAt(i))) cjk++;
  }
  const other = text.length - cjk;
  return Math.ceil(cjk * 0.7 + other / 3.6);
}

/**
 * 单张图片的折算量级。
 * 刻意用固定值而非 base64 长度：一张 1MB 的图 base64 有 130 万字符，按字符估会把整个
 * 上下文撑爆好几倍，而它的真实开销只有一千多 token。
 */
const IMAGE_TOKEN_ESTIMATE = 1600;

/** 每条消息的协议固定开销（role 标记、分隔符等） */
const PER_MESSAGE_OVERHEAD = 4;

/**
 * 估算一条 Chat 格式消息的 token。
 *
 * 关键：**必须覆盖 tool_calls**。工具参数往往就是本轮最大的一块——create_file 的 content
 * 是整个文件正文，str_replace 的 new_str 同理。早先 promptBuilder.messageText 只取
 * content 的 text 段、完全忽略 tool_calls，于是凡是基于它做的估算都系统性漏掉了历史里
 * 最大的部分（工具调用密集的 agent 会话能漏掉一半以上）。
 */
export function estimateChatMessageTokens(msg: ChatCompletionMessageParam | undefined): number {
  if (!msg) return 0;
  let total = PER_MESSAGE_OVERHEAD;

  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    total += estimateTokensFromText(content);
  } else if (Array.isArray(content)) {
    for (const part of content as Array<Record<string, unknown>>) {
      if (!part || typeof part !== "object") continue;
      if (part["type"] === "text") {
        total += estimateTokensFromText(String(part["text"] ?? ""));
      } else if (part["type"] === "image_url") {
        total += IMAGE_TOKEN_ESTIMATE;
      }
    }
  }

  // assistant 的工具调用：函数名 + 参数 JSON
  const toolCalls = (msg as { tool_calls?: unknown }).tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls as Array<Record<string, any>>) {
      total += PER_MESSAGE_OVERHEAD;
      total += estimateTokensFromText(String(tc?.function?.name ?? ""));
      total += estimateTokensFromText(String(tc?.function?.arguments ?? ""));
    }
  }

  return total;
}

/** 估算一组 Chat 消息的 token */
export function estimateChatMessagesTokens(messages: readonly (ChatCompletionMessageParam | undefined)[]): number {
  let total = 0;
  for (const m of messages) total += estimateChatMessageTokens(m);
  return total;
}

/**
 * 估算工具定义的 token。
 * 工具定义是结构化 JSON，token 密度高于自然文本，按序列化后的字符走同一套系数即可
 *（JSON 里几乎全是 ASCII，落在 3.6 字符/token 那一支）。
 */
export function estimateToolDefsTokens(tools: unknown): number {
  if (!tools) return 0;
  try {
    return estimateTokensFromText(JSON.stringify(tools));
  } catch {
    // 循环引用等序列化失败：宁可少算这一块，也不要让估算本身抛错影响主流程
    return 0;
  }
}

/** 一次请求的上下文构成（就是即将发出去的请求体的三个部分） */
export interface PromptParts {
  /** 系统提示（含各类注入）。传数组时自动拼接。 */
  system?: string | readonly string[];
  /** 对话历史（Chat 格式，上层唯一真源） */
  messages?: readonly (ChatCompletionMessageParam | undefined)[];
  /** 工具定义（原样传入，内部序列化估算） */
  tools?: unknown;
}

/**
 * 估算本次请求的上下文总量（system + messages + tools）。
 * 这是上下文占比与压缩决策的**唯一**口径。
 */
export function estimatePromptTokens(parts: PromptParts): number {
  const systemText = Array.isArray(parts.system) ? parts.system.join("\n\n") : (parts.system ?? "");
  return (
    estimateTokensFromText(String(systemText)) +
    estimateChatMessagesTokens(parts.messages ?? []) +
    estimateToolDefsTokens(parts.tools)
  );
}
