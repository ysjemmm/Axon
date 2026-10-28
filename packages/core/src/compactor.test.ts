import { describe, expect, it } from "vitest";
import { serializeHistoryForMemory } from "./compactor.js";

describe("会话记忆历史序列化", () => {
  it("保留工具名称、参数和关键路径", () => {
    const text = serializeHistoryForMemory([
      { role: "user", content: "把工作区改成折叠行" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "p1",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({ path: "web/src/components/ToolCallItem.tsx" }),
          },
        }],
      } as any,
      { role: "tool", content: "已应用补丁" } as any,
    ]);

    expect(text).toContain("apply_patch");
    expect(text).toContain("web/src/components/ToolCallItem.tsx");
    expect(text).not.toContain("（工具调用）");
  });
});

import { buildFallbackSummary, compactMessages } from "./compactor.js";

function longHistory(n = 20): any[] {
  const msgs: any[] = [{ role: "system", content: "system" }];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: "user", content: `问题 ${i}` });
    msgs.push({ role: "assistant", content: `回答 ${i}` });
  }
  return msgs;
}

describe("压缩摘要：不能用空摘要换掉早期对话", () => {
  it("生成摘要时关闭思考", async () => {
    const calls: any[] = [];
    const strategy: any = { runTurn: async (p: any) => { calls.push(p); return { content: "- 摘要要点" }; } };
    const out = await compactMessages(longHistory(), strategy, "deepseek-v4-pro", undefined, { modelSupportsThinking: true });
    expect(calls[0].think).toBe(false);
    expect(calls[0].modelSupportsThinking).toBe(true);
    expect(out[1].content).toBe("[对话历史摘要]\n- 摘要要点");
  });

  it("第一次返回空正文时缩短输入重试", async () => {
    let n = 0;
    const strategy: any = { runTurn: async () => ({ content: n++ === 0 ? "" : "- 重试后的摘要" }) };
    const out = await compactMessages(longHistory(), strategy, "m");
    expect(n).toBe(2);
    expect(out[1].content).toContain("重试后的摘要");
  });

  it("两次都失败时从原文摘录兜底，而不是写「无法生成摘要」", async () => {
    const strategy: any = { runTurn: async () => ({ content: "" }) };
    const out = await compactMessages(longHistory(), strategy, "m");
    const summary = String(out[1].content);
    expect(summary).not.toContain("无法生成摘要");
    expect(summary).toContain("自动摘要生成失败");
    expect(summary).toContain("问题 0");
  });

  it("再次压缩时，上一次的摘要原文完整交给模型合并，不被截断", async () => {
    const prev = "[对话历史摘要]\n" + "- 很早之前的决定\n".repeat(80);
    const history = [{ role: "system", content: "system" }, { role: "user", content: prev }, { role: "assistant", content: "明白，我已了解之前的对话内容。" }, ...longHistory().slice(1)];
    let prompt = "";
    const strategy: any = { runTurn: async (p: any) => { prompt = p.messages[0].content; return { content: "- 新摘要" }; } };
    await compactMessages(history as any, strategy, "m");
    expect(prompt.match(/很早之前的决定/g)?.length).toBe(80);
  });

  it("兜底摘要保留已有摘要、用户问题与涉及的文件", () => {
    const text = buildFallbackSummary("- 旧摘要", [
      { role: "user", content: "把按钮删掉" },
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: '{"path":"src/a.vue"}' } }] } as any,
    ]);
    expect(text).toContain("旧摘要");
    expect(text).toContain("把按钮删掉");
    expect(text).toContain("read_file(src/a.vue)");
  });
});

import { autoCompactThreshold, compactKeepingCurrentTurn } from "./compactor.js";

describe("自动压缩线：按窗口留余量，而不是固定比例", () => {
  it("常见窗口的压缩线", () => {
    expect(autoCompactThreshold(128_000)).toBe(96_000);
    expect(autoCompactThreshold(200_000)).toBe(168_000);
    expect(autoCompactThreshold(1_000_000)).toBe(850_000);
    // 余量封顶 160k：2M 窗口不必空着 300k
    expect(autoCompactThreshold(2_000_000)).toBe(1_840_000);
  });

  it("小窗口不低于一半；early 不超过一半；窗口未知返回 0", () => {
    expect(autoCompactThreshold(32_000)).toBe(16_000);
    expect(autoCompactThreshold(1_000_000, "early")).toBe(500_000);
    expect(autoCompactThreshold(0)).toBe(0);
  });
});

describe("回答进行中的压缩：当前请求原样保留", () => {
  const summarizer = () => {
    const prompts: string[] = [];
    const strategy: any = { runTurn: async (p: any) => { prompts.push(p.messages[0].content); return { content: "- 摘要" }; } };
    return { strategy, prompts };
  };
  const toolRound = (id: string, result: string): any[] => [
    { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `${id}.ts` }) } }] },
    { role: "tool", tool_call_id: id, content: result },
  ];

  it("本轮不大：只压更早的对话，本轮整段原样保留", async () => {
    const before = longHistory(6);
    const user = { role: "user", content: "现在的问题" };
    const turn = [...toolRound("a", "小结果"), ...toolRound("b", "小结果")];
    const messages = [...before, user, ...turn];
    const { strategy } = summarizer();
    const out = await compactKeepingCurrentTurn(messages, strategy, "m", before.length, 10_000);
    expect(out[1].content).toContain("[对话历史摘要]");
    expect(out.slice(3)).toEqual([user, ...turn]);
  });

  it("本轮自己很大：前面的工具轮进摘要，用户消息钉在摘要之后，不留孤儿 tool 结果", async () => {
    const user = { role: "user", content: "把这些文件都读一遍" };
    const big = "大".repeat(20_000);
    const turn = [...toolRound("a", big), ...toolRound("b", big), ...toolRound("c", "最后一轮")];
    const messages: any[] = [{ role: "system", content: "system" }, user, ...turn];
    const { strategy, prompts } = summarizer();
    const out = await compactKeepingCurrentTurn(messages, strategy, "m", 1, 2_000);
    expect(out[3]).toBe(user);
    // 只保留最后一整轮：assistant(tool_calls) 与它的 tool 结果成对
    expect(out.slice(4)).toEqual(toolRound("c", "最后一轮"));
    expect(out[1].content).toContain("请求原文见下一条消息");
    // 摘要输入里有本轮已完成的工具轮
    expect(prompts[0]).toContain("a.ts");
  });

  it("压不出东西时原样返回", async () => {
    const user = { role: "user", content: "问题" };
    const messages: any[] = [{ role: "system", content: "system" }, user, ...toolRound("a", "结果")];
    const { strategy } = summarizer();
    const out = await compactKeepingCurrentTurn(messages, strategy, "m", 1, 10);
    expect(out).toBe(messages);
  });
});
