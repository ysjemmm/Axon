#!/usr/bin/env node

/**
 * Axon CLI 入口 - 交互式对话循环
 */

import { createInterface } from "node:readline";
import { AgentLoop } from "./agent/loop.js";

// 从环境变量读取配置
const config = {
  apiKey: process.env.LLM_API_KEY || "",
  baseUrl: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
  model: process.env.LLM_MODEL || "gpt-4o",
};

if (!config.apiKey) {
  console.error("❌ 请设置环境变量 LLM_API_KEY");
  console.error("   参考 .env.example 配置");
  process.exit(1);
}

const cwd = process.cwd();
const agent = new AgentLoop(config, cwd);

console.log("🧠 Axon AI Agent");
console.log(`📁 工作目录: ${cwd}`);
console.log(`🤖 模型: ${config.model}`);
console.log("─".repeat(50));
console.log("输入你的问题（输入 exit 退出）\n");

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "你> ",
});

rl.prompt();

rl.on("line", async (line) => {
  const input = line.trim();

  if (!input) {
    rl.prompt();
    return;
  }

  if (input === "exit" || input === "quit") {
    console.log("\n👋 再见");
    process.exit(0);
  }

  if (input === "/info") {
    const info = agent.getSessionInfo();
    console.log(`📊 消息数: ${info.messageCount}, 预估 token: ${info.estimatedTokens}`);
    rl.prompt();
    return;
  }

  try {
    const response = await agent.handleUserInput(input);
    console.log(`\nAxon> ${response}\n`);
  } catch (error: unknown) {
    const err = error as Error;
    console.error(`\n❌ 错误: ${err.message}\n`);
  }

  rl.prompt();
});

rl.on("close", () => {
  console.log("\n👋 再见");
  process.exit(0);
});
