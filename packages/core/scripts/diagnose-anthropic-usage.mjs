#!/usr/bin/env node
/**
 * 上下文占比"重复累加"复现 / 定责脚本。
 *
 * 直连 Anthropic Messages 端点，连续跑 N 个回合（历史逐轮变长），把每回合的原始 usage
 * 字段打出来，并对比两种解释下的上下文占用：
 *
 *   A 相加（Anthropic 原生）  = input_tokens + cache_read + cache_creation
 *   B 包含（OpenAI 式中转）   = max(input_tokens, cache_read + cache_creation)
 *
 * 判读方法（回答"是中转站的问题还是 Axon 的设计 bug"）：
 *
 *   1) cache_read/cache_creation 全程为 0
 *      → 端点行为符合规范（本脚本和 Axon 都不发 cache_control，本就不该有缓存命中）。
 *        占比虚高与 usage 无关，去别处查。
 *
 *   2) cache_read > 0，且 input_tokens 明显 **大于等于** cache_read（≈ 全量 prompt）
 *      → 中转站用的是 OpenAI 语义：input_tokens 已经含了缓存部分。
 *        老代码把两者相加 = 缓存部分算两遍，这就是占比虚高的直接原因。
 *      → 定责：中转站 usage 不符合 Anthropic 规范 + Axon 无条件相加，两边都有份。
 *
 *   3) cache_read > 0，且 input_tokens 很小（几百~几千，只是未命中的尾巴）
 *      → 端点是 Anthropic 原生语义，相加是对的。占比虚高另有原因。
 *
 * 另外脚本会把"老公式"的结果一并打出来（含 message_delta 只回显 cache_read 时的重复累加），
 * 可以直接看到每回合被多算了多少。
 *
 * 用法（key/端点默认自动从 IDE 的 providers.json 读，通常无需任何参数）：
 *   node packages/core/scripts/diagnose-anthropic-usage.mjs
 *   node packages/core/scripts/diagnose-anthropic-usage.mjs --model gpt-5.6-sol --turns 5
 *
 * 参数：
 *   --key    API Key，默认按 IDE 同一套顺序解析：
 *            ~/.axon/settings/providers.json 的 builtinApiKeys.axon → 环境变量
 *            PROVIDER_AXON_API_KEY / AXON_API_KEY
 *   --base   端点，默认取 providers.json 的 builtinBaseUrls.axon，
 *            回退 https://ai.sunnorthgod.top:8443/v1
 *   --model  模型 id，默认 claude-sonnet-5
 *   --turns  回合数，默认 4
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

/** 读用户级 providers.json（与 apps/vscode-extension/src/statusBar.ts 同一套解析顺序） */
function readProvidersJson() {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".axon", "settings", "providers.json"), "utf8"));
  } catch {
    return {};
  }
}
const providersJson = readProvidersJson();
const pick = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");

const apiKey =
  arg("key", "") ||
  pick(providersJson.builtinApiKeys?.axon) ||
  pick(process.env.PROVIDER_AXON_API_KEY) ||
  pick(process.env.AXON_API_KEY);
const keySource = arg("key", "")
  ? "--key 参数"
  : pick(providersJson.builtinApiKeys?.axon)
    ? "~/.axon/settings/providers.json"
    : "环境变量";
const model = arg("model", "claude-sonnet-5");
const baseUrl = (
  arg("base", "") ||
  pick(providersJson.builtinBaseUrls?.axon) ||
  "https://ai.sunnorthgod.top:8443/v1"
).replace(/\/+$/, "");
const turns = Number(arg("turns", "4"));

if (!apiKey) {
  console.error(
    "没找到 Axon 官方 key。请在 IDE 里配置好官方 provider（写入 ~/.axon/settings/providers.json），\n" +
      "或设置环境变量 PROVIDER_AXON_API_KEY，或用 --key <KEY> 传入。",
  );
  process.exit(1);
}

// ── 本地粗估（与 packages/core/src/llm/anthropicUsage.ts 同一套系数）────────────
function isCjk(code) {
  return (
    (code >= 0x3000 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}
function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) if (isCjk(text.charCodeAt(i))) cjk++;
  return Math.ceil(cjk * 0.7 + (text.length - cjk) / 3.6);
}
function estimatePrompt(system, messages) {
  let total = estimateTokens(system);
  for (const m of messages) {
    total += 4;
    total += estimateTokens(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
  }
  return total;
}

// 让 prompt 足够长，跨过各家"最小可缓存长度"（OpenAI 1024 token / Anthropic 1024~2048 token），
// 否则缓存字段恒为 0，什么都判别不出来。
const SYSTEM = "你是一个用于诊断 token 计量的测试助手。请始终只回答一个阿拉伯数字，不要解释。\n"
  + "以下是用于把 prompt 撑过缓存最小长度阈值的填充内容，无实际含义：\n"
  + "上下文窗口计量诊断填充文本。".repeat(300);

/** 跑一个回合，返回原始 usage 事件序列 */
async function runTurn(messages) {
  const body = {
    model,
    max_tokens: 64,
    system: SYSTEM,
    messages,
    stream: true,
  };
  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  /** @type {Array<{event: string, usage: any}>} */
  const usageEvents = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      let eventType = "";
      let dataLine = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
      }
      if (!eventType || !dataLine) continue;
      let data;
      try {
        data = JSON.parse(dataLine);
      } catch {
        continue;
      }
      if (eventType === "message_start" && data.message?.usage) {
        usageEvents.push({ event: "message_start", usage: data.message.usage });
      } else if (eventType === "message_delta" && data.usage) {
        usageEvents.push({ event: "message_delta", usage: data.usage });
      } else if (eventType === "content_block_delta" && data.delta?.type === "text_delta") {
        content += data.delta.text || "";
      }
    }
  }
  return { content, usageEvents };
}

/** 老公式：逐事件"边合并边解释"（重现重复累加） */
function legacyPromptTokens(usageEvents) {
  let usage;
  for (const { event, usage: u } of usageEvents) {
    if (event === "message_start") {
      usage = { promptTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) };
    } else {
      usage = { promptTokens: (u.input_tokens ?? usage?.promptTokens ?? 0) + (u.cache_read_input_tokens ?? 0) };
    }
  }
  return usage?.promptTokens ?? 0;
}

/** 新公式：先合并原始字段（>0 才覆盖），最后解释一次 */
function mergedRaw(usageEvents) {
  const raw = { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
  for (const { usage: u } of usageEvents) {
    if (u.input_tokens > 0) raw.input = u.input_tokens;
    if (u.cache_read_input_tokens > 0) raw.cacheRead = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens > 0) raw.cacheCreation = u.cache_creation_input_tokens;
    if (u.output_tokens > 0) raw.output = u.output_tokens;
  }
  return raw;
}

const pad = (v, n = 9) => String(v).padStart(n);

async function main() {
  console.log(`端点  ${baseUrl}`);
  console.log(`模型  ${model}`);
  console.log(`Key   来自 ${keySource}（末 4 位 ****${apiKey.slice(-4)}）`);
  console.log(`回合  ${turns}（历史逐轮变长；本脚本与 Axon 一样不发 cache_control）\n`);

  const messages = [];
  let prevAdditive = 0;
  let prevInclusive = 0;
  let prevLegacy = 0;

  for (let t = 1; t <= turns; t++) {
    messages.push({ role: "user", content: `第 ${t} 轮。请只回答数字 ${t}。` });
    const { content, usageEvents } = await runTurn(messages);
    messages.push({ role: "assistant", content: content || String(t) });

    const raw = mergedRaw(usageEvents);
    const estimate = estimatePrompt(SYSTEM, messages.slice(0, -1));
    const cacheTotal = raw.cacheRead + raw.cacheCreation;
    const additive = raw.input + cacheTotal;
    const inclusive = Math.max(raw.input, cacheTotal);
    const legacy = legacyPromptTokens(usageEvents);

    console.log(`── 回合 ${t} ────────────────────────────────────────────`);
    for (const e of usageEvents) console.log(`   ${e.event.padEnd(14)} ${JSON.stringify(e.usage)}`);
    console.log(`   本地粗估          ${pad(estimate)}`);
    console.log(`   A 相加（原生）    ${pad(additive)}   Δ较上轮 ${pad(additive - prevAdditive, 7)}`);
    console.log(`   B 包含（中转）    ${pad(inclusive)}   Δ较上轮 ${pad(inclusive - prevInclusive, 7)}`);
    console.log(`   老公式实际上报    ${pad(legacy)}   Δ较上轮 ${pad(legacy - prevLegacy, 7)}`);
    console.log();

    prevAdditive = additive;
    prevInclusive = inclusive;
    prevLegacy = legacy;
  }

  console.log("── 判读 ────────────────────────────────────────────────");
  console.log("cache_read 全程为 0            → usage 正常，占比问题不在这里");
  console.log("cache_read > 0 且 input ≥ cache_read → 中转站用 OpenAI 语义，相加即重复累加（B 才对）");
  console.log("cache_read > 0 且 input 很小   → 端点是 Anthropic 原生语义，相加正确（A 才对）");
  console.log("老公式 > A                     → 与语义无关的实现 bug：delta 回显 cache_read 被累加了两次");
}

main().catch((err) => {
  console.error("诊断失败：", err.message);
  process.exit(1);
});
