/**
 * 内置 provider 出厂目录（唯一真源）—— 从前端 ModelSelector.MODELS 上移到核心层。
 *
 * 内置 provider 的 baseUrl / 协议 / 模型目录都固定在代码里：
 *  - zhipu：智谱直连，免费模型
 *
 * 自定义 provider 不走这里，走 providers.json（见 ProviderRegistry）。
 */

import { ZHIPU_PROVIDER, AXON_PROVIDER, type ProviderModel, type ProviderProtocol } from "./providerTypes.js";

// 把"值"常量经由本模块对外导出，供 server / extension 运行时使用。
export { ZHIPU_PROVIDER, AXON_PROVIDER, RESERVED_PROVIDER_NAMES, type ApiKeyHeader } from "./providerTypes.js";

/** 内置 provider 定义（apiKey 不在此处，运行时从 env / providers.json 注入） */
export interface BuiltinProviderDef {
  name: string;
  label: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  /** 是否锁定（用户只能改 apiKey，其余锁定） */
  locked: boolean;
  models: ProviderModel[];
  /** 认证头格式：bearer（默认）= Authorization: Bearer / x-api-key（Anthropic 等） */
  apiKeyHeader?: "bearer" | "x-api-key";
}

/** 内置 provider 目录 */
export const BUILTIN_PROVIDERS: BuiltinProviderDef[] = [
  {
    name: ZHIPU_PROVIDER,
    label: "智谱",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "chat",
    locked: false,
    models: [
      { id: "glm-4-flash", name: "GLM-4 Flash", contextWindow: 128_000, vision: false, free: true, description: "免费，快速响应", group: "智谱", tier: "fast" },
      { id: "glm-4-flashx", name: "GLM-4 FlashX", contextWindow: 128_000, vision: false, free: true, description: "免费，极速推理", group: "智谱", tier: "fast" },
    ],
  },
  {
    // Axon 官方 provider：出厂内置 Claude 模型目录，baseUrl/协议/模型清单锁定，
    // apiKey 默认空，前期由官方分发给用户手动粘贴，后续接入登录系统后自动注入。
    name: AXON_PROVIDER,
    label: "Axon 官方",
    baseUrl: "https://ai.sunnorthgod.top:8443/v1",
    protocol: "anthropic",
    locked: true,
    apiKeyHeader: "x-api-key",
    models: [
      { id: "claude-opus-4-8", name: "Claude Opus 4.8", contextWindow: 1_000_000, vision: true, vendor: "anthropic", description: "最强 Opus 档，长上下文", group: "Axon 官方", tier: "flagship" },
      { id: "claude-opus-4-7", name: "Claude Opus 4.7", contextWindow: 1_000_000, vision: true, vendor: "anthropic", description: "上一代 Opus，长上下文", group: "Axon 官方", tier: "flagship" },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", contextWindow: 1_000_000, vision: true, vendor: "anthropic", description: "较早 Opus，长上下文", group: "Axon 官方", tier: "flagship" },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextWindow: 1_000_000, vision: true, vendor: "anthropic", description: "Sonnet 档最新旗舰，长上下文", group: "Axon 官方", tier: "balanced" },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 1_000_000, vision: true, vendor: "anthropic", description: "上一代 Sonnet，长上下文", group: "Axon 官方", tier: "balanced" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000, vision: true, vendor: "anthropic", description: "速度最快，成本最低", group: "Axon 官方", tier: "fast" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 1_000_000, vision: true, vendor: "openai", protocol: "anthropic", description: "旗舰档，编码能力 SOTA", group: "Axon 官方", tier: "flagship" },
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextWindow: 1_000_000, vision: true, vendor: "openai", protocol: "anthropic", description: "均衡档，性价比高", group: "Axon 官方", tier: "balanced" },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 1_000_000, vision: true, vendor: "openai", protocol: "anthropic", description: "轻量档，速度最快成本最低", group: "Axon 官方", tier: "fast" },
    ],
  },
];

/** 取某内置 provider 定义 */
export function getBuiltinProvider(name: string): BuiltinProviderDef | undefined {
  return BUILTIN_PROVIDERS.find((p) => p.name === name);
}

/** 内置目录里所有模型 id（供 modelContext 等查窗口大小） */
export function builtinModels(): ProviderModel[] {
  return BUILTIN_PROVIDERS.flatMap((p) => p.models);
}
