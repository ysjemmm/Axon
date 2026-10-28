import { describe, expect, it, vi } from "vitest";

// 压缩本身要调 LLM，这里只关心"压缩后如何落盘"，故把摘要生成替换成确定结果。
vi.mock("../providers.js", () => ({ getStrategy: () => ({}), declaredThinkingFor: () => undefined }));
vi.mock("../compactor.js", () => ({
  needsCompaction: (total: number, max = 1_000_000, pct = 0.35) => total > max * pct,
  compactMessages: async (messages: any[]) => [messages[0], { role: "user", content: "摘要" }],
  rollingCompact: async (messages: any[]) => [[messages[0], { role: "user", content: "摘要" }], true],
  generateSessionMemory: vi.fn(async () => [{
    action: "upsert",
    key: "auto-memory",
    section: "status",
    title: "自动记忆",
    content: "自动合并后的记忆",
  }]),
}));

import { CompactionController } from "./compactionController.js";
import { generateSessionMemory } from "../compactor.js";

/** 用字符数当作"占用估算"，只为区分压缩前后的量级 */
const estimate = (messages: any[]) =>
  messages.reduce((sum, m) => sum + String(m.content ?? "").length, 0);

/**
 * 构造最小 session stub。
 *
 * 关键：persisted 数组模拟 registerPersistence 的写盘行为——它写盘时读的是
 * getLastTotalTokens()（即 lastTotalTokens 当时的快照），而不是重算一次。
 */
function makeSession(messages: any[]) {
  const persisted: number[] = [];
  const s: any = {
    messages,
    provider: "test",
    model: "test-model",
    isCompacting: false,
    lastPromptTokens: 0,
    lastTotalTokens: 0,
    rollingSummaryInProgress: false,
    rollingSummaryAccumulated: 0,
    compactionConfig: { enabled: true, keepRecentMessages: 2 },
    setMemory: vi.fn(),
    applyMemoryUpdates: vi.fn(),
    getMemory: () => "已有记忆",
    send: vi.fn(),
    getContextWindow: () => 1_000_000,
    getLastTotalTokens: () => s.lastTotalTokens,
    persistMessages: () => {
      persisted.push(s.lastTotalTokens);
    },
    updateAndSendTokenUsage: () => {
      s.lastTotalTokens = estimate(s.messages);
    },
  };
  return { s, persisted };
}

/** 造一份"很大"的历史，确保压缩后量级明显下降 */
function bigHistory() {
  return [
    { role: "system", content: "system" },
    ...Array.from({ length: 10 }, () => ({ role: "user", content: "长".repeat(5000) })),
  ];
}

describe("压缩后的上下文占用落盘", () => {
  it("手动压缩：落盘的是压缩后的占用，不是压缩前的旧值", async () => {
    const messages = bigHistory();
    const { s, persisted } = makeSession(messages);
    s.lastTotalTokens = estimate(messages); // 压缩前（界面显示 61% 的那个值）
    const before = s.lastTotalTokens;

    await new CompactionController(s).forceCompactSession();

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toBe(estimate(s.messages));
    expect(persisted[0]).toBeLessThan(before / 10);
  });

  it("滚动摘要：同样先重算占用再落盘", async () => {
    const messages = bigHistory();
    const { s, persisted } = makeSession(messages);
    s.lastTotalTokens = estimate(messages);

    await new CompactionController(s).maybeRollingSummary();

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toBe(estimate(s.messages));
  });

  it("溢出自动压缩：原先完全不落盘，现在会落盘压缩后的占用", async () => {
    const messages = bigHistory();
    const { s, persisted } = makeSession(messages);
    s.lastTotalTokens = 2_000_000; // > 窗口上限 → 走溢出分支

    const migrated = await new CompactionController(s).maybeAutoCompactBeforeTurn({} as any);

    expect(migrated).toBe(false);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toBe(estimate(s.messages));
  });
});

describe("后台记忆整理的时机", () => {
  const base = () => [
    { role: "system", content: "system" },
    { role: "user", content: "设计工作区" },
    { role: "assistant", content: "完成" },
  ];

  it("累计两个用户回合后后台整理一次", async () => {
    vi.mocked(generateSessionMemory).mockClear();
    const { s } = makeSession(base());
    const controller = new CompactionController(s);

    await controller.maybeRefreshMemoryAfterTurn(1000);
    expect(generateSessionMemory).not.toHaveBeenCalled();

    await controller.maybeRefreshMemoryAfterTurn(1000);
    expect(generateSessionMemory).toHaveBeenCalledTimes(1);
    expect(s.applyMemoryUpdates).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ key: "auto-memory", content: "自动合并后的记忆" }),
    ]));
  });

  it("用户交代长期约定（以后 / 记住 / 统一…）时当轮就整理", async () => {
    vi.mocked(generateSessionMemory).mockClear();
    const { s } = makeSession([
      { role: "system", content: "system" },
      { role: "user", content: "以后提交信息都用中文" },
      { role: "assistant", content: "好的" },
    ]);
    await new CompactionController(s).maybeRefreshMemoryAfterTurn(500);
    expect(generateSessionMemory).toHaveBeenCalledTimes(1);
  });

  it("每次只交给模型上次整理之后的新消息", async () => {
    vi.mocked(generateSessionMemory).mockClear();
    const { s } = makeSession(base());
    const controller = new CompactionController(s);
    await controller.maybeRefreshMemoryAfterTurn(1000);
    await controller.maybeRefreshMemoryAfterTurn(1000);
    const first = vi.mocked(generateSessionMemory).mock.calls[0][1] as any[];
    expect(first.map((m) => m.content)).toEqual(["设计工作区", "完成"]);

    s.messages.push({ role: "user", content: "再加个导出按钮" }, { role: "assistant", content: "加好了" });
    s.messages.push({ role: "user", content: "颜色改成灰色" }, { role: "assistant", content: "改好了" });
    await controller.maybeRefreshMemoryAfterTurn(1000);
    await controller.maybeRefreshMemoryAfterTurn(1000);
    const second = vi.mocked(generateSessionMemory).mock.calls[1][1] as any[];
    expect(second.map((m) => m.content)).toEqual(["再加个导出按钮", "加好了", "颜色改成灰色", "改好了"]);
  });

  it("压缩时用压缩前尚未整理的原文整理记忆，之后游标落到压缩后的末尾", async () => {
    vi.mocked(generateSessionMemory).mockClear();
    const messages = bigHistory();
    const { s } = makeSession(messages);
    const controller = new CompactionController(s);
    await controller.forceCompactSession();
    const used = vi.mocked(generateSessionMemory).mock.calls[0][1] as any[];
    expect(used).toHaveLength(10);
    expect(used.every((m) => m.role === "user")).toBe(true);

    // 压缩后只新增一轮：下一次整理只看这一轮
    s.messages.push({ role: "user", content: "新问题" }, { role: "assistant", content: "新回答" });
    await controller.maybeRefreshMemoryAfterTurn(1000);
    await controller.maybeRefreshMemoryAfterTurn(1000);
    const next = vi.mocked(generateSessionMemory).mock.calls[1][1] as any[];
    expect(next.map((m) => m.content)).toEqual(["新问题", "新回答"]);
  });
});
