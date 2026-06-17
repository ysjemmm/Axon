/**
 * 多模型对比变体 —— 每个模型一个变体，统一用基线工具描述/系统提示，
 * 用于横向比较不同模型在工具使用上的表现。
 *
 * 用法：npm run models           # 跑全部模型
 *      npm run models -- --runs 3
 *      npm run models -- --tool web_search
 */

import type { Variant } from "./types.ts";

/**
 * 参与对比的模型（esign 路由上的真实 ID）。
 * 注：qwen3.6-plus 经此中转网关极不稳定（频繁 5xx / 流式中断，重试也救不回），
 * 测出的是网关可靠性而非模型工具使用能力，故从默认对比中移除。
 */
export const MODEL_VARIANTS: Variant[] = [
  { id: "gpt-5.4", label: "GPT-5.4", model: "gpt-5.4" },
  { id: "gpt-5.5", label: "GPT-5.5", model: "gpt-5.5" },
  { id: "deepseek-v4-pro", label: "DeepSeek-V4-Pro", model: "deepseek-v4-pro" },
  { id: "glm-5.1", label: "GLM-5.1", model: "glm-5.1" },
];
