/**
 * TurnResultComparator —— 新老回合结果对比器（纯逻辑，可测试）
 *
 * 背景：
 * - 灰度切换方案的“影子运行（shadow）”阶段：老路径正常驱动 UI，新路径同一轮跑一遍，
 *   两者结果做结构化对比，用于发现分歧、积累接管信心，但不影响任何用户可见行为。
 * - 本对比器就是影子模式的核心判定件：输入老路径的 LLMTurnResult 与新路径的 LLMTurnRawResult，
 *   输出结构化差异报告。
 *
 * 设计要点：
 * - 纯逻辑：不发事件、不记日志、不碰 DOM、不依赖运行时状态；返回值即结论，便于单测与复用。
 * - 只做“结果形状对比”，不引入业务判断：是否需要因某个差异回退，由调用方按报告决定。
 * - 老路径的产品语义结束原因以 normalizedFinishReason 为准（此前已统一为唯一入口）。
 */

import type { LLMTurnResult } from "./types.js";
import type { LLMTurnRawResult } from "./llmTurnSource.js";
import type { NormalizedFinishReason } from "./finishReasonMapper.js";

/** 单项差异：记录字段名、老值、新值。 */
export interface TurnResultDiff {
  field: string;
  legacy: unknown;
  next: unknown;
}

/** 对比结果报告。 */
export interface TurnResultComparison {
  /** 是否完全一致（无任何差异）。 */
  equal: boolean;
  /** finishReason 是否一致。 */
  finishReasonEqual: boolean;
  /** 正文是否一致。 */
  contentEqual: boolean;
  /** 工具调用（数量 + 顺序 + 名称）是否一致。 */
  toolCallsEqual: boolean;
  /** 差异明细（equal=true 时为空数组）。 */
  diffs: TurnResultDiff[];
}

/** 归一化正文：容忍两侧首尾空白差异（不改变实质内容判断）。 */
function normalizeContent(text: string | null | undefined): string {
  return (text ?? "").trim();
}

/**
 * 对比新老回合结果。
 *
 * @param legacy 老路径 LLMStrategy.runTurn 的返回结果
 * @param next   新路径 LLMTurnSource.run 的返回结果
 */
export function compareTurnResults(legacy: LLMTurnResult, next: LLMTurnRawResult): TurnResultComparison {
  const diffs: TurnResultDiff[] = [];

  // 1) finishReason（产品语义）对比：老路径以 normalizedFinishReason 为准。
  const legacyFinish: NormalizedFinishReason = legacy.normalizedFinishReason;
  const finishReasonEqual = legacyFinish === next.finishReason;
  if (!finishReasonEqual) {
    diffs.push({ field: "finishReason", legacy: legacyFinish, next: next.finishReason });
  }

  // 2) 正文对比（容忍首尾空白）。
  const legacyContent = normalizeContent(legacy.content);
  const nextContent = normalizeContent(next.content);
  const contentEqual = legacyContent === nextContent;
  if (!contentEqual) {
    diffs.push({ field: "content", legacy: legacyContent, next: nextContent });
  }

  // 3) 工具调用对比：数量 + 顺序 + 名称。参数不参与对比（各协议序列化差异大，交由后续专门比对）。
  const legacyNames = legacy.toolCalls.map((tc) => tc.name);
  const nextNames = next.toolCalls.map((tc) => tc.toolName);
  let toolCallsEqual = legacyNames.length === nextNames.length;
  if (toolCallsEqual) {
    for (let i = 0; i < legacyNames.length; i++) {
      if (legacyNames[i] !== nextNames[i]) {
        toolCallsEqual = false;
        break;
      }
    }
  }
  if (!toolCallsEqual) {
    diffs.push({ field: "toolCalls", legacy: legacyNames, next: nextNames });
  }

  return {
    equal: diffs.length === 0,
    finishReasonEqual,
    contentEqual,
    toolCallsEqual,
    diffs,
  };
}
