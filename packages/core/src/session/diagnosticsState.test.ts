import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { AgentSession } from "../agentSession.js";
import type { AgentChannel } from "../channel/index.js";
import type { AgentHost } from "../host/index.js";

function hostStub(): AgentHost {
  return {
    fs: {
      read: async () => null,
      write: async () => {},
      append: async () => {},
      stat: async () => ({ isFile: true, isDir: false }),
      readdir: async () => [],
      mkdirp: async () => {},
      remove: async () => {},
    },
    commands: {} as any,
    diagnostics: {} as any,
    browser: {} as any,
    edits: {
      getMode: () => "auto",
      hasPending: () => false,
      getPendingPaths: () => [],
      getPendingDiffs: () => [],
      getPendingEditIds: () => [],
      getUndoablePaths: () => [],
      getUndoableEditIds: () => [],
      serialize: () => [],
      restore: () => {},
      setMode: () => {},
    } as any,
  } as AgentHost;
}

const channelStub: AgentChannel = { emit: () => {} };

describe("AI 诊断去重状态", () => {
  it("markAiTouchedFiles 会记录绝对路径；markDiagnosedFiles 仅移除成功诊断的文件", async () => {
    const s = new AgentSession("/workspace", channelStub, hostStub(), [], ["/workspace"] as any);
    s.setSessionId("sid");
    await (s as any).markAiTouchedFiles(["src/a.ts", "src/b.ts"]);
    const set1 = (s as any).aiTouchedFilesNeedingDiagnostics as Set<string>;
    expect(set1.has(resolve("/workspace", "src/a.ts"))).toBe(true);
    expect(set1.has(resolve("/workspace", "src/b.ts"))).toBe(true);

    await (s as any).markDiagnosedFiles(
      { paths: ["src/a.ts", "src/b.ts"] },
      { diagnostics: [{ path: "src/a.ts", ok: true }, { path: "src/b.ts", ok: false }] } as any,
      "success",
    );
    const set2 = (s as any).aiTouchedFilesNeedingDiagnostics as Set<string>;
    expect(set2.has(resolve("/workspace", "src/a.ts"))).toBe(false);
    expect(set2.has(resolve("/workspace", "src/b.ts"))).toBe(true);
  });
});
