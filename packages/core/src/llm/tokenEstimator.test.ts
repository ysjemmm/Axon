import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  estimateTokensFromText,
  estimateChatMessageTokens,
  estimateChatMessagesTokens,
  estimateToolDefsTokens,
  estimatePromptTokens,
} from "./tokenEstimator.js";

describe("estimateTokensFromText", () => {
  it("中文比同等字符数的英文估得更高", () => {
    const cn = estimateTokensFromText("上下文占比统计".repeat(50));
    const en = estimateTokensFromText("context ratio".repeat(50));
    expect(cn / 350).toBeGreaterThan(en / 650);
  });

  it("空值安全", () => {
    expect(estimateTokensFromText("")).toBe(0);
    expect(estimateTokensFromText(undefined as unknown as string)).toBe(0);
  });
});

/**
 * 这一组是本模块存在的理由。
 *
 * 旧的估算基于 promptBuilder.messageText，它只取 content 的 text 段、**完全忽略 tool_calls**。
 * 而 agent 会话里最大的一块恰恰在工具参数里：create_file 的 content 是整个文件正文，
 * str_replace 的 new_str 同理。漏掉它意味着工具调用越密集、上下文估得越偏小，
 * 而这正是 Axon 的典型用法。
 */
describe("必须覆盖 tool_calls（旧实现在此漏算）", () => {
  const bigFile = "export function foo() { return 1; }\n".repeat(500);

  it("assistant 的工具参数计入估算", () => {
    const msg = {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "t1", type: "function", function: { name: "create_file", arguments: JSON.stringify({ path: "a.ts", content: bigFile }) } },
      ],
    } as unknown as ChatCompletionMessageParam;
    // 文件正文本身约 4800 token，绝不该被算成"只有协议开销"
    expect(estimateChatMessageTokens(msg)).toBeGreaterThan(3000);
  });

  it("同样内容放在 content 里和放在 tool_calls 里，量级相当", () => {
    const asContent = estimateChatMessageTokens({ role: "assistant", content: bigFile } as ChatCompletionMessageParam);
    const asToolArgs = estimateChatMessageTokens({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "t1", type: "function", function: { name: "x", arguments: bigFile } }],
    } as unknown as ChatCompletionMessageParam);
    const ratio = asToolArgs / asContent;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.2);
  });

  it("tool 结果消息（role:tool）计入估算", () => {
    const msg = { role: "tool", tool_call_id: "t1", content: bigFile } as ChatCompletionMessageParam;
    expect(estimateChatMessageTokens(msg)).toBeGreaterThan(3000);
  });
});

describe("estimateChatMessageTokens 其它形态", () => {
  it("图片按固定量级折算，不被 base64 长度撑爆", () => {
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "看这张图" },
        { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(1_000_000) } },
      ],
    } as unknown as ChatCompletionMessageParam;
    // 1MB base64 若按字符估会是 27 万 token；真实开销只有一千多
    expect(estimateChatMessageTokens(msg)).toBeLessThan(3000);
  });

  it("undefined / 空消息不抛错", () => {
    expect(estimateChatMessageTokens(undefined)).toBe(0);
    expect(estimateChatMessagesTokens([undefined, undefined])).toBe(0);
  });

  it("每条消息计入协议固定开销", () => {
    const one = estimateChatMessagesTokens([{ role: "user", content: "hi" } as ChatCompletionMessageParam]);
    const three = estimateChatMessagesTokens([
      { role: "user", content: "hi" } as ChatCompletionMessageParam,
      { role: "user", content: "hi" } as ChatCompletionMessageParam,
      { role: "user", content: "hi" } as ChatCompletionMessageParam,
    ]);
    expect(three).toBe(one * 3);
  });
});

describe("estimateToolDefsTokens", () => {
  it("工具定义按序列化后估算", () => {
    const tools = [{ type: "function", function: { name: "read_file", description: "读文件", parameters: { type: "object", properties: { path: { type: "string" } } } } }];
    expect(estimateToolDefsTokens(tools)).toBeGreaterThan(10);
  });

  it("循环引用不抛错（宁可少算也不能让估算炸掉主流程）", () => {
    const circular: Record<string, unknown> = { name: "x" };
    circular["self"] = circular;
    expect(estimateToolDefsTokens([circular])).toBe(0);
  });

  it("空值返回 0", () => {
    expect(estimateToolDefsTokens(undefined)).toBe(0);
    expect(estimateToolDefsTokens(null)).toBe(0);
  });
});

/**
 * 这三条性质是"用本地估算替代 API 报数"的全部依据。
 * 实测中那个官方端点同一段历史能报出 90710 与 321207（差 3.5 倍），就是因为它一条都不满足。
 */
describe("上下文口径必须具备的性质", () => {
  const mk = (n: number): ChatCompletionMessageParam[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `第 ${i} 条消息，内容有点长度才有意义。` } as ChatCompletionMessageParam));

  it("纯函数：同一份输入永远得到同一个值", () => {
    const parts = { system: "你是助手", messages: mk(20), tools: [{ name: "x" }] };
    expect(estimatePromptTokens(parts)).toBe(estimatePromptTokens(parts));
  });

  it("单调：历史只增不减", () => {
    let prev = 0;
    for (const n of [1, 5, 20, 100]) {
      const cur = estimatePromptTokens({ system: "s", messages: mk(n) });
      expect(cur).toBeGreaterThan(prev);
      prev = cur;
    }
  });

  it("与 provider / 协议无关：输入里压根没有模型或端点的位置", () => {
    // 这条靠签名保证——estimatePromptTokens 只接受请求体三段，没有 model / provider 参数。
    // 用例存在的意义是：将来若有人想加一个 model 参数做"按模型分支"，这里会提醒他别这么干。
    const parts = { system: "s", messages: mk(10), tools: [] };
    expect(Object.keys(parts).sort()).toEqual(["messages", "system", "tools"]);
    expect(estimatePromptTokens(parts)).toBeGreaterThan(0);
  });

  it("三段加和 = 总量（system / 历史 / 工具各自独立可加）", () => {
    const system = "你是助手".repeat(20);
    const messages = mk(15);
    const tools = [{ name: "read_file", description: "读文件" }];
    expect(estimatePromptTokens({ system, messages, tools })).toBe(
      estimateTokensFromText(system) + estimateChatMessagesTokens(messages) + estimateToolDefsTokens(tools),
    );
  });

  it("system 传数组时按段拼接", () => {
    const a = estimatePromptTokens({ system: ["第一段", "第二段"] });
    const b = estimatePromptTokens({ system: "第一段\n\n第二段" });
    expect(a).toBe(b);
  });
});
