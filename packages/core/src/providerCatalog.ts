/**
 * 内置 provider 出厂目录（唯一真源）—— 从前端 ModelSelector.MODELS 上移到核心层。
 *
 * 内置 provider 的 baseUrl / 协议 / 模型目录都固定在代码里：
 *  - zhipu：智谱直连，免费模型
 *
 * 自定义 provider 不走这里，走 providers.json（见 ProviderRegistry）。
 */

import { ZHIPU_PROVIDER, type ProviderModel, type ProviderProtocol } from "./providerTypes.js";

// 把"值"常量经由本模块对外导出，供 server / extension 运行时使用。
export { ZHIPU_PROVIDER, RESERVED_PROVIDER_NAMES, type ApiKeyHeader } from "./providerTypes.js";

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
];

/** 取某内置 provider 定义 */
export function getBuiltinProvider(name: string): BuiltinProviderDef | undefined {
  return BUILTIN_PROVIDERS.find((p) => p.name === name);
}

/** 内置目录里所有模型 id（供 modelContext 等查窗口大小） */
export function builtinModels(): ProviderModel[] {
  return BUILTIN_PROVIDERS.flatMap((p) => p.models);
}
