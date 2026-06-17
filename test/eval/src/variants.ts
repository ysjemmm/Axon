/**
 * A/B 变体定义
 *
 * 每个变体可覆盖：模型 / 系统提示 / 工具描述。
 * 跑 A/B 时，同一批场景在每个变体下各跑 N 次，对比得分差异。
 *
 * 下面给出一组示例：
 *  - baseline：当前线上配置（默认系统提示 + 原始工具描述）
 *  - experiment：实验版——针对 eval 暴露的弱点（web_search/execute_command 偏保守）
 *    强化工具描述，看是否能提升触发准确率
 *
 * 你可以按需增删变体，或改成「A=旧 prompt，B=新 prompt」的对比。
 */

import type { Variant } from "./types.ts";
import { NEUTRAL_SYSTEM_PROMPT } from "./prompts.ts";

export const VARIANTS: Variant[] = [
  {
    id: "baseline",
    label: "Baseline（生产系统提示）",
    // 不覆盖 systemPrompt → 用真实生产 SYSTEM_PROMPT（已含 read_file 路径明确性修复）
  },
  {
    id: "neutral",
    label: "Neutral（裸工具，无生产提示）",
    // 对照组：换成极简中立提示，用于量化生产提示词相对裸工具定义贡献了多少分
    systemPrompt: NEUTRAL_SYSTEM_PROMPT,
  },
  {
    id: "experiment",
    label: "Experiment（强化工具描述）",
    toolDescriptions: {
      web_search:
        "联网搜索：查询最新信息、文档、技术方案、报错解决方案。" +
        "【重要】凡是涉及时效性（最新版本号、最近的 API 用法、框架新特性）、" +
        "或你不确定/可能过时的信息，必须主动联网搜索核实，不要凭记忆直接回答。" +
        "遇到用户贴的报错信息求助时，优先联网搜索该报错的解决方案。返回最多 10 条相关结果。",
      execute_command:
        "在终端执行命令。当用户明确要求运行、安装、构建、测试某个东西时（如「跑一下测试」「安装 X 依赖」），" +
        "直接执行对应命令，不要先去 list_dir/read_file 探查。" +
        "注意：对可能造成破坏的命令（rm -rf、删库、格式化等）应拒绝或先警告用户确认。",
    },
  },
];

/** 按 id 取变体 */
export function getVariant(id: string): Variant | undefined {
  return VARIANTS.find((v) => v.id === id);
}
