/**
 * 常见模型厂商的预设：添加 Provider 时选一家，地址 / 协议 / 认证方式 / 常用模型自动填好，只需填 API Key。
 *
 * 地址取各家官方文档里的 OpenAI 兼容端点（Anthropic 用原生 Messages API）。模型列表来自 builtinModels.ts，
 * 保存后还可以「从端点导入」补全。只是预填，所有字段在表单里都能改。
 */

import { BUILTIN_MODELS, protocolForVendor, type BuiltinModel } from "./builtinModels";
import type { ProviderModelInfo, ProviderProtocol } from "./apiClient";

export type PresetRegion = "cn" | "global" | "local" | "custom";

export interface ProviderPreset {
  id: string;
  name: string;
  region: PresetRegion;
  baseUrl: string;
  protocol: ProviderProtocol;
  apiKeyHeader?: "bearer" | "x-api-key";
  /** 去哪里拿 API Key */
  keyUrl?: string;
  /** builtinModels.ts 里的厂商名，用来预填模型 */
  vendor?: string;
  /** 本地服务不需要 Key（填任意值即可） */
  noKey?: boolean;
  /** 一句话提示 */
  hint?: string;
  /** 徽章 */
  badge: { text: string; className: string };
  /** 按 baseUrl 主机识别已有 Provider 属于哪家（给卡片配徽章） */
  hosts?: string[];
}

export const PRESET_REGIONS: { id: PresetRegion; label: string }[] = [
  { id: "cn", label: "国内" },
  { id: "global", label: "海外" },
  { id: "local", label: "本地" },
  { id: "custom", label: "自定义" },
];

export const PROVIDER_PRESETS: ProviderPreset[] = [
  // ── 国内 ──
  { id: "deepseek", name: "DeepSeek", region: "cn", baseUrl: "https://api.deepseek.com/v1", protocol: "chat", vendor: "DeepSeek", keyUrl: "https://platform.deepseek.com/api_keys", badge: { text: "DS", className: "bg-blue-600 text-white" }, hosts: ["deepseek.com"] },
  { id: "moonshot", name: "Kimi（月之暗面）", region: "cn", baseUrl: "https://api.moonshot.cn/v1", protocol: "chat", vendor: "Moonshot Kimi", keyUrl: "https://platform.moonshot.cn/console/api-keys", badge: { text: "K", className: "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" }, hosts: ["moonshot.cn", "moonshot.ai"] },
  { id: "zhipu", name: "智谱 GLM", region: "cn", baseUrl: "https://open.bigmodel.cn/api/paas/v4", protocol: "chat", vendor: "智谱 GLM", keyUrl: "https://open.bigmodel.cn/usercenter/apikeys", badge: { text: "智", className: "bg-indigo-600 text-white" }, hosts: ["bigmodel.cn", "z.ai"] },
  { id: "dashscope", name: "阿里云百炼（通义千问）", region: "cn", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", protocol: "chat", vendor: "阿里通义千问", keyUrl: "https://bailian.console.aliyun.com/?apiKey=1", badge: { text: "Q", className: "bg-violet-600 text-white" }, hosts: ["dashscope.aliyuncs.com", "aliyuncs.com"] },
  { id: "ark", name: "火山方舟（豆包）", region: "cn", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", protocol: "chat", vendor: "字节豆包", keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey", hint: "模型 ID 可以填模型名，也可以填方舟控制台里的推理接入点 ID（ep-…）。", badge: { text: "豆", className: "bg-sky-600 text-white" }, hosts: ["volces.com"] },
  { id: "minimax", name: "MiniMax", region: "cn", baseUrl: "https://api.minimaxi.com/v1", protocol: "chat", vendor: "MiniMax", keyUrl: "https://platform.minimaxi.com/user-center/basic-information/interface-key", badge: { text: "MM", className: "bg-rose-600 text-white" }, hosts: ["minimaxi.com", "minimax.io", "minimax.chat"] },
  { id: "mimo", name: "小米 MiMo", region: "cn", baseUrl: "https://api.xiaomimimo.com/v1", protocol: "chat", vendor: "小米 MiMo", badge: { text: "Mi", className: "bg-orange-500 text-white" }, hosts: ["xiaomimimo.com"] },
  { id: "hunyuan", name: "腾讯混元", region: "cn", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", protocol: "chat", vendor: "腾讯混元", keyUrl: "https://console.cloud.tencent.com/hunyuan/api-key", badge: { text: "混", className: "bg-blue-500 text-white" }, hosts: ["hunyuan.cloud.tencent.com"] },
  { id: "siliconflow", name: "硅基流动", region: "cn", baseUrl: "https://api.siliconflow.cn/v1", protocol: "chat", keyUrl: "https://cloud.siliconflow.cn/account/ak", hint: "聚合了 DeepSeek、Qwen、GLM、Kimi 等开源模型，保存后用「从端点导入」挑选模型。", badge: { text: "SF", className: "bg-purple-600 text-white" }, hosts: ["siliconflow.cn", "siliconflow.com"] },
  // ── 海外 ──
  { id: "openai", name: "OpenAI", region: "global", baseUrl: "https://api.openai.com/v1", protocol: "chat", vendor: "OpenAI", keyUrl: "https://platform.openai.com/api-keys", badge: { text: "AI", className: "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900" }, hosts: ["openai.com"] },
  { id: "anthropic", name: "Anthropic（Claude）", region: "global", baseUrl: "https://api.anthropic.com/v1", protocol: "anthropic", apiKeyHeader: "x-api-key", vendor: "Anthropic", keyUrl: "https://console.anthropic.com/settings/keys", badge: { text: "A", className: "bg-amber-700 text-white" }, hosts: ["anthropic.com"] },
  { id: "gemini", name: "Google Gemini", region: "global", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", protocol: "chat", vendor: "Google", keyUrl: "https://aistudio.google.com/apikey", badge: { text: "G", className: "bg-blue-500 text-white" }, hosts: ["googleapis.com"] },
  { id: "xai", name: "xAI（Grok）", region: "global", baseUrl: "https://api.x.ai/v1", protocol: "chat", vendor: "xAI", keyUrl: "https://console.x.ai", badge: { text: "X", className: "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900" }, hosts: ["x.ai"] },
  { id: "openrouter", name: "OpenRouter", region: "global", baseUrl: "https://openrouter.ai/api/v1", protocol: "chat", keyUrl: "https://openrouter.ai/keys", hint: "一个 Key 用几百个模型，保存后用「从端点导入」挑选。", badge: { text: "OR", className: "bg-slate-700 text-white" }, hosts: ["openrouter.ai"] },
  { id: "mistral", name: "Mistral", region: "global", baseUrl: "https://api.mistral.ai/v1", protocol: "chat", keyUrl: "https://console.mistral.ai/api-keys", badge: { text: "M", className: "bg-orange-600 text-white" }, hosts: ["mistral.ai"] },
  { id: "groq", name: "Groq", region: "global", baseUrl: "https://api.groq.com/openai/v1", protocol: "chat", keyUrl: "https://console.groq.com/keys", badge: { text: "GQ", className: "bg-red-600 text-white" }, hosts: ["groq.com"] },
  // ── 本地 ──
  { id: "ollama", name: "Ollama", region: "local", baseUrl: "http://127.0.0.1:11434/v1", protocol: "chat", noKey: true, hint: "先在本机运行 Ollama 并拉取模型，保存后用「从端点导入」。", badge: { text: "OL", className: "bg-stone-700 text-white" }, hosts: ["127.0.0.1:11434", "localhost:11434"] },
  { id: "lmstudio", name: "LM Studio", region: "local", baseUrl: "http://127.0.0.1:1234/v1", protocol: "chat", noKey: true, hint: "在 LM Studio 里开启本地服务器，保存后用「从端点导入」。", badge: { text: "LM", className: "bg-teal-700 text-white" }, hosts: ["127.0.0.1:1234", "localhost:1234"] },
  // ── 自定义 ──
  { id: "custom", name: "中转站 / 其他 OpenAI 兼容", region: "custom", baseUrl: "", protocol: "chat", hint: "填中转站或自建网关的地址（一般以 /v1 结尾），保存后可「从端点导入」模型。", badge: { text: "+", className: "bg-muted text-foreground" } },
];

/** 支持思考的模型默认带出的强度档位（与 ProviderStudio 的模型表单一致） */
const DEFAULT_EFFORTS = [
  { label: "Low", value: "low" },
  { label: "High", value: "high" },
  { label: "Max", value: "max" },
];

/** 内置模型清单的一条 → Provider 模型配置 */
export function builtinToModel(m: BuiltinModel): ProviderModelInfo {
  const thinking = !!m.tags?.includes("thinking");
  return {
    id: m.id,
    name: m.label || m.id,
    // 没有出处的窗口不瞎填：与模型表单的兜底一致取 1M
    contextWindow: m.contextWindow ?? 1_000_000,
    vision: !!m.tags?.includes("vision"),
    protocol: protocolForVendor(m.vendor),
    vendor: m.vendor,
    ...(thinking ? { thinking: true, effortLevels: DEFAULT_EFFORTS.map((x) => ({ ...x })), defaultEffort: "high" } : {}),
    ...(m.cacheControl ? { cacheControl: true } : {}),
  };
}

export function presetModels(preset: ProviderPreset): BuiltinModel[] {
  return preset.vendor ? BUILTIN_MODELS.filter((m) => m.vendor === preset.vendor) : [];
}

/** 按 baseUrl 认出是哪家（给已有 Provider 配徽章）；认不出返回 undefined */
export function presetForBaseUrl(baseUrl: string): ProviderPreset | undefined {
  let host = "";
  try { host = new URL(baseUrl).host.toLowerCase(); } catch { return undefined; }
  return PROVIDER_PRESETS.find((p) => p.hosts?.some((h) => host === h || host.endsWith(`.${h}`)));
}

/** 展示用的主机名：去掉协议和路径 */
export function hostOf(baseUrl: string): string {
  try { return new URL(baseUrl).host; } catch { return baseUrl; }
}

/** 由展示名生成 provider 标识（唯一 key）：保留字母数字，其余换成连字符 */
export function slugify(label: string, taken: string[]): string {
  const base = label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
  let slug = base;
  for (let i = 2; taken.includes(slug); i++) slug = `${base}-${i}`;
  return slug;
}
