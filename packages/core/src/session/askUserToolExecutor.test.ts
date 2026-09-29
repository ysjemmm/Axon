import { describe, expect, it } from "vitest";
import { AskUserToolExecutor, type AskUserAnswer } from "./askUserToolExecutor.js";

/** 构造执行器：门直接返回给定作答，spy 把门收到的参数回传出来。 */
function makeExecutor(answers: AskUserAnswer[] | null, spy?: (args: any[]) => void) {
  return new AskUserToolExecutor({
    waitForUserAnswer: async (toolCallId, questions) => {
      spy?.([toolCallId, questions]);
      return answers;
    },
  });
}

const oneQuestion = [{ question: "选哪个方案？", options: [{ label: "方案 A" }, { label: "方案 B" }] }];

describe("AskUserToolExecutor", () => {
  it("单选题：把选中的 label 与问题一起写进结果", async () => {
    const out = await makeExecutor([{ selected: ["opt_1"] }]).execute({
      toolName: "ask_user", toolArgs: { questions: oneQuestion }, toolCallId: "c1",
    });
    expect(out.status).toBe("success");
    expect(out.result).toContain("选哪个方案？");
    expect(out.result).toContain("方案 B");
  });

  it("缺省 id 补为 opt_i，并透传 multi/allowOther", async () => {
    let captured: any[] = [];
    await makeExecutor([{ selected: ["opt_0"] }], (a) => { captured = a; }).execute({
      toolName: "ask_user",
      toolArgs: { questions: [{ question: "q", options: [{ label: "A" }, { label: "B" }], multi: true, allowOther: false }] },
      toolCallId: "c2",
    });
    expect(captured[0]).toBe("c2");
    expect(captured[1][0].options.map((o: any) => o.id)).toEqual(["opt_0", "opt_1"]);
    expect(captured[1][0].multi).toBe(true);
    expect(captured[1][0].allowOther).toBe(false);
  });

  it("一次多问：逐题列出作答（含跳过与其他）", async () => {
    const out = await makeExecutor([
      { selected: ["opt_0"] },
      { selected: [], skipped: true },
      { selected: [], other: "我自己写的" },
    ]).execute({
      toolName: "ask_user",
      toolArgs: { questions: [
        { question: "Q1", options: [{ label: "选项甲" }] },
        { question: "Q2", options: [{ label: "选项乙" }] },
        { question: "Q3", options: [{ label: "选项丙" }] },
      ] },
      toolCallId: "c3",
    });
    expect(out.status).toBe("success");
    expect(out.result).toContain("Q1");
    expect(out.result).toContain("选项甲");
    expect(out.result).toContain("跳过");
    expect(out.result).toContain("我自己写的");
  });

  it("allowOther 缺省为 true", async () => {
    let captured: any[] = [];
    await makeExecutor([{ selected: ["opt_0"] }], (a) => { captured = a; }).execute({
      toolName: "ask_user", toolArgs: { questions: oneQuestion }, toolCallId: "c4",
    });
    expect(captured[1][0].allowOther).toBe(true);
  });

  it("questions 为空直接报错、不弹门", async () => {
    let called = false;
    const out = await makeExecutor([], () => { called = true; }).execute({
      toolName: "ask_user", toolArgs: { questions: [] }, toolCallId: "c5",
    });
    expect(out.status).toBe("error");
    expect(called).toBe(false);
  });

  it("门返回 null（会话取消）时报错而不是卡住", async () => {
    const out = await makeExecutor(null).execute({
      toolName: "ask_user", toolArgs: { questions: oneQuestion }, toolCallId: "c6",
    });
    expect(out.status).toBe("error");
    expect(out.result).toContain("取消");
  });

  it("一次最多只问 4 个问题", async () => {
    let captured: any[] = [];
    const many = Array.from({ length: 6 }, (_, i) => ({ question: `Q${i}`, options: [{ label: "A" }] }));
    await makeExecutor(many.map(() => ({ selected: ["opt_0"] })), (a) => { captured = a; }).execute({
      toolName: "ask_user", toolArgs: { questions: many }, toolCallId: "c7",
    });
    expect(captured[1].length).toBe(4);
  });

  it("每个问题最多只保留 4 个选项（超出截断，且不占「其他」配额）", async () => {
    let captured: any[] = [];
    const sevenOptions = Array.from({ length: 7 }, (_, i) => ({ label: `选项${i}` }));
    await makeExecutor([{ selected: ["opt_0"] }], (a) => { captured = a; }).execute({
      toolName: "ask_user",
      toolArgs: { questions: [{ question: "q", options: sevenOptions }] },
      toolCallId: "c8",
    });
    expect(captured[1][0].options.length).toBe(4);
    expect(captured[1][0].options.map((o: any) => o.label)).toEqual(["选项0", "选项1", "选项2", "选项3"]);
  });
});
