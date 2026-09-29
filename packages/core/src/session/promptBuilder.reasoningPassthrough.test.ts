import { describe, expect, it } from "vitest";
import { AgentSession } from "../agentSession.js";
import type { AgentChannel } from "../channel/index.js";
import type { AgentHost } from "../host/index.js";

/**
 * 回归：DeepSeek 等 reasoning 模型要求带 tool_calls 的 assistant 历史消息
 * 原样回传 reasoning_content，否则下一轮工具调用会报错（缺少思考状态）。
 *
 * 覆盖链路：agentSession 工具轮写入 reasoning_content → PromptBuilder.buildRequestMessages
 * 组装下一轮请求时不能把该字段丢掉（无论走 compaction 分支还是非 compaction 分支）。
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

describe("reasoning_content 在历史→下一轮请求消息中的透传", () => {
  it("非 compaction 场景：buildRequestMessages 保留 assistant 工具轮的 reasoning_content", () => {
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), historyWithReasoningToolTurn());
    s.compactionConfig.enabled = false;
    const msgs = s.promptBuilder.buildRequestMessages();
    const assistantWithTools = msgs.find((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls));
    expect(assistantWithTools).toBeTruthy();
    expect((assistantWithTools as any).reasoning_content).toBe(
      "用户想看 a.ts 的内容，我应该调用 read_file。",
    );
    // displayContent/runtimeContent 是内部字段，不应该泄漏给 provider
    expect((assistantWithTools as any).displayContent).toBeUndefined();
    expect((assistantWithTools as any).runtimeContent).toBeUndefined();
  });

  it("compaction 场景：buildRequestMessages 同样保留 reasoning_content", () => {
    const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), historyWithReasoningToolTurn());
    s.compactionConfig.enabled = true;
    const msgs = s.promptBuilder.buildRequestMessages();
    const assistantWithTools = msgs.find((m: any) => m.role === "assistant" && Array.isArray(m.tool_calls));
    expect(assistantWithTools).toBeTruthy();
    expect((assistantWithTools as any).reasoning_content).toBe(
      "用户想看 a.ts 的内容，我应该调用 read_file。",
    );
  });
});
