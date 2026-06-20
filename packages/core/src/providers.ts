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
import type { LLMStrategy } from "./llm/types.js";
import { ESIGN_PROVIDER, type ProviderProtocol, type ResolvedProvider, type ApiKeyHeader } from "./providerTypes.js";
import type { ProviderRegistry } from "./providerRegistry.js";

// 重新导出，保持 `import { ESIGN_PROVIDER } from "@axon/core"` 的公开 API 不变
export { ESIGN_PROVIDER } from "./providerTypes.js";

/** Provider 运行时配置（client 创建所需的最小信息） */
export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  /** 认证头格式，默认 bearer */
  apiKeyHeader?: ApiKeyHeader;
}

/**
 * 旧 provider 名 → 当前名 的向后兼容映射。
 * 历史会话 JSON 与旧配置里可能仍写着已废弃的 provider 名，运行时统一归一化，
 * 避免恢复旧会话时报"未知 provider"。
 */
const LEGACY_PROVIDER_ALIASES: Record<string, string> = {
  codex: ESIGN_PROVIDER, // 原 codex 网关已更名为 esign（e签宝 / timevale AI 路由）
};

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
  return list;
}

/** 当前已注入的 provider 列表（未注入返回空数组） */
export function getResolvedProviders(): ResolvedProvider[] {
  return _resolved ? [..._resolved.values()] : [];
}

/**
 * 取某 provider 的运行时配置：先查已注入的解析结果，再回退到环境变量。
 * 回退时协议按 esign=responses、其余=chat 推断（与历史行为一致）。
 */
function configFor(name: string): ProviderConfig | undefined {
  const hit = _resolved?.get(name);
  if (hit) return { apiKey: hit.apiKey, baseUrl: hit.baseUrl, protocol: hit.protocol, apiKeyHeader: hit.apiKeyHeader };

  // env 兜底
  const apiKey = (process.env[`PROVIDER_${name.toUpperCase()}_API_KEY`] || "").trim();
  if (!apiKey) return undefined;
  const baseUrl = (process.env[`PROVIDER_${name.toUpperCase()}_BASE_URL`] || "").trim();
  const protocol: ProviderProtocol = name === ESIGN_PROVIDER ? "responses" : "chat";
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
  const name = normalizeProvider(provider);
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
    });
  }
  return clients[cacheKey];
}

/** 已创建的策略缓存 */
const strategies: Record<string, LLMStrategy> = {};

/**
 * 获取指定 provider + model 的 LLM 调用策略。
 * - provider 协议为 responses 且模型为 GPT 系 → ResponsesStrategy（原生 agentic loop，防自停）
 * - 其他 → ChatCompletionsStrategy
 */
export function getStrategy(provider: string, model: string): LLMStrategy {
  const name = normalizeProvider(provider);
  const protocol = configFor(name)?.protocol ?? (name === ESIGN_PROVIDER ? "responses" : "chat");
  const useResponses = protocol === "responses" && /^gpt/i.test(model);
  const key = `${name}:${useResponses ? "responses" : "chat"}`;
  if (!strategies[key]) {
    const client = getClient(name, model);
    strategies[key] = useResponses ? new ResponsesStrategy(client) : new ChatCompletionsStrategy(client);
    console.log(`[agent] 使用策略 ${strategies[key].name}（provider=${name}, model=${model}）`);
  }
  return strategies[key];
}
