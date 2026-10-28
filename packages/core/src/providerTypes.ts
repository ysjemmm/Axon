/**
 * Provider / Model 的数据模型（零形态依赖，纯类型 + 常量）
 *
 * 这是"可自定义 provider"功能的数据契约：
 *  - 内置 provider（Axon 官方）由 providerCatalog.ts 提供出厂目录
 *  - 自定义 provider 来自 ~/.axon/settings/providers.json（用户级）/ <ws>/.axon/settings/providers.json（工作区级）
 *  - ProviderRegistry 把两者合并成 ResolvedProvider[]，供 getClient / getStrategy / 前端选择器消费
 */

import type { QuotaRule } from "./quota/types.js";

/**
 * provider 的 LLM 调用协议：
 * - chat：OpenAI Chat Completions（通用，绝大多数中转站/网关走这个，包括把 Claude 包装成
 *   OpenAI 兼容格式的中转站）
 * - responses：OpenAI Responses API（原生 agentic loop）
 * - anthropic：Anthropic 原生 Messages API（POST {baseUrl}/messages，x-api-key 认证，
 *   SSE 事件格式与 OpenAI 完全不同）。仅当该端点【只】提供原生 Anthropic 接口、没有
 *   OpenAI 兼容层时才需要选这个——多数声称支持 Claude 的中转站其实是走 chat 协议。
 */
export type ProviderProtocol = "chat" | "responses" | "anthropic";

/** 认证头类型：bearer = Authorization: Bearer <key>（默认）；x-api-key = x-api-key: <key>（Anthropic 等） */
export type ApiKeyHeader = "bearer" | "x-api-key";

/**
 * 模型可选的思考强度档位。
 * label 只用于 UI（如「高级」「Extra」）；value 是原样发给 provider 的协议值（如 high / xhigh）。
 * 不做内置推断：中转站可能接受任意值，支持哪些档位由用户在 Provider 模型配置里明确声明。
 */
export interface ModelEffortLevel {
  label: string;
  value: string;
}

/** Axon 官方 provider：出厂内置 Claude 模型目录，apiKey 默认空，由官方分发或后续登录系统注入 */
export const AXON_PROVIDER = "axon";

/** 内置 provider 的保留名（自定义 provider 不允许占用） */
export const RESERVED_PROVIDER_NAMES = [AXON_PROVIDER];

/** 单个模型的元数据 */
export interface ProviderModel {
  /** 真实 API model id（发给 provider 的那个） */
  id: string;
  /** 展示名 */
  name: string;
  /** 上下文窗口（token） */
  contextWindow: number;
  /** 是否多模态（支持图片） */
  vision?: boolean;
  /**
   * 是否支持"思考"（extended thinking / reasoning）。与 vision 同级的能力声明。
   *
   * 缺省（undefined）时按模型名启发式推断（见 llm/thinkingSupport.ts）。中转站的模型名
   * 是任意的，启发式必然覆盖不全——想要确定的行为就在这里显式声明：
   * - true：请求思考。请先确认该端点真支持，否则不认的参数会让中转网关直接断流。
   * - false：不请求。用于名字看着像推理模型、但该端点实际不支持的情况。
   */
  thinking?: boolean;
  /** 可选思考强度档位。未配置或空数组时，输入区不显示强度选择器。 */
  effortLevels?: ModelEffortLevel[];
  /** 默认思考强度实际值；必须是 effortLevels 中某一项的 value。缺省表示默认关闭。 */
  defaultEffort?: string;
  /**
   * 是否支持 OpenAI 兼容的 prompt caching（cache_control / ephemeral breakpoints）。
   *
   * 缺省（undefined）时按模型名启发式推断（见 llm/thinkingSupport.ts）。
   * 不支持的端点收到 cache_control 会直接 400——这和 thinking 参数一样危险。
   * 不确定时显式声明 false；确实支持的声明 true。
   */
  cacheControl?: boolean;
  /** LLM 调用协议：chat（通用）/ responses（OpenAI Responses API）。未填则回退 provider.protocol 或 chat */
  protocol?: ProviderProtocol;
  /** 一句话描述（下拉里展示） */
  description?: string;
  /** 厂商（openai / anthropic / qwen 等），后端据此做厂商兼容 */
  vendor?: string;
  /** 下拉分组标签（厂商/来源） */
  group?: string;
  /** 是否免费 */
  free?: boolean;
  /** 是否禁用（禁用后不出现在模型选择器，但仍保留配置，可重新启用） */
  disabled?: boolean;
}

/** 单个模型的单价（每 100 万 token） */
export interface ModelPrice {
  /** 输入（未命中缓存） */
  input?: number;
  /** 输出 */
  output?: number;
  /** 命中缓存的输入；不填按 input 计 */
  cacheRead?: number;
}

/**
 * Provider 计费单价：配置后每轮回复底部显示估算花费，不配置只显示 Token 数。
 * 只用于本地展示，不会发给任何接口。
 */
export interface ProviderPricing {
  /** 货币符号，例如 "¥"、"$"，默认 "¥" */
  currency?: string;
  /** 按模型 id 的单价 */
  models?: Record<string, ModelPrice>;
  /** 没单独配置的模型用这一档 */
  default?: ModelPrice;
}

/** 归一化后的 provider（registry 产出，运行时与 UI 都用它） */
export interface ResolvedProvider {
  /** provider key */
  name: string;
  /** 展示名 */
  label: string;
  baseUrl: string;
  apiKey: string;
  /** 认证头格式：bearer（默认）= Authorization: Bearer / x-api-key = x-api-key */
  apiKeyHeader: ApiKeyHeader;
  /** 旧配置兼容：provider 级默认协议；新配置推荐写到 model.protocol */
  protocol: ProviderProtocol;
  models: ProviderModel[];
  /** 当前生效的额度查询规则，不包含 API Key */
  quota?: ProviderQuotaConfig;
  /**
   * 额度规则是否来自用户自己的配置。false（工作区配置）时，额度请求只能发往 provider baseUrl 的同一主机，
   * 防止仓库里的配置把用户保存的额度凭证带到别处。
   */
  quotaTrusted?: boolean;
  /** 计费单价（仅用于回复底部的花费估算） */
  pricing?: ProviderPricing;
  /** 是否内置 Provider */
  builtin: boolean;
  /** 仅 esign：除 apiKey 外（baseUrl / 协议 / 模型目录）均锁定不可改 */
  locked: boolean;
  /** 是否已配置有效 apiKey */
  configured: boolean;
  /** 来源：内置目录 / 配置文件自定义 / 仅环境变量 */
  source: "builtin" | "custom" | "env";
  /** 自定义 provider 的来源层级（仅 source="custom" 时有值） */
  customLevel?: "user" | "workspace";
}

/** providers.json 里单个自定义 provider 的原始配置 */
export interface RawProviderEntry {
  label?: string;
  baseUrl?: string;
  apiKey?: string;
  /** 可选的额度查询规则；实际请求由宿主执行，避免向网页暴露 API Key */
  quota?: ProviderQuotaConfig;
  /** 计费单价（仅用于回复底部的花费估算） */
  pricing?: ProviderPricing;
  /** 认证头格式：bearer（默认）= Authorization: Bearer / x-api-key（Anthropic 等） */
  apiKeyHeader?: ApiKeyHeader;
  protocol?: ProviderProtocol;
  models?: ProviderModel[];
}

/** Provider 用量查询规则（结构与说明见 quota/types.ts 的 QuotaRule；旧版单请求规则仍兼容） */
export type ProviderQuotaConfig = QuotaRule;

/** providers.json 文件结构 */
export interface ProviderConfigFile {
  /** 自定义 provider（key = provider 名） */
  providers?: Record<string, RawProviderEntry>;
  /** 覆盖内置 provider 的 apiKey（esign 只认这个，其它字段锁定） */
  builtinApiKeys?: Record<string, string>;
  /** 覆盖内置 provider 的 baseUrl（默认取 providerCatalog 定义） */
  builtinBaseUrls?: Record<string, string>;
  /** 覆盖内置 provider 的模型列表（增删后整存；不设则取 providerCatalog 默认模型） */
  builtinModels?: Record<string, unknown[]>;
  /** 内置 Provider 的额度查询规则（与 API Key 分开保存） */
  builtinQuota?: Record<string, ProviderQuotaConfig>;
  /**
   * 识图兜底模型 id（全局一个）。
   * 当主模型不支持图片（vision === false）时，用该模型把图片转成文字描述再喂给主模型。
   * 留空/缺省 = 不启用识图兜底。
   */
  visionFallbackModel?: string;
}
