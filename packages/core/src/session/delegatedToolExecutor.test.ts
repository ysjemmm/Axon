import { describe, expect, it, vi } from "vitest";
import { ToolName } from "../tools/index.js";
import { DelegatedToolExecutor } from "./delegatedToolExecutor.js";

function makeExecutor(overrides: Partial<ConstructorParameters<typeof DelegatedToolExecutor>[0]> = {}) {
  return new DelegatedToolExecutor({
    runDelegateTask: vi.fn(async () => "delegated"),
    runParallelResearch: vi.fn(async () => "researched"),
    runParallelExecution: vi.fn(async () => "executed"),
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

  it("parallel_research：委托给 runParallelResearch", async () => {
    const runParallelResearch = vi.fn(async () => "researched");
    const ex = makeExecutor({ runParallelResearch });
    const out = await ex.execute({ toolName: ToolName.ParallelResearch, toolArgs: { tasks: [] }, toolCallId: "c2" });
    expect(out).toEqual({ result: "researched", status: "success" });
    expect(runParallelResearch).toHaveBeenCalledWith({ tasks: [] }, "c2");
  });

  it("parallel_execute：委托给 runParallelExecution", async () => {
    const runParallelExecution = vi.fn(async () => "executed");
    const ex = makeExecutor({ runParallelExecution });
    const out = await ex.execute({ toolName: ToolName.ParallelExecute, toolArgs: { tasks: [] }, toolCallId: "c3" });
    expect(out).toEqual({ result: "executed", status: "success" });
    expect(runParallelExecution).toHaveBeenCalledWith({ tasks: [] }, "c3");
  });

  it("各分支异常时收敛为对应错误文案", async () => {
    const ex = makeExecutor({
      runDelegateTask: vi.fn(async () => { throw new Error("d boom"); }),
      runParallelResearch: vi.fn(async () => { throw new Error("r boom"); }),
      runParallelExecution: vi.fn(async () => { throw new Error("e boom"); }),
    });

    await expect(ex.execute({ toolName: ToolName.DelegateTask, toolArgs: {}, toolCallId: "c1" }))
      .resolves.toEqual({ result: "委托子 Agent 失败: d boom", status: "error" });
    await expect(ex.execute({ toolName: ToolName.ParallelResearch, toolArgs: {}, toolCallId: "c2" }))
      .resolves.toEqual({ result: "并行调研失败: r boom", status: "error" });
    await expect(ex.execute({ toolName: ToolName.ParallelExecute, toolArgs: {}, toolCallId: "c3" }))
      .resolves.toEqual({ result: "并行执行失败: e boom", status: "error" });
  });
});
