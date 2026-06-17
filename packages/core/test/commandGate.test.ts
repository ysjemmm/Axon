/**
 * CommandGate 测试 —— 三层门控的关键安全不变量。
 *
 * 重点：
 * - 灾难命令即便处于信任白名单（甚至 `*`）仍被硬拦，且触发 emitBlocked。
 * - 内置只读默认集免确认。
 * - 未信任命令走人工授权：reject / once / exact / prefix 的行为与持久化语义。
 */

import { describe, it, expect, vi } from "vitest";
import { CommandGate, BUILTIN_TRUSTED_PATTERNS, type GateDeps } from "../src/tools/commandGate";
import type { TrustRule } from "../src/tools/commandTrust";

/** 用户决策类型 */
type Decision = { choice: "exact" | "prefix" | "all" | "once" | "reject"; pattern?: string };

/** 构造一套可断言的 gate 依赖，requestApproval 由用例指定决策 */
function makeDeps(decision: Decision) {
  const persisted: TrustRule[] = [];
  const blocked: { command: string; reason: string }[] = [];
  const requestApproval = vi.fn(async () => decision);
  const deps: GateDeps = {
    requestApproval,
    emitBlocked: (command, reason) => { blocked.push({ command, reason }); },
    persist: (rule) => { persisted.push(rule); },
  };
  return { deps, persisted, blocked, requestApproval };
}

describe("灾难命令硬拦（trust 越不过）", () => {
  it("即便白名单为 * ，rm -rf / 仍被拦截并触发 emitBlocked", async () => {
    const gate = new CommandGate(["*"]);
    const { deps, blocked, requestApproval } = makeDeps({ choice: "all" });
    const outcome = await gate.gate("rm -rf /", deps);
    expect(outcome.allow).toBe(false);
    expect(outcome.aiMessage).toBeTruthy();
    expect(blocked).toHaveLength(1);
    expect(blocked[0].command).toBe("rm -rf /");
    // 灾难命令在信任检查之前就被拦，不应弹授权
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("Remove-Item -Recurse -Force 被拦", async () => {
    const gate = new CommandGate(["*"]);
    const { deps } = makeDeps({ choice: "all" });
    const outcome = await gate.gate("Remove-Item -Recurse -Force C:\\data", deps);
    expect(outcome.allow).toBe(false);
  });
});

describe("内置只读默认集免确认", () => {
  it("BUILTIN 命令直接放行，不弹授权", async () => {
    const gate = new CommandGate(); // 默认装载内置集
    const { deps, requestApproval } = makeDeps({ choice: "reject" });
    expect((await gate.gate("git status -s", deps)).allow).toBe(true);
    expect((await gate.gate("pwd", deps)).allow).toBe(true);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("setTrustedPatterns 始终合并内置集", async () => {
    const gate = new CommandGate();
    gate.setTrustedPatterns(["docker ps"]);
    const { deps } = makeDeps({ choice: "reject" });
    expect((await gate.gate("git status", deps)).allow).toBe(true); // 内置仍在
    expect((await gate.gate("docker ps", deps)).allow).toBe(true);   // 新增生效
    expect(BUILTIN_TRUSTED_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe("未信任命令走人工授权", () => {
  it("reject → 不放行、不持久化", async () => {
    const gate = new CommandGate([]);
    const { deps, persisted } = makeDeps({ choice: "reject" });
    const outcome = await gate.gate("some-tool --flag", deps);
    expect(outcome.allow).toBe(false);
    expect(persisted).toHaveLength(0);
  });

  it("once → 放行但不写白名单（下次仍需授权）", async () => {
    const gate = new CommandGate([]);
    const { deps, persisted, requestApproval } = makeDeps({ choice: "once" });
    expect((await gate.gate("some-tool run", deps)).allow).toBe(true);
    expect(persisted).toHaveLength(0);
    // 第二次仍未信任 → 再次弹授权
    await gate.gate("some-tool run", deps);
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  it("exact → 放行、持久化、后续同命令免确认", async () => {
    const gate = new CommandGate([]);
    const { deps, persisted, requestApproval } = makeDeps({ choice: "exact", pattern: "some-tool run" });
    expect((await gate.gate("some-tool run", deps)).allow).toBe(true);
    expect(persisted).toEqual([{ scope: "exact", pattern: "some-tool run", source: "approved" }]);
    // 第二次直接信任，不再弹
    expect((await gate.gate("some-tool run", deps)).allow).toBe(true);
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it("all → 放行但不持久化（仅本会话）", async () => {
    const gate = new CommandGate([]);
    const { deps, persisted } = makeDeps({ choice: "all" });
    expect((await gate.gate("whatever cmd", deps)).allow).toBe(true);
    expect(persisted).toHaveLength(0); // all 不落盘
    // 本会话内后续任意命令都被信任
    const { deps: deps2, requestApproval: ra2 } = makeDeps({ choice: "reject" });
    expect((await gate.gate("another cmd", deps2)).allow).toBe(true);
    expect(ra2).not.toHaveBeenCalled();
  });
});
