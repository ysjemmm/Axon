/**
 * 工具集加载 —— 从 @axon/core 拿基础工具定义，并支持按变体覆盖 description
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { Variant } from "./types.ts";

let _base: ChatCompletionTool[] | null = null;

/** 加载基础工具定义（缓存） */
export async function loadBaseTools(): Promise<ChatCompletionTool[]> {
  if (_base) return _base;
  try {
    const { getToolDefinitions } = await import("@axon/core");
    _base = getToolDefinitions() as ChatCompletionTool[];
  } catch (err) {
    console.warn("[toolset] 加载 @axon/core 工具定义失败:", (err as Error).message);
    _base = [];
  }
  return _base;
}

/**
 * 为某个变体构建工具集：深拷贝基础工具，按 variant.toolDescriptions 覆盖 description。
 * 这样 A/B 两个变体可以用不同的工具描述，测出描述微调对模型选择的影响。
 */
export async function buildToolsForVariant(variant: Variant): Promise<ChatCompletionTool[]> {
  const base = await loadBaseTools();
  const overrides = variant.toolDescriptions;
  if (!overrides || Object.keys(overrides).length === 0) {
    return base;
  }
  return base.map((tool) => {
    const name = tool.function?.name;
    if (name && overrides[name]) {
      return {
        ...tool,
        function: { ...tool.function, description: overrides[name] },
      };
    }
    return tool;
  });
}
