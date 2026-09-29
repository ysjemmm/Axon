import { describe, expect, it, vi } from "vitest";
import { ToolName } from "../tools/index.js";
import { DelegatedToolExecutor } from "./delegatedToolExecutor.js";

function makeExecutor(overrides: Partial<ConstructorParameters<typeof DelegatedToolExecutor>[0]> = {}) {
  return new DelegatedToolExecutor({
    runDelegateTask: vi.fn(async () => "delegated"),
    ...overrides,
  });
}

describe("DelegatedToolExecutor", () => {
  it("delegate_task：委托给 runDelegateTask", async () => {
    const runDelegateTask = vi.fn(async () => "delegated");
    const ex = makeExecutor({ runDelegateTask });
    const out = await ex.execute({ toolName: ToolName.DelegateTask, toolArgs: { prompt: "x" }, toolCallId: "c1" });
    expect(out).toEqual({ result: "delegated", status: "success" });
    expect(runDelegateTask).toHaveBeenCalledWith({ prompt: "x" }, "c1");
  });

  it("异常时收敛为错误文案", async () => {
    const ex = makeExecutor({
      runDelegateTask: vi.fn(async () => { throw new Error("d boom"); }),
    });

    await expect(ex.execute({ toolName: ToolName.DelegateTask, toolArgs: {}, toolCallId: "c1" }))
      .resolves.toEqual({ result: "委托子 Agent 失败: d boom", status: "error" });
  });
});
