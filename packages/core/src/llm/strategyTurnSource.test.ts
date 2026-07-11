import { describe, expect, it } from "vitest";
import { StrategyTurnSource } from "./strategyTurnSource.js";
import type { LLMStrategy, RunTurnParams, LLMTurnResult } from "./types.js";

/**
 * mock 策略：按预设结果返回，并在 runTurn 里把预设的 reasoning 增量通过回调回放，
 * 用于验证 StrategyTurnSource 的形状适配（reasoning 收集、工具草案归一化、finishReason 透传）。
 */
function makeStrategy(
  result: LLMTurnResult,
  reasoningReplay: { text: string; partIndex?: number; itemId?: string }[] = [],
): LLMStrategy {
  return {
    name: "mock",
    async runTurn(params: RunTurnParams): Promise<LLMTurnResult> {
      for (const r of reasoningReplay) {
        params.callbacks.onReasoningDelta(r.text, r.partIndex, r.itemId);
      }
      return result;
    },
  };
}

function buildSource(strategy: LLMStrategy) {
  return new StrategyTurnSource({ strategy, model: "gpt-x", tools: [] });
}

describe("StrategyTurnSource", () => {
  it("收集 reasoning 增量并保留分段信息", async () => {
    const strategy = makeStrategy(
      { content: "答案", toolCalls: [], finishReason: "stop", normalizedFinishReason: "complete" },
      [
        { text: "先看", partIndex: 0, itemId: "r1" },
        { text: "再想", partIndex: 1, itemId: "r1" },
      ],
    );
    const raw = await buildSource(strategy).run([{ role: "user", content: "hi" }]);
    expect(raw.reasoningDeltas).toEqual([
      { text: "先看", partIndex: 0, itemId: "r1" },
      { text: "再想", partIndex: 1, itemId: "r1" },
    ]);
    expect(raw.content).toBe("答案");
    expect(raw.finishReason).toBe("complete");
    expect(raw.toolCalls).toEqual([]);
  });

  it("工具调用映射 toolKind 并解析参数", async () => {
    const strategy = makeStrategy({
      content: "",
      toolCalls: [
        { id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' },
        { id: "call-2", name: "web_search", arguments: '{"query":"x"}' },
      ],
      finishReason: "tool_calls",
      normalizedFinishReason: "tool_calls",
    });
    const raw = await buildSource(strategy).run([{ role: "user", content: "hi" }]);
    expect(raw.toolCalls).toEqual([
      { callId: "call-1", toolName: "read_file", toolKind: "read", parsedArgs: { path: "a.ts" }, rawArgsText: '{"path":"a.ts"}' },
      { callId: "call-2", toolName: "web_search", toolKind: "network", parsedArgs: { query: "x" }, rawArgsText: '{"query":"x"}' },
    ]);
    expect(raw.finishReason).toBe("tool_calls");
  });

  it("参数 JSON 非法时 parsedArgs 为 undefined 但保留 rawArgsText", async () => {
    const strategy = makeStrategy({
      content: "",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: "{不是合法JSON" }],
      finishReason: "tool_calls",
      normalizedFinishReason: "tool_calls",
    });
    const raw = await buildSource(strategy).run([{ role: "user", content: "hi" }]);
    expect(raw.toolCalls[0].parsedArgs).toBeUndefined();
    expect(raw.toolCalls[0].rawArgsText).toBe("{不是合法JSON");
  });

  it("content 为空时用流式累计兜底", async () => {
    const strategy = makeStrategy(
      { content: "", toolCalls: [], finishReason: "stop", normalizedFinishReason: "complete" },
    );
    // 用一个会在流式回调里推正文的策略覆盖 onTextDelta 场景
    const s: LLMStrategy = {
      name: "mock2",
      async runTurn(params: RunTurnParams): Promise<LLMTurnResult> {
        params.callbacks.onTextDelta("流式片段");
        return { content: "", toolCalls: [], finishReason: "stop", normalizedFinishReason: "complete" };
      },
    };
    void strategy;
    const raw = await new StrategyTurnSource({ strategy: s, model: "m", tools: [] }).run([]);
    expect(raw.content).toBe("流式片段");
  });

  it("未知工具名回退 toolKind=other", async () => {
    const strategy = makeStrategy({
      content: "",
      toolCalls: [{ id: "c1", name: "mcp__dyn_tool", arguments: "{}" }],
      finishReason: "tool_calls",
      normalizedFinishReason: "tool_calls",
    });
    const raw = await buildSource(strategy).run([]);
    expect(raw.toolCalls[0].toolKind).toBe("other");
  });

  it("提供回调时实时转发 reasoning / text 增量（canary 驱动 UI）", async () => {
    const s: LLMStrategy = {
      name: "mock-stream",
      async runTurn(params: RunTurnParams): Promise<LLMTurnResult> {
        params.callbacks.onReasoningDelta("想一下", 0, "r1");
        params.callbacks.onTextDelta("你好");
        params.callbacks.onTextDelta("，世界");
        return { content: "你好，世界", toolCalls: [], finishReason: "stop", normalizedFinishReason: "complete" };
      },
    };
    const reasoning: { text: string; partIndex?: number; itemId?: string }[] = [];
    const texts: string[] = [];
    const raw = await new StrategyTurnSource({
      strategy: s,
      model: "m",
      tools: [],
      onReasoningDelta: (text, partIndex, itemId) => reasoning.push({ text, partIndex, itemId }),
      onTextDelta: (text) => texts.push(text),
    }).run([]);
    expect(reasoning).toEqual([{ text: "想一下", partIndex: 0, itemId: "r1" }]);
    expect(texts).toEqual(["你好", "，世界"]);
    expect(raw.content).toBe("你好，世界");
  });

  it("不提供回调时静默（shadow 只读，无副作用、不抛错）", async () => {
    const s: LLMStrategy = {
      name: "mock-silent",
      async runTurn(params: RunTurnParams): Promise<LLMTurnResult> {
        params.callbacks.onReasoningDelta("x", 0, "r1");
        params.callbacks.onTextDelta("y");
        return { content: "y", toolCalls: [], finishReason: "stop", normalizedFinishReason: "complete" };
      },
    };
    const raw = await new StrategyTurnSource({ strategy: s, model: "m", tools: [] }).run([]);
    expect(raw.content).toBe("y");
  });

  it("透传底层 usage 供上层精确计费", async () => {
    const usage = { promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedTokens: 40 };
    const strategy = makeStrategy({
      content: "ok",
      toolCalls: [],
      finishReason: "stop",
      normalizedFinishReason: "complete",
      usage,
    });
    const raw = await buildSource(strategy).run([]);
    expect(raw.usage).toEqual(usage);
  });
});
