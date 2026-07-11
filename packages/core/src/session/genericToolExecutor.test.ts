import { describe, expect, it, vi } from "vitest";
import type { AgentHost } from "../host/index.js";
import { GenericToolExecutor } from "./genericToolExecutor.js";

vi.mock("../tools/index.js", async () => {
  const actual = await vi.importActual<any>("../tools/index.js");
  return {
    ...actual,
    executeToolCall: vi.fn(async (toolName: string) => `ok:${toolName}`),
  };
});

vi.mock("./toolTargetFiles.js", () => ({
  extractTargetFiles: vi.fn(async () => ["/abs/a.ts"]),
}));

describe("GenericToolExecutor", () => {
  function makeDeps(overrides: Partial<ConstructorParameters<typeof GenericToolExecutor>[0]> = {}) {
    return {
      cwd: "/workspace",
      host: {} as AgentHost,
      workspaces: ["/workspace"],
      snapshotMgr: {
        beforeEdit: vi.fn(async () => true),
        list: vi.fn(async () => [{ id: "s1" }]),
      } as any,
      sendSnapshotsListed: vi.fn(),
      trackTerminalCwd: vi.fn(),
      ...overrides,
    };
  }

  it("写文件工具执行前创建快照，并推送 snapshots_listed", async () => {
    const deps = makeDeps();
    const ex = new GenericToolExecutor(deps);
    const out = await ex.execute({
      toolName: "str_replace",
      toolArgs: { path: "a.ts" },
      meta: {} as any,
      runtime: { mode: "agent", turnCount: 3, guard: { noteFileRead: vi.fn(() => "") } as any, aiTouchedFilesNeedingDiagnostics: new Set<string>() },
    });
    expect((deps.snapshotMgr as any).beforeEdit).toHaveBeenCalledWith("turn-3", ["/abs/a.ts"]);
    expect(deps.sendSnapshotsListed).toHaveBeenCalledWith([{ id: "s1" }]);
    expect(out).toEqual({ result: "ok:str_replace", status: "success" });
  });

  it("quest 模式不创建快照", async () => {
    const deps = makeDeps();
    const ex = new GenericToolExecutor(deps);
    await ex.execute({
      toolName: "str_replace",
      toolArgs: { path: "a.ts" },
      meta: {} as any,
      runtime: { mode: "quest", turnCount: 3, guard: { noteFileRead: vi.fn(() => "") } as any, aiTouchedFilesNeedingDiagnostics: new Set<string>() },
    });
    expect((deps.snapshotMgr as any).beforeEdit).not.toHaveBeenCalled();
  });

  it("read_file 追加 LoopGuard 的重复读取提示", async () => {
    const deps = makeDeps();
    const ex = new GenericToolExecutor(deps);
    const runtime = { mode: "agent" as const, turnCount: 3, guard: { noteFileRead: vi.fn(() => "\n[extra]") } as any, aiTouchedFilesNeedingDiagnostics: new Set<string>() };
    const out = await ex.execute({ toolName: "read_file", toolArgs: { path: "a.ts" }, meta: {} as any, runtime });
    expect(runtime.guard.noteFileRead).toHaveBeenCalledWith("a.ts");
    expect(out).toEqual({ result: "ok:read_file\n[extra]", status: "success" });
  });

  it("异常时收敛为 error 文案", async () => {
    const { executeToolCall } = await import("../tools/index.js");
    (executeToolCall as any).mockImplementationOnce(async () => { throw new Error("boom"); });
    const deps = makeDeps();
    const ex = new GenericToolExecutor(deps);
    const out = await ex.execute({ toolName: "search", toolArgs: {}, meta: {} as any, runtime: { mode: "agent", turnCount: 1, guard: { noteFileRead: vi.fn(() => "") } as any, aiTouchedFilesNeedingDiagnostics: new Set<string>() } });
    expect(out).toEqual({ result: "错误: boom", status: "error" });
  });
});
