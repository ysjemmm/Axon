import { describe, expect, it, vi } from "vitest";
import { deriveSubAgentHost } from "./derive.js";
import { createScopedHost } from "./scopedHost.js";
import type { AgentHost } from "./index.js";

/** 构造一个可观测 fork 行为的 mock host */
function makeHost() {
  const makeCommands = (): any => ({
    exec: vi.fn(async () => ({ stdout: "", stderr: "", timedOut: false, exitCode: 0 })),
    fork: vi.fn(() => makeCommands()),
  });
  const commands = makeCommands();
  const edits: any = {
    fork: vi.fn(() => ({})),
  };
  return { commands, edits, fs: {}, diagnostics: {}, browser: {} };
}

describe("子 Agent host 派生：命令执行器隔离", () => {
  it("deriveSubAgentHost fork commands，返回独立实例而非父终端", () => {
    const parent = makeHost() as unknown as AgentHost;
    const child = deriveSubAgentHost(parent);
    expect(parent.commands.fork).toHaveBeenCalledTimes(1);
    expect(child.commands).not.toBe(parent.commands);
  });

  it("createScopedHost fork commands，返回独立实例而非父终端", () => {
    const parent = makeHost() as unknown as AgentHost;
    const child = createScopedHost(parent, ["src/**"], "/cwd");
    expect(parent.commands.fork).toHaveBeenCalledTimes(1);
    expect(child.commands).not.toBe(parent.commands);
  });
});
