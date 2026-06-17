/**
 * Eval Runner —— 批量运行评估场景并生成报告
 *
 * 用法：
 *   npm run eval                    # 跑所有场景
 *   npm run eval:tool -- read_file  # 只跑指定工具的场景
 */

import "dotenv/config";
import OpenAI from "openai";
import { ESIGN_PROVIDER } from "@axon/core";
import { runScenario, DEFAULT_EVAL_SYSTEM_PROMPT } from "./harness.ts";
import { scoreResult } from "./scorer.ts";
import { loadBaseTools } from "./toolset.ts";
import type { EvalScenario, EvalResult } from "./types.ts";

// 动态加载所有场景
async function loadScenarios(toolFilter?: string): Promise<EvalScenario[]> {
  const modules = [
    import("./scenarios/read_file.ts"),
    import("./scenarios/str_replace.ts"),
    import("./scenarios/execute_command.ts"),
    import("./scenarios/web_search.ts"),
    import("./scenarios/search.ts"),
  ];

  const all: EvalScenario[] = [];
  for (const mod of await Promise.all(modules)) {
    all.push(...mod.scenarios);
  }

  if (toolFilter) {
    return all.filter((s) => s.targetTool === toolFilter);
  }
  return all;
}

async function main() {
  const model = process.env.EVAL_MODEL || "gpt-5.4";
  const provider = process.env.EVAL_PROVIDER || ESIGN_PROVIDER;
  const apiKey = process.env[`PROVIDER_${provider.toUpperCase()}_API_KEY`];
  const baseUrl = process.env[`PROVIDER_${provider.toUpperCase()}_BASE_URL`] || "";

  if (!apiKey) {
    console.error(`❌ 未找到 provider "${provider}" 的 API Key（环境变量 PROVIDER_${provider.toUpperCase()}_API_KEY）`);
    process.exit(1);
  }

  const client = new OpenAI({ apiKey, baseURL: baseUrl || undefined });
  const tools = await loadBaseTools();

  // 解析 --tool 参数
  const args = process.argv.slice(2);
  const toolIdx = args.indexOf("--tool");
  const toolFilter = toolIdx >= 0 ? args[toolIdx + 1] : undefined;

  const scenarios = await loadScenarios(toolFilter);
  if (scenarios.length === 0) {
    console.error("❌ 没有匹配的场景");
    process.exit(1);
  }

  console.log(`\n🧪 Axon Tool Eval`);
  console.log(`   模型: ${model} (${provider})`);
  console.log(`   场景: ${scenarios.length} 个${toolFilter ? ` (筛选: ${toolFilter})` : ""}`);
  console.log(`   ────────────────────────────────────\n`);

  const results: EvalResult[] = [];

  for (const scenario of scenarios) {
    process.stdout.write(`   ${scenario.id.padEnd(35)} `);
    try {
      const harnessResult = await runScenario(scenario, client, { model, systemPrompt: DEFAULT_EVAL_SYSTEM_PROMPT, tools });
      const evalResult = scoreResult(scenario, harnessResult);
      results.push(evalResult);

      const icon = evalResult.passed ? "✅" : "❌";
      const score = (evalResult.overall * 100).toFixed(0).padStart(3);
      const tools = harnessResult.toolCalls.map((t) => t.name).join(",") || "(无)";
      console.log(`${icon} ${score}%  [${tools}]  ${evalResult.latency}ms`);
    } catch (err) {
      console.log(`💥 ERROR: ${(err as Error).message}`);
      results.push({
        scenarioId: scenario.id,
        toolCalls: [],
        reply: "",
        scores: { toolSelection: 0, argsCorrectness: 0, noForbidden: 0, efficiency: 0, judge: null },
        overall: 0,
        passed: false,
        latency: 0,
        tokens: 0,
      });
    }
  }

  // 汇总
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const avgScore = results.reduce((s, r) => s + r.overall, 0) / results.length;
  const avgLatency = results.reduce((s, r) => s + r.latency, 0) / results.length;
  const totalTokens = results.reduce((s, r) => s + r.tokens, 0);

  console.log(`\n   ────────────────────────────────────`);
  console.log(`   总计: ${results.length}  通过: ${passed}  失败: ${failed}`);
  console.log(`   平均分: ${(avgScore * 100).toFixed(1)}%`);
  console.log(`   平均延迟: ${avgLatency.toFixed(0)}ms`);
  console.log(`   总 token: ${totalTokens}`);
  console.log(`   通过率: ${((passed / results.length) * 100).toFixed(1)}%\n`);

  // 输出 JSON 报告
  const report = {
    model,
    provider,
    timestamp: new Date().toISOString(),
    scenarios: results,
    summary: { total: results.length, passed, failed, avgScore, avgLatency, totalTokens },
  };

  const { writeFile, mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const reportDir = join(import.meta.dirname || ".", "..", "reports");
  await mkdir(reportDir, { recursive: true });
  const reportPath = join(reportDir, `eval-${model}-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");
  console.log(`   📄 报告已保存: ${reportPath}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("💥 Runner 异常:", err);
  process.exit(1);
});
