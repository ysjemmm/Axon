import { describe, expect, it } from "vitest";
import { AgentSession } from "../agentSession.js";
import type { AgentChannel } from "../channel/index.js";
import type { AgentHost } from "../host/index.js";

/**
 * 回归：历史 reasoning_content 的回传策略。
 *
 * ── 两轮演进，别退回旧行为 ──
 * 1. DeepSeek 等 reasoning 模型要求带 tool_calls 的 assistant 历史消息**保留** `reasoning_content`
 *    字段，否则下一轮工具调用会报错（缺少思考状态）。所以字段必须存在。
 * 2. 但把历史思考内容原样回传，会让模型被自己的旧思考带向重复：实测多轮工具链里，每轮开头的
 *    思考都是同一句「用户选择了X，我先摸清Y」。先试过「保留最近 3 轮」，无效——那 3 轮本身
 *    就是同一种句式的复制品，喂回去等于给了 3 个范例，而这类重复只需要 1 个样本就能形成 few-shot。
 *
 * 现行策略：**字段保留、内容一律清空**（`PromptBuilder.REASONING_KEEP_RECENT = 0`）。
 * 想调回「保留最近 N 轮」只需把该常量改成 N（N > 0），本文件的断言相应放宽。
 */

function minimalHost(): AgentHost {
  return {
    fs: {
      read: async () => null,
      write: async () => {},
      append: async () => {},
      stat: async () => null,
      readdir: async () => [],
      mkdirp: async () => {},
      remove: async () => {},
    },
    commands: {} as any,
    diagnostics: {} as any,
    browser: {} as any,
    edits: {
      getMode: () => "auto",
      hasPending: () => false,
      getPendingPaths: () => [],
      getPendingDiffs: () => [],
      getPendingEditIds: () => [],
      getUndoablePaths: () => [],
      getUndoableEditIds: () => [],
      serialize: () => [],
      restore: () => {},
      setMode: () => {},
    } as any,
  } as AgentHost;
}

const channelStub: AgentChannel = { emit: () => {} };

/** 构造一段"assistant(tool_calls+reasoning) → tool 结果"历史，模拟已完成的一轮工具调用 */
function historyWithReasoningToolTurn(): any[] {
  return [
    { role: "system", content: "system prompt" },
    { role: "user", content: "帮我读一下 a.ts" },
    {
      role: "assistant",
      content: null,
      reasoning_content: "用户想看 a.ts 的内容，我应该调用 read_file。",
      displayContent: null,
      runtimeContent: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "文件内容：export const a = 1;" },
  ];
}

/** 造 N 轮「assistant(工具调用 + 思考) → tool 结果」的历史 */
function historyWithTurns(n: number): any[] {
  const history: any[] = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "开始" },
  ];
  for (let i = 1; i <= n; i++) {
    history.push({
      role: "assistant",
      content: null,
      reasoning_content: `思考${i}`,
      displayContent: null,
      runtimeContent: null,
      tool_calls: [
        { id: `call_${i}`, type: "function", function: { name: "read_file", arguments: `{"path":"${i}.ts"}` } },
      ],
    });
    history.push({ role: "tool", tool_call_id: `call_${i}`, content: "ok" });
  }
  return history;
}

describe("历史 reasoning_content 回传策略：字段保留、内容清空", () => {
  it("工具轮：字段仍在，内容被清空", () => {
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), historyWithReasoningToolTurn());
    s.compactionConfig.enabled = false;
    const msgs = s.promptBuilder.buildRequestMessages();
    const assistantWithTools = msgs.find((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls));

    expect(assistantWithTools).toBeTruthy();
    // 字段必须在：部分端点对「带 tool_calls 却缺 reasoning_content」会直接报错
    expect("reasoning_content" in (assistantWithTools as any)).toBe(true);
    // 内容必须为空：原样回传会把模型带向重复
    expect((assistantWithTools as any).reasoning_content).toBe("");
  });

  it("displayContent / runtimeContent 是内部字段，不该泄漏给 provider", () => {
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), historyWithReasoningToolTurn());
    s.compactionConfig.enabled = false;
    const assistantWithTools = s.promptBuilder
      .buildRequestMessages()
      .find((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls));

    expect((assistantWithTools as any).displayContent).toBeUndefined();
    expect((assistantWithTools as any).runtimeContent).toBeUndefined();
  });

  it("compaction 场景下同样清空内容", () => {
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), historyWithReasoningToolTurn());
    s.compactionConfig.enabled = true;
    const assistantWithTools = s.promptBuilder
      .buildRequestMessages()
      .find((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls));

    expect(assistantWithTools).toBeTruthy();
    expect((assistantWithTools as any).reasoning_content).toBe("");
  });

  it("非工具轮的最终回复：同样清空内容", () => {
    const history = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "解释一下这段代码" },
      { role: "assistant", content: "这段代码做的是……", reasoning_content: "先看它导入了什么" },
    ];
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), history as any);
    s.compactionConfig.enabled = false;
    const assistant = s.promptBuilder.buildRequestMessages().find((m: any) => m.role === "assistant" && !m.tool_calls);

    expect(assistant).toBeTruthy();
    expect((assistant as any).reasoning_content).toBe("");
    // 正文本身不受影响——那是给用户看的结论，必须保留
    expect((assistant as any).content).toBe("这段代码做的是……");
  });

  it("多轮工具链：所有历史思考一律清空，且字段齐全", () => {
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), historyWithTurns(5) as any);
    s.compactionConfig.enabled = false;
    const assistants = s.promptBuilder
      .buildRequestMessages()
      .filter((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls));

    expect(assistants.length).toBe(5);
    for (const a of assistants) {
      expect("reasoning_content" in (a as any)).toBe(true);
      expect((a as any).reasoning_content).toBe("");
    }
  });

  it("原始历史不被改写：清空只作用于发出去的副本", () => {
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), historyWithTurns(3) as any);
    s.compactionConfig.enabled = false;
    s.promptBuilder.buildRequestMessages();

    // 历史本体必须保持原样，否则会污染持久化与其他模型的回放
    const raw = s.messages.filter((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls));
    expect(raw.map((m: any) => m.reasoning_content)).toEqual(["思考1", "思考2", "思考3"]);
  });
});
