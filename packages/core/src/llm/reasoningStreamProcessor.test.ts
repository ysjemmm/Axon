import { describe, expect, it } from "vitest";
import { ReasoningStreamProcessor } from "./reasoningStreamProcessor.js";

const ctx = { requestId: "req-1", turnId: "turn-1", now: () => "2025-01-01T00:00:00.000Z" };

describe("ReasoningStreamProcessor", () => {
  it("每条增量产出对应的 reasoning.delta 事件", () => {
    const p = new ReasoningStreamProcessor(ctx);
    const e1 = p.push({ text: "分析", partIndex: 0, itemId: "r1" });
    const e2 = p.push({ text: "问题", partIndex: 0, itemId: "r1" });
    expect(e1?.type).toBe("reasoning.delta");
    expect(e1?.text).toBe("分析");
    expect(e2?.text).toBe("问题");
  });

  it("空文本增量被忽略，返回 null 且不累加", () => {
    const p = new ReasoningStreamProcessor(ctx);
    expect(p.push({ text: "" })).toBeNull();
    expect(p.isEmpty()).toBe(true);
  });

  it("收尾 commit 基于拼装文本，按分段顺序汇总", () => {
    const p = new ReasoningStreamProcessor(ctx);
    p.push({ text: "第一段", partIndex: 0, itemId: "r1" });
    p.push({ text: "第二段", partIndex: 1, itemId: "r1" });
    p.push({ text: "。续一", partIndex: 0, itemId: "r1" });
    const commit = p.commit("full");
    expect(commit?.type).toBe("reasoning.commit");
    expect(commit?.text).toBe("第一段。续一\n\n第二段");
    expect(commit?.stage).toBe("committed");
  });

  it("未累计任何内容时 commit 返回 null，不产生空事件", () => {
    const p = new ReasoningStreamProcessor(ctx);
    expect(p.commit()).toBeNull();
  });

  it("完整闭环：多条增量 -> delta 序列 + 一条 commit", () => {
    const p = new ReasoningStreamProcessor(ctx);
    const deltas = [
      p.push({ text: "先看", partIndex: 0, itemId: "r1" }),
      p.push({ text: "映射", partIndex: 0, itemId: "r1" }),
      p.push({ text: "再验证", partIndex: 1, itemId: "r1" }),
    ].filter(Boolean);
    expect(deltas).toHaveLength(3);
    const commit = p.commit();
    expect(commit?.text).toBe("先看映射\n\n再验证");
  });

  it("reset 后清空累计状态", () => {
    const p = new ReasoningStreamProcessor(ctx);
    p.push({ text: "x" });
    p.reset();
    expect(p.isEmpty()).toBe(true);
    expect(p.commit()).toBeNull();
  });
});
