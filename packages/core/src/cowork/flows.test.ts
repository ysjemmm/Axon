import { describe, expect, it } from "vitest";
import { CoworkFlowStore, collectDraftSource, normalizeFlow, parseFlowDraft } from "./flows.js";
import { parseChecks, checksResult } from "./checks.js";
import type { HostFileSystem } from "../host/index.js";

function memoryFs(): HostFileSystem & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: async (p) => files.get(p) ?? null,
    write: async (p, c) => { files.set(p, c); },
    append: async (p, c) => { files.set(p, (files.get(p) ?? "") + c); },
    stat: async () => null,
    readdir: async () => [],
    mkdirp: async () => {},
    remove: async (p) => { files.delete(p); },
  };
}

const base = { name: "月度对账", inputs: [{ label: "银行流水", multiple: true }, { label: "账簿" }], steps: ["按凭证号匹配"], checks: ["合计一致"] };

describe("Cowork 流程", () => {
  it("校验：缺名字 / 步骤 / 输入时报中文错误，输入槽自动补 id 且不重复", () => {
    expect(() => normalizeFlow({ ...base, name: "" })).toThrow(/名字/);
    expect(() => normalizeFlow({ ...base, steps: [] })).toThrow(/步骤/);
    expect(() => normalizeFlow({ ...base, inputs: [] })).toThrow(/输入文件/);
    const flow = normalizeFlow({ ...base, inputs: [{ id: "a", label: "甲" }, { id: "a", label: "乙" }, { label: "丙" }] });
    expect(new Set(flow.inputs.map((i) => i.id)).size).toBe(3);
  });

  it("保存、更新、记运行、删除；最近运行的排在最前", async () => {
    const fs = memoryFs();
    const store = new CoworkFlowStore(fs, "/home/u");
    const a = await store.save(base, 1000);
    const b = await store.save({ ...base, name: "报销汇总" }, 2000);
    expect((await store.list()).map((f) => f.name)).toEqual(["报销汇总", "月度对账"]);
    await store.recordRun(a.id, "s1", 3000);
    const listed = await store.list();
    expect(listed[0].id).toBe(a.id);
    expect(listed[0].runs).toEqual([{ sessionId: "s1", at: 3000 }]);
    const edited = await store.save({ ...base, id: a.id, name: "银行对账" }, 4000);
    expect(edited).toMatchObject({ id: a.id, name: "银行对账", createdAt: 1000, updatedAt: 4000, runs: [{ sessionId: "s1", at: 3000 }] });
    await store.remove(b.id);
    expect((await store.list()).map((f) => f.id)).toEqual([a.id]);
    expect([...fs.files.keys()][0]).toMatch(/\.axon[\\/]cowork[\\/]flows\.json$/);
  });

  it("并发保存不会互相覆盖", async () => {
    const store = new CoworkFlowStore(memoryFs(), "/home/u");
    await Promise.all([1, 2, 3, 4].map((n) => store.save({ ...base, name: `流程${n}` }, n)));
    expect(await store.list()).toHaveLength(4);
  });

  it("解析模型草稿：容忍代码块包裹，没给输入槽时补一个可多选的", () => {
    const draft = parseFlowDraft("```json\n{\"name\":\"工单周报\",\"steps\":[\"按类别统计\"],\"checks\":[\"条数一致\"],\"askEachRun\":\"\"}\n```");
    expect(draft).toMatchObject({ name: "工单周报", inputs: [{ label: "要处理的文件", multiple: true }], checks: ["条数一致"] });
    expect(draft.askEachRun).toBeUndefined();
    expect(() => parseFlowDraft("不是 JSON")).toThrow(/重试/);
  });

  it("提炼素材：用户原话、附件名、产出，跳过注入消息", () => {
    const source = collectDraftSource([
      { role: "user", content: "要处理的文件：/a/b.xlsx\n汇总一下", displayText: "汇总一下", attachedFiles: [{ name: "b.xlsx" }] } as never,
      { role: "user", content: "系统提示", _ephemeralInjected: true } as never,
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "report_outputs", arguments: JSON.stringify({ files: [{ path: "/out/总表.xlsx", note: "总表" }] }) } }] } as never,
      { role: "assistant", content: "做好了" },
    ]);
    expect(source.requests).toEqual([{ text: "汇总一下", files: ["b.xlsx"] }]);
    expect(source.outputs).toEqual(["总表.xlsx（总表）"]);
    expect(source.replies).toEqual(["做好了"]);
  });
});

describe("Cowork 核对", () => {
  it("宽松解析状态写法，丢弃没有标签的项", () => {
    const checks = parseChecks({ checks: [{ label: "合计", status: "ok", detail: "一致" }, { label: "条数", status: "failed" }, { status: "pass" }, { label: "日期", status: "?" }] });
    expect(checks.map((c) => c.status)).toEqual(["pass", "fail", "warn"]);
    expect(checksResult(checks)).toMatch(/1 项不通过/);
  });
});
