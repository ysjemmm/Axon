/**
 * 回归测试：尾部注入的内容在一轮之内必须保持不变。
 *
 * 为什么要测这个：Anthropic / Responses 协议把所有 system 消息**合并**成一个顶层 system / instructions，
 * 放在所有对话消息之前。所以"尾部注入"在这两条链路上并不在尾部——它和系统提示词一起落在前缀的最开头，
 * 任何一条注入变了，整段前缀缓存都从第一个字节起失效，本轮这次请求按全价重算。
 *
 * 实测：终端 cwd 提示随 execute_command 的 cwd 实时变化（每次命令换个目录就变一次），
 * 同一轮里凡是"上一次命令换了目录"的请求都比相邻请求贵约 3 倍。
 *
 * 所以这类随工具执行而变的注入，必须在一轮开始时定格，一轮之内逐字节不变。
 */
import { describe, expect, it } from "vitest";
import { PromptBuilder } from "./promptBuilder.js";

function makeSession(overrides: Record<string, unknown> = {}) {
  const s: any = {
    model: "claude-opus-5.5",
    cwd: "/work/main",
    terminalCwd: "/work/main",
    workspaces: ["/work/main"],
    host: {},
    messages: [{ role: "system", content: "SYSTEM PROMPT" }, { role: "user", content: "u1" }],
    ideContextCache: null,
    skillsPromptCache: null,
    powersPromptCache: null,
    wikiPromptCache: null,
    lastTotalTokens: 0,
    getContextWindow: () => 1_000_000,
    ...overrides,
  };
  s.promptBuilder = new PromptBuilder(s);
  return s;
}

/** 把一次请求里所有 system 消息拼起来 —— 正是 Anthropic/Responses 链路实际发出的 system 前缀 */
function systemPrefix(s: any): string {
  return s.promptBuilder
    .buildRequestMessages()
    .filter((m: any) => m.role === "system")
    .map((m: any) => m.content)
    .join("\n\n");
}

describe("尾部注入在一轮内保持稳定", () => {
  it("GPT Chat 把易变 system 注入锚在本轮用户消息之前，保留可自动缓存的稳定前缀", () => {
    const s = makeSession({
      model: "gpt-5.6-sol",
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
      ],
      ideContextCache: "CURRENT IDE CONTEXT",
    });

    const request = s.promptBuilder.buildRequestMessages();
    expect(request[0]).toEqual(s.messages[0]);
    expect(request.slice(-2)).toEqual(s.messages.slice(1));
    expect(request.at(-3)?.role).toBe("system");
    expect(request.at(-3)?.content).toBe("CURRENT IDE CONTEXT");
  });

  it("同一轮中 execute_command 换了目录，system 前缀不变", () => {
    const s = makeSession();
    s.promptBuilder.beginTurn();
    const first = systemPrefix(s);

    // 模拟本轮中途：命令在子目录执行，终端 cwd 随之改变
    s.terminalCwd = "/work/main/packages/core";
    const second = systemPrefix(s);

    expect(second).toBe(first);
  });

  it("新一轮开始时才反映最新的终端 cwd", () => {
    const s = makeSession();
    s.promptBuilder.beginTurn();
    s.terminalCwd = "/work/main/packages/core";
    s.promptBuilder.beginTurn();

    expect(systemPrefix(s)).toContain("/work/main/packages/core");
  });

  it("终端 cwd 与主工作区相同时不注入提示", () => {
    const s = makeSession();
    s.promptBuilder.beginTurn();
    expect(systemPrefix(s)).not.toContain("终端当前工作目录");
  });

  it("同一轮中上下文使用率上涨，提醒里的百分比不变", () => {
    const s = makeSession({ lastTotalTokens: 800_000 });
    s.promptBuilder.beginTurn();
    const first = systemPrefix(s);
    expect(first).toContain("80%");

    s.lastTotalTokens = 840_000;
    expect(systemPrefix(s)).toBe(first);
  });

  it("占用未到提醒线（75%）时不出现提醒", () => {
    const s = makeSession({ lastTotalTokens: 610_000 });
    s.promptBuilder.beginTurn();
    expect(systemPrefix(s)).not.toContain("【上下文使用率】");
  });

  it("本轮中途占用回落（压缩）后，冻结的提醒立即作废", () => {
    const s = makeSession({ lastTotalTokens: 800_000 });
    s.promptBuilder.beginTurn();
    expect(systemPrefix(s)).toContain("当前已用 80%");

    // 模拟本轮中途自动压缩：占用从 80% 掉到 10%
    s.lastTotalTokens = 100_000;
    expect(systemPrefix(s)).not.toContain("【上下文使用率】");
  });

  it("chat 链路（非缓存友好模型）注入紧跟系统提示词：一轮内整条请求的前缀不变", () => {
    const s = makeSession({ model: "claude-opus-5.5" });
    s.promptBuilder.beginTurn();
    const before = JSON.stringify(s.promptBuilder.buildRequestMessages());
    s.terminalCwd = "/work/main/apps/ext";
    s.messages.push({ role: "assistant", content: "a1" });
    const after = JSON.stringify(s.promptBuilder.buildRequestMessages());
    // 新请求 = 旧请求 + 追加的消息（去掉旧请求末尾的 "]" 后应是新请求的前缀）
    expect(after.startsWith(before.slice(0, -1))).toBe(true);
  });

  it("会话记忆随本轮注入发出；清空后不再注入", () => {
    // 用缓存友好模型：只有这条链路才把注入锚在用户消息前（而不是紧跟系统提示）
    const s = makeSession({ model: "gpt-5.6-sol", memory: "# 记忆\n- 结论 A" });
    s.promptBuilder.beginTurn();
    const request = s.promptBuilder.buildRequestMessages();

    expect(systemPrefix(s)).toContain("【会话记忆】");
    expect(systemPrefix(s)).toContain("结论 A");
    // 紧挨着本轮用户消息，不夹在系统提示与历史之间
    expect(request.at(-2)?.content).toContain("【会话记忆】");
    expect(request.at(-1)?.content).toBe("u1");

    s.memory = "";
    expect(systemPrefix(s)).not.toContain("【会话记忆】");
  });
});
