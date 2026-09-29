import { describe, expect, it } from "vitest";
import { AgentSession } from "../agentSession.js";
import { messageText } from "./promptBuilder.js";
import type { AgentChannel } from "../channel/index.js";
import type { AgentHost, IdeContextProvider } from "../host/index.js";

/** 构造一个带 ideContext（模拟 IDE 形态）的最小 host */
function hostWithIdeContext(activeFilePath: string | null): AgentHost {
  const ideContext: IdeContextProvider = {
    activeEditor: () => (activeFilePath ? { path: activeFilePath } : null),
    openFiles: () => [],
    gitDiff: async () => "",
  };
  return {
    fs: {
      read: async () => null,
      write: async () => {},
      append: async () => {},
      stat: async () => null,
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
    ideContext,
  } as AgentHost;
}

/** 非 IDE 形态：没有 ideContext */
function hostWithoutIdeContext(): AgentHost {
  const h = hostWithIdeContext(null) as any;
  delete h.ideContext;
  return h as AgentHost;
}

const channelStub: AgentChannel = { emit: () => {} };

const WS = ["d:\\projects\\Axon", "d:\\me\\ai-router", "d:\\projects\\work\\e-code-re"];

/** 取出本轮注入的 system 消息文本（拼接后便于断言） */
function injectionsText(session: AgentSession): string {
  return session.promptBuilder
    .buildInjections()
    .map((m) => messageText(m))
    .join("\n---\n");
}

function makeSession(workspaces: string[], host: AgentHost): AgentSession {
  return new AgentSession(workspaces[0], channelStub, host, [], workspaces as any);
}

describe("工作区聚焦提示（多工作区场景）", () => {
  it("活动文件在某个工作区时，聚焦该工作区（而非主工作区）", () => {
    // 主工作区是 Axon，但用户正在看 ai-router 里的文件
    const s = makeSession(WS, hostWithIdeContext("d:\\me\\ai-router\\kiro-reverser\\src\\a.ts"));
    const text = injectionsText(s);
    expect(text).toContain("【工作区聚焦】");
    expect(text).toContain("d:\\me\\ai-router");
    expect(text).toContain("用户当前在编辑器里打开的文件位于该工作区");
  });

  it("活动文件不属于任何工作区时，回退到主工作区", () => {
    const s = makeSession(WS, hostWithIdeContext("d:\\somewhere\\else\\a.ts"));
    const text = injectionsText(s);
    expect(text).toContain("【工作区聚焦】");
    expect(text).toContain("d:\\projects\\Axon");
    expect(text).toContain("当前选中（绑定）的主工作区");
  });

  it("没有打开的文件时，回退到主工作区", () => {
    const s = makeSession(WS, hostWithIdeContext(null));
    const text = injectionsText(s);
    expect(text).toContain("d:\\projects\\Axon");
    expect(text).toContain("当前选中（绑定）的主工作区");
  });

  it("非 IDE 形态（无 ideContext）也能给出焦点，取主工作区", () => {
    const s = makeSession(WS, hostWithoutIdeContext());
    const text = injectionsText(s);
    expect(text).toContain("【工作区聚焦】");
    expect(text).toContain("d:\\projects\\Axon");
  });

  it("单工作区不注入聚焦提示（不存在歧义）", () => {
    const s = makeSession(["d:\\projects\\Axon"], hostWithIdeContext("d:\\projects\\Axon\\a.ts"));
    expect(injectionsText(s)).not.toContain("【工作区聚焦】");
  });

  it("聚焦提示与工作区列表是两条独立消息（列表长期稳定，焦点随切文件变化）", () => {
    const s = makeSession(WS, hostWithIdeContext("d:\\projects\\work\\e-code-re\\x.ts"));
    const msgs = s.promptBuilder.buildInjections();
    const listMsg = msgs.find((m) => messageText(m).includes("当前会话绑定了多个工作区"));
    const focusMsg = msgs.find((m) => messageText(m).includes("【工作区聚焦】"));
    expect(listMsg).toBeTruthy();
    expect(focusMsg).toBeTruthy();
    expect(listMsg).not.toBe(focusMsg);
    // 焦点应指向活动文件所在的第 3 个工作区
    expect(messageText(focusMsg!)).toContain("d:\\projects\\work\\e-code-re");
  });
});

describe("注入块不带自我介绍（教训固化）", () => {
  it("注入列表里不得出现描述自身来源的说明文字", () => {
    const s = makeSession(WS, hostWithIdeContext("d:\\me\\ai-router\\a.ts"));
    const text = s.promptBuilder.buildInjections().map((m) => messageText(m)).join("\n");
    // 曾先后加过两版"这是自动附加的内容…"式说明，都无效。病根不在措辞也不在注入结构：
    // 助手一旦在**可见回复**里谈论过这块内容，它就进了对话历史，成为少样本范例，
    // 之后每轮照演一遍（推理不持久化，但可见回复会）。实测未加说明的历史会话里，
    // reasoning 提到注入的占比约 0.0%，加了的会话是 6.7%。
    // 结论：注入块不需要自我介绍，该做的是不去谈论它。这条断言防止它被重新加回来。
    expect(text).not.toContain("自动附加");
    expect(text).not.toContain("系统自动附带");
  });
});
