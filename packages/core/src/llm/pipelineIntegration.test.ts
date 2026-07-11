import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  DefaultPipelineOrchestrator,
  DefaultRequestContextHandler,
  DefaultTurnContextHandler,
  DefaultLLMHandler,
  DefaultToolDispatchHandler,
  DefaultOutputHandler,
} from "./index.js";
import type { LLMTurnSource, LLMTurnRawResult } from "./llmTurnSource.js";
import type { ToolExecutor, ToolExecuteRequest, ToolExecuteResult } from "./toolExecutor.js";

/** mock 回合来源：可配置产出 reasoning 增量、工具草案、正文、finishReason。 */
function makeSource(raw: LLMTurnRawResult): LLMTurnSource {
  return {
    async run(_messages: ChatCompletionMessageParam[]): Promise<LLMTurnRawResult> {
      return raw;
    },
  };
}

/** mock 工具执行器：按 toolName 返回预设结果，可模拟成功/失败/抛异常。 */
function makeExecutor(map: Record<string, ToolExecuteResult | "throw">): ToolExecutor {
  return {
    async execute(req: ToolExecuteRequest): Promise<ToolExecuteResult> {
      const r = map[req.toolName];
      if (r === "throw") throw new Error(`${req.toolName} 执行异常`);
      return r ?? { ok: true, result: "ok" };
    },
  };
}

function buildOrchestrator(source: LLMTurnSource, executor?: ToolExecutor) {
  return new DefaultPipelineOrchestrator(
    new DefaultRequestContextHandler(),
    new DefaultTurnContextHandler(),
    new DefaultLLMHandler(source),
    new DefaultToolDispatchHandler(executor),
    new DefaultOutputHandler(),
  );
}

describe("Pipeline 集成：LLM -> ToolDispatch -> Output 全链路", () => {
  it("回合产出工具草案 -> 分发执行成功 -> 事件汇总", async () => {
    const source = makeSource({
      content: "",
      reasoningDeltas: [
        { text: "先看", partIndex: 0, itemId: "r1" },
        { text: "定义", partIndex: 0, itemId: "r1" },
      ],
      toolCalls: [
        { callId: "call-1", toolName: "read_file", toolKind: "read", parsedArgs: { path: "a.ts" } },
      ],
      finishReason: "tool_calls",
    });
    const executor = makeExecutor({ read_file: { ok: true, result: "file content" } });

    const out = await buildOrchestrator(source, executor).run({
      requestId: "req-1",
      turnId: "turn-1",
      startedAt: new Date().toISOString(),
      userInput: "看看 a.ts",
    });

    expect(out.llmStage).toBe("tool_calls_detected");
    expect(out.toolStage).toBe("tool_completed");
    expect(out.shouldContinue).toBe(true); // tool_calls -> 需要继续下一轮

    // 事件汇总应包含 reasoning.commit 与工具三段（planned/executing/completed）
    const types = out.committedEvents.map((e) => (e as any).type);
    expect(types).toContain("reasoning.commit");
    const toolPhases = out.committedEvents
      .filter((e) => (e as any).type === "tool.phase")
      .map((e) => (e as any).phase);
    expect(toolPhases).toEqual(["planned", "executing", "completed"]);
  });

  it("工具执行失败时汇总为 failed 事件且 toolStage=tool_failed", async () => {
    const source = makeSource({
      content: "",
      reasoningDeltas: [],
      toolCalls: [
        { callId: "call-1", toolName: "execute_command", toolKind: "command", parsedArgs: { command: "x" } },
      ],
      finishReason: "tool_calls",
    });
    const executor = makeExecutor({ execute_command: { ok: false, error: "命令失败" } });

    const out = await buildOrchestrator(source, executor).run({
      requestId: "req-1",
      turnId: "turn-1",
      startedAt: new Date().toISOString(),
      userInput: "跑个命令",
    });

    expect(out.toolStage).toBe("tool_failed");
    const failed = out.committedEvents.find(
      (e) => (e as any).type === "tool.phase" && (e as any).phase === "failed",
    ) as any;
    expect(failed).toBeTruthy();
    expect(failed.aiPayload).toEqual({ ok: false, error: "命令失败" });
  });

  it("无工具调用的纯回答回合：complete -> 产出 finalContent", async () => {
    const source = makeSource({
      content: "这是最终回答",
      reasoningDeltas: [{ text: "想一下", partIndex: 0, itemId: "r1" }],
      toolCalls: [],
      finishReason: "complete",
    });

    const out = await buildOrchestrator(source).run({
      requestId: "req-1",
      turnId: "turn-1",
      startedAt: new Date().toISOString(),
      userInput: "你好",
    });

    expect(out.llmStage).toBe("content_completed");
    expect(out.shouldContinue).toBe(false);
    expect(out.finalContent).toBe("这是最终回答");
  });

  it("执行器抛异常也被收敛为 failed 事件，不中断链路", async () => {
    const source = makeSource({
      content: "",
      reasoningDeltas: [],
      toolCalls: [
        { callId: "call-1", toolName: "read_file", toolKind: "read" },
      ],
      finishReason: "tool_calls",
    });
    const executor = makeExecutor({ read_file: "throw" });

    const out = await buildOrchestrator(source, executor).run({
      requestId: "req-1",
      turnId: "turn-1",
      startedAt: new Date().toISOString(),
      userInput: "看看",
    });

    expect(out.toolStage).toBe("tool_failed");
    const failed = out.committedEvents.find(
      (e) => (e as any).type === "tool.phase" && (e as any).phase === "failed",
    ) as any;
    expect(failed.aiPayload.ok).toBe(false);
    expect(failed.aiPayload.error).toContain("执行异常");
  });
});
