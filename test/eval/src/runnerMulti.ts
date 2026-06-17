/**
 * 多轮评估运行器
 *
 * 用法：
 *   npm run multi                       # 全部模型 × 全部多轮场景，每场景 1 次
 *   npm run multi -- --runs 2
 *   npm run multi -- --variants gpt-5.5
 *   npm run multi -- --scenario mt_locate_and_fix
 */

import "dotenv/config";
import OpenAI from "openai";
import { ESIGN_PROVIDER } from "@axon/core";
import { runMultiTurnScenario } from "./multiTurnHarness.ts";
import { scoreMultiTurn } from "./scorerMulti.ts";
import { judgeReply } from "./judge.ts";
import { buildToolsForVariant } from "./toolset.ts";
import { PRODUCTION_SYSTEM_PROMPT } from "./prompts.ts";
import { MODEL_VARIANTS } from "./models.ts";
import { scenarios as coreScenarios } from "./scenariosMulti.ts";
import { scenarios as editScenarios } from "./scenariosEdit.ts";
import type { MultiTurnResult, MultiTurnScenario } from "./typesMulti.ts";
import type { Variant } from "./types.ts";

function parseArg(name: string, def?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : def;
}
function mean(ns: number[]): number {
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0;
}

/** 跑一个变体的全部多轮场景 */
async function runVariant(
  variant: Variant,
  scenarios: MultiTurnScenario[],
  client: OpenAI,
  defaultModel: string,
  judgeModel: string,
  runs: number,
): Promise<{ variant: Variant; results: { scenario: string; agg: MultiTurnResult[] }[]; meanScore: number; passRate: number }> {
  const model = variant.model || defaultModel;
  const tools = await buildToolsForVariant(variant);
  console.log(`\n   ▶ 变体 [${variant.id}]  (model=${model}, runs=${runs})`);
  const results: { scenario: string; agg: MultiTurnResult[] }[] = [];

  for (const scenario of scenarios) {
    process.stdout.write(`     ${scenario.id.padEnd(28)} `);
    const agg: MultiTurnResult[] = [];
    for (let i = 0; i < runs; i++) {
      const run = await runMultiTurnScenario(scenario, client, {
        model, systemPrompt: variant.systemPrompt || PRODUCTION_SYSTEM_PROMPT, tools,
      });
      let judgeScore: number | null = null;
      if (scenario.judge) judgeScore = (await judgeReply(scenario as never, run.finalReply, client, judgeModel)).score;
      agg.push(scoreMultiTurn(scenario, run, judgeScore));
    }
    const ms = mean(agg.map((r) => r.overall));
    const tc = mean(agg.map((r) => r.scores.taskCompletion));
    const rounds = mean(agg.map((r) => r.rounds));
    const bar = "█".repeat(Math.round(ms * 10)).padEnd(10, "░");
    const seq = agg[0].trace.map((t) => t.name).join("→") || "(无工具)";
    console.log(`${bar} ${(ms * 100).toFixed(0).padStart(3)}%  完成度=${(tc * 100).toFixed(0)}%  轮=${rounds.toFixed(0)}  [${seq}]`);
    results.push({ scenario: scenario.id, agg });
  }

  const meanScore = mean(results.flatMap((r) => r.agg.map((a) => a.overall)));
  const passRate = mean(results.flatMap((r) => r.agg.map((a) => (a.passed ? 1 : 0))));
  return { variant, results, meanScore, passRate };
}

async function main() {
  const defaultModel = process.env.EVAL_MODEL || "gpt-5.4";
  const judgeModel = process.env.EVAL_JUDGE_MODEL || defaultModel;
  const provider = process.env.EVAL_PROVIDER || ESIGN_PROVIDER;
  const apiKey = process.env[`PROVIDER_${provider.toUpperCase()}_API_KEY`];
  const baseUrl = process.env[`PROVIDER_${provider.toUpperCase()}_BASE_URL`] || "";
  if (!apiKey) { console.error(`❌ 缺少 PROVIDER_${provider.toUpperCase()}_API_KEY`); process.exit(1); }
  const client = new OpenAI({ apiKey, baseURL: baseUrl || undefined });

  const runs = parseInt(parseArg("runs", "1") || "1", 10);
  const variantFilter = parseArg("variants");
  const scenarioFilter = parseArg("scenario");
  const suite = parseArg("suite"); // "core" | "edit" | 缺省=全部
  let variants = MODEL_VARIANTS;
  if (variantFilter) {
    const ids = variantFilter.split(",").map((s) => s.trim());
    variants = variants.filter((v) => ids.includes(v.id));
  }
  const allScenarios: MultiTurnScenario[] =
    suite === "edit" ? editScenarios :
    suite === "core" ? coreScenarios :
    [...coreScenarios, ...editScenarios];
  const scenarios = scenarioFilter ? allScenarios.filter((s) => s.id === scenarioFilter) : allScenarios;
  if (variants.length === 0 || scenarios.length === 0) { console.error("❌ 没有可跑的变体或场景"); process.exit(1); }

  console.log(`\n🧪 Axon 多轮评估（真实沙箱）`);
  console.log(`   模型: ${variants.map((v) => v.id).join(", ")}  |  场景: ${scenarios.length}  |  每场景跑: ${runs} 次`);

  const reports = [];
  for (const v of variants) reports.push(await runVariant(v, scenarios, client, defaultModel, judgeModel, runs));

  console.log(`\n   ════════════════════ 多轮汇总 ════════════════════`);
  for (const r of reports) {
    console.log(`   ${r.variant.id.padEnd(16)} 平均分 ${(r.meanScore * 100).toFixed(1)}%  通过率 ${(r.passRate * 100).toFixed(1)}%`);
  }
  console.log(`   ═══════════════════════════════════════════════════\n`);

  const { writeFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = join(import.meta.dirname || ".", "..", "reports");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `multi-${Date.now()}.json`),
    JSON.stringify(reports, null, 2), "utf-8");
}

main().catch((e) => { console.error("💥 多轮 Runner 异常:", e); process.exit(1); });
