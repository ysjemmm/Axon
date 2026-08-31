/**
 * Provider / Model 的数据模型（零形态依赖，纯类型 + 常量）
 *
 * 这是"可自定义 provider"功能的数据契约：
 *  - 内置 provider（Axon 官方）由 providerCatalog.ts 提供出厂目录
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
  /** 认证头格式：bearer（默认）= Authorization: Bearer / x-api-key（Anthropic 等） */
  apiKeyHeader?: ApiKeyHeader;
  protocol?: ProviderProtocol;
  models?: ProviderModel[];
}

/** Provider 额度查询的声明式规则。字段路径只支持 $.data.balance 这类受限 JSONPath。 */
export interface ProviderQuotaConfig {
  enabled?: boolean;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  /** 独立额度令牌认证；缺省时沿用 Provider API Key。 */
  auth?: {
    header?: string;
    prefix?: string;
    /** 独立 Cookie 的请求头名，通常为 "cookie"；Cookie 内容由安全存储保管。 */
    cookieHeader?: string;
    /** 距过期不足该秒数时主动刷新；0 表示仅在 401/403 后刷新。 */
    refreshBeforeSeconds?: number;
    /** 配置后额度 access token 视为短期令牌；refreshToken 由安全存储保管。 */
    refresh?: {
      url: string;
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      query?: Record<string, string>;
      body?: unknown;
      accessTokenPath: string;
      refreshTokenPath?: string;
      expiresInPath?: string;
      expiresAtPath?: string;
    };
  };
  fields: {
    balance?: string;
    used?: string;
    total?: string;
    unit?: string;
    expiresAt?: string;
    /** 下次额度重置时间；支持 Unix 秒或毫秒时间戳。 */
    resetAt?: string;
  };
  /** 展示换算：提取到的余额/已用/总额均除以此值，例如 500000。 */
  scale?: number;
  /** 响应中没有单位字段时使用的展示单位，例如 "$" 或 "Credits"。 */
  unit?: string;
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
  /** 内置 Provider 的额度查询规则（与 API Key 分开保存） */
  builtinQuota?: Record<string, ProviderQuotaConfig>;
  /**
   * 识图兜底模型 id（全局一个）。
   * 当主模型不支持图片（vision === false）时，用该模型把图片转成文字描述再喂给主模型。
   * 留空/缺省 = 不启用识图兜底。
   */
  visionFallbackModel?: string;
}
