/**
 * 大文件生成压测：测"模型一次性写大文件会不会被输出截断、能否恢复"。
 *
 * 为什么单独写一个 harness：通用 multiTurnHarness 把 max_tokens 写死成 1024
 * （约 80~120 行就截断），那测的是 harness 的人为上限，不是生产行为。生产的
 * ChatCompletionsStrategy 不设 max_tokens。这里用 16384（远高于 1024）逼近生产，
 * 并用生产同款 parseToolArguments（带 JSON 修复）判定工具参数是否被截断，
 * 才能测出"模型自身写大文件"的真实表现，给"要不要加 append_file"提供数据。
 *
 * 关键产出（每模型 × 每尺寸）：轮数 / create_file 调用数 / 截断轮数(finish=length) /
 * 参数解析失败数 / 是否降级到 execute_command / 最终条目数 vs 目标 / 是否写全。
 *
 * 运行：npm run stress:largefile
 *      npm run stress:largefile -- --variants gpt-5.5,deepseek-v4-pro
 */

import "dotenv/config";
import OpenAI from "openai";
import type { ChatCompletionChunk, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { Stream } from "openai/streaming";
import { executeToolCall, parseToolArguments, ESIGN_PROVIDER } from "@axon/core";
import { createSandbox } from "./sandbox.ts";
import { buildToolsForVariant } from "./toolset.ts";
import { PRODUCTION_SYSTEM_PROMPT } from "./prompts.ts";
import { MODEL_VARIANTS } from "./models.ts";

/** 输出上限：远高于通用 harness 的 1024，逼近生产（生产不设上限），用于测模型真实大文件输出 */
const MAX_OUTPUT_TOKENS = 16384;

interface SizeSpec { name: string; entries: number; }
/** 递增尺寸：用条目数控制文件规模（每条目约 1 行 + 内容，260 条约 8~10k token，逼近多数模型单次输出上限） */
const SIZES: SizeSpec[] = [
  { name: "S", entries: 40 },
  { name: "M", entries: 120 },
  { name: "L", entries: 260 },
];

/** 强制模型逐条手写大文件（禁止用循环/省略偷懒），用于测"大文件字面量输出"的截断 */
function buildPrompt(entries: number): string {
  return (
    `创建文件 src/menuData.ts，导出一个常量 MENU_ITEMS（数组），里面必须有正好 ${entries} 个菜单项对象，` +
    `逐个手写完整列出。【硬性要求】禁止用循环 / Array.from / map / 展开生成，禁止用 "// ..." 之类省略，` +
    `必须把 ${entries} 个对象字面量全部真实写出来。每个对象格式固定：` +
    `{ id: 1, label: "菜单项 1", path: "/item/1", icon: "icon-1", order: 1 }，` +
    `其中 id 与 order 从 1 递增到 ${entries}，label/path/icon 内的数字同步。请一次性写完整个文件。`
  );
}

/** 真实风格请求：只说要什么，不限制怎么实现（模型可自行选择 create_file / 脚本生成） */
function buildRealisticPrompt(entries: number): string {
  return (
    `创建文件 src/menuData.ts，导出一个常量 MENU_ITEMS（数组），包含 ${entries} 个菜单项，` +
    `每个形如 { id, label, path, icon, order }：id 与 order 从 1 递增到 ${entries}，` +
    `label 为 "菜单项 N"、path 为 "/item/N"、icon 为 "icon-N"（N 为序号）。`
  );
}

/** 用 path: "/item/N" 的出现次数精确统计实际写出的条目数 */
function countEntries(content: string): number {
  return (content.match(/path:\s*["']\/item\//g) || []).length;
}

/** 单轮流式结果：含 finish_reason（截断信号）与累积的工具调用原始参数 */
interface RoundInfo {
  finishReason: string | null;
  toolCalls: { id: string; name: string; args: string }[];
  content: string;
  tokens: number;
}

/** 跑一个 LLM 回合，捕获 finish_reason、工具调用、token；用高 max_tokens 逼近生产 */
async function streamTurn(
  client: OpenAI,
  model: string,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
): Promise<RoundInfo> {
  const stream = (await client.chat.completions.create({
    model, messages, tools, temperature: 0,
    max_tokens: MAX_OUTPUT_TOKENS, stream: true, stream_options: { include_usage: true },
  })) as Stream<ChatCompletionChunk>;

  let content = "";
  let finishReason: string | null = null;
  let tokens = 0;
  const acc: Record<number, { id: string; name: string; args: string }> = {};
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) content += choice.delta.content;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    for (const tc of choice?.delta?.tool_calls ?? []) {
      const i = tc.index ?? 0;
      acc[i] = acc[i] || { id: "", name: "", args: "" };
      if (tc.id) acc[i].id = tc.id;
      if (tc.function?.name) acc[i].name = tc.function.name;
      if (tc.function?.arguments) acc[i].args += tc.function.arguments;
    }
    if (chunk.usage?.total_tokens) tokens = chunk.usage.total_tokens;
  }
  const toolCalls = Object.keys(acc).map(Number).sort((a, b) => a - b).map((i) => acc[i]).filter((t) => t.name);
  return { content, finishReason, toolCalls, tokens };
}

/** 一次 (模型 × 尺寸) 压测的统计指标 */
interface StressMetrics {
  rounds: number;
  createFileCalls: number;
  truncatedRounds: number;   // finish_reason === "length"
  argParseFails: number;     // 工具调用有参数但（经生产同款修复后）仍解析失败 = 被截断
  usedExecCmd: boolean;      // 是否降级到 execute_command 写文件
  maxRoundTokens: number;    // 单轮最大 token 用量（看离上限多近）
  finalEntries: number;
  target: number;
  done: boolean;
  finalReply: string;        // 模型最后给出的文字回复（诊断"没写文件却结束"用）
}

/** 在真实沙箱里把一次大文件生成任务跑到底，收集截断/恢复指标 */
async function runOne(
  client: OpenAI,
  model: string,
  size: SizeSpec,
  tools: ChatCompletionTool[],
  realistic: boolean,
): Promise<StressMetrics> {
  // 播种一个真实的项目结构：避免空沙箱触发模型"目录不存在，要不要新建 src/"的确认式犹豫
  // （那是 create_file 目录确认规则 × 空工作区的测试假象，会掩盖我们真正想测的大文件写入行为）
  const sandbox = await createSandbox({
    "package.json": '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n',
    "src/index.ts": 'export const VERSION = "1.0.0";\n',
  });
  const m: StressMetrics = {
    rounds: 0, createFileCalls: 0, truncatedRounds: 0, argParseFails: 0,
    usedExecCmd: false, maxRoundTokens: 0, finalEntries: 0, target: size.entries, done: false, finalReply: "",
  };
  const prompt = realistic ? buildRealisticPrompt(size.entries) : buildPrompt(size.entries);
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: PRODUCTION_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];
  try {
    for (let round = 0; round < 10; round++) {
      m.rounds = round + 1;
      const turn = await streamTurn(client, model, messages, tools);
      m.maxRoundTokens = Math.max(m.maxRoundTokens, turn.tokens);
      if (turn.finishReason === "length") m.truncatedRounds++;
      if (turn.toolCalls.length === 0) { m.finalReply = turn.content; break; } // 模型给出最终文字回复，结束

      messages.push({
        role: "assistant", content: turn.content || null,
        tool_calls: turn.toolCalls.map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.args } })),
      } as ChatCompletionMessageParam);

      for (const tc of turn.toolCalls) {
        if (tc.name === "create_file") m.createFileCalls++;
        if (tc.name === "execute_command") m.usedExecCmd = true;
        await execOne(tc, sandbox, messages, m);
      }
    }
    const content = (await sandbox.readFinal("src/menuData.ts")) || "";
    m.finalEntries = countEntries(content);
    m.done = m.finalEntries === size.entries;
    return m;
  } finally {
    await sandbox.dispose();
  }
}

/** 执行单个工具调用并回填结果；用生产同款 parseToolArguments 判定参数是否被截断 */
async function execOne(
  tc: { id: string; name: string; args: string },
  sandbox: Awaited<ReturnType<typeof createSandbox>>,
  messages: ChatCompletionMessageParam[],
  m: StressMetrics,
): Promise<void> {
  let args: Record<string, unknown> = {};
  let result: string;
  try {
    args = parseToolArguments(tc.args); // 与生产一致：含 JSON 修复，仍失败即视为被截断
  } catch (err) {
    m.argParseFails++;
    result = `错误: ${(err as Error).message}`;
    messages.push({ role: "tool", tool_call_id: tc.id, content: result } as ChatCompletionMessageParam);
    return;
  }
  try {
    result = await executeToolCall(tc.name, args, sandbox.root, sandbox.host, {}, [sandbox.root]);
  } catch (err) {
    result = `错误: ${(err as Error).message}`;
  }
  messages.push({ role: "tool", tool_call_id: tc.id, content: result.length > 2000 ? result.slice(0, 2000) + "\n[已截断]" : result } as ChatCompletionMessageParam);
}

async function main() {
  const provider = process.env.EVAL_PROVIDER || ESIGN_PROVIDER;
  const apiKey = process.env[`PROVIDER_${provider.toUpperCase()}_API_KEY`];
  const baseUrl = process.env[`PROVIDER_${provider.toUpperCase()}_BASE_URL`] || "";
  if (!apiKey) { console.error(`缺少 PROVIDER_${provider.toUpperCase()}_API_KEY`); process.exit(1); }
  const client = new OpenAI({ apiKey, baseURL: baseUrl || undefined });
  const tools = await buildToolsForVariant({ id: "baseline", label: "" } as never);

  const idx = process.argv.indexOf("--variants");
  const models = idx >= 0 ? process.argv[idx + 1].split(",") : MODEL_VARIANTS.map((v) => v.id);
  const realistic = process.argv.includes("--realistic");
  const sIdx = process.argv.indexOf("--sizes");
  const sizes = sIdx >= 0 ? SIZES.filter((s) => process.argv[sIdx + 1].split(",").includes(s.name)) : SIZES;

  console.log(`🔥 大文件生成压测（max_tokens=${MAX_OUTPUT_TOKENS}，逼近生产无上限）`);
  console.log(`   模型: ${models.join(", ")}　提示模式: ${realistic ? "realistic(不限实现)" : "forbid-script(强制逐条手写)"}\n`);

  for (const size of sizes) {
    console.log(`\n══ 尺寸 ${size.name}：${size.entries} 条目（约 ${Math.round(size.entries * 3.5)} 行）══`);
    for (const model of models) {
      try {
        const m = await runOne(client, model, size, tools, realistic);
        const verdict = m.done ? "✅ 写全" : `❌ 缺失(${m.finalEntries}/${m.target})`;
        console.log(
          `  ▶ ${model.padEnd(16)} 轮=${m.rounds} create_file=${m.createFileCalls} ` +
          `截断(length)=${m.truncatedRounds} 参数截断=${m.argParseFails} ` +
          `降级命令=${m.usedExecCmd ? "是" : "否"} 单轮峰值token=${m.maxRoundTokens} → ${verdict}`,
        );
        if (!m.done && m.finalReply) {
          console.log(`        模型回复: ${m.finalReply.replace(/\s+/g, " ").slice(0, 200)}`);
        }
      } catch (err) {
        console.log(`  ▶ ${model.padEnd(16)} 💥 运行异常: ${err instanceof Error ? err.message.slice(0, 140) : String(err)}`);
      }
    }
  }
  console.log("\n说明：截断(length)>0 或 参数截断>0 即出现了真实截断；done=写全 表示模型最终把文件补完整。");
}

main().catch((e) => { console.error("💥 大文件压测异常:", e); process.exit(1); });
