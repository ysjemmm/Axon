/**
 * CommandGate 测试 —— 门控的关键不变量。
 *
 * 重点：
 * - 已信任命令直接放行；命中风险模式（如递归删除）时**只给提醒、不二次确认**。
 * - 未信任命令走人工授权：reject / once / exact / prefix 的行为与持久化语义。
 * - 内置只读默认集免确认。
 */

import { describe, it, expect, vi } from "vitest";
import { CommandGate, BUILTIN_TRUSTED_PATTERNS, type GateDeps } from "../src/tools/commandGate";
import type { TrustRule } from "../src/tools/commandTrust";

/** 用户决策类型 */
type Decision = { choice: "exact" | "prefix" | "all" | "once" | "reject"; pattern?: string };

/** 构造一套可断言的 gate 依赖，requestApproval 由用例指定决策 */
function makeDeps(decision: Decision) {
  const persisted: TrustRule[] = [];
  const requestApproval = vi.fn(async () => decision);
  const deps: GateDeps = {
    requestApproval,
    persist: (rule) => { persisted.push(rule); },
  };
  return { deps, persisted, requestApproval };
}

describe("风险检测只产出提醒，不触发二次确认", () => {
  it("已信任 + 命中风险 → 直接放行、不弹确认，并回传 warning", async () => {
    const gate = new CommandGate(["*"]);
    // 用 reject 做探针：若真弹了确认，下面 allow 就会是 false
    const { deps, requestApproval } = makeDeps({ choice: "reject" });
    const outcome = await gate.gate("rm -rf /tmp/x", deps);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(outcome.allow).toBe(true);
    expect(outcome.warning).toBeTruthy();
  });

  it("已信任 + 无风险 → 放行且不带 warning", async () => {
    const gate = new CommandGate(["*"]);
    const { deps, requestApproval } = makeDeps({ choice: "reject" });
    const outcome = await gate.gate("npm test", deps);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(outcome.allow).toBe(true);
    expect(outcome.warning).toBeUndefined();
  });

  it("未信任 + 命中风险 → 仍走人工确认，并把风险原因透传给确认弹窗", async () => {
    const gate = new CommandGate([]);
    const { deps, requestApproval } = makeDeps({ choice: "all" });
    const outcome = await gate.gate("Remove-Item -Force -Recurse C:\\data", deps);
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0][2]).toBeTruthy(); // 第三个参数：风险原因
    expect(outcome.allow).toBe(true);
  });

  it("未信任 + 用户拒绝 → 不放行，并给出风险相关文案", async () => {
    const gate = new CommandGate([]);
    const { deps } = makeDeps({ choice: "reject" });
    const outcome = await gate.gate("Remove-Item -Recurse -Force C:\\data", deps);
    expect(outcome.allow).toBe(false);
    expect(outcome.aiMessage).toBeTruthy();
  });
});

describe("风险模式的参数顺序无关（修复漏报）", () => {
  it("-Recurse 排在 -Force 之后同样被识别", async () => {
    const gate = new CommandGate(["*"]);
    const { deps } = makeDeps({ choice: "reject" });
    const normal = await gate.gate("Remove-Item -Recurse -Force D:/tmp", deps);
    const swapped = await gate.gate("Remove-Item -Force -Recurse D:/tmp", deps);
    expect(normal.warning).toBeTruthy();
    // 旧实现的正则要求 -Recurse 在 -Force 之前，这里会漏报成 undefined
    expect(swapped.warning).toBeTruthy();
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
