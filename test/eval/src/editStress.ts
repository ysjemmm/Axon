/**
 * 编辑压测：真实复杂代码文件 + 单文件十几处编辑 + 重复行陷阱。
 * 专测「读完文件后 str_replace 持续失败」这一真实失败模式，并观察模型是否恢复/换策略。
 *
 * 关键产出：每个模型每个场景的 str_replace 调用数 / 失败数 / 失败率 / 是否最终改对 / 是否换策略。
 *
 * 运行：npm run stress:edit
 */

import "dotenv/config";
import OpenAI from "openai";
import { ESIGN_PROVIDER } from "@axon/core";
import { runMultiTurnScenario } from "./multiTurnHarness.ts";
import { buildToolsForVariant } from "./toolset.ts";
import { PRODUCTION_SYSTEM_PROMPT } from "./prompts.ts";
import { MODEL_VARIANTS } from "./models.ts";
import type { MultiTurnScenario } from "./typesMulti.ts";

/** 真实风格 TS 服务文件：嵌套缩进、模板字符串、try/catch、注释、长行——共 14 处 console.log 调用 */
const ORDER_FILE = `import { EventEmitter } from "node:events";

/** 订单处理服务（示例）。日志目前用 console.log，需要统一换成结构化 logger。 */
export class OrderService extends EventEmitter {
  private orders = new Map<string, { amount: number; status: string }>();

  constructor(private readonly gateway: string) {
    super();
    console.log("[OrderService] initialized with gateway:", gateway);
  }

  async createOrder(userId: string, amount: number): Promise<string> {
    if (amount <= 0) {
      console.log(\`[OrderService] reject invalid amount \${amount} for user \${userId}\`);
      throw new Error("amount must be positive");
    }
    const id = \`ord_\${Date.now()}\`;
    this.orders.set(id, { amount, status: "created" });
    console.log("[OrderService] order created:", id, "amount=", amount);
    this.emit("created", id);
    return id;
  }

  async pay(orderId: string): Promise<void> {
    const order = this.orders.get(orderId);
    if (!order) {
      console.log("[OrderService] pay failed, order not found:", orderId);
      throw new Error("order not found");
    }
    try {
      console.log(\`[OrderService] charging \${order.amount} via \${this.gateway}\`);
      order.status = "paid";
      console.log("[OrderService] payment ok for", orderId);
    } catch (err) {
      console.log("[OrderService] payment error:", (err as Error).message);
      order.status = "failed";
      throw err;
    }
  }

  async refund(orderId: string, reason: string): Promise<void> {
    const order = this.orders.get(orderId);
    if (!order) {
      console.log("[OrderService] refund skip, no such order:", orderId);
      return;
    }
    console.log(\`[OrderService] refunding \${orderId}, reason=\${reason}\`);
    order.status = "refunded";
    console.log("[OrderService] refund done:", orderId);
  }

  reconcile(): number {
    let paid = 0;
    for (const [id, order] of this.orders) {
      if (order.status === "paid") {
        paid += order.amount;
        console.log("[OrderService] reconcile counting", id);
      }
    }
    console.log("[OrderService] reconcile total paid =", paid);
    return paid;
  }

  dump(): void {
    console.log("[OrderService] dumping", this.orders.size, "orders");
    for (const [id, order] of this.orders) {
      console.log(\`  - \${id}: \${order.status} (\${order.amount})\`);
    }
  }
}
`;

/** 重复行陷阱：8 行完全相同的 process(data); —— 朴素 str_replace 会触发「出现多次」失败 */
const DUP_FILE = `export function pipeline(data: number[]) {
  process(data);
  process(data);
  process(data);
  process(data);
  process(data);
  process(data);
  process(data);
  process(data);
}

function process(_d: number[]) {}
function processSpecial(_d: number[]) {}
`;

const SCENARIOS: { sc: MultiTurnScenario; verify: (content: string) => { done: boolean; note: string } }[] = [
  {
    sc: {
      id: "stress_replace_all_logs",
      description: "真实文件 14 处 console.log 调用 → this.logger.info",
      userMessage:
        "src/orderService.ts 里到处用 console.log，请把文件里所有 console.log 调用都改成 this.logger.info，" +
        "参数原样保留，注释和其他代码不要动。",
      files: { "src/orderService.ts": ORDER_FILE },
      expected: { finalFiles: { "src/orderService.ts": ["this.logger.info"] } },
      maxRounds: 30,
    },
    verify: (c) => {
      const calls = (c.match(/console\.log\(/g) || []).length;
      const newLogs = (c.match(/this\.logger\.info\(/g) || []).length;
      return { done: calls === 0 && newLogs >= 14, note: `剩余 console.log(=${calls}  新 this.logger.info(=${newLogs}` };
    },
  },
  {
    sc: {
      id: "stress_dup_lines",
      description: "重复行陷阱：把其中一处 process(data) 改成 processSpecial(data)",
      userMessage:
        "src/pipeline.ts 里 pipeline 函数中有 8 行一模一样的 process(data);，请把其中任意一处改成 processSpecial(data);，只改一处，其余 7 处保持不变。",
      files: { "src/pipeline.ts": DUP_FILE },
      expected: { finalFiles: { "src/pipeline.ts": ["processSpecial(data);"] } },
      maxRounds: 30,
    },
    verify: (c) => {
      const normal = (c.match(/ {2}process\(data\);/g) || []).length;
      const special = (c.match(/processSpecial\(data\);/g) || []).length;
      return { done: special === 1 && normal === 7, note: `process(data)=${normal}  processSpecial=${special}` };
    },
  },
];

function analyze(trace: { name: string; ok: boolean; resultPreview: string }[]) {
  const sr = trace.filter((t) => t.name === "str_replace");
  const fails = sr.filter((t) => !t.ok);
  return {
    srTotal: sr.length,
    srFail: fails.length,
    createFile: trace.filter((t) => t.name === "create_file").length,
    usedScript: trace.some((t) => t.name === "execute_command"),
    failMsgs: fails.slice(0, 2).map((f) => f.resultPreview.replace(/\s+/g, " ").slice(0, 130)),
  };
}

async function main() {
  const provider = process.env.EVAL_PROVIDER || ESIGN_PROVIDER;
  const apiKey = process.env[`PROVIDER_${provider.toUpperCase()}_API_KEY`];
  const baseUrl = process.env[`PROVIDER_${provider.toUpperCase()}_BASE_URL`] || "";
  const client = new OpenAI({ apiKey, baseURL: baseUrl || undefined });
  const tools = await buildToolsForVariant({ id: "baseline", label: "" } as never);
  const idx = process.argv.indexOf("--variants");
  const models = idx >= 0 ? process.argv[idx + 1].split(",") : MODEL_VARIANTS.map((v) => v.id);

  for (const { sc, verify } of SCENARIOS) {
    console.log(`\n🔥 ${sc.id} — ${sc.description}`);
    for (const model of models) {
      try {
        const run = await runMultiTurnScenario(sc, client, { model, systemPrompt: PRODUCTION_SYSTEM_PROMPT, tools });
        const a = analyze(run.trace);
        const content = run.finalFileContents[Object.keys(sc.files!)[0]] || "";
        const v = verify(content);
        const rate = a.srTotal ? Math.round((a.srFail / a.srTotal) * 100) : 0;
        console.log(`  ▶ ${model.padEnd(15)} 轮=${run.rounds} str_replace=${a.srTotal} 失败=${a.srFail}(${rate}%) 重写=${a.createFile} 命令=${a.usedScript} → ${v.done ? "✅" : "❌"} ${v.note}`);
        for (const m of a.failMsgs) console.log(`        失败: ${m}`);
      } catch (err) {
        console.log(`  ▶ ${model.padEnd(15)} 💥 运行异常: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
      }
    }
  }
}

main().catch((e) => { console.error("💥 编辑压测异常:", e); process.exit(1); });
