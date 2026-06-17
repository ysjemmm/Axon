/**
 * 内置 provider 出厂目录（唯一真源）—— 从前端 ModelSelector.MODELS 上移到核心层。
 *
 * 内置 provider 的 baseUrl / 协议 / 模型目录都固定在代码里：
 *  - esign：e签宝 / timevale AI 路由网关，locked（用户只能改 apiKey，其余锁定）
 *  - zhipu：智谱直连
 *
 * 自定义 provider 不走这里，走 providers.json（见 ProviderRegistry）。
 */

import { ESIGN_PROVIDER, ZHIPU_PROVIDER, type ProviderModel, type ProviderProtocol } from "./providerTypes.js";

// 把这两个"值"常量经由本模块（被 index 以 export * 暴露）对外导出，
// 供 server / extension 运行时使用；ESIGN_PROVIDER 已由 providers.ts 再导出，故此处不重复导出它。
export { ZHIPU_PROVIDER, RESERVED_PROVIDER_NAMES } from "./providerTypes.js";

/** 内置 provider 定义（apiKey 不在此处，运行时从 env / providers.json 注入） */
export interface BuiltinProviderDef {
  name: string;
  label: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  /** 仅 esign：除 apiKey 外全部锁定 */
  locked: boolean;
  models: ProviderModel[];
}

/** 内置 provider 目录 */
export const BUILTIN_PROVIDERS: BuiltinProviderDef[] = [
  {
    name: ESIGN_PROVIDER,
    label: "eSign",
    baseUrl: "https://ai-router.timevale.cn/v1",
    protocol: "responses", // gpt* 走 Responses API（见 getStrategy 内的 /^gpt/ 守卫）
    locked: true,
    models: [
      { id: "gpt-5.5", name: "GPT-5.5", contextWindow: 1_000_000, vision: true, description: "最新旗舰模型", group: "OpenAI", tier: "flagship" },
      { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 1_000_000, vision: true, description: "高性能模型", group: "OpenAI", tier: "flagship" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1_000_000, vision: false, description: "1.6T MoE，1M 上下文，开源旗舰", group: "DeepSeek", tier: "balanced" },
      { id: "glm-5.1", name: "GLM-5.1", contextWindow: 200_000, vision: false, description: "智谱最新旗舰模型", group: "智谱", tier: "balanced" },
    ],
  },
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
