/**
 * 评估用系统提示词来源
 *
 * - PRODUCTION_SYSTEM_PROMPT：直接取自 @axon/core 的真实生产系统提示（Axon 主 Agent）。
 *   这是 eval 的默认基线——只有用真实提示词测，A/B 才能反映「线上真实行为」，
 *   也才能测出「改一句提示词到底涨没涨分」。
 * - NEUTRAL_SYSTEM_PROMPT：一段极简中立提示，作为对照变体，用于量化
 *   「那份详尽的生产提示词相对裸工具定义贡献了多少分」。
 */

import { SYSTEM_PROMPT } from "@axon/core";

/** 真实生产系统提示（主 Agent）——eval 默认基线 */
export const PRODUCTION_SYSTEM_PROMPT: string = SYSTEM_PROMPT;

/** 极简中立提示（对照组，不含任何行为约束） */
export const NEUTRAL_SYSTEM_PROMPT = `你是 Axon，一个 AI 编程助手，能读写代码、执行命令、搜索项目和联网查询。
根据用户的请求，决定是否使用工具以及使用哪些工具。
如果不需要工具就能回答，直接回答即可。`;
