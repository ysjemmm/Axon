/**
 * A/B Runner —— 多变体 × 多场景 × 多次运行的评估编排器
 *
 * 用法：
 *   npm run ab                       # 跑所有变体 × 所有场景，每场景默认 3 次
 *   npm run ab -- --runs 5           # 每场景跑 5 次（降方差）
 *   npm run ab -- --tool web_search  # 只跑某工具的场景
 *   npm run ab -- --variants baseline,experiment
 */

import "dotenv/config";
import OpenAI from "openai";
import { ESIGN_PROVIDER } from "@axon/core";
import { runScenario, DEFAULT_EVAL_SYSTEM_PROMPT } from "./harness.ts";
import { scoreResult } from "./scorer.ts";
import { judgeReply } from "./judge.ts";
import { buildToolsForVariant } from "./toolset.ts";
import { VARIANTS } from "./variants.ts";
import { MODEL_VARIANTS } from "./models.ts";
import { renderMarkdown, printConsoleSummary } from "./report.ts";
import {
  snapshotFromReport, compareToBaseline, printGateResult,
  type BaselineSnapshot,
} from "./regression.ts";
import type {
  EvalScenario, EvalResult, Variant, AggregatedResult,
  DimensionScores, VariantReport, ABReport,
} from "./types.ts";

async function loadScenarios(toolFilter?: string, exclude?: string[]): Promise<EvalScenario[]> {
  const modules = await Promise.all([
    import("./scenarios/read_file.ts"),
    import("./scenarios/str_replace.ts"),
    import("./scenarios/execute_command.ts"),
    import("./scenarios/web_search.ts"),
    import("./scenarios/search.ts"),
  ]);
  const all: EvalScenario[] = [];
  for (const mod of modules) all.push(...mod.scenarios);
  let filtered = toolFilter ? all.filter((s) => s.targetTool === toolFilter) : all;
  if (exclude && exclude.length > 0) {
    filtered = filtered.filter((s) => !exclude.includes(s.targetTool));
  }
  return filtered;
}

function mean(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}
function stdDev(nums: number[]): number {
  if (nums.length < 2) return 0;
  const m = mean(nums);
  return Math.sqrt(mean(nums.map((n) => (n - m) ** 2)));
}
function meanDim(results: EvalResult[], key: keyof DimensionScores): number {
  const vals = results.map((r) => r.scores[key]).filter((v): v is number => v !== null);
  return vals.length ? mean(vals) : 0;
}
function hasJudge(results: EvalResult[]): boolean {
  return results.some((r) => r.scores.judge !== null);
}

/** 聚合同一场景的多次运行 */
function aggregate(scenarioId: string, runs: EvalResult[]): AggregatedResult {
  const overalls = runs.map((r) => r.overall);
  return {
    scenarioId,
    runs: runs.length,
    passRate: runs.filter((r) => r.passed).length / runs.length,
    meanScore: mean(overalls),
    stdDev: stdDev(overalls),
    meanScores: {
      toolSelection: meanDim(runs, "toolSelection"),
      argsCorrectness: meanDim(runs, "argsCorrectness"),
      noForbidden: meanDim(runs, "noForbidden"),
      efficiency: meanDim(runs, "efficiency"),
      judge: hasJudge(runs) ? meanDim(runs, "judge") : null,
    },
    avgLatency: mean(runs.map((r) => r.latency)),
    totalTokens: runs.reduce((s, r) => s + r.tokens, 0),
    sampleToolCalls: runs.map((r) => r.toolCalls.map((t) => t.name)),
  };
}

/** 跑一个变体的全部场景 */
async function runVariant(
  variant: Variant,
  scenarios: EvalScenario[],
  client: OpenAI,
  defaultModel: string,
  judgeModel: string,
  runs: number,
): Promise<VariantReport> {
  const model = variant.model || defaultModel;
  const systemPrompt = variant.systemPrompt || DEFAULT_EVAL_SYSTEM_PROMPT;
  const tools = await buildToolsForVariant(variant);

  console.log(`\n   ▶ 变体 [${variant.id}] ${variant.label}  (model=${model}, runs=${runs})`);
  const results: AggregatedResult[] = [];

  for (const scenario of scenarios) {
    process.stdout.write(`     ${scenario.id.padEnd(35)} `);
    const runResults: EvalResult[] = [];
    for (let i = 0; i < runs; i++) {
      try {
        const hr = await runScenario(scenario, client, { model, systemPrompt, tools });
        let judgeScore: number | null = null;
        if (scenario.judge) {
          const j = await judgeReply(scenario, hr.reply, client, judgeModel);
          judgeScore = j.score;
        }
        runResults.push(scoreResult(scenario, hr, judgeScore));
      } catch (err) {
        runResults.push({
          scenarioId: scenario.id, toolCalls: [], reply: "",
          scores: { toolSelection: 0, argsCorrectness: 0, noForbidden: 0, efficiency: 0, judge: null },
          overall: 0, passed: false, latency: 0, tokens: 0,
        });
        process.stdout.write("💥");
      }
    }
    const agg = aggregate(scenario.id, runResults);
    results.push(agg);
    const bar = "█".repeat(Math.round(agg.meanScore * 10)).padEnd(10, "░");
    console.log(`${bar} ${(agg.meanScore * 100).toFixed(0).padStart(3)}%  σ=${agg.stdDev.toFixed(2)}  pass=${(agg.passRate * 100).toFixed(0)}%`);
  }

  const meanScore = mean(results.map((r) => r.meanScore));
  const passRate = mean(results.map((r) => r.passRate));
  return {
    variant,
    resolvedModel: model,
    results,
    summary: {
      total: results.length,
      meanScore,
      passRate,
      avgLatency: mean(results.map((r) => r.avgLatency)),
      totalTokens: results.reduce((s, r) => s + r.totalTokens, 0),
    },
  };
}

function parseArg(name: string, def?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : def;
}

async function main() {
  const defaultModel = process.env.EVAL_MODEL || "gpt-5.4";
  const judgeModel = process.env.EVAL_JUDGE_MODEL || defaultModel;
  const provider = process.env.EVAL_PROVIDER || ESIGN_PROVIDER;
  const apiKey = process.env[`PROVIDER_${provider.toUpperCase()}_API_KEY`];
  const baseUrl = process.env[`PROVIDER_${provider.toUpperCase()}_BASE_URL`] || "";
  if (!apiKey) {
    console.error(`❌ 缺少 PROVIDER_${provider.toUpperCase()}_API_KEY`);
    process.exit(1);
  }
  const client = new OpenAI({ apiKey, baseURL: baseUrl || undefined });

  const runs = parseInt(parseArg("runs", "3") || "3", 10);
  const toolFilter = parseArg("tool");
  const excludeArg = parseArg("exclude");
  const exclude = excludeArg ? excludeArg.split(",").map((s) => s.trim()) : undefined;
  const variantFilter = parseArg("variants");
  const preset = parseArg("preset"); // "models" → 多模型对比；缺省 → variants.ts 的 A/B 变体
  const saveBaseline = process.argv.includes("--save-baseline");
  const gate = process.argv.includes("--gate");
  const toleranceArg = parseArg("tolerance");
  const tolerance = toleranceArg ? parseFloat(toleranceArg) : 0.08;

  let variants = preset === "models" ? MODEL_VARIANTS : VARIANTS;
  if (variantFilter) {
    const ids = variantFilter.split(",").map((s) => s.trim());
    variants = variants.filter((v) => ids.includes(v.id));
  }

  const scenarios = await loadScenarios(toolFilter, exclude);
  if (scenarios.length === 0 || variants.length === 0) {
    console.error("❌ 没有可跑的场景或变体");
    process.exit(1);
  }

  console.log(`\n🧪 Axon Tool A/B Eval`);
  console.log(`   默认模型: ${defaultModel} (${provider})  |  judge: ${judgeModel}`);
  console.log(`   场景: ${scenarios.length}  变体: ${variants.map((v) => v.id).join(", ")}  每场景跑: ${runs} 次`);

  const variantReports: VariantReport[] = [];
  for (const variant of variants) {
    variantReports.push(await runVariant(variant, scenarios, client, defaultModel, judgeModel, runs));
  }

  // 逐场景对比（仅 2 变体时）
  let comparison: ABReport["comparison"];
  let overallWinner: string | undefined;
  if (variantReports.length === 2) {
    const [a, b] = variantReports;
    comparison = scenarios.map((s) => {
      const sa = a.results.find((r) => r.scenarioId === s.id)?.meanScore ?? 0;
      const sb = b.results.find((r) => r.scenarioId === s.id)?.meanScore ?? 0;
      const delta = sb - sa;
      return {
        scenarioId: s.id,
        scores: { [a.variant.id]: sa, [b.variant.id]: sb },
        delta,
        winner: Math.abs(delta) < 0.01 ? "tie" : delta > 0 ? b.variant.id : a.variant.id,
      };
    });
  }
  if (variantReports.length >= 2) {
    const best = [...variantReports].sort((x, y) => y.summary.meanScore - x.summary.meanScore)[0];
    const second = [...variantReports].sort((x, y) => y.summary.meanScore - x.summary.meanScore)[1];
    overallWinner = Math.abs(best.summary.meanScore - second.summary.meanScore) < 0.005
      ? "tie（差异不显著）"
      : `${best.variant.id}（${(best.summary.meanScore * 100).toFixed(1)}%）`;
  }

  const report: ABReport = {
    timestamp: new Date().toISOString(),
    runsPerScenario: runs,
    variants: variantReports,
    comparison,
    overallWinner,
  };

  printConsoleSummary(report);

  // 写 JSON + Markdown
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const reportDir = join(import.meta.dirname || ".", "..", "reports");
  await mkdir(reportDir, { recursive: true });
  const stamp = Date.now();
  await writeFile(join(reportDir, `ab-${stamp}.json`), JSON.stringify(report, null, 2), "utf-8");
  const mdPath = join(reportDir, `ab-${stamp}.md`);
  await writeFile(mdPath, renderMarkdown(report), "utf-8");
  console.log(`   📄 报告: ${mdPath}\n`);

  // ── 回归门禁 ──
  const baselinePath = join(import.meta.dirname || ".", "..", "baseline.json");
  if (saveBaseline) {
    const snapshot = snapshotFromReport(report);
    await writeFile(baselinePath, JSON.stringify(snapshot, null, 2), "utf-8");
    console.log(`   📌 基线已保存: ${baselinePath}（${Object.keys(snapshot.data).length} 个变体）\n`);
  }
  if (gate) {
    const { readFile } = await import("node:fs/promises");
    let baseline: BaselineSnapshot;
    try {
      baseline = JSON.parse(await readFile(baselinePath, "utf-8")) as BaselineSnapshot;
    } catch {
      console.error(`   ❌ 未找到基线文件 ${baselinePath}，请先用 --save-baseline 生成基线`);
      process.exit(1);
    }
    const gateResult = compareToBaseline(report, baseline, tolerance);
    printGateResult(gateResult);
    if (!gateResult.ok) {
      console.error(`   💥 回归门禁未通过：检测到行为退化，请检查上面的退化项`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("💥 AB Runner 异常:", err);
  process.exit(1);
});
