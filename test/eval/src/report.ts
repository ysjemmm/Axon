/**
 * 报告生成 —— 控制台表格 + Markdown 报告
 */

import type { ABReport, VariantReport } from "./types.ts";

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/** 生成 Markdown 报告 */
export function renderMarkdown(report: ABReport): string {
  const lines: string[] = [];
  lines.push(`# Axon 工具使用 A/B 评估报告`);
  lines.push("");
  lines.push(`- 时间：${report.timestamp}`);
  lines.push(`- 每场景运行次数：${report.runsPerScenario}`);
  lines.push(`- 变体数：${report.variants.length}`);
  if (report.overallWinner) lines.push(`- **总体胜者：${report.overallWinner}**`);
  lines.push("");

  // 变体汇总表
  lines.push(`## 变体汇总`);
  lines.push("");
  lines.push(`| 变体 | 模型 | 平均分 | 通过率 | 平均延迟 | 总 token |`);
  lines.push(`|------|------|--------|--------|----------|----------|`);
  for (const v of report.variants) {
    lines.push(
      `| ${v.variant.label} | ${v.resolvedModel} | ${pct(v.summary.meanScore)} | ${pct(v.summary.passRate)} | ${v.summary.avgLatency.toFixed(0)}ms | ${v.summary.totalTokens} |`,
    );
  }
  lines.push("");

  // 逐场景对比（A/B）
  if (report.comparison && report.variants.length === 2) {
    const [a, b] = report.variants;
    lines.push(`## 逐场景对比（${a.variant.label} → ${b.variant.label}）`);
    lines.push("");
    lines.push(`| 场景 | ${a.variant.id} | ${b.variant.id} | Δ | 胜者 |`);
    lines.push(`|------|------|------|------|------|`);
    for (const c of report.comparison) {
      const sa = c.scores[a.variant.id] ?? 0;
      const sb = c.scores[b.variant.id] ?? 0;
      const arrow = c.delta > 0.01 ? "🟢" : c.delta < -0.01 ? "🔴" : "⚪";
      lines.push(`| ${c.scenarioId} | ${pct(sa)} | ${pct(sb)} | ${arrow} ${(c.delta * 100).toFixed(1)}% | ${c.winner} |`);
    }
    lines.push("");
  }

  // 多变体（>2）矩阵：场景 × 变体 平均分，标注每行最高
  if (report.variants.length > 2) {
    const vs = report.variants;
    const scenarioIds = vs[0].results.map((r) => r.scenarioId);
    lines.push(`## 场景 × 变体 得分矩阵`);
    lines.push("");
    lines.push(`| 场景 | ${vs.map((v) => v.variant.id).join(" | ")} | 最佳 |`);
    lines.push(`|------|${vs.map(() => "------").join("|")}|------|`);
    for (const sid of scenarioIds) {
      const row = vs.map((v) => v.results.find((r) => r.scenarioId === sid)?.meanScore ?? 0);
      const max = Math.max(...row);
      const bestIdx = row.indexOf(max);
      const cells = row.map((s, idx) => (idx === bestIdx ? `**${pct(s)}**` : pct(s)));
      lines.push(`| ${sid} | ${cells.join(" | ")} | ${vs[bestIdx].variant.id} |`);
    }
    lines.push("");
  }

  // 每个变体的稳定性明细（标准差）
  for (const v of report.variants) {
    lines.push(`## 明细：${v.variant.label}`);
    lines.push("");
    lines.push(`| 场景 | 平均分 | 通过率 | 稳定性(σ) | 工具选择 | 参数 | 禁止 | 效率 | judge |`);
    lines.push(`|------|--------|--------|-----------|----------|------|------|------|-------|`);
    for (const r of v.results) {
      const m = r.meanScores;
      lines.push(
        `| ${r.scenarioId} | ${pct(r.meanScore)} | ${pct(r.passRate)} | ${r.stdDev.toFixed(3)} | ${pct(m.toolSelection)} | ${pct(m.argsCorrectness)} | ${pct(m.noForbidden)} | ${pct(m.efficiency)} | ${m.judge === null ? "-" : pct(m.judge)} |`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** 控制台打印 A/B 对比摘要 */
export function printConsoleSummary(report: ABReport): void {
  console.log(`\n   ════════════════════ A/B 汇总 ════════════════════`);
  for (const v of report.variants) {
    console.log(
      `   ${v.variant.id.padEnd(12)} 平均分 ${pct(v.summary.meanScore).padStart(6)}  通过率 ${pct(v.summary.passRate).padStart(6)}  ${v.summary.avgLatency.toFixed(0)}ms  ${v.summary.totalTokens} tok`,
    );
  }
  if (report.comparison && report.variants.length === 2) {
    const [a, b] = report.variants;
    const improved = report.comparison.filter((c) => c.delta > 0.01).length;
    const regressed = report.comparison.filter((c) => c.delta < -0.01).length;
    const tied = report.comparison.length - improved - regressed;
    console.log(`   ───────────────────────────────────────────────────`);
    console.log(`   ${b.variant.id} vs ${a.variant.id}:  🟢 提升 ${improved}  🔴 回退 ${regressed}  ⚪ 持平 ${tied}`);
  }
  if (report.overallWinner) {
    console.log(`   🏆 总体胜者: ${report.overallWinner}`);
  }
  console.log(`   ═══════════════════════════════════════════════════\n`);
}

export function variantOverall(v: VariantReport): number {
  return v.summary.meanScore;
}
