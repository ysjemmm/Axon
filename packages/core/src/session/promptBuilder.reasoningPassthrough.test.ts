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
 * 3. 但「一律清空」连**当前用户回合**的思考也清掉了：做到第 5 步时模型看不到前 4 步的思路，
 *    只能凭 tool_calls 重推一遍，每一步都从「用户让我按方向 A……」重新起头。
 *
 * 现行策略：**当前用户回合的思考原样回传；之前回合的思考字段保留、内容清空**
 * （`PromptBuilder.REASONING_KEEP_PREVIOUS_TURNS = 0`）。
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

/** 在历史末尾追加一条新的用户消息：此前的思考都变成「之前回合」的 */
function thenUserAsks(history: any[], text = "下一个问题"): any[] {
  return [...history, { role: "user", content: text }];
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

describe("之前回合的 reasoning_content：字段保留、内容清空", () => {
  it("工具轮：字段仍在，内容被清空", () => {
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), thenUserAsks(historyWithReasoningToolTurn()));
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
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), thenUserAsks(historyWithReasoningToolTurn()));
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
      { role: "user", content: "那这里呢" },
    ];
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), history as any);
    s.compactionConfig.enabled = false;
    const assistant = s.promptBuilder.buildRequestMessages().find((m: any) => m.role === "assistant" && !m.tool_calls);

    expect(assistant).toBeTruthy();
    expect((assistant as any).reasoning_content).toBe("");
    // 正文本身不受影响——那是给用户看的结论，必须保留
    expect((assistant as any).content).toBe("这段代码做的是……");
  });

  it("多轮工具链结束后用户再提问：之前的思考全部清空，且字段齐全", () => {
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), thenUserAsks(historyWithTurns(5)) as any);
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
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), thenUserAsks(historyWithTurns(3)) as any);
    s.compactionConfig.enabled = false;
    s.promptBuilder.buildRequestMessages();

    // 历史本体必须保持原样，否则会污染持久化与其他模型的回放
    const raw = s.messages.filter((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls));
    expect(raw.map((m: any) => m.reasoning_content)).toEqual(["思考1", "思考2", "思考3"]);
  });
});

describe("当前用户回合的 reasoning_content：原样回传", () => {
  it("回合进行中的多步工具链：每一步的思考都原样保留", () => {
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), historyWithTurns(5) as any);
    s.compactionConfig.enabled = false;
    const assistants = s.promptBuilder
      .buildRequestMessages()
      .filter((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls));

    expect(assistants.map((a: any) => a.reasoning_content)).toEqual(["思考1", "思考2", "思考3", "思考4", "思考5"]);
  });

  it("之前回合清空、当前回合保留，边界是最后一条真实用户消息", () => {
    const history = thenUserAsks(historyWithTurns(2), "按方向 A 实现");
    history.push({
      role: "assistant",
      content: null,
      reasoning_content: "本回合思考",
      tool_calls: [{ id: "call_now", type: "function", function: { name: "read_file", arguments: "{}" } }],
    });
    history.push({ role: "tool", tool_call_id: "call_now", content: "ok" });
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), history as any);
    s.compactionConfig.enabled = false;
    const assistants = s.promptBuilder
      .buildRequestMessages()
      .filter((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls));

    expect(assistants.map((a: any) => a.reasoning_content)).toEqual(["", "", "本回合思考"]);
  });

  it("截图回填的 user 消息不算新回合：其前面的本回合思考仍保留", () => {
    const history = historyWithTurns(2);
    history.push({ role: "user", content: [{ type: "text", text: "截图" }], _screenshotInjection: true });
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), history as any);
    s.compactionConfig.enabled = false;
    const assistants = s.promptBuilder
      .buildRequestMessages()
      .filter((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls));

    expect(assistants.map((a: any) => a.reasoning_content)).toEqual(["思考1", "思考2"]);
  });

  it("回合内每一步的请求以上一步为完整前缀（清空集合在回合内不变）", () => {
    const history = thenUserAsks(historyWithTurns(2), "按方向 A 实现");
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), history as any);
    s.compactionConfig.enabled = false;
    const steps: string[][] = [];
    for (let i = 1; i <= 3; i++) {
      s.messages.push({
        role: "assistant",
        content: null,
        reasoning_content: `本回合思考${i}`,
        tool_calls: [{ id: `call_now_${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }],
      } as any);
      s.messages.push({ role: "tool", tool_call_id: `call_now_${i}`, content: "ok" } as any);
      steps.push(s.promptBuilder.buildRequestMessages().map((m: any) => JSON.stringify(m)));
    }
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].slice(0, steps[i - 1].length)).toEqual(steps[i - 1]);
    }
  });
});

describe("工具轮叙述（displayContent）：当前回合回传，之前回合不发", () => {
  function toolTurn(id: string, prose: string | null): any {
    return {
      role: "assistant",
      content: null,
      reasoning_content: `思考${id}`,
      displayContent: prose,
      runtimeContent: null,
      tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }],
    };
  }

  it("当前回合：叙述作为 content 回传；之前回合：content 仍为 null", () => {
    const history = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "第一轮" },
      toolTurn("old", "先看下路由配置"),
      { role: "tool", tool_call_id: "old", content: "ok" },
      { role: "assistant", content: "完成" },
      { role: "user", content: "按方向 A 实现" },
      toolTurn("now1", "先定位历史会话面板的代码"),
      { role: "tool", tool_call_id: "now1", content: "ok" },
      toolTurn("now2", null),
      { role: "tool", tool_call_id: "now2", content: "ok" },
    ];
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), history as any);
    s.compactionConfig.enabled = false;
    const assistants = s.promptBuilder
      .buildRequestMessages()
      .filter((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls));

    expect(assistants.map((a: any) => a.content)).toEqual([null, "先定位历史会话面板的代码", null]);
    // 内部字段不泄漏
    for (const a of assistants) expect((a as any).displayContent).toBeUndefined();
  });
});

describe("displayGroupSummary 是纯展示字段", () => {
  it("不发给 provider", () => {
    const history = historyWithReasoningToolTurn();
    history[2].displayGroupSummary = { toolCallId: "call_1", text: "查看了 a.ts" };
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), history);
    s.compactionConfig.enabled = false;
    const a = s.promptBuilder.buildRequestMessages().find((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls));
    expect((a as any).displayGroupSummary).toBeUndefined();
  });
});
