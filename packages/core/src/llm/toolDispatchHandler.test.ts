import { describe, expect, it } from "vitest";
import { DefaultToolDispatchHandler } from "./toolDispatchHandler.js";
import type { ToolExecutor, ToolExecuteRequest, ToolExecuteResult } from "./toolExecutor.js";
import type { ToolDispatchHandlerInput } from "./toolDispatchHandlerContract.js";
import type { ToolEvent } from "./toolEventModel.js";
import type { ToolGateDecider, ToolGateDecision } from "./toolGateDecider.js";

/** 构造一个最小工具草案（planned 阶段的 ToolEvent，仅用于测试输入）。 */
function draft(callId: string, toolName: string, parsedArgs?: Record<string, unknown>): ToolEvent {
  return {
    type: "tool.phase",
    ts: "2025-01-01T00:00:00.000Z",
    requestId: "req-1",
    turnId: "turn-1",
    source: "tool",
    stage: "runtime",
    callId,
    toolName,
    toolKind: "read",
    phase: "planned",
    parsedArgs,
  } as ToolEvent;
}

function makeInput(drafts: ToolEvent[]): ToolDispatchHandlerInput {
  return {
    requestId: "req-1",
    turnId: "turn-1",
    toolDrafts: drafts,
    toolContexts: [],
  };
}

describe("DefaultToolDispatchHandler", () => {
  it("无草案时保持 dispatching 空转", async () => {
    const h = new DefaultToolDispatchHandler();
    const out = await h.handle(makeInput([]));
    expect(out.stage).toBe("dispatching");
    expect(out.toolResultsReady).toBe(false);
    expect(out.runtimeEvents).toHaveLength(0);
  });

  it("有草案但未注入 executor 时退回骨架模式（draft_received）", async () => {
    const h = new DefaultToolDispatchHandler();
    const out = await h.handle(makeInput([draft("c1", "read_file")]));
    expect(out.stage).toBe("draft_received");
    expect(out.toolResultsReady).toBe(false);
    expect(out.runtimeEvents).toHaveLength(0);
  });

  it("注入 executor：成功执行产出 plan/execute/complete 三事件", async () => {
    const executor: ToolExecutor = {
      async execute(_req: ToolExecuteRequest): Promise<ToolExecuteResult> {
        return { ok: true, result: "文件内容" };
      },
    };
    const h = new DefaultToolDispatchHandler(executor);
    const out = await h.handle(makeInput([draft("c1", "read_file", { path: "a.ts" })]));

    expect(out.stage).toBe("tool_completed");
    expect(out.toolResultsReady).toBe(true);
    const phases = out.runtimeEvents.map((e) => (e as ToolEvent).phase);
    expect(phases).toEqual(["planned", "executing", "completed"]);
    const last = out.runtimeEvents[out.runtimeEvents.length - 1] as ToolEvent;
    expect(last.aiPayload).toEqual({ ok: true, result: "文件内容" });
    expect(out.toolContexts).toHaveLength(1);
    expect(out.toolContexts[0].partialToolEvent?.phase).toBe("completed");
  });

  it("注入 executor：执行失败收敛为 fail 事件", async () => {
    const executor: ToolExecutor = {
      async execute(): Promise<ToolExecuteResult> {
        return { ok: false, error: "读取失败" };
      },
    };
    const h = new DefaultToolDispatchHandler(executor);
    const out = await h.handle(makeInput([draft("c1", "read_file")]));

    expect(out.stage).toBe("tool_failed");
    const phases = out.runtimeEvents.map((e) => (e as ToolEvent).phase);
    expect(phases).toEqual(["planned", "executing", "failed"]);
    const last = out.runtimeEvents[out.runtimeEvents.length - 1] as ToolEvent;
    expect(last.aiPayload).toEqual({ ok: false, error: "读取失败" });
  });

  it("executor 抛异常也收敛为 fail 事件，不静默吞掉", async () => {
    const executor: ToolExecutor = {
      async execute(): Promise<ToolExecuteResult> {
        throw new Error("宿主崩了");
      },
    };
    const h = new DefaultToolDispatchHandler(executor);
    const out = await h.handle(makeInput([draft("c1", "read_file")]));

    expect(out.stage).toBe("tool_failed");
    const last = out.runtimeEvents[out.runtimeEvents.length - 1] as ToolEvent;
    expect(last.phase).toBe("failed");
    expect(last.aiPayload?.error).toBe("宿主崩了");
  });

  it("多个草案：一成一败时整体判为 tool_failed", async () => {
    const executor: ToolExecutor = {
      async execute(req: ToolExecuteRequest): Promise<ToolExecuteResult> {
        return req.callId === "c2" ? { ok: false, error: "x" } : { ok: true, result: "ok" };
      },
    };
    const h = new DefaultToolDispatchHandler(executor);
    const out = await h.handle(makeInput([draft("c1", "read_file"), draft("c2", "search")]));

    expect(out.stage).toBe("tool_failed");
    expect(out.toolContexts).toHaveLength(2);
    // 每个工具各产出 plan/execute/终态 三事件
    expect(out.runtimeEvents).toHaveLength(6);
  });

  describe("门控决策器（方案 B）", () => {
    const okExecutor: ToolExecutor = {
      async execute(): Promise<ToolExecuteResult> {
        return { ok: true, result: "ok" };
      },
    };

    function makeGate(fn: (req: { toolName: string; parsedArgs?: Record<string, unknown> }) => ToolGateDecision): ToolGateDecider {
      return { async decide(req) { return fn(req); } };
    }

    it("放行：门控 allow 时正常 plan/execute/complete", async () => {
      const gate = makeGate(() => ({ action: "allow" }));
      const h = new DefaultToolDispatchHandler(okExecutor, gate);
      const out = await h.handle(makeInput([draft("c1", "read_file")]));

      expect(out.stage).toBe("tool_completed");
      const phases = out.runtimeEvents.map((e) => (e as ToolEvent).phase);
      expect(phases).toEqual(["planned", "executing", "completed"]);
    });

    it("拦截：门控 block 时工具不执行，收敛为 cancelled 终态", async () => {
      let executed = false;
      const executor: ToolExecutor = {
        async execute(): Promise<ToolExecuteResult> { executed = true; return { ok: true }; },
      };
      const gate = makeGate(() => ({ action: "block", reason: "命令未获授权" }));
      const h = new DefaultToolDispatchHandler(executor, gate);
      const out = await h.handle(makeInput([draft("c1", "execute_command", { command: "rm -rf /" })]));

      expect(executed).toBe(false); // 被拦截，执行器不应被调用
      expect(out.stage).toBe("tool_failed");
      const phases = out.runtimeEvents.map((e) => (e as ToolEvent).phase);
      expect(phases).toEqual(["planned", "cancelled"]); // plan 后直接 block→cancelled，无 executing
      const last = out.runtimeEvents[out.runtimeEvents.length - 1] as ToolEvent;
      expect(last.gateState).toBe("blocked");
      expect(last.aiPayload).toEqual({ ok: false, error: "命令未获授权" });
    });

    it("改写参数：门控 allow 携带 editedArgs 时用改写后的参数执行", async () => {
      let seenArgs: Record<string, unknown> | undefined;
      const executor: ToolExecutor = {
        async execute(req): Promise<ToolExecuteResult> { seenArgs = req.parsedArgs; return { ok: true, result: "ok" }; },
      };
      const gate = makeGate(() => ({ action: "allow", editedArgs: { command: "ls -la" } }));
      const h = new DefaultToolDispatchHandler(executor, gate);
      const out = await h.handle(makeInput([draft("c1", "execute_command", { command: "ls" })]));

      expect(out.stage).toBe("tool_completed");
      expect(seenArgs).toEqual({ command: "ls -la" }); // 执行用的是改写后的参数
    });

    it("决策器抛异常时保守拦截（安全优先，不放行）", async () => {
      let executed = false;
      const executor: ToolExecutor = {
        async execute(): Promise<ToolExecuteResult> { executed = true; return { ok: true }; },
      };
      const gate: ToolGateDecider = { async decide() { throw new Error("门控崩了"); } };
      const h = new DefaultToolDispatchHandler(executor, gate);
      const out = await h.handle(makeInput([draft("c1", "execute_command", { command: "x" })]));

      expect(executed).toBe(false);
      expect(out.stage).toBe("tool_failed");
      const last = out.runtimeEvents[out.runtimeEvents.length - 1] as ToolEvent;
      expect(last.phase).toBe("cancelled");
      expect(last.aiPayload?.error).toContain("门控决策异常");
    });
  });
});
