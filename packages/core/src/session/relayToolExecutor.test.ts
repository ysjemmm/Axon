import { describe, expect, it, vi } from "vitest";
import { ToolName } from "../tools/index.js";
import { RelayToolExecutor } from "./relayToolExecutor.js";

function makeExecutor(overrides: Partial<ConstructorParameters<typeof RelayToolExecutor>[0]> = {}) {
  return new RelayToolExecutor({
    waitForToolConfirmation: vi.fn(async () => true),
    runRelayCreate: vi.fn(async () => "created"),
    runRelaySaveDoc: vi.fn(async () => "saved"),
    runRelayAdvance: vi.fn(async () => "advanced"),
    runRelayUpdateTask: vi.fn(async () => "updated"),
    runRelayReviewTask: vi.fn(async () => "reviewed"),
    ...overrides,
  });
}

describe("RelayToolExecutor", () => {
  it("relay_create：用户确认后执行 create", async () => {
    const runRelayCreate = vi.fn(async () => "created");
    const ex = makeExecutor({ runRelayCreate });
    const meta: any = {};
    const out = await ex.execute({ toolName: ToolName.RelayCreate, toolArgs: { title: "x" }, meta });
    expect(out).toEqual({ result: "created", status: "success" });
    expect(runRelayCreate).toHaveBeenCalled();
  });

  it("relay_create：用户拒绝时返回原文案并写 meta.userMessage", async () => {
    const ex = makeExecutor({ waitForToolConfirmation: vi.fn(async () => false) });
    const meta: any = {};
    const out = await ex.execute({ toolName: ToolName.RelayCreate, toolArgs: { title: "x" }, meta });
    expect(out.status).toBe("error");
    expect(out.result).toContain("用户拒绝创建 Relay 工作流");
    expect(meta.userMessage).toBe("用户跳过了 Relay 创建");
  });

  it("其余 relay_* 直接委托对应 runner", async () => {
    const runRelaySaveDoc = vi.fn(async () => "saved");
    const runRelayAdvance = vi.fn(async () => "advanced");
    const runRelayUpdateTask = vi.fn(async () => "updated");
    const runRelayReviewTask = vi.fn(async () => "reviewed");
    const ex = makeExecutor({ runRelaySaveDoc, runRelayAdvance, runRelayUpdateTask, runRelayReviewTask });
    const meta: any = {};
    await expect(ex.execute({ toolName: ToolName.RelaySaveDoc, toolArgs: {}, meta })).resolves.toEqual({ result: "saved", status: "success" });
    await expect(ex.execute({ toolName: ToolName.RelayAdvance, toolArgs: {}, meta })).resolves.toEqual({ result: "advanced", status: "success" });
    await expect(ex.execute({ toolName: ToolName.RelayUpdateTask, toolArgs: {}, meta })).resolves.toEqual({ result: "updated", status: "success" });
    await expect(ex.execute({ toolName: ToolName.RelayReviewTask, toolArgs: {}, meta })).resolves.toEqual({ result: "reviewed", status: "success" });
  });

  it("runner 抛异常时收敛为 error", async () => {
    const ex = makeExecutor({ runRelayAdvance: vi.fn(async () => { throw new Error("boom"); }) });
    const meta: any = {};
    const out = await ex.execute({ toolName: ToolName.RelayAdvance, toolArgs: {}, meta });
    expect(out).toEqual({ result: "Relay 操作失败: boom", status: "error" });
  });
});
