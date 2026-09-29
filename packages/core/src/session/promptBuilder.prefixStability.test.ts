import { describe, expect, it } from "vitest";
import { AgentSession } from "../agentSession.js";
import type { AgentChannel } from "../channel/index.js";
import type { AgentHost } from "../host/index.js";

/**
 * 回归：用户发新消息时，**上一轮已经发过的历史**在请求里必须逐字节不变。
 *
 * 前缀缓存按"从头开始逐字节相同的最长前缀"命中。早先 buildRequestMessages 以
 * turnStartMsgCount（本轮起点）为界，对"之前轮次"的工具结果做两件事：
 *   · 瞬态工具（search 等）的结果整条移除
 *   · 超过 200 字（DeepSeek 80 字）的工具结果截短
 * 上一轮里这些结果是完整发出去的；新一轮一开始它们就变了——前缀从中间断开，
 * 整段历史按未缓存重新计费。实测表现：每次发问后的首个请求 ≈6.8 credit，
 * 同一轮后续请求 ≈2 credit。
 *
 * 旧工具结果的体积控制交给两处"写回历史"的机制：回合结束时的 pruneOldToolResults
 * 与滚动压缩。它们改写的是持久化历史本身，改写后每次请求都一致，不会在轮内反复打断前缀。
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

const LONG = "x".repeat(1200);

/** 上一轮：用户提问 → 一次 search（瞬态工具）+ 一次长结果的 read_file → 最终回复 */
function previousTurn(): any[] {
  return [
    { role: "system", content: "system prompt" },
    { role: "user", content: "帮我看看这个项目" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_s", type: "function", function: { name: "search", arguments: '{"query":"foo"}' } },
        { id: "call_r", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_s", _toolName: "search", content: `搜索结果：${LONG}` },
    { role: "tool", tool_call_id: "call_r", _toolName: "read_file", content: `文件内容：${LONG}` },
    { role: "assistant", content: "看完了，结论是……" },
  ];
}

/** 取请求里的历史部分（去掉尾部注入：它们是 system 且排在历史之后，本测试只关心历史） */
function historyPart(msgs: any[]): string[] {
  return msgs.filter((m) => m.role !== "system").map((m) => JSON.stringify(m));
}

describe("新一轮开头，上一轮历史在请求中保持不变（前缀缓存可命中）", () => {
  for (const model of ["deepseek-v4-flash", "gpt-4o"]) {
    it(`${model}：上一轮的工具结果不被移除、不被截短`, () => {
      const s = new AgentSession("d:\\projects\\Axon", channelStub, minimalHost(), previousTurn());
      s.compactionConfig.enabled = true;
      (s as any).model = model;

      // 上一轮进行中：turnStartMsgCount 指向上一轮的用户消息
      (s as any).turnStartMsgCount = 1;
      const lastRequestOfPrevTurn = historyPart(s.promptBuilder.buildRequestMessages());

      // 用户发新消息：本轮起点前移到末尾，再追加新的用户消息
      (s as any).turnStartMsgCount = s.messages.length;
      s.messages.push({ role: "user", content: "再帮我改一下" } as any);
      const firstRequestOfNewTurn = historyPart(s.promptBuilder.buildRequestMessages());

      // 新一轮首个请求必须以"上一轮最后一个请求的历史"为完整前缀
      expect(firstRequestOfNewTurn.slice(0, lastRequestOfPrevTurn.length)).toEqual(lastRequestOfPrevTurn);
      expect(firstRequestOfNewTurn.length).toBe(lastRequestOfPrevTurn.length + 1);
    });
  }
});
