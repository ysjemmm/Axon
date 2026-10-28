import { describe, expect, it } from "vitest";
import { AgentSession } from "../agentSession.js";
import type { AgentHost } from "../host/index.js";

function minimalHost(): AgentHost {
  return {
    fs: { read: async () => null, write: async () => {}, append: async () => {}, stat: async () => null, readdir: async () => [], mkdirp: async () => {}, remove: async () => {} },
    commands: {} as any, diagnostics: {} as any, browser: {} as any,
    edits: { getMode: () => "auto", hasPending: () => false, getPendingPaths: () => [], getPendingDiffs: () => [], getPendingEditIds: () => [], getUndoablePaths: () => [], getUndoableEditIds: () => [], serialize: () => [], restore: () => {}, setMode: () => {} } as any,
  } as AgentHost;
}

describe("上下文占用按来源拆分", () => {
  it("各项加和等于推给界面的总量，并带上自动 / 手动压缩阈值", () => {
    const events: any[] = [];
    const s = new AgentSession("/work", { emit: (e: any) => events.push(e) }, minimalHost(), [
      { role: "system", content: "你是 Axon，" },
      { role: "user", content: "帮我看看这个项目".repeat(50) },
      { role: "assistant", content: "好的".repeat(100) },
    ] as any);
    s.setMemory("## 用户偏好\n\n- 中文回复", "user");
    s.updateAndSendTokenUsage();
    const usage = events.filter((e) => e.type === "token_usage").at(-1);
    const b = usage.breakdown;
    const sum = b.categories.reduce((a: number, c: any) => a + c.tokens, 0);
    // 各项分别四舍五入，允许几个 token 的误差
    expect(Math.abs(sum - usage.used)).toBeLessThanOrEqual(b.categories.length);
    const byKey = Object.fromEntries(b.categories.map((c: any) => [c.key, c.tokens]));
    expect(byKey.messages).toBeGreaterThan(0);
    expect(byKey.systemTools).toBeGreaterThan(0);
    expect(byKey.memory).toBeGreaterThan(0);
    expect(byKey.systemPrompt).toBeGreaterThan(0);
    expect(b.autoCompactAt).toBe(Math.round(usage.max * 0.75));
    expect(b.manualCompactAt).toBe(Math.round(usage.max * 0.35));
  });
});
