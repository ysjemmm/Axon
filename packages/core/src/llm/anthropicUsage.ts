/**
 * Anthropic Messages 协议的 usage 归一化。
 *
 * 为什么需要单独一层：/v1/messages 的 usage 有两套互不兼容的语义，而"中转站"两种都可能返回。
 *
 *  A. Anthropic 原生语义（相加）：input_tokens 只算**未命中缓存**的部分，
 *     真实上下文 = input_tokens + cache_read_input_tokens + cache_creation_input_tokens。
 *  B. OpenAI 式语义（包含）：中转站把上游的 prompt_tokens 直接映射成 input_tokens，
 *     而 OpenAI 的 prompt_tokens **已经包含** cached_tokens；再把 cached_tokens 映射成
 *     cache_read_input_tokens。此时相加就是把缓存部分算了两遍。
 *
 * 老实现无条件按 A 相加，遇到 B 类中转站时上下文占比会随缓存命中量一起虚高
 *（命中越多虚高越狠，长会话里能翻近一倍，甚至冲破 100%、误触发压缩）。
 *
 * 这里的做法：用请求体自身的本地粗估当"裁判"，在两种解释里选更接近的那个。
 * 两个候选值通常相差 1.5~10 倍（缓存命中占大头），而粗估的误差在 ±30% 量级，
 * 足够可靠地区分；差距不大时（<1.3 倍）一律按协议规范取 A，避免粗估噪声乱改数。
 */

/** 流式过程中累积的 Anthropic 原始 usage 字段（未做任何语义解释） */
export interface RawAnthropicUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  /** 是否收到过任何 usage 字段（全 0 与"没返回"要区分开） */
  seen: boolean;
  /** 是否收到过 message_start 的 usage */
  sawStart: boolean;
  /**
   * message_start 里报的 input_tokens 原值（含 0）。
   * 规范的 Messages API 在 message_start 就给出真实 prompt 大小，所以"这里是 0 而缓存字段
   * 非 0"是端点 input_tokens 不代表 prompt 的确定性证据——判别语义时不必依赖任何估算。
   */
  startInputTokens: number;
  /** message_start 里报的缓存字段合计 */
  startCacheTotal: number;
}

/** 归一化后的 usage，附带命中的语义（便于日志与诊断） */
export interface NormalizedAnthropicUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  /**
   * plain      = 无缓存字段，input_tokens 即全部
   * additive   = Anthropic 原生：input + cache_read + cache_creation
   * inclusive  = OpenAI 式：input_tokens 已含缓存部分
   * cache_only = cache_read + cache_creation 才是上下文，input_tokens 是另一套账
   */
  semantics: "plain" | "additive" | "inclusive" | "cache_only";
}

export function emptyRawUsage(): RawAnthropicUsage {
  return {
    inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0,
    seen: false, sawStart: false, startInputTokens: 0, startCacheTotal: 0,
  };
}

/**
 * 把一个 usage 事件（message_start.message.usage / message_delta.usage）合并进累积器。
 *
 * ── prompt 侧字段：message_start 一旦给出，delta 不得改写（实测驱动的修复）──
 *
 * prompt 的大小在请求发出那一刻就固定了，流开始之后逻辑上不可能再变。Anthropic 官方
 * message_delta 也只报 output_tokens，正因如此。
 *
 * 为什么必须约束：实测 Axon 官方中转站（claude-sonnet-5），一个真实只有 264 token 的请求——
 *   message_start.usage = { input_tokens: 286, cache_*: 0 }        ← 可信，误差 8%
 *   message_delta.usage = { input_tokens: 6955, credits: 0.0287 }  ← 与 prompt 无关
 * delta 里那个 6955 是网关自己的计费数字（同一个 delta 里还塞了非标准的 credits 字段作旁证）。
 * 老规则"逐字段覆盖"会让它盖掉 start 的 286，于是这类无缓存小请求的用量虚高 26 倍，
 * 直接体现在 credits 上。
 *
 * 但规则刻意只做到"不得改写"，而不是"delta 一律忽略"：确实存在只在 message_delta 里报
 * usage、message_start 不报的端点，一律忽略会让这些端点彻底拿不到用量。所以 delta 只能
 * **补空**（sawStart 为假时），不能覆盖。对规范端点零影响——它们的 delta 压根不带这些字段。
 *
 * output_tokens 不受此约束，逐事件覆盖：它确实是边生成边累计的，且协议规定 delta 报的是
 * 整条消息的累计值而非增量，取最后一次即为最终值。
 */
export function mergeRawUsage(acc: RawAnthropicUsage, incoming: unknown, isStart = false): void {
  if (!incoming || typeof incoming !== "object") return;
  const u = incoming as Record<string, unknown>;
  const take = (key: string): number | undefined => {
    const v = u[key];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  };

  const output = take("output_tokens");
  if (output !== undefined) {
    acc.outputTokens = output;
    acc.seen = true;
  }

  // message_start 的原值单独留档（含 0），用于判别端点语义
  if (isStart) {
    const rawInput = u["input_tokens"];
    acc.sawStart = true;
    acc.startInputTokens = typeof rawInput === "number" && Number.isFinite(rawInput) ? rawInput : 0;
    acc.startCacheTotal = (take("cache_read_input_tokens") ?? 0) + (take("cache_creation_input_tokens") ?? 0);
  } else if (acc.sawStart) {
    // message_start 已经给过 prompt 侧的账，delta 无权改写（那是网关计费口径）。
    return;
  }

  const input = take("input_tokens");
  const cacheRead = take("cache_read_input_tokens");
  const cacheCreation = take("cache_creation_input_tokens");
  if (input !== undefined) acc.inputTokens = input;
  if (cacheRead !== undefined) acc.cacheReadTokens = cacheRead;
  if (cacheCreation !== undefined) acc.cacheCreationTokens = cacheCreation;
  if (input !== undefined || cacheRead !== undefined || cacheCreation !== undefined) {
    acc.seen = true;
  }
}

/**
 * 文本 token 估算：统一走 tokenEstimator，本模块不再自己维护系数。
 * 早先这里有一份独立的 isCjk + 系数实现，与 tokenAccountant 里的 `chars * 0.4` 是第三份口径——
 * 同一个仓库对"一个字符值多少 token"给出三个答案，占比和计费自然对不上。
 */
import { estimateTokensFromText } from "./tokenEstimator.js";
export { estimateTokensFromText };

/** 单张图片按 Anthropic 常见量级折算（与 base64 长度无关，避免 base64 把估算撑爆） */
const IMAGE_TOKEN_ESTIMATE = 1600;

/** 每条消息的协议固定开销（role/分隔符等） */
const PER_MESSAGE_OVERHEAD = 4;

/**
 * 估算本次请求的 prompt token 总量（system + messages + tools）。
 * 入参就是即将发出去的请求体的三个部分，因此这是"我们自己发了多少"的可信下界参照。
 */
export function estimateAnthropicPromptTokens(
  system: string,
  messages: Array<{ role: string; content: unknown }>,
  tools: unknown[],
): number {
  let total = estimateTokensFromText(system || "");
  if (tools && tools.length > 0) {
    try {
      total += estimateTokensFromText(JSON.stringify(tools));
    } catch {
      /* 工具定义序列化失败时忽略（不影响判别的量级） */
    }
  }
  for (const msg of messages) {
    total += PER_MESSAGE_OVERHEAD;
    const content = msg?.content;
    if (typeof content === "string") {
      total += estimateTokensFromText(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (!block || typeof block !== "object") continue;
      switch (block["type"]) {
        case "text":
          total += estimateTokensFromText(String(block["text"] ?? ""));
          break;
        case "tool_result":
          total += estimateTokensFromText(String(block["content"] ?? ""));
          break;
        case "tool_use":
          total += estimateTokensFromText(String(block["name"] ?? ""));
          try {
            total += estimateTokensFromText(JSON.stringify(block["input"] ?? {}));
          } catch {
            /* 参数序列化失败时忽略 */
          }
          break;
        case "image":
          total += IMAGE_TOKEN_ESTIMATE;
          break;
        default:
          break;
      }
    }
  }
  return total;
}

/**
 * 把累积的原始字段解释成上下文占用。
 *
 * ⚠️ 判别**不使用**任何 token 估算，只认确定性证据。
 * 曾经试过"additive 超出本地粗估 N 倍就换一种解释"的兜底，被本模块的回归测试打掉了：
 * 粗估只要异常偏小（多图按固定量级折算、代码/JSON 密度高于系数、或估算本身有 bug），
 * 它就会把**规范端点**的正确相加值替换成离谱的小值。宁可漏判未知的异常端点，
 * 也不能误伤规范端点。估算（estimateAnthropicPromptTokens）只用于打日志给人看。
 *
 * 三条分支，覆盖所有端点：
 *
 *   plain      无缓存字段          → input_tokens 就是全部（绝大多数端点走这里，行为同改动前）
 *   cache_only message_start 报了
 *              缓存却给 input=0    → cache_read + cache_creation（实测 Axon 官方中转站）
 *   additive   其余                → input + cache_read + cache_creation（Anthropic 规范）
 */
export function normalizeAnthropicUsage(raw: RawAnthropicUsage): NormalizedAnthropicUsage | undefined {
  if (!raw.seen) return undefined;

  const input = raw.inputTokens;
  const cacheRead = raw.cacheReadTokens;
  const cacheCreation = raw.cacheCreationTokens;
  const output = raw.outputTokens;
  const cacheTotal = cacheRead + cacheCreation;

  // 没有缓存字段 → 三种解释退化为同一个，input_tokens 就是全部 prompt。
  // 绝大多数端点（包括不注入 cache_control 的规范 Anthropic API，我们本就不发）走这一支，
  // 结果与改动前完全一致。
  if (cacheTotal <= 0) {
    return {
      promptTokens: input,
      completionTokens: output,
      totalTokens: input + output,
      cachedTokens: cacheRead,
      semantics: "plain",
    };
  }

  // 确定性证据：message_start 报了缓存字段，却给 input_tokens = 0。
  // 规范的 Messages API 在 message_start 就给出真实 prompt 大小，不可能是 0；出现这种组合
  // 说明该端点的 input_tokens 是另一套账（实测 Axon 官方中转站正是如此：input_tokens 逐轮
  // 递减，而 cache_read + cache_creation 稳定按每轮新增量递增，后者才是上下文）。
  if (raw.sawStart && raw.startInputTokens === 0 && raw.startCacheTotal > 0) {
    return {
      promptTokens: cacheTotal,
      completionTokens: output,
      totalTokens: cacheTotal + output,
      cachedTokens: cacheRead,
      semantics: "cache_only",
    };
  }

  // 默认按协议规范相加。规范端点永远落在这一支，与估算准不准无关。
  const additive = input + cacheTotal;
  return {
    promptTokens: additive,
    completionTokens: output,
    totalTokens: additive + output,
    cachedTokens: cacheRead,
    semantics: "additive",
  };
}
