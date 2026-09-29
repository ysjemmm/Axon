/**
 * SessionHub 事件路由归属回归测试
 *
 * 锁死一个真实发生过的严重 bug：
 *   会话 A 正在流式输出时，用户切到【新开的空面板 B】，
 *   A 的输出整体跑到 B 上，而 A 自己再也收不到任何内容。
 *
 * 根因是两处缺陷叠加：
 *   R1 —— sendTo 只是"把一条事件发出去"，却借 getOrCreateSessionChannel 的赋值副作用
 *         改写了 SessionChannel.clientId（会话的展示归属）。于是任何一次事件投递都能抢走归属。
 *   R2 —— resolveSessionId 在面板 clientId 未注册时兜底到全局 lastActiveSessionId，
 *         使【新空面板】发出的指令被解析成【别的面板】正在跑的那个会话，从而触发 R1。
 *
 * 本测试不追求覆盖 SessionHub 全貌，只钉住这两条语义，防止再次回归。
 */

import { describe, it, expect } from "vitest";
import { SessionHub } from "./sessionHub.js";
import type { SessionHubDeps } from "./types.js";
import type { AgentEvent } from "../channel/index.js";

/** 造一个只关心"发出了什么事件"的最小 hub */
function makeHub() {
  const emitted: AgentEvent[] = [];
  const deps = {
    storage: {},
    channel: {
      emit: (e: AgentEvent) => {
        emitted.push(e);
      },
    },
    createHost: () => ({}),
    isValidDir: async () => true,
    resolveWorkspaceGroup: async () => null,
    defaultWorkspace: "D:\\fake-workspace",
    homeDir: "D:\\fake-home",
  } as unknown as SessionHubDeps;
  const hub = new SessionHub(deps);
  return { hub, emitted };
}

describe("SessionHub 事件路由归属", () => {
  it("R1：投递一条事件不得改写会话的展示归属", () => {
    const { hub, emitted } = makeHub();
    const anyHub = hub as any;

    const ch = anyHub.getOrCreateSessionChannel("sess-A");
    ch.clientId = "panel-A";

    // 模拟：新空面板 B 触发的「面板专属响应」（工作区 / 编辑模式等）被投递到会话 A。
    // 原实现走到这里就会把 sess-A 的归属改写成 panel-B。
    anyHub.sendTo("sess-A", "panel-B", { type: "workspace_set" } as AgentEvent);

    // 这一次确实送给了 B（定向投递的语义要保留）
    expect(emitted[emitted.length - 1]).toMatchObject({
      type: "workspace_set",
      sessionId: "sess-A",
      clientId: "panel-B",
    });
    // 但归属必须仍是 A —— 这正是原 bug 里被抢走的东西
    expect(anyHub.sessionChannels.get("sess-A").clientId).toBe("panel-A");
  });

  it("R1：归属未被抢走时，A 的流式增量仍然投给 A", () => {
    const { hub, emitted } = makeHub();
    const anyHub = hub as any;

    const ch = anyHub.getOrCreateSessionChannel("sess-A");
    ch.clientId = "panel-A";
    anyHub.sendTo("sess-A", "panel-B", { type: "workspace_set" } as AgentEvent);

    emitted.length = 0;
    // A 的 agent loop 完全不感知后台，照常 emit 一条流式增量
    ch.emit({ type: "stream_delta", content: "hello" } as AgentEvent);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "stream_delta",
      sessionId: "sess-A",
      clientId: "panel-A",
    });
  });

  it("R2：未注册的面板 clientId 不得外溢到别人的会话", () => {
    const { hub } = makeHub();
    const anyHub = hub as any;

    anyHub.clientSessions.set("panel-A", "sess-A");
    anyHub.lastActiveSessionId = "sess-A";

    // 新空面板 B：clientId 未注册、指令也没带 sessionId。
    // 必须给不出目标，绝不能落到 panel-A 的 sess-A（那正是触发整个 bug 的第一步）。
    expect(anyHub.resolveSessionId({ type: "set_edit_mode", clientId: "panel-B" })).toBe(null);

    // 面板显式指定的 sessionId 仍要认（cancel 等场景会带上）
    expect(
      anyHub.resolveSessionId({ type: "cancel", clientId: "panel-B", sessionId: "sess-X" }),
    ).toBe("sess-X");

    // 已注册的面板照旧以它自己的映射为准
    expect(anyHub.resolveSessionId({ type: "cancel", clientId: "panel-A" })).toBe("sess-A");

    // 不带 clientId 的入口（侧栏树按钮 / 命令面板）保留 lastActiveSessionId 兜底
    expect(anyHub.resolveSessionId({ type: "cancel" })).toBe("sess-A");
  });
});
