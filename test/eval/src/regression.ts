/**
 * 回归门禁 —— 把一次"已认可"的评估结果固化为基线快照，
 * 之后每次改提示词/工具/场景，都用当前结果对比基线，自动卡住退化。
 *
 * 用法（见 abrunner）：
 *   npm run models -- --save-baseline   # 把本次结果存为基线
 *   npm run models -- --gate            # 对比基线，若有退化则进程退出码=1
 *
 * 设计：
 * - 快照粒度到 (变体 × 场景) 的 meanScore + passRate，这是最能反映行为变化的两个量。
 * - 退化判定：meanScore 跌幅 > tolerance 或 passRate 跌幅 > tolerance 即算退化。
 * - 新增场景/变体不算退化（只提示）；基线里有但本次缺失的，算"缺失"并失败（防止偷偷删场景刷分）。
 */

import type { ABReport } from "./types.ts";

/** 单个 (变体,场景) 的基线指标 */
export interface BaselineEntry {
  meanScore: number;
  passRate: number;
}

/** 基线快照文件结构 */
export interface BaselineSnapshot {
  timestamp: string;
  runsPerScenario: number;
  /** variantId -> scenarioId -> 指标 */
  data: Record<string, Record<string, BaselineEntry>>;
}

/** 一条退化/变更记录 */
export interface RegressionItem {
  variantId: string;
  scenarioId: string;
  kind: "regressed" | "missing" | "improved" | "new";
  baseScore?: number;
  currScore?: number;
  basePass?: number;
  currPass?: number;
}

export interface GateResult {
  ok: boolean;
  tolerance: number;
  items: RegressionItem[];
}

/** 从一次 A/B 报告抽取基线快照 */
export function snapshotFromReport(report: ABReport): BaselineSnapshot {
  const data: BaselineSnapshot["data"] = {};
  for (const vr of report.variants) {
    const byScenario: Record<string, BaselineEntry> = {};
    for (const r of vr.results) {
      byScenario[r.scenarioId] = { meanScore: r.meanScore, passRate: r.passRate };
    }
    data[vr.variant.id] = byScenario;
  }
  return {
    timestamp: report.timestamp,
    runsPerScenario: report.runsPerScenario,
    data,
  };
}

/**
 * 用当前报告对比基线，产出退化清单与门禁结论。
 * @param tolerance 容差（默认 0.08）：跌幅在容差内视为正常波动，不算退化
 */
export function compareToBaseline(
  report: ABReport,
  baseline: BaselineSnapshot,
  tolerance = 0.08,
): GateResult {
  const items: RegressionItem[] = [];
  const curr = snapshotFromReport(report);

  for (const [variantId, baseScenarios] of Object.entries(baseline.data)) {
    const currScenarios = curr.data[variantId] || {};
    for (const [scenarioId, base] of Object.entries(baseScenarios)) {
      const cur = currScenarios[scenarioId];
      if (!cur) {
        items.push({ variantId, scenarioId, kind: "missing", baseScore: base.meanScore, basePass: base.passRate });
        continue;
      }
      const scoreDrop = base.meanScore - cur.meanScore;
      const passDrop = base.passRate - cur.passRate;
      if (scoreDrop > tolerance || passDrop > tolerance) {
        items.push({
          variantId, scenarioId, kind: "regressed",
          baseScore: base.meanScore, currScore: cur.meanScore,
          basePass: base.passRate, currPass: cur.passRate,
        });
      } else if (cur.meanScore - base.meanScore > tolerance) {
        items.push({
          variantId, scenarioId, kind: "improved",
          baseScore: base.meanScore, currScore: cur.meanScore,
        });
      }
    }
  }

  // 标记本次新增（基线里没有）的场景，仅作提示
  for (const [variantId, currScenarios] of Object.entries(curr.data)) {
    const baseScenarios = baseline.data[variantId] || {};
    for (const scenarioId of Object.keys(currScenarios)) {
      if (!(scenarioId in baseScenarios)) {
        items.push({ variantId, scenarioId, kind: "new", currScore: currScenarios[scenarioId].meanScore });
      }
    }
  }

  const ok = !items.some((i) => i.kind === "regressed" || i.kind === "missing");
  return { ok, tolerance, items };
}

/** 把门禁结论打印到控制台 */
export function printGateResult(result: GateResult): void {
  const regressed = result.items.filter((i) => i.kind === "regressed");
  const missing = result.items.filter((i) => i.kind === "missing");
  const improved = result.items.filter((i) => i.kind === "improved");
  const created = result.items.filter((i) => i.kind === "new");

  console.log(`\n   ════════════════════ 回归门禁（容差 ${(result.tolerance * 100).toFixed(0)}%）════════════════════`);
  if (result.ok) {
    console.log(`   ✅ 通过：无退化、无缺失场景`);
  } else {
    console.log(`   ❌ 未通过：${regressed.length} 处退化，${missing.length} 处场景缺失`);
  }
  for (const i of regressed) {
    console.log(`   🔴 退化 [${i.variantId}] ${i.scenarioId}: ${(i.baseScore! * 100).toFixed(0)}%→${(i.currScore! * 100).toFixed(0)}% (pass ${(i.basePass! * 100).toFixed(0)}%→${(i.currPass! * 100).toFixed(0)}%)`);
  }
  for (const i of missing) {
    console.log(`   ⚠️ 缺失 [${i.variantId}] ${i.scenarioId}（基线 ${(i.baseScore! * 100).toFixed(0)}%，本次未跑）`);
  }
  for (const i of improved) {
    console.log(`   🟢 提升 [${i.variantId}] ${i.scenarioId}: ${(i.baseScore! * 100).toFixed(0)}%→${(i.currScore! * 100).toFixed(0)}%`);
  }
  for (const i of created) {
    console.log(`   ✨ 新增 [${i.variantId}] ${i.scenarioId}: ${(i.currScore! * 100).toFixed(0)}%（不在基线中）`);
  }
  console.log(`   ═══════════════════════════════════════════════════════\n`);
}
