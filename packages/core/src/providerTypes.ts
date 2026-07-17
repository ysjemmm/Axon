/**
 * Provider / Model 的数据模型（零形态依赖，纯类型 + 常量）
 *
 * 这是"可自定义 provider"功能的数据契约：
 *  - 内置 provider（zhipu）由 providerCatalog.ts 提供出厂目录
 *  - 自定义 provider 来自 ~/.axon/settings/providers.json（用户级）/ <ws>/.axon/settings/providers.json（工作区级）
 *  - ProviderRegistry 把两者合并成 ResolvedProvider[]，供 getClient / getStrategy / 前端选择器消费
 */

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

/** provider 名常量（唯一真源，避免字面量散落） */
export const ZHIPU_PROVIDER = "zhipu";
/** Axon 官方 provider：出厂内置 Claude 模型目录，apiKey 默认空，由官方分发或后续登录系统注入 */
export const AXON_PROVIDER = "axon";

/** 内置 provider 的保留名（自定义 provider 不允许占用） */
export const RESERVED_PROVIDER_NAMES = [ZHIPU_PROVIDER, AXON_PROVIDER];

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
  /** LLM 调用协议：chat（通用）/ responses（OpenAI Responses API）。未填则回退 provider.protocol 或 chat */
  protocol?: ProviderProtocol;
  /** 一句话描述（下拉里展示） */
  description?: string;
  /** 厂商（openai / anthropic / qwen / zhipu 等），后端据此做厂商兼容 */
  vendor?: string;
  /** 下拉分组标签（厂商/来源） */
  group?: string;
  /** 是否免费 */
  free?: boolean;
  /** 是否禁用（禁用后不出现在模型选择器，但仍保留配置，可重新启用） */
  disabled?: boolean;
  /** Auto 自动选择用的档位：fast=便宜快(简单问答) / balanced=均衡 / flagship=旗舰(复杂代码)。未标默认按 balanced 处理 */
  tier?: "fast" | "balanced" | "flagship";
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
  /** 是否内置（esign / zhipu） */
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
  /** 认证头格式：bearer（默认）= Authorization: Bearer / x-api-key（Anthropic 等） */
  apiKeyHeader?: ApiKeyHeader;
  protocol?: ProviderProtocol;
  models?: ProviderModel[];
}

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
}
