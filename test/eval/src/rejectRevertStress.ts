/**
 * 拒绝回滚（reject → revert）严格测试 —— 数据安全级
 *
 * 背景：手动确认模式下，工具改动会"先落盘 + 标记待确认"。用户点【拒绝】时，必须把
 * 磁盘文件回滚到改动前的原始内容（新文件则删除）。如果拒绝后文件没回滚，等于用户的
 * "拒绝"被无视、改动被偷偷保留——这是数据安全级的致命问题。
 *
 * 本测试走【生产同款代码路径】：真实 NodeAgentHost(manual) + executeToolCall + host.edits，
 * 并【忠实复刻 agentSession 的拒绝逻辑】（前端回传 getPendingPaths() 的相对路径，
 * agentSession 用 resolve(cwd, relPath) 定位后调用 host.edits.reject(abs)）。
 *
 * 覆盖三类路径解析场景（这正是真实项目里模型给路径的常见形态）：
 *   A. 精确路径：模型给的路径正好是 cwd 相对（对照组，应当通过）
 *   B. basename 兜底：模型给 "x.ts"，文件实际在 "src/.../x.ts"（resolveInWorkspaces 兜底命中）
 *   C. 多根工作区：文件在非主工作区（resolveInWorkspaces 命中第二个 root）
 *
 * 另含一个【真实模型】端到端用例：让模型在 manual 沙箱里改文件，再整体拒绝，校验全部回滚。
 *
 * 运行：npm run stress:reject
 *      npm run stress:reject -- --variants gpt-5.5
 */

import "dotenv/config";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createNodeAgentHost } from "@axon/host-node";
import { executeToolCall, parseToolArguments, ESIGN_PROVIDER, type AgentHost } from "@axon/core";
import { buildToolsForVariant } from "./toolset.ts";
import { PRODUCTION_SYSTEM_PROMPT } from "./prompts.ts";
import { MODEL_VARIANTS } from "./models.ts";

// ── 工具：临时目录 / 读写 ───────────────────────────────────────────────
async function mkRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "axon-reject-"));
}
async function seed(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf-8");
}
async function readOrNull(abs: string): Promise<string | null> {
  try { return await readFile(abs, "utf-8"); } catch { return null; }
}

/**
 * 忠实复刻【修复后】agentSession.rejectEdits 的逐文件拒绝：
 * 前端回传 getPendingPaths()（相对路径），agentSession 直接把该 path 交给 host.edits.reject，
 * 由 presenter 按 e.path / absPath 匹配（不再 resolve(cwd, path) 重解析）。
 */
async function productionRejectAll(host: AgentHost, _cwd: string): Promise<string[]> {
  const pendingRel = host.edits.getPendingPaths();
  const rejected: string[] = [];
  for (const rel of pendingRel) {
    const r = await host.edits.reject(rel); // ← 修复后：直接传相对 path
    rejected.push(...r);
  }
  return rejected;
}

interface Case {
  name: string;
  cwd: string;
  workspaces: string[];
  /** 每个被改文件：绝对路径 → 原始内容（用于回滚后比对） */
  originals: { abs: string; original: string | null }[];
  /** 改动前的"反向断言串"：拒绝回滚后，这些字符串应当【重新出现】（原内容标志） */
  mustRestore: { abs: string; needle: string }[];
  /** 改动引入的新串：拒绝回滚后，这些串应当【消失】 */
  mustVanish: { abs: string; needle: string }[];
}

interface CaseResult { name: string; passed: boolean; detail: string; }

/** 单个确定性用例：建沙箱 → manual 改动 → 生产式拒绝 → 校验回滚 */
async function runDeterministicCase(
  build: () => Promise<{ host: AgentHost; cwd: string; workspaces: string[]; edits: () => Promise<void>; spec: Omit<Case, "cwd" | "workspaces"> }>,
): Promise<CaseResult> {
  const { host, cwd, workspaces, edits, spec } = await build();
  try {
    await edits();
    // 改动应已落盘
    await productionRejectAll(host, cwd);

    const fails: string[] = [];
    for (const o of spec.originals) {
      const now = await readOrNull(o.abs);
      if (now !== o.original) {
        fails.push(`未回滚: ${o.abs}\n   期望(原始)=${JSON.stringify((o.original ?? "<删除>").slice(0, 60))}\n   实际=${JSON.stringify((now ?? "<不存在>").slice(0, 60))}`);
      }
    }
    for (const r of spec.mustVanish) {
      const now = (await readOrNull(r.abs)) ?? "";
      if (now.includes(r.needle)) fails.push(`改动残留(应消失): ${r.abs} 仍含 "${r.needle}"`);
    }
    return { name: spec.name, passed: fails.length === 0, detail: fails.join("\n   ") || "回滚正确" };
  } finally {
    for (const ws of new Set(workspaces)) await rm(ws, { recursive: true, force: true });
  }
}

const ORIG_A = `export const RATE = 3;\nexport function calc(x: number) {\n  return x * RATE;\n}\n`;

/** A. 精确路径（对照组）：文件在 cwd 根，模型给 cwd 相对路径 */
async function caseA(): Promise<CaseResult> {
  return runDeterministicCase(async () => {
    const root = await mkRoot();
    await seed(root, "calc.ts", ORIG_A);
    const host = createNodeAgentHost();
    host.edits.setMode("manual");
    const abs = join(root, "calc.ts");
    return {
      host, cwd: root, workspaces: [root],
      edits: async () => {
        await executeToolCall("str_replace", { path: "calc.ts", oldStr: "export const RATE = 3;", newStr: "export const RATE = 999;" }, root, host, {}, [root]);
      },
      spec: { name: "A. 精确路径(对照组)", originals: [{ abs, original: ORIG_A }], mustRestore: [{ abs, needle: "RATE = 3" }], mustVanish: [{ abs, needle: "RATE = 999" }] },
    };
  });
}

/** B. basename 兜底：文件在子目录，模型只给文件名 */
async function caseB(): Promise<CaseResult> {
  return runDeterministicCase(async () => {
    const root = await mkRoot();
    await seed(root, "src/services/api/relativeParty.ts", ORIG_A);
    const host = createNodeAgentHost();
    host.edits.setMode("manual");
    const abs = join(root, "src/services/api/relativeParty.ts");
    return {
      host, cwd: root, workspaces: [root],
      edits: async () => {
        // 模型只给 basename，resolveInWorkspaces 兜底命中深层文件
        await executeToolCall("str_replace", { path: "relativeParty.ts", oldStr: "export const RATE = 3;", newStr: "export const RATE = 999;" }, root, host, {}, [root]);
      },
      spec: { name: "B. basename 兜底解析", originals: [{ abs, original: ORIG_A }], mustRestore: [{ abs, needle: "RATE = 3" }], mustVanish: [{ abs, needle: "RATE = 999" }] },
    };
  });
}

/** C. 多根工作区：文件在第二个 root，cwd 是第一个 root */
async function caseC(): Promise<CaseResult> {
  return runDeterministicCase(async () => {
    const rootA = await mkRoot();
    const rootB = await mkRoot();
    await seed(rootB, "config.ts", ORIG_A);
    const host = createNodeAgentHost();
    host.edits.setMode("manual");
    const abs = join(rootB, "config.ts");
    return {
      host, cwd: rootA, workspaces: [rootA, rootB],
      edits: async () => {
        // 文件在 rootB，模型给相对名；resolveInWorkspaces 命中 rootB
        await executeToolCall("str_replace", { path: "config.ts", oldStr: "export const RATE = 3;", newStr: "export const RATE = 999;" }, rootA, host, {}, [rootA, rootB]);
      },
      spec: { name: "C. 多根工作区(非主 root)", originals: [{ abs, original: ORIG_A }], mustRestore: [{ abs, needle: "RATE = 3" }], mustVanish: [{ abs, needle: "RATE = 999" }] },
    };
  });
}

/** D. apply_patch 多文件 + basename：补丁一次改多个深层文件 */
async function caseD(): Promise<CaseResult> {
  return runDeterministicCase(async () => {
    const root = await mkRoot();
    await seed(root, "src/a/foo.ts", ORIG_A);
    await seed(root, "src/b/bar.ts", ORIG_A);
    const host = createNodeAgentHost();
    host.edits.setMode("manual");
    const absFoo = join(root, "src/a/foo.ts");
    const absBar = join(root, "src/b/bar.ts");
    const patch = [
      "*** Begin Patch",
      "*** Update File: foo.ts",
      "@@",
      "-export const RATE = 3;",
      "+export const RATE = 111;",
      "*** Update File: bar.ts",
      "@@",
      "-export const RATE = 3;",
      "+export const RATE = 222;",
      "*** End Patch",
    ].join("\n");
    return {
      host, cwd: root, workspaces: [root],
      edits: async () => { await executeToolCall("apply_patch", { patch }, root, host, {}, [root]); },
      spec: {
        name: "D. apply_patch 多文件 basename",
        originals: [{ abs: absFoo, original: ORIG_A }, { abs: absBar, original: ORIG_A }],
        mustRestore: [{ abs: absFoo, needle: "RATE = 3" }, { abs: absBar, needle: "RATE = 3" }],
        mustVanish: [{ abs: absFoo, needle: "RATE = 111" }, { abs: absBar, needle: "RATE = 222" }],
      },
    };
  });
}

// ── 真实模型端到端：manual 沙箱里让模型改文件，再整体拒绝，校验全部回滚 ──
const RM_FILE = "src/order/orderService.ts";
const RM_ORIG = `export const MAX_RETRIES = 3;\nexport const PAGE_SIZE = 20;\nexport function ok() { return true; }\n`;
const RM_TASK = `请把 src/order/orderService.ts 里的 MAX_RETRIES 改成 5，PAGE_SIZE 改成 50。只改这两个常量，别动其它。`;

async function runRealModel(client: OpenAI, model: string, tools: ChatCompletionTool[]): Promise<CaseResult> {
  const root = await mkRoot();
  await seed(root, RM_FILE, RM_ORIG);
  const host = createNodeAgentHost();
  host.edits.setMode("manual");
  const abs = join(root, RM_FILE);
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: PRODUCTION_SYSTEM_PROMPT },
    { role: "user", content: RM_TASK },
  ];
  try {
    let edited = false;
    for (let round = 0; round < 8; round++) {
      const resp = await client.chat.completions.create({ model, messages, tools, tool_choice: "auto" });
      const msg = resp.choices[0]?.message;
      if (!msg) break;
      const toolCalls = msg.tool_calls || [];
      if (toolCalls.length === 0) break;
      messages.push({ role: "assistant", content: msg.content || null, tool_calls: toolCalls } as ChatCompletionMessageParam);
      for (const tc of toolCalls) {
        let result: string;
        try {
          const args = parseToolArguments(tc.function.arguments);
          if (tc.function.name === "str_replace" || tc.function.name === "create_file" || tc.function.name === "apply_patch") edited = true;
          result = await executeToolCall(tc.function.name, args, root, host, {}, [root]);
        } catch (err) { result = `错误: ${(err as Error).message}`; }
        messages.push({ role: "tool", tool_call_id: tc.id, content: result.slice(0, 1200) } as ChatCompletionMessageParam);
      }
    }
    if (!edited || !host.edits.hasPending()) {
      return { name: `真实模型(${model})`, passed: false, detail: "模型未产生待确认改动，无法验证拒绝回滚" };
    }
    // 用户拒绝全部 → 校验回滚
    await productionRejectAll(host, root);
    const now = (await readOrNull(abs)) ?? "";
    const reverted = now === RM_ORIG;
    const detail = reverted ? "拒绝后已完整回滚到原始内容" : `未回滚！实际内容:\n   ${JSON.stringify(now.slice(0, 120))}`;
    return { name: `真实模型(${model})`, passed: reverted, detail };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  console.log("🛡  拒绝回滚（reject → revert）严格测试\n");

  // 1) 确定性用例（无需模型，100% 可复现）
  const det = [await caseA(), await caseB(), await caseC(), await caseD()];
  let anyFail = false;
  console.log("【确定性用例 · 真实 host.edits + 生产拒绝路径】");
  for (const r of det) {
    const tag = r.passed ? "✅ 通过" : "❌ 失败";
    if (!r.passed) anyFail = true;
    console.log(`  ${tag}  ${r.name}\n   ${r.detail}`);
  }

  // 2) 真实模型端到端（可选；缺 key 时跳过）
  const provider = process.env.EVAL_PROVIDER || ESIGN_PROVIDER;
  const apiKey = process.env[`PROVIDER_${provider.toUpperCase()}_API_KEY`];
  const baseUrl = process.env[`PROVIDER_${provider.toUpperCase()}_BASE_URL`] || "";
  if (apiKey) {
    const client = new OpenAI({ apiKey, baseURL: baseUrl || undefined });
    const tools = await buildToolsForVariant({ id: "baseline", label: "" } as never);
    const idx = process.argv.indexOf("--variants");
    const models = idx >= 0 ? process.argv[idx + 1].split(",") : [MODEL_VARIANTS[0].id];
    console.log("\n【真实模型端到端 · manual 改动 → 拒绝 → 校验回滚】");
    for (const model of models) {
      const r = await runRealModel(client, model, tools);
      const tag = r.passed ? "✅ 通过" : "❌ 失败";
      if (!r.passed) anyFail = true;
      console.log(`  ${tag}  ${r.name}\n   ${r.detail}`);
    }
  } else {
    console.log(`\n（跳过真实模型用例：缺少 PROVIDER_${provider.toUpperCase()}_API_KEY）`);
  }

  console.log(`\n${anyFail ? "❌ 存在失败：拒绝后改动未正确回滚（数据安全风险）" : "✅ 全部通过：拒绝后改动均已回滚"}`);
  if (anyFail) process.exit(1);
}

main().catch((e) => { console.error("💥 reject 回滚测试异常:", e); process.exit(1); });
