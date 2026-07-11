import { describe, expect, it } from "vitest";
import {
  DefaultRequestContextHandler,
  DefaultTurnContextHandler,
  DefaultOutputHandler,
} from "./index.js";

/**
 * 五段式责任链各节点的最小单元测试。
 *
 * 目的：在接入真实 LLM / 工具执行之前，先把纯数据组装与分支判定测细，
 * 保证后续接入真实逻辑时，这一层的行为是已知且稳定的。
 */

describe("DefaultRequestContextHandler", () => {
  it("应把 historyMessages 原样构造成 request 基础上下文", async () => {
    const handler = new DefaultRequestContextHandler();
    const history = [{ role: "user" as const, content: "上一条历史" }];

    const out = await handler.handle({
      requestId: "req-1",
      startedAt: "2025-01-01T00:00:00.000Z",
      userInput: "本次问题",
      historyMessages: history,
    });

    expect(out.stage).toBe("base_messages_built");
    expect(out.requestContext.requestId).toBe("req-1");
    expect(out.requestContext.baseMessages).toEqual(history);
    // 必须是拷贝，避免实现层直接持有外部传入引用
    expect(out.requestContext.baseMessages).not.toBe(history);
  });
});

describe("DefaultTurnContextHandler", () => {
  it("应把 baseMessages 与 addedMessages 顺序拼接成 effectiveMessages", async () => {
    const handler = new DefaultTurnContextHandler();

    const out = await handler.handle({
      requestId: "req-1",
      turnId: "turn-1",
      startedAt: "2025-01-01T00:00:00.000Z",
      requestContext: {
        requestId: "req-1",
        startedAt: "2025-01-01T00:00:00.000Z",
        baseMessages: [{ role: "system", content: "系统提示" }],
      },
      addedMessages: [{ role: "user", content: "本轮新增" }],
    });

    expect(out.stage).toBe("turn_context_ready");
    expect(out.turnContext.effectiveMessages).toEqual([
      { role: "system", content: "系统提示" },
      { role: "user", content: "本轮新增" },
    ]);
    // 运行态容器应初始化为空
    expect(out.turnContext.runtimeEvents).toEqual([]);
    expect(out.turnContext.committedEvents).toEqual([]);
    expect(out.turnContext.toolContexts).toEqual([]);
  });
});

describe("DefaultOutputHandler", () => {
  it("finishReason=tool_calls 时应继续下一轮，且不产出最终内容", async () => {
    const handler = new DefaultOutputHandler();
    const out = await handler.handle({
      requestId: "req-1",
      turnId: "turn-1",
      runtimeEvents: [],
      committedEvents: [],
      toolContexts: [],
      contentDraft: "工具轮叙述",
      finishReason: "tool_calls",
    });

    expect(out.shouldContinue).toBe(true);
    expect(out.finalContent).toBeUndefined();
    expect(out.stage).toBe("ready_to_commit");
  });

  it("finishReason=truncated 时应继续下一轮", async () => {
    const handler = new DefaultOutputHandler();
    const out = await handler.handle({
      requestId: "req-1",
      turnId: "turn-1",
      runtimeEvents: [],
      committedEvents: [],
      toolContexts: [],
      contentDraft: "半截内容",
      finishReason: "truncated",
    });

    expect(out.shouldContinue).toBe(true);
    expect(out.finalContent).toBeUndefined();
  });

  it("finishReason=complete 时应结束并产出最终内容", async () => {
    const handler = new DefaultOutputHandler();
    const out = await handler.handle({
      requestId: "req-1",
      turnId: "turn-1",
      runtimeEvents: [],
      committedEvents: [],
      toolContexts: [],
      contentDraft: "最终回答",
      finishReason: "complete",
    });

    expect(out.shouldContinue).toBe(false);
    expect(out.finalContent).toBe("最终回答");
  });

  it("finishReason=error 时不继续、不产出最终内容", async () => {
    const handler = new DefaultOutputHandler();
    const out = await handler.handle({
      requestId: "req-1",
      turnId: "turn-1",
      runtimeEvents: [],
      committedEvents: [],
      toolContexts: [],
      contentDraft: "出错前的半截",
      finishReason: "error",
    });

    expect(out.shouldContinue).toBe(false);
    expect(out.finalContent).toBeUndefined();
  });

  it("finishReason=cancelled 时不继续、不产出最终内容", async () => {
    const handler = new DefaultOutputHandler();
    const out = await handler.handle({
      requestId: "req-1",
      turnId: "turn-1",
      runtimeEvents: [],
      committedEvents: [],
      toolContexts: [],
      contentDraft: "取消前的半截",
      finishReason: "cancelled",
    });

    expect(out.shouldContinue).toBe(false);
    expect(out.finalContent).toBeUndefined();
  });
});
