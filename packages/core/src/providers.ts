/**
 * Provider（LLM 供应商）运行时 —— 按 provider 名产出 OpenAI client 与调用策略。
 *
 * 数据来源是 ProviderRegistry 解析出的 ResolvedProvider[]：bootstrap（server 入口 / 扩展 activate）
 * 解析 providers.json + 内置目录后，调 applyResolvedProviders() 注入到本模块的同步存储；
 * getClient / getStrategy 读这份存储。配置变更时重新解析 + 注入即可（会清空 client/strategy 缓存）。
 *
 * 兜底：若从未注入（纯 server 只配了 env、未走 bootstrap 注入），回退到读 PROVIDER_<NAME>_* 环境变量，
 * 保证旧部署零改动可用。
 */

import OpenAI from "openai";
import { ChatCompletionsStrategy } from "./llm/chatCompletionsStrategy.js";
import { ResponsesStrategy } from "./llm/responsesStrategy.js";
import { AnthropicMessagesStrategy } from "./llm/anthropicMessagesStrategy.js";
import type { LLMStrategy } from "./llm/types.js";
import { type ProviderProtocol, type ResolvedProvider, type ApiKeyHeader } from "./providerTypes.js";
import type { ProviderRegistry } from "./providerRegistry.js";

/** Provider 运行时配置（client 创建所需的最小信息） */
export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  /** 认证头格式，默认 bearer */
  apiKeyHeader?: ApiKeyHeader;
}

/** 旧 provider 名 → 当前名 的向后兼容映射 */
const LEGACY_PROVIDER_ALIASES: Record<string, string> = {};

/** 归一化 provider 名：把已废弃的旧名映射到当前名 */
export function normalizeProvider(provider: string): string {
  return LEGACY_PROVIDER_ALIASES[provider] || provider;
}

// ── 已解析 provider 的同步存储（由 bootstrap 注入）─────────────────────────

/** name → ResolvedProvider；null 表示尚未注入（走 env 兜底） */
let _resolved: Map<string, ResolvedProvider> | null = null;

/** 注入解析后的 provider 列表（bootstrap / 配置变更时调用），并清空下游缓存 */
export function applyResolvedProviders(providers: ResolvedProvider[]): void {
  _resolved = new Map(providers.map((p) => [p.name, p]));
  for (const k of Object.keys(clients)) delete clients[k];
  for (const k of Object.keys(strategies)) delete strategies[k];
}

/** 用注册表重新解析并注入（便捷封装，bootstrap 与配置监听都用它） */
export async function refreshProviders(registry: ProviderRegistry): Promise<ResolvedProvider[]> {
  const list = await registry.resolve();
  applyResolvedProviders(list);
  setVisionFallbackModel(await registry.getVisionFallbackModel());
  return list;
}

/** 当前已注入的 provider 列表（未注入返回空数组） */
export function getResolvedProviders(): ResolvedProvider[] {
  return _resolved ? [..._resolved.values()] : [];
}

/**
 * 把"用户填写的 provider 标识"解析成规范 provider name。
 *
 * 为什么需要：面向用户的配置项（如 `axon.inlineCompletion.provider`）是自由文本，
 * 而 provider 有两个不同的标识——name（key，如 `esign-now`）与 label（展示名，如 `公司中转站`）。
 * 用户在界面里看到的是 label，很容易把 label 填进配置；而 getClient / getStrategy
 * 只认 name，于是抛「未知 provider: 公司中转站」，且内联补全每次击键都会重报一次。
 *
 * 解析顺序：
 *   1) 精确匹配 name（先做历史别名归一化 normalizeProvider）
 *   2) 大小写不敏感匹配 label；命中多个（不同 provider 用了同名展示名）时不猜，返回 undefined
 * 都未命中返回 undefined，由调用方决定回退还是报错——不在这里偷偷替换成别的 provider。
 */
export function resolveProviderName(input: string): string | undefined {
  const raw = (input || "").trim();
  if (!raw) return undefined;

  const normalized = normalizeProvider(raw);
  const list = getResolvedProviders();
  if (list.length === 0) return undefined;

  // 1) name 精确匹配（name 是内部 key，区分大小写）
  if (list.some((p) => p.name === normalized)) return normalized;

  // 2) label 匹配：用户填的是展示名。大小写不敏感，但歧义时不猜
  const lower = normalized.toLowerCase();
  const byLabel = list.filter((p) => (p.label || "").trim().toLowerCase() === lower);
  if (byLabel.length === 1) return byLabel[0].name;
  if (byLabel.length > 1) {
    console.warn(
      `[providers] 展示名 "${raw}" 同时对应多个 provider（${byLabel.map((p) => p.name).join(", ")}），存在歧义，请改用 provider key`,
    );
  }
  return undefined;
}

/**
 * 获取模型的展示名称。优先限定在当前 provider，避免相同模型 ID 在多个中转站中产生歧义。
 * 未配置名称或尚未注入 provider 目录时返回 undefined，由呈现端回退显示模型 ID。
 */
export function getModelDisplayName(modelId: string, preferredProvider?: string): string | undefined {
  if (!_resolved) return undefined;

  const provider = preferredProvider ? _resolved.get(normalizeProvider(preferredProvider)) : undefined;
  const model = provider?.models.find((item) => item.id === modelId);
  return model?.name?.trim() || undefined;
}

/** 获取 provider 的展示名称；找不到时回退 provider key。 */
export function getProviderDisplayName(providerName?: string): string | undefined {
  if (!providerName) return undefined;
  const provider = _resolved?.get(normalizeProvider(providerName));
  return provider?.label?.trim() || providerName;
}

/**
 * 根据模型 id 反查它所属的 provider 名称。用于 Relay 模型覆盖等场景——用户/AI 只给出
 * 一个模型 id（如 "gpt-5.5"），需要找到对应的 provider 才能调用 getStrategy。
 *
 * ⚠️ 同一个模型 id 可能在多个 provider 下都存在（如两个中转站都配了同名的 "gpt-5.5"）。
 * 为避免"悄悄选中错误 provider（错的 baseUrl/apiKey/协议）导致调用行为不对但不报错"这类
 * 隐蔽问题，这里要求显式传入 preferredProvider 时优先匹配该 provider；
 * 不传或该 provider 下未找到时，遍历全部 provider 命中【唯一】匹配则返回，
 * 命中多个（同名歧义）时保守返回 undefined，由调用方回退默认而不是猜一个。
 *
 * @param modelId 模型 id
 * @param preferredProvider 可选：优先在这个 provider 下查找（如当前会话 provider）
 */
export function findProviderForModel(modelId: string, preferredProvider?: string): string | undefined {
  if (!_resolved) return undefined;

  if (preferredProvider) {
    const preferred = _resolved.get(normalizeProvider(preferredProvider));
    if (preferred?.models.some((m) => m.id === modelId)) return preferred.name;
  }

  const matches = [..._resolved.values()].filter((p) => p.models.some((m) => m.id === modelId));
  if (matches.length === 1) return matches[0].name;
  if (matches.length > 1) {
    console.warn(`[providers] 模型 id "${modelId}" 在多个 provider 中都存在（${matches.map((p) => p.name).join(", ")}），存在歧义，未指定 preferredProvider 时不猜测，返回 undefined`);
  }
  return undefined;
}

/**
 * 查某模型在 provider 目录 / providers.json 里**声明**的思考能力。
 *
 * 返回 undefined 表示"没声明"，调用方据此回退到 supportsThinking 的兜底启发式；
 * 返回 true/false 都是用户/目录的明确意图，策略层直接采信。
 *
 * 解析规则与 findProviderForModel 保持一致（优先 preferredProvider，其次全局唯一命中，
 * 同名歧义时不猜）：同一个模型 id 可能在多个中转站下都配着，而它们对思考的支持情况
 * 完全可能不同，猜错的代价是断流。
 */
export function declaredThinkingFor(modelId: string, preferredProvider?: string): boolean | undefined {
  if (!_resolved) return undefined;

  if (preferredProvider) {
    const preferred = _resolved.get(normalizeProvider(preferredProvider));
    const hit = preferred?.models.find((m) => m.id === modelId);
    if (hit) return hit.thinking ?? (Array.isArray(hit.effortLevels) && hit.effortLevels.length > 0 ? true : undefined);
  }

  const matches = [..._resolved.values()]
    .map((p) => p.models.find((m) => m.id === modelId))
    .filter((m): m is NonNullable<typeof m> => !!m);
  return matches.length === 1
    ? matches[0].thinking ?? (Array.isArray(matches[0].effortLevels) && matches[0].effortLevels.length > 0 ? true : undefined)
    : undefined;
}

/** 查询某模型在 Provider 中明确配置的思考强度实际值列表。 */
export function declaredEffortValuesFor(modelId: string, preferredProvider?: string): string[] {
  if (!_resolved) return [];
  const values = (levels: { value: string }[] | undefined): string[] =>
    (Array.isArray(levels) ? levels : [])
      .map((x) => typeof x?.value === "string" ? x.value.trim() : "")
      .filter((x): x is string => !!x);

  if (preferredProvider) {
    const preferred = _resolved.get(normalizeProvider(preferredProvider));
    const hit = preferred?.models.find((m) => m.id === modelId);
    if (hit) return values(hit.effortLevels);
  }

  const matches = [..._resolved.values()]
    .map((p) => p.models.find((m) => m.id === modelId))
    .filter((m): m is NonNullable<typeof m> => !!m);
  return matches.length === 1 ? values(matches[0].effortLevels) : [];
}

/**
 * 查询某模型在 provider 目录里**声明**的 cache_control 能力。
 *
 * 返回 undefined 表示"没声明"，调用方据此回退到启发式；
 * 返回 true/false 都是明确意图，策略层直接采信。
 */
export function declaredCacheControlFor(modelId: string, preferredProvider?: string): boolean | undefined {
  if (!_resolved) return undefined;

  if (preferredProvider) {
    const preferred = _resolved.get(normalizeProvider(preferredProvider));
    const hit = preferred?.models.find((m) => m.id === modelId);
    if (hit) return hit.cacheControl;
  }

  const matches = [..._resolved.values()]
    .map((p) => p.models.find((m) => m.id === modelId))
    .filter((m): m is NonNullable<typeof m> => !!m);
  return matches.length === 1 ? matches[0].cacheControl : undefined;
}

/**
 * 查询某模型在 provider 目录里**声明**的 vision（多模态/支持图片）能力。
 *
 * 与 declaredThinkingFor / declaredCacheControlFor 同构：优先 preferredProvider 命中，
 * 其次全局唯一命中，同名歧义时不猜返回 undefined。
 * 用于判断主模型能否直接看图——这决定了是否走"识图兜底"链路。
 */
export function declaredVisionFor(modelId: string, preferredProvider?: string): boolean | undefined {
  if (!_resolved) return undefined;

  if (preferredProvider) {
    const preferred = _resolved.get(normalizeProvider(preferredProvider));
    const hit = preferred?.models.find((m) => m.id === modelId);
    if (hit) return hit.vision;
  }

  const matches = [..._resolved.values()]
    .map((p) => p.models.find((m) => m.id === modelId))
    .filter((m): m is NonNullable<typeof m> => !!m);
  return matches.length === 1 ? matches[0].vision : undefined;
}

/** 识图兜底模型 id（全局配置，由 refreshProviders 注入）；null 表示未配置 */
let _visionFallbackModel: string | null = null;

/** 注入识图兜底模型 id（配置变更时由 refreshProviders 同步） */
export function setVisionFallbackModel(id: string | null): void {
  _visionFallbackModel = id;
}

/** 当前识图兜底模型 id（未配置返回 null） */
export function getVisionFallbackModel(): string | null {
  return _visionFallbackModel;
}

/** 取某 provider 的运行时配置：先查已注入的解析结果，再回退到环境变量。 */
function configFor(name: string): ProviderConfig | undefined {
  const hit = _resolved?.get(name);
  if (hit) return { apiKey: hit.apiKey, baseUrl: hit.baseUrl, protocol: hit.protocol, apiKeyHeader: hit.apiKeyHeader };

  // env 兜底
  const apiKey = (process.env[`PROVIDER_${name.toUpperCase()}_API_KEY`] || "").trim();
  if (!apiKey) return undefined;
  const baseUrl = (process.env[`PROVIDER_${name.toUpperCase()}_BASE_URL`] || "").trim();
  const protocol: ProviderProtocol = "chat";
  return { apiKey, baseUrl, protocol };
}

/** 根据模型厂商返回对应的认证头格式（仅用于 OpenAI 兼容端点）。
 *  注意：Anthropic 的 OpenAI 兼容端点使用标准 Bearer 认证，x-api-key 仅用于原生 Messages API。
 *  其他厂商如有特殊需求，在此添加 case。 */
function vendorToApiKeyHeader(_vendor: string): ApiKeyHeader | undefined {
  // 当前所有厂商的 OpenAI 兼容端点均使用标准 Bearer 认证，无需特殊处理
  return undefined;
}

// ── client / strategy 缓存 ────────────────────────────────────────────────

/** 已创建的 OpenAI client 缓存（按归一化后的 provider name + apiKeyHeader） */
const clients: Record<string, OpenAI> = {};

/** 获取或创建指定 provider 的 OpenAI client，可选传 model 以根据模型厂商自动选择认证头 */
export function getClient(provider: string, model?: string): OpenAI {
  // 兼容传入展示名（label）的情况：统一解析成规范 name 再查配置。
  // 解析不出时回退到归一化后的原值，让下面照常抛出「未知 provider」——
  // 保持原有报错语义，不把无法识别的输入悄悄换掉。
  const name = resolveProviderName(provider) ?? normalizeProvider(provider);
  const conf = configFor(name);
  if (!conf) {
    const known = getResolvedProviders().map((p) => p.name).join(", ") || "（无）";
    throw new Error(`未知 provider: ${name}，已配置: ${known}`);
  }
  // apiKeyHeader：provider 级别配置优先，其次从 model vendor 推断
  let apiKeyHeader: ApiKeyHeader = conf.apiKeyHeader || "bearer";
  if (!conf.apiKeyHeader && model && _resolved) {
    const resolved = _resolved.get(name);
    const modelDef = resolved?.models.find(m => m.id === model);
    if (modelDef?.vendor) {
      apiKeyHeader = vendorToApiKeyHeader(modelDef.vendor) || apiKeyHeader;
    }
  }
  const cacheKey = `${name}:${apiKeyHeader}`;
  if (!clients[cacheKey]) {
    const defaultHeaders: Record<string, string> = {};
    if (apiKeyHeader === "x-api-key") {
      defaultHeaders["x-api-key"] = conf.apiKey;
    }
    clients[cacheKey] = new OpenAI({
      apiKey: apiKeyHeader === "x-api-key" ? "not-used" : conf.apiKey,
      baseURL: conf.baseUrl,
      defaultHeaders: Object.keys(defaultHeaders).length ? defaultHeaders : undefined,
      fetch: globalThis.fetch as any,
    });
  }
  return clients[cacheKey];
}

/** 已创建的策略缓存 */
const strategies: Record<string, LLMStrategy> = {};

/** 获取模型级协议：model.protocol 优先，provider.protocol 仅作为旧配置 fallback */
function protocolForModel(provider: string, model: string): ProviderProtocol {
  const name = normalizeProvider(provider);
  const resolved = _resolved?.get(name);
  const modelDef = resolved?.models.find((m) => m.id === model);
  if (modelDef?.protocol === "responses" || modelDef?.protocol === "chat" || modelDef?.protocol === "anthropic") return modelDef.protocol;
  return configFor(name)?.protocol ?? "chat";
}

/**
 * 获取指定 provider + model 的 LLM 调用策略。
 * - model.protocol = anthropic → AnthropicMessagesStrategy（原生 Messages API，独立于 OpenAI SDK）
 * - model.protocol = responses 且模型为 GPT 系 → ResponsesStrategy（原生 agentic loop，防自停）
 * - 其他 → ChatCompletionsStrategy
 */
export function getStrategy(provider: string, model: string): LLMStrategy {
  const name = resolveProviderName(provider) ?? normalizeProvider(provider);
  const protocol = protocolForModel(name, model);

  if (protocol === "anthropic") {
    const key = `${name}:${model}:anthropic`;
    if (!strategies[key]) {
      const conf = configFor(name);
      if (!conf) {
        const known = getResolvedProviders().map((p) => p.name).join(", ") || "（无）";
        throw new Error(`未知 provider: ${name}，已配置: ${known}`);
      }
      strategies[key] = new AnthropicMessagesStrategy(conf.baseUrl, conf.apiKey);
      console.log(`[agent] 使用策略 ${strategies[key].name}（provider=${name}, model=${model}, protocol=${protocol}）`);
    }
    return strategies[key];
  }

  const useResponses = protocol === "responses" && /^gpt/i.test(model);
  const key = `${name}:${model}:${useResponses ? "responses" : "chat"}`;
  if (!strategies[key]) {
    const client = getClient(name, model);
    strategies[key] = useResponses ? new ResponsesStrategy(client) : new ChatCompletionsStrategy(client);
    console.log(`[agent] 使用策略 ${strategies[key].name}（provider=${name}, model=${model}, protocol=${protocol}）`);
  }
  return strategies[key];
}
