import { describe, expect, it } from "vitest";
import { toolEventToFrontend, toolEventsToFrontend } from "./toolEventBridge.js";
import type { ToolEvent } from "./toolEventModel.js";

/** 构造一条指定阶段的 ToolEvent（仅测试用最小字段）。 */
function ev(phase: ToolEvent["phase"], extra: Partial<ToolEvent> = {}): ToolEvent {
  return {
    type: "tool.phase",
    ts: "2025-01-01T00:00:00.000Z",
    requestId: "req-1",
    turnId: "turn-1",
    source: "tool",
    stage: phase === "planned" || phase === "executing" ? "runtime" : "committed",
    callId: "c1",
    toolName: "read_file",
    toolKind: "read",
    phase,
    ...extra,
  } as ToolEvent;
}

describe("ToolEventBridge：ToolEvent → 前端事件", () => {
  it("planned → tool_call(pending)，不带 args", () => {
    const fe = toolEventToFrontend(ev("planned", { rawArgsText: '{"path":"a.ts"}' }));
    expect(fe).toEqual({
      type: "tool_call",
      payload: { id: "c1", name: "read_file", args: undefined, status: "pending" },
    });
  });

  it("executing → tool_call(executing)，携带 parsedArgs", () => {
    const fe = toolEventToFrontend(ev("executing", { parsedArgs: { path: "a.ts" } }));
    expect(fe).toEqual({
      type: "tool_call",
      payload: { id: "c1", name: "read_file", args: { path: "a.ts" }, status: "executing" },
    });
  });

  it("completed → tool_result(success)，result 取 aiPayload.result", () => {
    const fe = toolEventToFrontend(ev("completed", { aiPayload: { ok: true, result: "文件内容" } }));
    expect(fe?.type).toBe("tool_result");
    expect(fe?.payload.status).toBe("success");
    expect(fe?.payload.result).toBe("文件内容");
  });

  it("failed → tool_result(error)，result 取 aiPayload.error", () => {
    const fe = toolEventToFrontend(ev("failed", { aiPayload: { ok: false, error: "读取失败" } }));
    expect(fe?.type).toBe("tool_result");
    expect(fe?.payload.status).toBe("error");
    expect(fe?.payload.result).toBe("读取失败");
  });

  it("cancelled + blocked → tool_result(error)（门控拦截按 error 展示）", () => {
    const fe = toolEventToFrontend(ev("cancelled", { gateState: "blocked", aiPayload: { ok: false, error: "命令未获授权" } }));
    expect(fe?.type).toBe("tool_result");
    expect(fe?.payload.status).toBe("error");
    expect(fe?.payload.result).toBe("命令未获授权");
  });

  it("cancelled（普通取消）→ tool_result(cancelled)", () => {
    const fe = toolEventToFrontend(ev("cancelled", { aiPayload: { ok: false, error: "已取消" } }));
    expect(fe?.payload.status).toBe("cancelled");
  });

  it("visibility=suppressed 的事件不驱动前端（返回 null）", () => {
    expect(toolEventToFrontend(ev("completed", { visibility: "suppressed" }))).toBeNull();
    expect(toolEventToFrontend(ev("planned", { visibility: "debug_only" }))).toBeNull();
  });

  it("批量翻译：过滤掉 suppressed，保留其余并保序", () => {
    const events: ToolEvent[] = [
      ev("planned"),
      ev("executing", { parsedArgs: { path: "a.ts" } }),
      ev("completed", { visibility: "suppressed" }),
      ev("failed", { aiPayload: { ok: false, error: "x" } }),
    ];
    const out = toolEventsToFrontend(events);
    expect(out.map((e) => `${e.type}:${e.payload.status}`)).toEqual([
      "tool_call:pending",
      "tool_call:executing",
      "tool_result:error",
    ]);
  });
});
