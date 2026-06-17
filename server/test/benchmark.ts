/**
 * Axon Agent 基准测试
 *
 * 测试项：
 *   1. 短期记忆 — 多轮对话中能否记住之前的信息
 *   2. 工具调用 — 能否正确调用工具并返回结果
 *   3. 上下文累积 — 多轮对话后 token 用量是否正常增长
 *
 * 运行方式：npx tsx test/benchmark.ts
 */

import "dotenv/config";
import OpenAI from "openai";
import { executeToolCall, getToolDefinitions } from "../src/tools.js";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

// ── 配置 ─────────────────────────────────────────────────────────────────────

const CONFIG = {
  apiKey: process.env.LLM_API_KEY || "",
  baseUrl: process.env.LLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
  model: process.env.LLM_MODEL || "glm-4-plus",
};

const CWD = process.env.WORKSPACE_DIR || process.cwd();

if (!CONFIG.apiKey) {
  console.error("❌ 请设置 LLM_API_KEY 环境变量");
  process.exit(1);
}

const client = new OpenAI({ apiKey: CONFIG.apiKey, baseURL: CONFIG.baseUrl });

// ── 测试工具 ─────────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
  tokensUsed?: number;
}

async function runAgentLoop(
  messages: ChatCompletionMessageParam[],
  maxRounds = 5,
): Promise<{ messages: ChatCompletionMessageParam[]; finalContent: string; totalTokens: number }> {
  let totalTokens = 0;

  for (let i = 0; i < maxRounds; i++) {
    const response = await client.chat.completions.create({
      model: CONFIG.model,
      messages,
      tools: getToolDefinitions() as ChatCompletionTool[],
    });

    totalTokens += response.usage?.total_tokens || 0;
    const choice = response.choices[0];
    if (!choice?.message) break;

    messages.push(choice.message);

    if (!choice.message.tool_calls?.length) {
      return { messages, finalContent: choice.message.content || "", totalTokens };
    }

    for (const tc of choice.message.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      let result: string;
      try {
        result = await executeToolCall(tc.function.name, args, CWD);
      } catch (err) {
        result = `错误: ${(err as Error).message}`;
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }

  return { messages, finalContent: "(超过最大轮次)", totalTokens };
}

// ── 测试用例 ─────────────────────────────────────────────────────────────────

async function testMemoryBasic(): Promise<TestResult> {
  const name = "短期记忆 - 基础";
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: "你是一个助手，直接回答问题。" },
    { role: "user", content: "我的名字叫张三，我今年25岁，我住在杭州。记住这些信息。" },
  ];

  const r1 = await runAgentLoop([...messages]);
  messages.push({ role: "assistant", content: r1.finalContent });
  messages.push({ role: "user", content: "我叫什么名字？我住在哪里？" });

  const r2 = await runAgentLoop([...messages]);

  const passed = r2.finalContent.includes("张三") && r2.finalContent.includes("杭州");
  return {
    name,
    passed,
    detail: passed
      ? `正确回答: ${r2.finalContent.slice(0, 100)}`
      : `回答中未包含'张三'或'杭州': ${r2.finalContent.slice(0, 100)}`,
    tokensUsed: r2.totalTokens,
  };
}

async function testMemoryMultiTurn(): Promise<TestResult> {
  const name = "短期记忆 - 多轮累积";
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: "你是一个助手，直接回答问题。" },
  ];

  // 分 3 轮告诉信息
  const facts = [
    { input: "我养了一只猫，名字叫豆豆。", key: "豆豆" },
    { input: "我的工作是后端工程师，用 Java。", key: "Java" },
    { input: "我最喜欢的食物是螺蛳粉。", key: "螺蛳粉" },
  ];

  for (const fact of facts) {
    messages.push({ role: "user", content: fact.input });
    const r = await runAgentLoop([...messages]);
    messages.push({ role: "assistant", content: r.finalContent });
  }

  // 提问
  messages.push({ role: "user", content: "我的猫叫什么？我用什么编程语言？我喜欢吃什么？" });
  const final = await runAgentLoop([...messages]);

  const allFound = facts.every((f) => final.finalContent.includes(f.key));
  return {
    name,
    passed: allFound,
    detail: allFound
      ? `正确回忆所有信息`
      : `回答: ${final.finalContent.slice(0, 150)}`,
    tokensUsed: final.totalTokens,
  };
}

async function testToolCall(): Promise<TestResult> {
  const name = "工具调用 - 执行命令";
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: "你是一个助手，使用 Windows PowerShell 命令。" },
    { role: "user", content: "用命令告诉我当前目录下有哪些文件夹" },
  ];

  const r = await runAgentLoop(messages);
  // 模型调用了工具（messages 中有 tool role）并最终给出了回复
  const calledTool = r.messages.some((m) => m.role === "tool");
  const hasContent = r.finalContent.length > 0;
  const passed = calledTool && hasContent;

  return {
    name,
    passed,
    detail: passed
      ? `成功调用工具并返回结果`
      : `calledTool=${calledTool}, hasContent=${hasContent}: ${r.finalContent.slice(0, 100)}`,
    tokensUsed: r.totalTokens,
  };
}

async function testTokenGrowth(): Promise<TestResult> {
  const name = "上下文累积 - Token 增长";
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: "你是一个助手。" },
  ];

  const tokenCounts: number[] = [];

  for (let i = 0; i < 5; i++) {
    messages.push({ role: "user", content: `这是第 ${i + 1} 轮对话，请简短回复。` });
    const r = await runAgentLoop([...messages]);
    messages.push({ role: "assistant", content: r.finalContent });
    tokenCounts.push(r.totalTokens);
  }

  // Token 应该逐轮递增（因为历史越来越长）
  const isGrowing = tokenCounts.every((t, i) => i === 0 || t >= tokenCounts[i - 1]);
  return {
    name,
    passed: isGrowing,
    detail: `各轮 token: ${tokenCounts.join(" → ")}`,
    tokensUsed: tokenCounts[tokenCounts.length - 1],
  };
}

async function testCompaction(): Promise<TestResult> {
  const name = "无感压缩 - 压缩后仍能回忆关键信息";

  // 模拟：构建一堆历史消息，压缩后验证关键信息保留
  const { compactMessages } = await import("../src/compactor.js");

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: "你是一个助手。" },
    { role: "user", content: "我叫李明，我在阿里巴巴工作，用 Java 开发。" },
    { role: "assistant", content: "你好李明！了解了你的背景。" },
    { role: "user", content: "帮我创建一个 hello.txt 文件" },
    { role: "assistant", content: "好的，已创建。" },
    { role: "user", content: "我的项目叫 Axon，是一个 AI IDE。" },
    { role: "assistant", content: "了解，Axon 是你的 AI IDE 项目。" },
    { role: "user", content: "帮我查看 server 目录" },
    { role: "assistant", content: "server 目录下有 src、test、package.json 等。" },
    // 这些是"最近"的消息，会被保留原文
    { role: "user", content: "帮我写一个排序算法" },
    { role: "assistant", content: "好的，这是一个快速排序的实现..." },
    { role: "user", content: "改成冒泡排序" },
    { role: "assistant", content: "好的，这是冒泡排序..." },
  ];

  const compacted = await compactMessages(
    messages,
    client,
    CONFIG.model,
    { triggerPercent: 0, keepRecentCount: 4, maxTokens: 128000 }, // 强制触发压缩
  );

  // 压缩后消息数应该比原来少
  const shorter = compacted.length < messages.length;

  // 用压缩后的消息问问题，验证关键信息保留
  compacted.push({ role: "user", content: "我叫什么名字？我的项目叫什么？" });
  const r = await runAgentLoop(compacted);

  const remembers = r.finalContent.includes("李明") && r.finalContent.includes("Axon");

  return {
    name,
    passed: shorter && remembers,
    detail: shorter && remembers
      ? `压缩成功（${messages.length}条→${compacted.length - 1}条），关键信息保留`
      : `shorter=${shorter}, remembers=${remembers}, 回答: ${r.finalContent.slice(0, 100)}`,
    tokensUsed: r.totalTokens,
  };
}

// ── 主程序 ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("🧪 Axon Agent 基准测试");
  console.log(`   模型: ${CONFIG.model}`);
  console.log(`   工作目录: ${CWD}`);
  console.log("─".repeat(50));

  const tests = [
    testMemoryBasic,
    testMemoryMultiTurn,
    testToolCall,
    testTokenGrowth,
    testCompaction,
  ];

  const results: TestResult[] = [];

  for (const test of tests) {
    process.stdout.write(`⏳ ${test.name}...`);
    try {
      const result = await test();
      results.push(result);
      console.log(result.passed ? " ✅" : " ❌");
    } catch (err) {
      const error = err as Error;
      results.push({ name: test.name, passed: false, detail: `异常: ${error.message}` });
      console.log(" ❌ (异常)");
    }
  }

  // 汇总
  console.log("\n" + "─".repeat(50));
  console.log("📊 测试结果:\n");

  for (const r of results) {
    const icon = r.passed ? "✅" : "❌";
    console.log(`  ${icon} ${r.name}`);
    console.log(`     ${r.detail}`);
    if (r.tokensUsed) console.log(`     Token: ${r.tokensUsed}`);
    console.log();
  }

  const passed = results.filter((r) => r.passed).length;
  console.log(`\n总计: ${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(console.error);
