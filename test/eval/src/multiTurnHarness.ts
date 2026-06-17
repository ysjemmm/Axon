/**
 * 多轮 harness —— 在真实沙箱里把一个任务跑到底
 *
 * 每轮调 LLM，截获工具调用 → 用 executeToolCall 真正执行（作用于沙箱）→ 结果回填 →
 * 直到模型不再调工具或到轮次上限。全程记录工具轨迹、轮次、延迟、token。
 */

import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { Stream } from "openai/streaming";
import { executeToolCall } from "@axon/core";
import { createStreamWithRetry } from "./harness.ts";
import { createSandbox } from "./sandbox.ts";
import type { MultiTurnScenario, MultiTurnRunResult, ToolTraceEntry } from "./typesMulti.ts";

export interface MultiTurnConfig {
  model: string;
  systemPrompt: string;
  tools: ChatCompletionTool[];
}

interface TurnOutput {
  content: string;
  toolCalls: { id: string; name: string; args: string }[];
  tokens: number;
}

/** 跑一个 LLM 回合，累积流式增量为文字 + 工具调用（带 id）。对瞬时流式错误做有限重试。 */
async function runTurn(
  client: OpenAI,
  config: MultiTurnConfig,
  messages: ChatCompletionMessageParam[],
): Promise<TurnOutput> {
  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await runTurnOnce(client, config, messages);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const transient = /unexpected EOF|upstream_error|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed|stream error/i.test(msg)
        || ((err as { status?: number }).status ?? 0) >= 500;
      if (attempt < MAX_RETRIES && transient) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

async function runTurnOnce(
  client: OpenAI,
  config: MultiTurnConfig,
  messages: ChatCompletionMessageParam[],
): Promise<TurnOutput> {
  const stream = (await createStreamWithRetry(client, {
    model: config.model,
    messages,
    tools: config.tools.length > 0 ? config.tools : undefined,
    temperature: 0,
    max_tokens: 1024,
    stream: true,
    stream_options: { include_usage: true },
  })) as Stream<ChatCompletionChunk>;

  let content = "";
  const acc: Record<number, { id: string; name: string; args: string }> = {};
  let tokens = 0;
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) content += delta.content;
    for (const tc of delta?.tool_calls ?? []) {
      const i = tc.index ?? 0;
      acc[i] = acc[i] || { id: "", name: "", args: "" };
      if (tc.id) acc[i].id = tc.id;
      if (tc.function?.name) acc[i].name = tc.function.name;
      if (tc.function?.arguments) acc[i].args += tc.function.arguments;
    }
    if (chunk.usage?.total_tokens) tokens = chunk.usage.total_tokens;
  }

  const toolCalls = Object.keys(acc)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => acc[i])
    .filter((t) => t.name);
  return { content, toolCalls, tokens };
}

/** 把一次工具调用执行并回填到 messages，返回轨迹记录 */
async function execAndRecord(
  tc: { id: string; name: string; args: string },
  round: number,
  root: string,
  host: Parameters<typeof executeToolCall>[3],
  messages: ChatCompletionMessageParam[],
): Promise<ToolTraceEntry> {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(tc.args || "{}"); } catch { /* 参数不完整留空 */ }

  let result: string;
  let ok = true;
  try {
    result = await executeToolCall(tc.name, args, root, host, {}, [root]);
  } catch (err) {
    result = `错误: ${err instanceof Error ? err.message : String(err)}`;
    ok = false;
  }

  messages.push({
    role: "tool",
    tool_call_id: tc.id,
    content: result.length > 4000 ? result.slice(0, 4000) + "\n[已截断]" : result,
  } as ChatCompletionMessageParam);

  return { round, name: tc.name, args, ok, resultPreview: result.slice(0, 200) };
}

/** 在沙箱里把一个多轮场景跑到底 */
export async function runMultiTurnScenario(
  scenario: MultiTurnScenario,
  client: OpenAI,
  config: MultiTurnConfig,
): Promise<MultiTurnRunResult> {
  const sandbox = await createSandbox(scenario.files);
  const maxRounds = scenario.maxRounds ?? 8;
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: scenario.userMessage },
  ];
  const trace: ToolTraceEntry[] = [];
  let finalReply = "";
  let tokens = 0;
  let rounds = 0;
  const start = Date.now();

  try {
    for (let round = 0; round < maxRounds; round++) {
      rounds = round + 1;
      const turn = await runTurn(client, config, messages);
      tokens += turn.tokens;

      if (turn.toolCalls.length === 0) {
        finalReply = turn.content;
        break;
      }

      messages.push({
        role: "assistant",
        content: turn.content || null,
        tool_calls: turn.toolCalls.map((tc) => ({
          id: tc.id, type: "function" as const,
          function: { name: tc.name, arguments: tc.args },
        })),
      } as ChatCompletionMessageParam);

      for (const tc of turn.toolCalls) {
        trace.push(await execAndRecord(tc, round + 1, sandbox.root, sandbox.host, messages));
      }
    }

    const finalFileContents: Record<string, string | null> = {};
    const paths = new Set<string>([
      ...Object.keys(scenario.expected.finalFiles ?? {}),
      ...(scenario.expected.absentFiles ?? []),
    ]);
    for (const p of paths) finalFileContents[p] = await sandbox.readFinal(p);

    return { trace, finalReply, rounds, latency: Date.now() - start, tokens, finalFileContents };
  } finally {
    await sandbox.dispose();
  }
}
