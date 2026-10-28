import { describe, expect, it } from "vitest";
import { AgentSession } from "../agentSession.js";
import type { AgentChannel } from "../channel/index.js";
import type { AgentHost } from "../host/index.js";

function minimalHost(): AgentHost {
  return {
    fs: { read: async () => null, write: async () => {}, append: async () => {}, stat: async () => null, readdir: async () => [], mkdirp: async () => {}, remove: async () => {} },
    commands: {} as any, diagnostics: {} as any, browser: {} as any,
    edits: {
      getMode: () => "auto", hasPending: () => false, getPendingPaths: () => [], getPendingDiffs: () => [],
      getPendingEditIds: () => [], getUndoablePaths: () => [], getUndoableEditIds: () => [], serialize: () => [],
      restore: () => {}, setMode: () => {},
    } as any,
  } as AgentHost;
}

function session() {
  const events: any[] = [];
  const channel: AgentChannel = { emit: (e: any) => events.push(e) };
  const s = new AgentSession("/work", channel, minimalHost());
  return { s, events };
}

describe("会话记忆：历史版本与防覆盖", () => {
  it("每次改写前把旧内容存成历史版本，可以恢复", () => {
    const { s } = session();
    s.setMemory("## 用户偏好\n\n- 中文回复", "user");
    s.setMemory("## 用户偏好\n\n- 英文回复", "auto");
    expect(s.getMemoryHistory()).toHaveLength(1);
    expect(s.getMemoryHistory()[0]).toMatchObject({ source: "auto", content: "## 用户偏好\n\n- 中文回复" });

    expect(s.restoreMemoryVersion(s.getMemoryHistory()[0].at)).toBe(true);
    expect(s.getMemory()).toContain("中文回复");
    // 恢复本身也留了一个版本，可以再撤回
    expect(s.getMemoryHistory()).toHaveLength(2);
  });

  it("用户基于旧版本编辑保存时，与后台期间新写的块三方合并", () => {
    const { s } = session();
    const base = "## 用户偏好\n\n- 中文回复";
    s.setMemory(base, "user");
    s.setMemory(base + "\n\n## 踩坑\n\n- Windows 路径要转义", "auto"); // 用户编辑期间后台整理
    s.saveMemoryFromUser("## 用户偏好\n\n- 中文回复\n- 不要分割线", { base });
    expect(s.getMemory()).toContain("不要分割线");
    expect(s.getMemory()).toContain("Windows 路径要转义");
  });

  it("导入是合并，不冲掉已有记忆", () => {
    const { s } = session();
    s.setMemory("## 用户偏好\n\n- 中文回复", "user");
    s.saveMemoryFromUser("## 项目结构\n\n- monorepo", { mode: "merge" });
    expect(s.getMemory()).toContain("中文回复");
    expect(s.getMemory()).toContain("monorepo");
  });

  it("update_memory 传了一份明显残缺的完整内容时按合并处理", () => {
    const { s } = session();
    s.setMemory("## 用户偏好\n\n- 中文回复\n- 不要分割线\n\n## 项目结构\n\n- monorepo，pnpm workspace + turbo\n- packages/core 是 Agent 内核", "user");
    const r = s.updateMemory({ content: "## 待办\n\n- 补测试" });
    expect(r.status).toBe("success");
    expect(s.getMemory()).toContain("monorepo");
    expect(s.getMemory()).toContain("补测试");
    expect(r.result).toContain("已按合并处理");
  });

  it("清空记忆也算改过：持久化会写下空串", () => {
    const { s } = session();
    expect(s.isMemoryTouched()).toBe(false);
    s.setMemory("## 待办\n\n- x", "user");
    s.setMemory("", "user");
    expect(s.isMemoryTouched()).toBe(true);
    expect(s.getMemory()).toBe("");
  });

  it("回填历史版本时只保留最近 20 份", () => {
    const { s } = session();
    s.hydrateMemory("## a\n\nb", Array.from({ length: 30 }, (_, i) => ({ at: i, source: "auto" as const, content: `v${i}` })));
    expect(s.getMemoryHistory()).toHaveLength(20);
    expect(s.getMemoryHistory()[0].content).toBe("v10");
  });
});
