/**
 * 测试所有模型的 usage 返回情况
 * 用法：node test/usage-test.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");
const { Buffer } = require("node:buffer");

// ── 读配置 ──
let providersJson;
try {
  providersJson = JSON.parse(readFileSync(join(homedir(), ".axon", "settings", "providers.json"), "utf-8"));
} catch {
  console.error("找不到 ~/.axon/settings/providers.json");
  process.exit(1);
}

const axonKey = providersJson.builtinApiKeys?.axon || "";
const axonBaseUrl = (providersJson.builtinBaseUrls?.axon || "https://direct.sunnorthgod.top/v1").replace(/\/+$/, "");

// 自定义 provider 列表
const customProviders = Object.entries(providersJson.providers || {}).map(([name, cfg]) => ({ name, ...cfg }));

// ── 测试模型定义 ──
const TESTS = [];

// Axon 官方（Anthropic 协议）
const axonModels = [
  "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
  "claude-sonnet-5", "claude-sonnet-4-5", "claude-haiku-4-5",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
];
for (const m of axonModels) {
  TESTS.push({ label: `Axon/${m}`, model: m, protocol: "anthropic", baseUrl: axonBaseUrl, headers: { "x-api-key": axonKey, "anthropic-version": "2023-06-01", "content-type": "application/json" } });
}

// 智谱（Chat Completions）- 需要环境变量 PROVIDER_ZHIPU_API_KEY
const zhipuKey = process.env.PROVIDER_ZHIPU_API_KEY || "";
if (zhipuKey) {
  for (const m of ["glm-4-flash", "glm-4-flashx"]) {
    TESTS.push({ label: `Zhipu/${m}`, model: m, protocol: "chat", baseUrl: "https://open.bigmodel.cn/api/paas/v4", headers: { "authorization": `Bearer ${zhipuKey}`, "content-type": "application/json" } });
  }
} else {
  console.log("⚠ 智谱 key 未配置，跳过智谱模型测试\n");
}

// 自定义 provider
for (const prov of customProviders) {
  const key = prov.apiKey || "";
  if (!key) { console.log(`⚠ ${prov.name} key 未配置，跳过\n`); continue; }
  const baseUrl = prov.baseUrl.replace(/\/+$/, "");
  const models = Array.isArray(prov.models) ? prov.models : [];
  for (const m of models) {
    const id = m.id || m.name;
    if (!id) continue;
    const protocol = m.protocol || prov.protocol || "chat";
    const headers = { "authorization": `Bearer ${key}`, "content-type": "application/json" };
    TESTS.push({ label: `${prov.name}/${id}`, model: id, protocol, baseUrl, headers });
  }
}

console.log(`共 ${TESTS.length} 个模型待测试\n`);

// ── 通用 SSE 流读取 ──
async function readSSEStream(res, onLine) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") continue;
      try { onLine(JSON.parse(raw)); } catch { /* skip parse errors */ }
    }
  }
}

// ── Anthropic SSE 流读取 ──
async function readAnthropicStream(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      let eventType = "", dataLine = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
      }
      if (!eventType || !dataLine) continue;
      try { onEvent(eventType, JSON.parse(dataLine)); } catch { /* skip */ }
    }
  }
}

// ── 测试 Anthropic 协议 ──
async function testAnthropic(model, baseUrl, headers) {
  const url = `${baseUrl}/messages`;
  const body = { model, max_tokens: 10, messages: [{ role: "user", content: "Hi" }], stream: true };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };

  let inputTokens = 0, outputTokens = 0, totalTokens = 0;
  const source = [];
  await readAnthropicStream(res, (eventType, data) => {
    if (eventType === "message_start" && data.message?.usage) {
      inputTokens = data.message.usage.input_tokens || 0;
      outputTokens = data.message.usage.output_tokens || 0;
      totalTokens = inputTokens + outputTokens;
      source.push("message_start");
    }
    if (eventType === "message_delta" && data.usage) {
      outputTokens += data.usage.output_tokens || 0;
      totalTokens = inputTokens + outputTokens;
      source.push("message_delta");
    }
  });
  return { ok: true, inputTokens, outputTokens, totalTokens, source: [...new Set(source)] };
}

// ── 测试 Chat Completions ──
async function testChat(model, baseUrl, headers) {
  const url = `${baseUrl}/chat/completions`;
  const body = { model, messages: [{ role: "user", content: "Hi" }], stream: true, stream_options: { include_usage: true } };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status} - ${errText.slice(0, 200)}` };
  }

  let inputTokens = 0, outputTokens = 0, totalTokens = 0;
  const source = [];
  await readSSEStream(res, (chunk) => {
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens || 0;
      outputTokens = chunk.usage.completion_tokens || 0;
      totalTokens = chunk.usage.total_tokens || (inputTokens + outputTokens);
      source.push("usage_chunk(stream_options)");
    }
  });
  return { ok: true, inputTokens, outputTokens, totalTokens, source: [...new Set(source)] };
}

// ── 测试 Responses API ──
async function testResponses(model, baseUrl, headers) {
  const url = `${baseUrl}/responses`;
  const body = { model, input: "Hi", stream: true, max_output_tokens: 10 };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status} - ${errText.slice(0, 200)}` };
  }

  let inputTokens = 0, outputTokens = 0, totalTokens = 0;
  const source = [];
  await readSSEStream(res, (chunk) => {
    if (chunk.type === "response.completed" && chunk.response?.usage) {
      inputTokens = chunk.response.usage.input_tokens || 0;
      outputTokens = chunk.response.usage.output_tokens || 0;
      totalTokens = chunk.response.usage.total_tokens || (inputTokens + outputTokens);
      source.push("response.completed");
    }
  });
  return { ok: true, inputTokens, outputTokens, totalTokens, source: [...new Set(source)] };
}

// ── 主流程 ──
console.log("═══════════════════════════════════════════════");
console.log(" 模型 Usage 测试");
console.log("═══════════════════════════════════════════════\n");

const results = [];

for (const t of TESTS) {
  const start = Date.now();
  process.stdout.write(`[${t.label}] `);
  try {
    let r;
    if (t.protocol === "anthropic") r = await testAnthropic(t.model, t.baseUrl, t.headers);
    else if (t.protocol === "responses") r = await testResponses(t.model, t.baseUrl, t.headers);
    else r = await testChat(t.model, t.baseUrl, t.headers);

    const ms = Date.now() - start;
    if (r.ok) {
      const hasUsage = r.totalTokens > 0;
      console.log(`${hasUsage ? "✅" : "❌"} input=${r.inputTokens} output=${r.outputTokens} total=${r.totalTokens}  来源=${r.source.join(",") || "无"}  ${ms}ms`);
      results.push({ protocol: t.protocol, hasUsage, inputTokens: r.inputTokens, outputTokens: r.outputTokens, totalTokens: r.totalTokens, source: r.source.join(","), ms });
    } else {
      console.log(`⚠ 失败 ${r.error}  ${ms}ms`);
      results.push({ protocol: t.protocol, hasUsage: false, error: r.error, ms });
    }
  } catch (err) {
    console.log(`✗ 异常 ${err.message}  ${Date.now() - start}ms`);
    results.push({ protocol: t.protocol, hasUsage: false, error: err.message, ms: Date.now() - start });
  }
}

// ── 汇总 ──
console.log("\n═══════════════════════════════════════════════");
console.log(" 汇总");
console.log("═══════════════════════════════════════════════\n");

const withUsage = results.filter(r => r.hasUsage);
const withoutUsage = results.filter(r => !r.hasUsage);

console.log("✅ 有 usage 的模型：");
if (withUsage.length === 0) console.log("  （无）");
for (const r of withUsage) {
  console.log(`  ${r.protocol} — ${r.totalTokens} tokens (来源: ${r.source})`);
}

console.log("\n❌ 无 usage 的模型：");
if (withoutUsage.length === 0) console.log("  （无）");
for (const r of withoutUsage) {
  console.log(`  ${r.protocol} — ${r.error || "无 usage 返回"}`);
}

writeFileSync("test/usage-report.json", JSON.stringify(results, null, 2), "utf-8");
console.log("\n报告已写入 test/usage-report.json");
