/**
 * 内置 provider 出厂目录（唯一真源）—— 从前端 ModelSelector.MODELS 上移到核心层。
 *
 * 内置 provider 的 baseUrl / 协议 / 模型目录都固定在代码里。
 *
 * 自定义 provider 不走这里，走 providers.json（见 ProviderRegistry）。
 */

import { AXON_PROVIDER, type ProviderModel, type ProviderProtocol } from "./providerTypes.js";

// 把"值"常量经由本模块对外导出，供 server / extension 运行时使用。
export { AXON_PROVIDER, RESERVED_PROVIDER_NAMES, type ApiKeyHeader } from "./providerTypes.js";

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
    // Axon 官方 provider：出厂内置 Claude 模型目录，baseUrl/协议/模型清单锁定，
    // apiKey 默认空，前期由官方分发给用户手动粘贴，后续接入登录系统后自动注入。
    name: AXON_PROVIDER,
    label: "Axon 官方",
    baseUrl: "https://direct.sunnorthgod.top/v1",
    protocol: "anthropic",
    locked: true,
    apiKeyHeader: "x-api-key",
    models: [
      { id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 1_000_000, vision: true, thinking: true, vendor: "anthropic", description: "最新 Opus 旗舰，长上下文", group: "Axon 官方" },
      { id: "claude-opus-4-8", name: "Claude Opus 4.8", contextWindow: 1_000_000, vision: true, thinking: true, vendor: "anthropic", description: "最强 Opus 档，长上下文", group: "Axon 官方" },
      { id: "claude-opus-4-7", name: "Claude Opus 4.7", contextWindow: 1_000_000, vision: true, thinking: true, vendor: "anthropic", description: "上一代 Opus，长上下文", group: "Axon 官方" },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", contextWindow: 1_000_000, vision: true, thinking: true, vendor: "anthropic", description: "较早 Opus，长上下文", group: "Axon 官方" },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextWindow: 1_000_000, vision: true, thinking: true, vendor: "anthropic", description: "Sonnet 档最新旗舰，长上下文", group: "Axon 官方" },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 1_000_000, vision: true, thinking: true, vendor: "anthropic", description: "上一代 Sonnet，长上下文", group: "Axon 官方" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000, vision: true, thinking: true, vendor: "anthropic", description: "速度最快，成本最低", group: "Axon 官方" },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 1_000_000, vision: true, thinking: true, vendor: "openai", protocol: "anthropic", description: "旗舰档，编码能力 SOTA", group: "Axon 官方" },
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", contextWindow: 1_000_000, vision: true, thinking: true, vendor: "openai", protocol: "anthropic", description: "均衡档，性价比高", group: "Axon 官方" },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", contextWindow: 1_000_000, vision: true, thinking: true, vendor: "openai", protocol: "anthropic", description: "轻量档，速度最快成本最低", group: "Axon 官方" },
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
