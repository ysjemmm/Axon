/**
 * Eval Harness —— 运行单个评估场景（单次）
 *
 * 给定一个 EvalScenario + 运行配置（model / systemPrompt / tools），调真实 LLM 跑一个 turn：
 * - 构建消息（系统提示 + 工具定义 + 用户消息 + 可选文件上下文）
 * - 调用 LLM，截获工具调用序列和文字回复
 * - 不真正执行工具（只截获模型决策），纯测"模型用工具的判断"
 */

import OpenAI from "openai";
import type { Stream } from "openai/streaming";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { EvalScenario } from "./types.ts";
import { PRODUCTION_SYSTEM_PROMPT, NEUTRAL_SYSTEM_PROMPT } from "./prompts.ts";

/**
 * 默认 eval 系统提示 = 真实生产系统提示。
 * 只有用真实提示词作基线，A/B 才能反映线上真实行为。
 * 需要「裸工具」对照时，变体里显式指定 NEUTRAL_SYSTEM_PROMPT。
 */
export const DEFAULT_EVAL_SYSTEM_PROMPT = PRODUCTION_SYSTEM_PROMPT;
export { NEUTRAL_SYSTEM_PROMPT };

export interface RunConfig {
  model: string;
  systemPrompt: string;
  tools: ChatCompletionTool[];
}

export interface HarnessResult {
  toolCalls: { name: string; args: Record<string, unknown> }[];
  reply: string;
  tokens: number;
  latency: number;
}

/** 判断是否为可重试的瞬时错误（5xx / 流式中断 / 网络） */
function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: number }).status;
  if (typeof status === "number" && status >= 500) return true;
  const msg = (err as { message?: string }).message || "";
  return /stream error|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i.test(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 创建流式响应，对瞬时错误做有限重试（最多 2 次，指数退避） */
export async function createStreamWithRetry(
  client: OpenAI,
  params: Parameters<OpenAI["chat"]["completions"]["create"]>[0],
): Promise<Stream<ChatCompletionChunk>> {
  const maxRetries = 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return (await client.chat.completions.create(params)) as Stream<ChatCompletionChunk>;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && isTransientError(err)) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function runScenario(
  scenario: EvalScenario,
  client: OpenAI,
  config: RunConfig,
): Promise<HarnessResult> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: config.systemPrompt },
    { role: "user", content: scenario.userMessage },
  ];

  // 如果场景提供了文件上下文，注入为系统消息
  if (scenario.files && Object.keys(scenario.files).length > 0) {
    const fileContext = Object.entries(scenario.files)
      .map(([path, content]) => `文件 ${path}:\n\`\`\`\n${content}\n\`\`\``)
      .join("\n\n");
    messages.splice(1, 0, {
      role: "system",
      content: `当前工作区包含以下文件：\n\n${fileContext}`,
    });
  }

  const tools = config.tools.length > 0 ? config.tools : undefined;

  const start = Date.now();
  // 统一用流式：部分中转网关（如 qwen3.6-plus）在非流式响应里不返回 tool_calls，
  // 只有流式增量里才有完整工具调用数据。流式对所有模型都兼容。
  // 对 5xx / 网络类瞬时错误做有限重试：多模型批量跑时网关偶发 500 不应被
  // 当成模型决策失败而拉低平均分。最多重试 2 次，指数退避。
  const stream = await createStreamWithRetry(client, {
    model: config.model,
    messages,
    tools,
    temperature: 0,
    max_tokens: 1024,
    stream: true,
    stream_options: { include_usage: true },
  });

  // 累积流式增量：文字 + 工具调用（按 index 拼接 arguments）
  let replyBuf = "";
  const toolAcc: Record<number, { name: string; args: string }> = {};
  let usageTokens = 0;
  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta || {};
      if (typeof delta.content === "string") replyBuf += delta.content;
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          toolAcc[idx] = toolAcc[idx] || { name: "", args: "" };
          if (tc.function?.name) toolAcc[idx].name = tc.function.name;
          if (tc.function?.arguments) toolAcc[idx].args += tc.function.arguments;
        }
      }
    }
    if (chunk.usage?.total_tokens) usageTokens = chunk.usage.total_tokens;
  }
  const latency = Date.now() - start;

  const toolCalls: { name: string; args: Record<string, unknown> }[] = [];
  for (const idx of Object.keys(toolAcc).map(Number).sort((a, b) => a - b)) {
    const { name, args } = toolAcc[idx];
    if (!name) continue;
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(args || "{}"); } catch { /* 参数不完整时留空 */ }
    toolCalls.push({ name, args: parsed });
  }

  return { toolCalls, reply: replyBuf, tokens: usageTokens, latency };
}
