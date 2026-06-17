/**
 * apply_patch 真实模型严格测试
 *
 * 场景：给模型一个真实的、~90 行的源文件，要求做 5 处【分散】的精确改动。考察：
 *   1. 模型是否选用 apply_patch（而非整文件 create_file / 一个超大 str_replace）
 *   2. 改动是否【全部正确落地】：新值出现、旧值消失、无关代码完好（没被整文件重写冲掉）
 *   3. 输出 token（output）成本——这是耗时的真正杠杆，apply_patch 应显著低于整文件重写
 *   4. apply_patch 失败重试次数（补丁应用器的健壮性）
 *
 * 走生产同款链路：PRODUCTION_SYSTEM_PROMPT + getToolDefinitions（含 apply_patch）+ 真实沙箱 auto 落盘。
 *
 * 运行：npm run stress:patch
 *      npm run stress:patch -- --variants gpt-5.5,deepseek-v4-pro,glm-5.1
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

const TARGET = "src/orderService.ts";

/** 待编辑的真实源文件（~90 行，多处可改点，含 import/常量/接口/方法/注释/日志） */
const SEED = `import { Logger } from "./logger";
import { Db } from "./db";

/** 订单状态 */
export type OrderStatus = "pending" | "paid" | "shipped" | "done";

/** 重试上限 */
const MAX_RETRIES = 3;
/** 单页默认条数 */
const DEFAULT_PAGE_SIZE = 20;

export interface Order {
  id: string;
  userId: string;
  amount: number;
  status: OrderStatus;
  createdAt: string;
}

export class OrderService {
  private logger = new Logger("OrderService");

  constructor(private db: Db) {}

  /** 按 id 查订单 */
  async getById(id: string): Promise<Order | null> {
    this.logger.info("query order");
    const row = await this.db.queryOne("SELECT * FROM orders WHERE id = ?", [id]);
    return row ? this.toOrder(row) : null;
  }

  /** 分页列出某用户的订单 */
  async listByUser(userId: string, page = 1): Promise<Order[]> {
    const offset = (page - 1) * DEFAULT_PAGE_SIZE;
    const rows = await this.db.query(
      "SELECT * FROM orders WHERE user_id = ? LIMIT ? OFFSET ?",
      [userId, DEFAULT_PAGE_SIZE, offset],
    );
    return rows.map((r) => this.toOrder(r));
  }

  /** 创建订单（带重试） */
  async create(userId: string, amount: number): Promise<Order> {
    let lastErr: unknown;
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const id = await this.db.insert("orders", { userId, amount, status: "pending" });
        return { id, userId, amount, status: "pending", createdAt: new Date().toISOString() };
      } catch (err) {
        lastErr = err;
        this.logger.warn("create order failed, retrying");
      }
    }
    throw lastErr;
  }

  private toOrder(row: Record<string, unknown>): Order {
    return {
      id: String(row.id),
      userId: String(row.user_id),
      amount: Number(row.amount),
      status: row.status as OrderStatus,
      createdAt: String(row.created_at),
    };
  }
}
`;

/** 任务：5 处分散改动 */
const TASK =
  `修改 ${TARGET}，做以下 5 处改动（仅改这些，其它代码保持不变）：\n` +
  `1. 把重试上限 MAX_RETRIES 从 3 改成 5；\n` +
  `2. 把 DEFAULT_PAGE_SIZE 从 20 改成 50；\n` +
  `3. 给 Order 接口新增一个可选字段 remark?: string;（放在 createdAt 之后）；\n` +
  `4. getById 里的日志 this.logger.info("query order") 文案改成 this.logger.info("query order by id")；\n` +
  `5. OrderStatus 类型新增一个 "cancelled" 取值。`;

/** 校验：改动后必须出现的内容 */
const REQUIRED_PRESENT = [
  "MAX_RETRIES = 5",
  "DEFAULT_PAGE_SIZE = 50",
  "remark?: string",
  'this.logger.info("query order by id")',
  '"cancelled"',
];
/** 校验：旧值必须消失 */
const REQUIRED_ABSENT = ["MAX_RETRIES = 3", "DEFAULT_PAGE_SIZE = 20", 'this.logger.info("query order")'];
/** 校验：无关代码必须保留（证明没被整文件重写冲掉/丢内容） */
const PRESERVED = [
  'import { Logger } from "./logger";',
  "async listByUser(userId: string, page = 1)",
  "private toOrder(row: Record<string, unknown>): Order",
  "throw lastErr;",
];

interface RoundInfo {
  finishReason: string | null;
  toolCalls: { id: string; name: string; args: string }[];
  content: string;
  promptTokens: number;
  completionTokens: number;
}

async function streamTurn(client: OpenAI, model: string, messages: ChatCompletionMessageParam[], tools: ChatCompletionTool[]): Promise<RoundInfo> {
  // 对偶发的网关流中断（unexpected EOF 等）做有限重试——这类是中转网关抖动，非模型/逻辑问题
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await streamTurnOnce(client, model, messages, tools);
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message || "";
      if (!/EOF|stream|aborted|ECONN|socket|terminated|premature/i.test(msg)) throw err; // 非流错误不重试
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function streamTurnOnce(client: OpenAI, model: string, messages: ChatCompletionMessageParam[], tools: ChatCompletionTool[]): Promise<RoundInfo> {
  const stream = (await client.chat.completions.create({
    model, messages, tools, temperature: 0, max_tokens: 16384, stream: true, stream_options: { include_usage: true },
  })) as Stream<ChatCompletionChunk>;
  let content = "";
  let finishReason: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
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
    if (chunk.usage) { promptTokens = chunk.usage.prompt_tokens ?? promptTokens; completionTokens = chunk.usage.completion_tokens ?? completionTokens; }
  }
  const toolCalls = Object.keys(acc).map(Number).sort((a, b) => a - b).map((i) => acc[i]).filter((t) => t.name);
  return { content, finishReason, toolCalls, promptTokens, completionTokens };
}

interface Metrics {
  rounds: number;
  toolCounts: Record<string, number>;
  applyPatchFails: number;     // apply_patch 返回失败的次数（重试信号）
  outputTokens: number;        // 累计 completion token（耗时杠杆）
  present: number; absent: number; preserved: number;
  correct: boolean;            // 5 处改动全对 + 无关代码完好
  usedApplyPatch: boolean;
}

async function runOne(client: OpenAI, model: string, tools: ChatCompletionTool[]): Promise<Metrics> {
  const sandbox = await createSandbox({ "package.json": '{\n  "name": "demo"\n}\n', [TARGET]: SEED });
  const m: Metrics = { rounds: 0, toolCounts: {}, applyPatchFails: 0, outputTokens: 0, present: 0, absent: 0, preserved: 0, correct: false, usedApplyPatch: false };
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: PRODUCTION_SYSTEM_PROMPT },
    { role: "user", content: TASK },
  ];
  try {
    for (let round = 0; round < 12; round++) {
      m.rounds = round + 1;
      const turn = await streamTurn(client, model, messages, tools);
      m.outputTokens += turn.completionTokens;
      if (turn.toolCalls.length === 0) break;
      messages.push({
        role: "assistant", content: turn.content || null,
        tool_calls: turn.toolCalls.map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.args } })),
      } as ChatCompletionMessageParam);
      for (const tc of turn.toolCalls) {
        m.toolCounts[tc.name] = (m.toolCounts[tc.name] || 0) + 1;
        if (tc.name === "apply_patch") m.usedApplyPatch = true;
        let result: string;
        try {
          const args = parseToolArguments(tc.args);
          result = await executeToolCall(tc.name, args, sandbox.root, sandbox.host, {}, [sandbox.root]);
        } catch (err) {
          result = `错误: ${(err as Error).message}`;
          if (tc.name === "apply_patch") m.applyPatchFails++;
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: result.length > 1500 ? result.slice(0, 1500) + "\n[已截断]" : result } as ChatCompletionMessageParam);
      }
    }
    const final = (await sandbox.readFinal(TARGET)) || "";
    m.present = REQUIRED_PRESENT.filter((s) => final.includes(s)).length;
    m.absent = REQUIRED_ABSENT.filter((s) => !final.includes(s)).length;
    m.preserved = PRESERVED.filter((s) => final.includes(s)).length;
    m.correct = m.present === REQUIRED_PRESENT.length && m.absent === REQUIRED_ABSENT.length && m.preserved === PRESERVED.length;
    return m;
  } finally {
    await sandbox.dispose();
  }
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

  console.log("🔧 apply_patch 真实模型严格测试（5 处分散改动）");
  console.log(`   模型: ${models.join(", ")}\n`);
  let anyFail = false;
  for (const model of models) {
    try {
      const m = await runOne(client, model, tools);
      const toolStr = Object.entries(m.toolCounts).map(([k, v]) => `${k}×${v}`).join(" ") || "无";
      const verdict = m.correct ? "✅ 全对" : `❌ 改动(${m.present}/${REQUIRED_PRESENT.length}) 旧值清除(${m.absent}/${REQUIRED_ABSENT.length}) 保留(${m.preserved}/${PRESERVED.length})`;
      if (!m.correct) anyFail = true;
      console.log(
        `  ▶ ${model.padEnd(16)} 轮=${m.rounds} 工具[${toolStr}] ` +
        `apply_patch=${m.usedApplyPatch ? "用了" : "没用"} 补丁失败重试=${m.applyPatchFails} ` +
        `输出token=${m.outputTokens} → ${verdict}`,
      );
    } catch (err) {
      anyFail = true;
      console.log(`  ▶ ${model.padEnd(16)} 💥 异常: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`);
    }
  }
  console.log("\n说明：理想结果=用了 apply_patch、全对、输出token 远低于整文件重写（~900 字符 ≈ 350 token）。");
  if (anyFail) process.exit(1);
}

main().catch((e) => { console.error("💥 apply_patch 压测异常:", e); process.exit(1); });
