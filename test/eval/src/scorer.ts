/**
 * Eval Scorer —— 对单个场景的运行结果打分（确定性维度）
 *
 * judge 维度（主观质量）由 judge.ts 单独计算后注入，本模块负责确定性维度
 * （工具选择 / 参数 / 禁止工具 / 效率）与最终加权。
 */

import type { EvalScenario, EvalResult, DimensionScores } from "./types.ts";
import type { HarnessResult } from "./harness.ts";

/** 确定性维度权重（judge 维度的权重来自 scenario.judge.weight，会动态归一化） */
const BASE_WEIGHTS = {
  toolSelection: 0.40,
  argsCorrectness: 0.25,
  noForbidden: 0.20,
  efficiency: 0.15,
};

/** glob 匹配：把 glob 转为正则做整串匹配，支持 `*` / `**` 出现在任意位置 */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  // 转义正则特殊字符，再把通配符占位还原为 .*
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // 转义除 * 外的正则元字符
    .replace(/\*+/g, "\u0000"); // 先把连续的 * / ** 折叠为占位符
  const regexBody = escaped.replace(/\u0000/g, ".*");
  return new RegExp(`^${regexBody}$`).test(value);
}

/** 计算确定性维度得分（不含 judge） */
export function scoreResult(
  scenario: EvalScenario,
  result: HarnessResult,
  judgeScore: number | null = null,
): EvalResult {
  const { expected } = scenario;
  const calledNames = result.toolCalls.map((tc) => tc.name);

  // ── 工具选择 ──
  // - toolCalled 非空：必须命中其一
  // - toolCalled 显式为 []：严格不调任何工具（纯概念问答）
  // - 仅有 notCalled（负向场景）：只要没调禁止工具即可，允许用其他工具调研
  // - 无任何约束：视为通过
  let toolSelection: number;
  if (expected.toolCalled && expected.toolCalled.length > 0) {
    toolSelection = expected.toolCalled.some((t) => calledNames.includes(t)) ? 1 : 0;
  } else if (expected.toolCalled && expected.toolCalled.length === 0) {
    toolSelection = calledNames.length === 0 ? 1 : 0;
  } else if (expected.notCalled && expected.notCalled.length > 0) {
    toolSelection = expected.notCalled.some((t) => calledNames.includes(t)) ? 0 : 1;
  } else {
    toolSelection = 1;
  }

  // ── 参数正确性 ──
  let argsCorrectness = 1;
  if (expected.argsMatch && Object.keys(expected.argsMatch).length > 0) {
    const targetCall = result.toolCalls.find((tc) => expected.toolCalled?.includes(tc.name));
    if (!targetCall) {
      argsCorrectness = 0;
    } else {
      let matched = 0;
      let total = 0;
      for (const [key, pattern] of Object.entries(expected.argsMatch)) {
        total++;
        if (globMatch(pattern, String(targetCall.args[key] ?? ""))) matched++;
      }
      argsCorrectness = total > 0 ? matched / total : 1;
    }
  }

  // ── 禁止工具 ──
  let noForbidden = 1;
  if (expected.notCalled && expected.notCalled.length > 0) {
    noForbidden = expected.notCalled.some((t) => calledNames.includes(t)) ? 0 : 1;
  }

  // ── 效率 ──
  const expectedCallCount = expected.toolCalled && expected.toolCalled.length > 0 ? 1 : 0;
  const extraCalls = Math.max(0, calledNames.length - expectedCallCount);
  const efficiency = 1 / (1 + extraCalls);

  const scores: DimensionScores = {
    toolSelection,
    argsCorrectness,
    noForbidden,
    efficiency,
    judge: judgeScore,
  };

  // ── 加权（judge 有效时动态并入；权重归一化） ──
  const judgeWeight = (scenario.judge?.weight && judgeScore !== null) ? scenario.judge.weight : 0;
  const detTotal = 1; // BASE_WEIGHTS 之和为 1
  const norm = detTotal + judgeWeight;
  let overall =
    (scores.toolSelection * BASE_WEIGHTS.toolSelection +
      scores.argsCorrectness * BASE_WEIGHTS.argsCorrectness +
      scores.noForbidden * BASE_WEIGHTS.noForbidden +
      scores.efficiency * BASE_WEIGHTS.efficiency) / norm;
  if (judgeWeight > 0 && judgeScore !== null) {
    overall += (judgeScore * judgeWeight) / norm;
  }

  return {
    scenarioId: scenario.id,
    toolCalls: result.toolCalls,
    reply: result.reply,
    scores,
    overall,
    passed: overall >= 0.7,
    latency: result.latency,
    tokens: result.tokens,
  };
}
