import { describe, expect, it } from "vitest";
import { ReasoningAssembler } from "./reasoningAssembler.js";

describe("ReasoningAssembler", () => {
  it("同一分段的多个增量应按到达顺序累加", () => {
    const a = new ReasoningAssembler();
    a.push({ text: "分析", partIndex: 0, itemId: "r1" });
    a.push({ text: "问题", partIndex: 0, itemId: "r1" });
    expect(a.text()).toBe("分析问题");
  });

  it("不同分段应按首次出现顺序拼接", () => {
    const a = new ReasoningAssembler();
    a.push({ text: "第一段", partIndex: 0, itemId: "r1" });
    a.push({ text: "第二段", partIndex: 1, itemId: "r1" });
    a.push({ text: "。续第一段", partIndex: 0, itemId: "r1" });
    expect(a.text()).toBe("第一段。续第一段\n\n第二段");
  });

  it("不同 itemId 的相同 partIndex 视为不同分段", () => {
    const a = new ReasoningAssembler();
    a.push({ text: "A", partIndex: 0, itemId: "r1" });
    a.push({ text: "B", partIndex: 0, itemId: "r2" });
    expect(a.text()).toBe("A\n\nB");
  });

  it("无 partIndex 时归到单一顺序缓冲", () => {
    const a = new ReasoningAssembler();
    a.push({ text: "思考" });
    a.push({ text: "继续" });
    expect(a.text()).toBe("思考继续");
  });

  it("空文本增量被忽略，不产生空段", () => {
    const a = new ReasoningAssembler();
    a.push({ text: "", partIndex: 0, itemId: "r1" });
    a.push({ text: "有效", partIndex: 1, itemId: "r1" });
    expect(a.text()).toBe("有效");
  });

  it("isEmpty / reset 行为正确", () => {
    const a = new ReasoningAssembler();
    expect(a.isEmpty()).toBe(true);
    a.push({ text: "x" });
    expect(a.isEmpty()).toBe(false);
    a.reset();
    expect(a.isEmpty()).toBe(true);
    expect(a.text()).toBe("");
  });

  it("支持自定义分隔符", () => {
    const a = new ReasoningAssembler();
    a.push({ text: "A", partIndex: 0, itemId: "r1" });
    a.push({ text: "B", partIndex: 1, itemId: "r1" });
    expect(a.text(" | ")).toBe("A | B");
  });
});
