/**
 * wiki_save_page 工具的隔离性与行为。
 *
 * 这个文件存在的首要目的：把「该工具绝不默认出现在任何工具列表里」这条性质锁死。
 * 它一旦泄漏进公共列表，代价是每个会话、每一轮请求都要多带一份用不到的 schema，
 * 而且模型会看到它、可能在无关场景自作主张地写文档 —— 这类回归很难在事后被发现，
 * 所以用测试守住。
 */

import { describe, expect, it } from "vitest";
import type { AgentHost } from "../host/index.js";
import { getReadOnlyToolDefinitions, getToolDefinitions, getWikiPlanToolDefinitions, getWikiToolDefinitions } from "./definitions.js";
import { executeToolCall } from "./execute.js";

describe("wiki_save_page · 工具隔离", () => {
  it("不出现在公共工具列表里（否则每个会话每轮都白带一份 schema）", () => {
    const names = getToolDefinitions().map((t) => t.function.name);
    expect(names).not.toContain("wiki_save_page");
  });

  it("也不在只读工具列表里（它是写工具，只读子 Agent 不该拿到）", () => {
    const names = getReadOnlyToolDefinitions().map((t) => t.function.name);
    expect(names).not.toContain("wiki_save_page");
  });

  it("由 getWikiToolDefinitions 单独提供，且只有它一个", () => {
    const defs = getWikiToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].function.name).toBe("wiki_save_page");
  });

  it("wiki_plan_pages 同样不在公共列表里，由 getWikiPlanToolDefinitions 单独提供", () => {
    const pub = getToolDefinitions().map((t) => t.function.name);
    expect(pub).not.toContain("wiki_plan_pages");
    expect(getReadOnlyToolDefinitions().map((t) => t.function.name)).not.toContain("wiki_plan_pages");
    const defs = getWikiPlanToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].function.name).toBe("wiki_plan_pages");
  });

  it("参数 schema 声明必填字段（含 category —— 它是侧边栏归组的依据）", () => {
    const params = getWikiToolDefinitions()[0].function.parameters;
    expect(params.required).toEqual(["title", "summary", "category", "sources", "content"]);
    expect(Object.keys(params.properties).sort()).toEqual(["category", "content", "sources", "summary", "title"]);
  });

  it("描述里点明 sources 的后果（它是过时检测的唯一依据）", () => {
    const desc = getWikiToolDefinitions()[0].function.description;
    expect(desc).toContain("sources");
    expect(desc).toContain("过时");
  });
});

/** 该工具在无 host 交互的路径上就能验证，故用空对象占位 */
const noHost = {} as unknown as AgentHost;

/** 位置参数较多，集中一处避免每处都数一遍 */
function callWiki(args: Record<string, unknown>, wiki?: unknown) {
  return executeToolCall(
    "wiki_save_page",
    args,
    "/tmp",
    noHost,
    undefined, undefined, undefined, undefined, undefined, undefined,
    wiki as never,
  );
}

/** wiki_plan_pages 的调用（同一个 wiki 参数位） */
function callPlan(args: Record<string, unknown>, wiki?: unknown) {
  return executeToolCall(
    "wiki_plan_pages",
    args,
    "/tmp",
    noHost,
    undefined, undefined, undefined, undefined, undefined, undefined,
    wiki as never,
  );
}

describe("wiki_save_page · 执行", () => {
  it("没有生成上下文（未注入保存器）时被拒绝 —— 工具此刻本就不该可用", async () => {
    await expect(callWiki({ title: "X", summary: "", sources: [], content: "y" }))
      .rejects.toThrow(/不在 Wiki 生成流程/);
  });

  it("注入了保存器时把页面原样交给它，并回执文件名", async () => {
    const seen: { title: string; summary: string; sources: string[]; body: string }[] = [];
    const save = async (p: { title: string; summary: string; sources: string[]; body: string }) => {
      seen.push(p);
      return { slug: "订单系统" };
    };

    const out = await callWiki(
      { title: "订单系统", summary: "订单流转", sources: ["src/order/service.ts"], content: "# 正文" },
      { save },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      title: "订单系统",
      summary: "订单流转",
      sources: ["src/order/service.ts"],
      body: "# 正文",
    });
    // 回执要带上实际文件名，模型据此确认落盘位置
    expect(out).toContain("订单系统");
    expect(out).toContain("订单系统.md");
  });

  it("title / content 为空时拒绝，不写出一页空文档", async () => {
    const wiki = { save: async () => ({ slug: "x" }) };
    await expect(callWiki({ title: "  ", summary: "", sources: [], content: "y" }, wiki))
      .rejects.toThrow(/title 不能为空/);
    await expect(callWiki({ title: "X", summary: "", sources: [], content: "  " }, wiki))
      .rejects.toThrow(/content 不能为空/);
  });

  it("sources 为空时仍保存，但明确告知后果（缺它就没有过时检测）", async () => {
    const out = await callWiki({ title: "总览", summary: "", sources: [], content: "x" }, { save: async () => ({ slug: "总览" }) });
    expect(out).toContain("总览");
    expect(out).toContain("过时");
  });

  it("sources 里的非字符串与空白项被剔除，不计入依据数", async () => {
    const seen: { sources: string[] }[] = [];
    const save = async (p: { sources: string[] }) => { seen.push(p); return { slug: "X" }; };

    const out = await callWiki(
      { title: "X", summary: "", sources: [" a.ts ", 42, null, "  ", "b.ts"], content: "z" },
      { save },
    );

    expect(seen[0].sources).toEqual(["a.ts", "b.ts"]);
    expect(out).toContain("2 个文件");
  });

  it("sources 不是数组时按空处理（模型偶尔会传字符串）", async () => {
    const seen: { sources: string[] }[] = [];
    const save = async (p: { sources: string[] }) => { seen.push(p); return { slug: "X" }; };
    await callWiki({ title: "X", summary: "", sources: "src/a.ts", content: "z" }, { save });
    expect(seen[0].sources).toEqual([]);
  });

  it("只注入 plan（规划阶段）时，wiki_save_page 不可用 —— 阶段能力互不串用", async () => {
    await expect(callWiki({ title: "X", summary: "", sources: [], content: "y" }, { plan: async () => "ok" }))
      .rejects.toThrow(/不在 Wiki 生成流程/);
  });
});

describe("wiki_plan_pages · 执行", () => {
  it("没有规划上下文（未注入规划器）时被拒绝", async () => {
    await expect(callPlan({ pages: [{ title: "X", summary: "s" }] }))
      .rejects.toThrow(/不在 Wiki 规划阶段/);
  });

  it("把每页的 category 原样交给规划器 —— 它是页面在侧边栏归组的唯一依据", async () => {
    const seen: { title: string; summary: string; sources: string[]; category?: string }[][] = [];
    const plan = async (pages: { title: string; summary: string; sources: string[]; category?: string }[]) => {
      seen.push(pages);
      return `已登记 ${pages.length} 个页面。`;
    };

    await callPlan(
      { pages: [{ title: "订单系统", summary: "订单流转", category: "领域", sources: ["src/order/service.ts"] }] },
      { plan },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toEqual({
      title: "订单系统",
      summary: "订单流转",
      category: "领域",
      sources: ["src/order/service.ts"],
    });
  });

  it("category 空白时不编造分类（留空由 UI 归入「未分类」）", async () => {
    const seen: { category?: string }[][] = [];
    const plan = async (pages: { category?: string }[]) => { seen.push(pages); return "ok"; };
    await callPlan({ pages: [{ title: "X", summary: "s", category: "   " }] }, { plan });
    expect(seen[0][0].category).toBeUndefined();
  });
});

describe("wiki_save_page · 敏感信息", () => {
  it("正文里有疑似密钥 → 拒绝保存，报错里给出行号但不回显密钥", async () => {
    let saved = false;
    const wiki = { save: async () => { saved = true; return { slug: "x" }; } };
    const key = "sk-" + "a".repeat(30);
    const out = await callWiki({ title: "X", summary: "s", sources: [], content: `第一行\nOPENAI_KEY=${key}` }, wiki).catch((e: Error) => e.message);
    expect(saved).toBe(false);
    expect(String(out)).toContain("第 2 行");
    expect(String(out)).not.toContain(key);
  });

  it("占位写法不误报", async () => {
    let saved = false;
    const wiki = { save: async () => { saved = true; return { slug: "x" }; } };
    await callWiki({ title: "X", summary: "s", sources: [], content: "api_key: <API_KEY>\npassword = process.env.DB_PASSWORD\ntoken: string" }, wiki);
    expect(saved).toBe(true);
  });
});
