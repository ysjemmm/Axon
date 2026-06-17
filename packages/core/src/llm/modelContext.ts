/**
 * 模型上下文窗口的唯一事实来源（single source of truth）。
 *
 * 之前 agentSession 和 compactor 各自硬编码了一份窗口大小，换模型时容易漂移
 * （压缩按 128k 算，实际模型可能是 200k / 1M）。这里收敛成一处，两边都引用。
 *
 * 数据驱动后：优先查 ProviderRegistry 解析出的模型（含内置目录 + 自定义 provider 的模型），
 * 查不到再回退到下方静态表，最后回退默认值。自定义 provider 的模型窗口因此能被正确识别。
 */

import { getResolvedProviders } from "../providers.js";

/** 已知模型的上下文窗口（token）。未列出的模型回退到 DEFAULT_CONTEXT_WINDOW。 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-5.4": 1_000_000,
  "gpt-5.5": 1_000_000,
  "glm-5.1": 200_000,
  "glm-4-plus": 128_000,
  "glm-4": 128_000,
  "glm-4-long": 1_000_000,
  "glm-4-flash": 128_000,
  "glm-4-flashx": 128_000,
  "qwen3.6-plus": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
  "MiniMax-M2.7": 200_000,
};

/** 未知模型的保守默认窗口 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * 返回指定模型的上下文窗口大小（token）。
 * 先精确匹配，再按前缀族匹配（如自定义后缀的模型名），最后回退默认值。
 */
export function modelContextWindow(model: string): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;

  // 优先：已注入的 provider 模型目录（含自定义 provider）
  for (const p of getResolvedProviders()) {
    const m = p.models.find((x) => x.id === model);
    if (m?.contextWindow) return m.contextWindow;
  }

  if (MODEL_CONTEXT_WINDOWS[model]) return MODEL_CONTEXT_WINDOWS[model];

  // 前缀族匹配：取能作为该模型名前缀的最长已知 key（容忍版本后缀差异）
  let best = "";
  for (const key of Object.keys(MODEL_CONTEXT_WINDOWS)) {
    if (model.startsWith(key) && key.length > best.length) best = key;
  }
  return best ? MODEL_CONTEXT_WINDOWS[best] : DEFAULT_CONTEXT_WINDOW;
}
