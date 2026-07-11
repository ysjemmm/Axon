import { describe, expect, it, vi } from "vitest";
import { ToolOutcomeRecorder } from "./toolOutcomeRecorder.js";

describe("ToolOutcomeRecorder", () => {
  function makeRecorder() {
    const send = vi.fn();
    const pushToolMessage = vi.fn();
    const markNextAsTransient = vi.fn();
    const recorder = new ToolOutcomeRecorder({ send, pushToolMessage, markNextAsTransient });
    return { recorder, send, pushToolMessage, markNextAsTransient };
  }

  it("普通成功结果：发送 tool_result，并写入工具消息", () => {
    const { recorder, send, pushToolMessage } = makeRecorder();
    const guard: any = { recordToolResult: vi.fn() };
    const out = recorder.record({
      toolCallId: "c1",
      toolName: "search",
      toolArgs: { query: "x" },
      result: "ok",
      status: "success",
      meta: {} as any,
      displayCwd: "",
      guard,
      mutatedFiles: new Set(),
      isPending: false,
    });

    expect(out).toEqual({ mutated: false, diagnosed: false });
    expect(send).toHaveBeenCalledWith("tool_result", expect.objectContaining({ id: "c1", name: "search", result: "ok", status: "success" }));
    expect(pushToolMessage).toHaveBeenCalledWith(expect.objectContaining({ tool_call_id: "c1", _toolName: "search", content: "ok", status: "success" }));
  });

  it("soft-fail 工具成功后补发 tool_call(success)", () => {
    const { recorder, send } = makeRecorder();
    const guard: any = { recordToolResult: vi.fn() };
    recorder.record({
      toolCallId: "c1",
      toolName: "read_file",
      toolArgs: { path: "a.ts" },
      result: "content",
      status: "success",
      meta: {} as any,
      displayCwd: "",
      guard,
      mutatedFiles: new Set(),
      isPending: false,
    });
    expect(send).toHaveBeenCalledWith("tool_call", expect.objectContaining({ id: "c1", name: "read_file", status: "success" }));
  });

  it("编辑工具软失败：标 hidden + transient，不补发 tool_call", () => {
    const { recorder, send, markNextAsTransient } = makeRecorder();
    const guard: any = { recordToolResult: vi.fn() };
    const meta: any = {};
    recorder.record({
      toolCallId: "c1",
      toolName: "str_replace",
      toolArgs: { path: "a.ts" },
      result: "未找到匹配 oldStr",
      status: "error",
      meta,
      displayCwd: "",
      guard,
      mutatedFiles: new Set(),
      isPending: false,
    });
    expect(meta.hidden).toBe(true);
    expect(markNextAsTransient).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith("tool_call", expect.anything());
  });

  it("commandWasEdited 会注入 AI hint，同时 displayCommand/displayContent 保留原结果", () => {
    const { recorder, pushToolMessage } = makeRecorder();
    const guard: any = { recordToolResult: vi.fn() };
    recorder.record({
      toolCallId: "c1",
      toolName: "execute_command",
      toolArgs: { command: "ls -la" },
      result: "real output",
      status: "success",
      commandWasEdited: "ls -la",
      meta: {} as any,
      displayCwd: "/tmp",
      guard,
      mutatedFiles: new Set(),
      isPending: false,
    });
    const msg = pushToolMessage.mock.calls[0][0];
    expect(msg.content).toContain("用户在审批环节将你请求的命令手动改为");
    expect(msg.displayCommand).toBe("ls -la");
    expect(msg.displayContent).toBe("real output");
  });

  it("check_diagnostics 标记 diagnosed=true，fileDiff 标记 mutated=true", () => {
    const { recorder } = makeRecorder();
    const guard: any = { recordToolResult: vi.fn() };
    const out = recorder.record({
      toolCallId: "c1",
      toolName: "check_diagnostics",
      toolArgs: { paths: ["a.ts"] },
      result: "ok",
      status: "success",
      meta: { fileDiff: { path: "a.ts" } } as any,
      displayCwd: "",
      guard,
      mutatedFiles: new Set(),
      isPending: false,
    });
    expect(out).toEqual({ mutated: true, diagnosed: true });
  });
});
