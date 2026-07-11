import { describe, expect, it } from "vitest";
import { ToolCallStateMachine, toolPhaseToStage } from "./toolCallStateMachine.js";

const ctx = {
  requestId: "req-1",
  turnId: "turn-1",
  callId: "call-1",
  toolName: "read_file",
  toolKind: "read" as const,
  now: () => "2025-01-01T00:00:00.000Z",
};

describe("toolPhaseToStage", () => {
  it("planned/executing 为 runtime，终态为 committed", () => {
    expect(toolPhaseToStage("planned")).toBe("runtime");
    expect(toolPhaseToStage("executing")).toBe("runtime");
    expect(toolPhaseToStage("completed")).toBe("committed");
    expect(toolPhaseToStage("failed")).toBe("committed");
    expect(toolPhaseToStage("cancelled")).toBe("committed");
  });
});

describe("ToolCallStateMachine", () => {
  it("plan -> execute -> complete 正常闭环", () => {
    const m = new ToolCallStateMachine(ctx);
    const planned = m.plan('{"path":"a.ts"}');
    expect(planned.phase).toBe("planned");
    expect(planned.stage).toBe("runtime");
    expect(planned.rawArgsText).toBe('{"path":"a.ts"}');

    const executing = m.execute({ path: "a.ts" });
    expect(executing.phase).toBe("executing");
    expect(executing.parsedArgs).toEqual({ path: "a.ts" });

    const completed = m.complete("file content");
    expect(completed.phase).toBe("completed");
    expect(completed.stage).toBe("committed");
    expect(completed.aiPayload).toEqual({ ok: true, result: "file content" });
    expect(completed.tracePayload).toEqual({ rawResult: "file content" });
    expect(m.isTerminal()).toBe(true);
  });

  it("plan -> execute -> fail 产出错误载荷", () => {
    const m = new ToolCallStateMachine(ctx);
    m.plan();
    m.execute();
    const failed = m.fail("读取失败");
    expect(failed.phase).toBe("failed");
    expect(failed.aiPayload).toEqual({ ok: false, error: "读取失败" });
    expect(failed.tracePayload).toEqual({ rawError: "读取失败" });
    expect(m.isTerminal()).toBe(true);
  });

  it("planned 直接 cancel 合法", () => {
    const m = new ToolCallStateMachine(ctx);
    m.plan();
    const cancelled = m.cancel("用户取消");
    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.aiPayload).toEqual({ ok: false, error: "用户取消" });
    expect(m.isTerminal()).toBe(true);
  });

  it("executing 阶段可以 cancel", () => {
    const m = new ToolCallStateMachine(ctx);
    m.plan();
    m.execute();
    expect(m.cancel().phase).toBe("cancelled");
  });

  it("终态后再推进抛错", () => {
    const m = new ToolCallStateMachine(ctx);
    m.plan();
    m.execute();
    m.complete();
    expect(() => m.execute()).toThrow(/非法工具状态流转/);
    expect(() => m.fail("x")).toThrow(/非法工具状态流转/);
  });

  it("planned 不能直接 complete（必须先 executing）", () => {
    const m = new ToolCallStateMachine(ctx);
    m.plan();
    expect(() => m.complete()).toThrow(/非法工具状态流转/);
  });

  it("complete 支持 outcomeKind（如 noop）", () => {
    const m = new ToolCallStateMachine(ctx);
    m.plan();
    m.execute();
    const completed = m.complete(undefined, "noop");
    expect(completed.outcomeKind).toBe("noop");
    expect(completed.tracePayload).toBeUndefined();
  });
});

describe("ToolCallStateMachine 门控流转", () => {
  it("plan -> requireGate(waiting_confirm) -> approveGate -> execute -> complete", () => {
    const m = new ToolCallStateMachine(ctx);
    m.plan();
    const gated = m.requireGate("waiting_confirm");
    expect(gated.phase).toBe("planned");
    expect(gated.gateState).toBe("waiting_confirm");
    expect(m.isWaitingGate()).toBe(true);

    const approved = m.approveGate();
    expect(approved.gateState).toBe("none");
    expect(m.isWaitingGate()).toBe(false);

    expect(m.execute().phase).toBe("executing");
    expect(m.complete().phase).toBe("completed");
  });

  it("门控未放行时不能 execute", () => {
    const m = new ToolCallStateMachine(ctx);
    m.plan();
    m.requireGate("waiting_input");
    expect(() => m.execute()).toThrow(/仍在等待门控处理/);
  });

  it("block 作为拦截终态收尾（未执行）", () => {
    const m = new ToolCallStateMachine(ctx);
    m.plan();
    const blocked = m.block("危险命令被拦截");
    expect(blocked.phase).toBe("cancelled");
    expect(blocked.gateState).toBe("blocked");
    expect(blocked.aiPayload).toEqual({ ok: false, error: "危险命令被拦截" });
    expect(m.isTerminal()).toBe(true);
  });

  it("requireGate 只能在 planned 阶段挂起", () => {
    const m = new ToolCallStateMachine(ctx);
    m.plan();
    m.execute();
    expect(() => m.requireGate("waiting_confirm")).toThrow(/只能在 planned 阶段挂起/);
  });

  it("没有待处理门控时 approveGate 抛错", () => {
    const m = new ToolCallStateMachine(ctx);
    m.plan();
    expect(() => m.approveGate()).toThrow(/没有待处理的门控/);
  });

  it("block 只能发生在 planned 阶段", () => {
    const m = new ToolCallStateMachine(ctx);
    m.plan();
    m.execute();
    expect(() => m.block()).toThrow(/拦截只能发生在 planned 阶段/);
  });
});
