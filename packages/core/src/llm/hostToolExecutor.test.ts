import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostToolExecutor } from "./hostToolExecutor.js";

// 用 vi.mock 拦截现网 executeToolCall，只验证本适配器的“形状适配”职责，
// 不真正触碰文件系统/宿主能力。
vi.mock("../tools/index.js", () => ({
  executeToolCall: vi.fn(),
}));

import { executeToolCall } from "../tools/index.js";

const mockExecute = executeToolCall as unknown as ReturnType<typeof vi.fn>;

function makeExecutor() {
  return new HostToolExecutor({
    cwd: "/ws",
    host: {} as any,
    workspaces: ["/ws"],
  });
}

describe("HostToolExecutor", () => {
  beforeEach(() => {
    mockExecute.mockReset();
  });

  it("executeToolCall 成功返回结果文本时归一化为 ok=true", async () => {
    mockExecute.mockResolvedValueOnce("file content");
    const out = await makeExecutor().execute({
      callId: "call-1",
      toolName: "read_file",
      parsedArgs: { path: "a.ts" },
    });
    expect(out).toEqual({ ok: true, result: "file content" });
  });

  it("executeToolCall 抛异常时归一化为 ok=false 且携带错误信息", async () => {
    mockExecute.mockRejectedValueOnce(new Error("读取失败"));
    const out = await makeExecutor().execute({
      callId: "call-2",
      toolName: "read_file",
      parsedArgs: { path: "missing.ts" },
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("读取失败");
  });

  it("parsedArgs 缺失时退回空对象调用（不抛错，交由 executeToolCall 内部校验）", async () => {
    mockExecute.mockResolvedValueOnce("ok");
    await makeExecutor().execute({ callId: "call-3", toolName: "list_processes" });
    // 第 2 个位置参数应为解析后的参数对象，缺失时退回 {}
    expect(mockExecute.mock.calls[0][1]).toEqual({});
  });

  it("按注入的会话依赖透传 cwd / workspaces", async () => {
    mockExecute.mockResolvedValueOnce("ok");
    await makeExecutor().execute({ callId: "call-4", toolName: "search", parsedArgs: { query: "x" } });
    expect(mockExecute.mock.calls[0][2]).toBe("/ws");
    expect(mockExecute.mock.calls[0][5]).toEqual(["/ws"]);
  });
});
