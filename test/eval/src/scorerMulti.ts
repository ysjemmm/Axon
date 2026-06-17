/**
 * 多轮评分器 —— 以「任务最终是否真正完成」为核心维度
 *
 * 维度权重：
 *  - taskCompletion 0.45：最终落盘文件是否满足断言（最重要，直接反映任务做没做成）
 *  - toolTrajectory 0.25：该用的工具用了、顺序对、没用禁用的
 *  - noForbidden    0.15：没有调用禁用工具
 *  - efficiency     0.15：轮次/调用数惩罚
 *  - judge（动态）：可选的回复质量评分
 */

import type {
  MultiTurnScenario, MultiTurnRunResult, MultiTurnResult, MultiTurnDimensionScores,
} from "./typesMulti.ts";

const W = { taskCompletion: 0.45, toolTrajectory: 0.25, noForbidden: 0.15, efficiency: 0.15 };

/** toolSequence 是否作为有序子序列出现在实际调用序列中 */
function isSubsequence(needle: string[], haystack: string[]): boolean {
  let i = 0;
  for (const name of haystack) {
    if (i < needle.length && name === needle[i]) i++;
  }
  return i === needle.length;
}

/** 任务完成度：finalFiles 子串断言 + absentFiles 不存在断言，按条目平均 */
function scoreTaskCompletion(scenario: MultiTurnScenario, run: MultiTurnRunResult): number {
  const checks: boolean[] = [];
  for (const [path, substrings] of Object.entries(scenario.expected.finalFiles ?? {})) {
    const content = run.finalFileContents[path];
    if (content === null) { checks.push(false); continue; }
    for (const sub of substrings) checks.push(content.includes(sub));
  }
  for (const path of scenario.expected.absentFiles ?? []) {
    checks.push(run.finalFileContents[path] === null);
  }
  if (checks.length === 0) return 1; // 没声明文件断言时不惩罚
  return checks.filter(Boolean).length / checks.length;
}

/** 工具轨迹正确性：toolsUsed / toolSequence / toolsAbsent 三项可用子检查的平均 */
function scoreToolTrajectory(scenario: MultiTurnScenario, names: string[]): number {
  const parts: number[] = [];
  const { toolsUsed, toolSequence, toolsAbsent } = scenario.expected;
  if (toolsUsed && toolsUsed.length > 0) {
    const hit = toolsUsed.filter((t) => names.includes(t)).length;
    parts.push(hit / toolsUsed.length);
  }
  if (toolSequence && toolSequence.length > 0) {
    parts.push(isSubsequence(toolSequence, names) ? 1 : 0);
  }
  if (toolsAbsent && toolsAbsent.length > 0) {
    parts.push(toolsAbsent.some((t) => names.includes(t)) ? 0 : 1);
  }
  return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) / parts.length : 1;
}

export function scoreMultiTurn(
  scenario: MultiTurnScenario,
  run: MultiTurnRunResult,
  judgeScore: number | null = null,
): MultiTurnResult {
  const names = run.trace.map((t) => t.name);

  const taskCompletion = scoreTaskCompletion(scenario, run);
  const toolTrajectory = scoreToolTrajectory(scenario, names);
  const noForbidden = (scenario.expected.toolsAbsent ?? []).some((t) => names.includes(t)) ? 0 : 1;

  // 效率：理想调用数取「序列长度」或「用到的工具数」或 2 的较大值；超出则衰减
  const ideal = Math.max(2, scenario.expected.toolSequence?.length ?? 0, scenario.expected.toolsUsed?.length ?? 0);
  const extra = Math.max(0, names.length - ideal);
  const efficiency = 1 / (1 + 0.5 * extra);

  const scores: MultiTurnDimensionScores = {
    taskCompletion, toolTrajectory, noForbidden, efficiency, judge: judgeScore,
  };

  const judgeWeight = (scenario.judge?.weight && judgeScore !== null) ? scenario.judge.weight : 0;
  const norm = 1 + judgeWeight;
  let overall =
    (taskCompletion * W.taskCompletion +
      toolTrajectory * W.toolTrajectory +
      noForbidden * W.noForbidden +
      efficiency * W.efficiency) / norm;
  if (judgeWeight > 0 && judgeScore !== null) overall += (judgeScore * judgeWeight) / norm;

  return {
    scenarioId: scenario.id,
    trace: run.trace,
    finalReply: run.finalReply,
    rounds: run.rounds,
    scores,
    overall,
    passed: overall >= 0.7,
    latency: run.latency,
    tokens: run.tokens,
  };
}
