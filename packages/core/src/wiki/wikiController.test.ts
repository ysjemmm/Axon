/**
 * WikiController —— 生成流程编排逻辑。
 *
 * 这里不调真实模型：runSubAgent 是注入的，测试里换成假实现即可完整覆盖
 * 「规划 → 建作业 → 逐页撰写 → 收尾」的每一步分支。生成质量那一层属于 skill 与
 * 子 Agent 的职责，不该混进编排测试。
 */

import { describe, expect, it, vi } from "vitest";
import type { AgentHost } from "../host/index.js";
import { WikiStore, wikiSlug, type WikiJob } from "./wikiStore.js";
import { WikiController, resolveWikiModel, type WikiGenerationEvent, type WikiSubAgentRequest } from "./wikiController.js";

const norm = (p: string) => p.replace(/\\/g, "/");
const WS = "D:/ws/axon";

/** 内存宿主：文件内容 + mtime，够 summary/checkStale/save 用 */
function makeHost(seed: Record<string, string> = {}) {
  const store = new Map<string, string>();
  for (const [k, v] of Object.entries(seed)) store.set(norm(k), v);
  const fs = {
    read: vi.fn(async (p: string) => store.get(norm(p)) ?? null),
    write: vi.fn(async (p: string, c: string) => { store.set(norm(p), c); }),
    append: vi.fn(async (p: string, c: string) => { const k = norm(p); store.set(k, (store.get(k) ?? "") + c); }),
    mkdirp: vi.fn(async (_p: string) => { /* noop */ }),
    remove: vi.fn(async (p: string) => { store.delete(norm(p)); }),
    readdir: vi.fn(async (p: string) => {
      const prefix = `${norm(p)}/`;
      const seen = new Map<string, boolean>();
      for (const k of store.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (!rest) continue;
        const seg = rest.split("/")[0];
        if (!seen.has(seg)) seen.set(seg, rest.includes("/"));
      }
      return [...seen.entries()].map(([name, isDir]) => ({ name, path: `${norm(p)}/${name}`, isFile: !isDir, isDir }));
    }),
    stat: vi.fn(async (p: string) => {
      const k = norm(p);
      if (store.has(k)) return { isFile: true, isDir: false, mtimeMs: 1000 };
      if ([...store.keys()].some((x) => x.startsWith(`${k}/`))) return { isFile: false, isDir: true };
      return null;
    }),
  };
  return { host: { fs } as unknown as AgentHost, store, fs };
}

/** 造一个已存在的页面文件 */
function existingPage(title: string, sources: string[] = []) {
  const fm = ["---", `title: ${title}`, "summary: 既有页", "sources:", ...sources.map((s) => `  - ${s}`), "---", "", "正文"].join("\n");
  return { path: `${WS}/.axon/wiki/${wikiSlug(title)}.md`, content: fm };
}

/** 搭一个 controller，runSubAgent 用给定的行为 */
function setup(opts: {
  seed?: Record<string, string>;
  behavior: (req: WikiSubAgentRequest) => Promise<void> | void;
  ok?: (req: WikiSubAgentRequest) => boolean;
  signal?: AbortSignal;
  maxPages?: number;
  tokenBudget?: number;
  /** 每次子 Agent 运行报告的 token 用量 */
  tokensPerRun?: number;
}) {
  const { host, store: files } = makeHost(opts.seed);
  const wikiStore = new WikiStore([WS], host);
  const events: WikiGenerationEvent[] = [];
  const controller = new WikiController({
    host,
    workspaces: [WS],
    store: wikiStore,
    emit: (e) => events.push(e),
    signal: opts.signal,
    model: "test-model",
    sessionId: "s-1",
    maxPages: opts.maxPages,
    tokenBudget: opts.tokenBudget,
    runSubAgent: async (req) => {
      await opts.behavior(req);
      return { ok: opts.ok ? opts.ok(req) : true, text: "ok", inputTokens: opts.tokensPerRun ?? 0, outputTokens: 0 };
    },
  });
  return { controller, events, wikiStore, files, host };
}

/** 读作业列表（从落盘状态里取，验证真实持久化结果而非内存） */
async function readJobs(files: Map<string, string>): Promise<WikiJob[]> {
  const raw = files.get(norm(`${WS}/.axon/wiki/.state.json`));
  return raw ? (JSON.parse(raw).jobs as WikiJob[]) : [];
}

/** 一个标准的「规划 + 逐页撰写」假子 Agent：规划给 pages，撰写则真调 save */
function planAndWrite(pages: { title: string; summary: string; sources: string[] }[]) {
  return async (req: WikiSubAgentRequest) => {
    if (req.wiki?.plan) {
      await req.wiki.plan(pages);
      return;
    }
    // 撰写阶段：从 prompt 里认出当前是哪个页面，调用 save
    const title = pages.find((p) => req.prompt.includes(`《${p.title}》`))?.title;
    if (title && req.wiki?.save) {
      await req.wiki.save({ title, summary: `摘要 ${title}`, sources: [], body: `正文 ${title}` });
    }
  };
}

describe("WikiController · 规划阶段", () => {
  it("规划未产出清单时不建作业（避免留下永远跑不完的空作业污染续跑）", async () => {
    const { controller, events, files } = setup({ behavior: () => { /* 什么都不做，模拟未调 wiki_plan_pages */ } });

    const res = await controller.generate(WS);

    expect(res.ok).toBe(false);
    expect(res.message).toContain("规划");
    expect(await readJobs(files)).toEqual([]);
    expect(events.some((e) => e.type === "planned")).toBe(false);
  });

  it("无工作区时直接拒绝，不触碰任何状态", async () => {
    const { controller, files } = setup({ behavior: () => {} });
    const res = await controller.generate("");
    expect(res.ok).toBe(false);
    expect(await readJobs(files)).toEqual([]);
  });
});

describe("WikiController · 正常流程", () => {
  const pages = [
    { title: "订单系统", summary: "订单流转", sources: [] },
    { title: "支付流程", summary: "支付链路", sources: [] },
  ];

  it("规划 → 建作业 → 逐页落盘 → 作业完成，且事件按序发出", async () => {
    const { controller, events, files } = setup({ behavior: planAndWrite(pages) });

    const res = await controller.generate(WS);

    expect(res.ok).toBe(true);
    expect(res.total).toBe(2);
    expect(res.done).toBe(2);
    expect(res.failed).toEqual([]);

    // 页面确实落到了磁盘
    expect(files.has(norm(`${WS}/.axon/wiki/订单系统.md`))).toBe(true);
    expect(files.has(norm(`${WS}/.axon/wiki/支付流程.md`))).toBe(true);

    // 作业状态推进到 done
    const jobs = await readJobs(files);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe("done");
    expect(jobs[0].planned.sort()).toEqual(["订单系统", "支付流程"].sort());
    expect(jobs[0].done.sort()).toEqual(["订单系统", "支付流程"].sort());
    // 溯源字段在，但不参与任何判断
    expect(jobs[0].sessionId).toBe("s-1");
    expect(jobs[0].model).toBe("test-model");

    // 事件序列：planning → planned → page_saved×2 → finished。
    // 首条 planning 是刻意加的：规划阶段可能持续几十秒，没有它，
    // 用户点完按钮到第一页落盘之间完全静默，会以为没生效。
    const kinds = events.map((e) => e.type);
    expect(kinds).toEqual(["planning", "planned", "page_saved", "page_saved", "finished"]);
    const saved = events.filter((e) => e.type === "page_saved") as Extract<WikiGenerationEvent, { type: "page_saved" }>[];
    expect(saved.map((e) => e.done)).toEqual([1, 2]); // 进度递增
    expect(saved[1].total).toBe(2);

    // 正常完成不带 cancelled 标记（呈现端据此区分「完成」与「被中止」）
    const finished = events.find((e) => e.type === "finished") as Extract<WikiGenerationEvent, { type: "finished" }>;
    expect(finished.cancelled).toBeUndefined();
  });

  it("子 Agent 声称成功但未调用 wiki_save_page → 该页判失败（不做假成功）", async () => {
    const { controller, events } = setup({
      behavior: async (req) => {
        if (req.wiki?.plan) await req.wiki.plan(pages);
        // 撰写阶段什么都不做，但 runSubAgent 返回 ok=true
      },
    });

    const res = await controller.generate(WS);

    // 只信「页面真的落盘了」，不信子 Agent 的自我报告
    expect(res.ok).toBe(false);
    expect(res.failed.sort()).toEqual(["支付流程", "订单系统"].sort());
    expect(events.filter((e) => e.type === "page_failed")).toHaveLength(2);
  });

  it("子 Agent 返回 ok=false → 该页判失败，作业记 failed 并带上原因", async () => {
    const { controller, files } = setup({
      behavior: async (req) => {
        if (req.wiki?.plan) await req.wiki.plan([pages[0]]);
      },
      ok: (req) => !!req.wiki?.plan, // 只有规划阶段成功
    });

    const res = await controller.generate(WS);

    expect(res.ok).toBe(false);
    expect(res.failed).toEqual(["订单系统"]);
    const jobs = await readJobs(files);
    expect(jobs[0].status).toBe("failed");
    expect(jobs[0].error).toContain("订单系统");
  });
});

describe("WikiController · 续跑", () => {
  it("已存在的页面被跳过，但计入进度分母与已完成数", async () => {
    const seed = { [existingPage("订单系统").path]: existingPage("订单系统").content };
    const pages = [
      { title: "订单系统", summary: "订单流转", sources: [] }, // 已存在
      { title: "支付流程", summary: "支付链路", sources: [] }, // 待生成
    ];
    const { controller, events, files } = setup({ seed, behavior: planAndWrite(pages) });

    const res = await controller.generate(WS);

    expect(res.ok).toBe(true);
    expect(res.total).toBe(2);
    expect(res.done).toBe(2);

    // 只对「支付流程」发生了一次保存 —— 已存在的那页没被重写
    const saved = events.filter((e) => e.type === "page_saved") as Extract<WikiGenerationEvent, { type: "page_saved" }>[];
    expect(saved).toHaveLength(1);
    expect(saved[0].title).toBe("支付流程");
    // 进度从 2/2 起算（1 页已存在 + 刚写的 1 页），不是 1/2
    expect(saved[0].done).toBe(2);

    const jobs = await readJobs(files);
    expect(jobs[0].done.sort()).toEqual(["支付流程", "订单系统"].sort());
  });

  it("全部页面都已存在时，不需要跑撰写阶段", async () => {
    const seed = { [existingPage("订单系统").path]: existingPage("订单系统").content };
    let writeRuns = 0;
    const { controller } = setup({
      seed,
      behavior: async (req) => {
        if (req.wiki?.plan) { await req.wiki.plan([{ title: "订单系统", summary: "s", sources: [] }]); return; }
        writeRuns++;
      },
    });

    const res = await controller.generate(WS);

    expect(res.ok).toBe(true);
    expect(res.done).toBe(1);
    expect(writeRuns).toBe(0);
  });
});

describe("WikiController · 取消", () => {
  it("取消时作业记 interrupted（可续跑），而不是 failed（作废）", async () => {
    const ac = new AbortController();
    const pages = [
      { title: "订单系统", summary: "s", sources: [] },
      { title: "支付流程", summary: "s", sources: [] },
    ];
    const { controller, events, files } = setup({
      signal: ac.signal,
      behavior: async (req) => {
        if (req.wiki?.plan) { await req.wiki.plan(pages); return; }
        // 写完第一页后触发取消
        const title = pages.find((p) => req.prompt.includes(`《${p.title}》`))?.title;
        if (title && req.wiki?.save) {
          await req.wiki.save({ title, summary: "", sources: [], body: "x" });
          ac.abort();
        }
      },
    });

    const res = await controller.generate(WS);

    expect(res.ok).toBe(false);
    expect(res.message).toContain("取消");
    // 取消不是失败：剩下的页面下次还能接着写
    const jobs = await readJobs(files);
    expect(jobs[0].status).toBe("interrupted");
    expect(jobs[0].done).toEqual(["订单系统"]);

    const finished = events.find((e) => e.type === "finished") as Extract<WikiGenerationEvent, { type: "finished" }>;
    expect(finished.message).toContain("接着写");
    // cancelled 单独标出：呈现端据此用信息提示而非黄色警告（用户主动中止不是失败）
    expect(finished.cancelled).toBe(true);
    expect(finished.ok).toBe(false);
  });

  it("取消后 getResumableJob 仍能取到它，且只差未完成的那页", async () => {
    const ac = new AbortController();
    const pages = [
      { title: "订单系统", summary: "s", sources: [] },
      { title: "支付流程", summary: "s", sources: [] },
    ];
    const { controller, wikiStore } = setup({
      signal: ac.signal,
      behavior: async (req) => {
        if (req.wiki?.plan) { await req.wiki.plan(pages); return; }
        const title = pages.find((p) => req.prompt.includes(`《${p.title}》`))?.title;
        if (title && req.wiki?.save) {
          await req.wiki.save({ title, summary: "", sources: [], body: "x" });
          ac.abort();
        }
      },
    });

    await controller.generate(WS);

    const job = await wikiStore.getResumableJob(WS);
    expect(job).not.toBeNull();
    expect(job!.planned.length - job!.done.length).toBe(1);
  });
});

describe("WikiController · 工具注入", () => {
  it("规划阶段只给 plan，撰写阶段只给 save —— 能力不跨阶段泄漏", async () => {
    const pages = [{ title: "订单系统", summary: "s", sources: [] }];
    const seen: { phase: string; hasPlan: boolean; hasSave: boolean; readOnly: boolean }[] = [];
    const { controller } = setup({
      behavior: async (req) => {
        seen.push({ phase: req.wiki?.plan ? "plan" : "save", hasPlan: !!req.wiki?.plan, hasSave: !!req.wiki?.save, readOnly: req.readOnly });
        if (req.wiki?.plan) await req.wiki.plan(pages);
        else if (req.wiki?.save) await req.wiki.save({ title: "订单系统", summary: "s", sources: [], body: "x" });
      },
    });

    await controller.generate(WS);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ phase: "plan", hasPlan: true, hasSave: false, readOnly: true });
    // 撰写者同样只读：只读仓库 + 只能提交页面，没有写文件 / 执行命令的工具
    expect(seen[1]).toEqual({ phase: "save", hasPlan: false, hasSave: true, readOnly: true });
  });

  it("两次调用同一标题时，save 写入的是同一页（不产生重复文件）", async () => {
    const { controller, files } = setup({
      behavior: async (req) => {
        if (req.wiki?.plan) { await req.wiki.plan([{ title: "订单系统", summary: "s", sources: [] }]); return; }
        // 子 Agent 重试导致写了两次
        await req.wiki?.save?.({ title: "订单系统", summary: "s", sources: [], body: "v2" });
      },
    });

    const res = await controller.generate(WS);
    expect(res.total).toBe(1);
    // 同一个 slug 只算一页
    const mdFiles = [...files.keys()].filter((k) => k.endsWith(".md"));
    expect(mdFiles).toHaveLength(1);
  });
});

// ── 页面数上限 ──────────────────────────────────────────────────────────────

describe("WikiController · 页面数上限", () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ title: `页${i}`, summary: "s", sources: [] }));

  it("超出上限时只生成前 N 页，并在事件里标记被截断", async () => {
    const { controller, events, files } = setup({ maxPages: 3, behavior: planAndWrite(many) });

    const res = await controller.generate(WS);

    expect(res.total).toBe(3);
    expect(res.done).toBe(3);
    const planned = events.find((e) => e.type === "planned") as Extract<WikiGenerationEvent, { type: "planned" }>;
    expect(planned.pages.map((p) => p.title)).toEqual(["页0", "页1", "页2"]);
    expect(planned.truncated).toBe(true);
    expect([...files.keys()].filter((k) => k.endsWith(".md"))).toHaveLength(3);
  });

  it("未超上限时不标记截断（用户不必去猜该不该调大上限）", async () => {
    const { controller, events } = setup({ maxPages: 10, behavior: planAndWrite(many) });

    await controller.generate(WS);

    const planned = events.find((e) => e.type === "planned") as Extract<WikiGenerationEvent, { type: "planned" }>;
    expect(planned.pages).toHaveLength(8);
    expect(planned.truncated).toBeUndefined();
  });

  it("配置成 0 时至少仍生成一页（异常配置不该导致一页都不写）", async () => {
    const { controller } = setup({ maxPages: 0, behavior: planAndWrite(many) });
    expect((await controller.generate(WS)).total).toBe(1);
  });

  it("规划提示词里写明上限 —— 让模型主动挑重点，而不是列完再被代码截断", async () => {
    let planPrompt = "";
    const { controller } = setup({
      maxPages: 5,
      behavior: async (req) => {
        if (req.wiki?.plan) {
          planPrompt = req.prompt;
          await req.wiki.plan([{ title: "A", summary: "s", sources: [] }]);
        }
      },
    });

    await controller.generate(WS);

    expect(planPrompt).toContain("最多 5 页");
  });
});

// ── 模型解析 ────────────────────────────────────────────────────────────────

describe("resolveWikiModel · 模型解析", () => {
  const base = { provider: "p-session", model: "m-session" };
  const found = () => "p-found";
  const notFound = () => undefined;

  it("未配置 → 完全跟随会话（含 Relay 执行阶段的覆盖，已体现在 base 里）", () => {
    expect(resolveWikiModel(base, {}, found)).toEqual(base);
  });

  it("只配 model → 自动找出提供它的 provider（用户不该被迫手填可推断的字段）", () => {
    expect(resolveWikiModel(base, { model: "m-x" }, found)).toEqual({ provider: "p-found", model: "m-x" });
  });

  it("只配 model 且查不到 provider → 退回会话 provider，不留下空值", () => {
    expect(resolveWikiModel(base, { model: "m-x" }, notFound)).toEqual({ provider: "p-session", model: "m-x" });
  });

  it("只配 provider → 保留会话模型", () => {
    expect(resolveWikiModel(base, { provider: "p-x" }, found)).toEqual({ provider: "p-x", model: "m-session" });
  });

  it("两者都配 → 都生效，且不因查找结果被改写成别的 provider", () => {
    expect(resolveWikiModel(base, { provider: "p-x", model: "m-x" }, found)).toEqual({ provider: "p-x", model: "m-x" });
  });

  it("base 为空串（会话尚未选模型）时不崩，原样返回", () => {
    const empty = { provider: "", model: "" };
    expect(resolveWikiModel(empty, {}, found)).toEqual(empty);
  });
});

describe("WikiController · 刷新、预算与用量", () => {
  it("再次生成会重写「待复核」的页面，不待复核的跳过", async () => {
    const pages = [{ title: "A", summary: "s", sources: ["src/a.ts"] }, { title: "B", summary: "s", sources: ["src/b.ts"] }];
    const written: string[] = [];
    const { controller, host } = setup({
      seed: { [`${WS}/src/a.ts`]: "a", [`${WS}/src/b.ts`]: "b" },
      behavior: async (req) => {
        if (req.wiki?.plan) { await req.wiki.plan(pages); return; }
        const title = req.prompt.includes("《A》") ? "A" : "B";
        written.push(title);
        await req.wiki?.save?.({ title, summary: "s", sources: [`src/${title.toLowerCase()}.ts`], body: "x" });
      },
    });
    await controller.generate(WS);
    expect(written).toEqual(["A", "B"]);
    // A 的依据文件变了（内容 + 时间戳）
    await host.fs.write(`${WS}/src/a.ts`, "a2");
    const orig = host.fs.stat;
    host.fs.stat = (async (p: string) => {
      const r = await orig(p);
      return r && norm(p).endsWith("src/a.ts") ? { ...r, mtimeMs: 99999 } : r;
    }) as typeof host.fs.stat;
    written.length = 0;
    await controller.generate(WS);
    expect(written).toEqual(["A"]);
  });

  it("mode=stale 不规划，只重写待复核页面；mode=pages 只重写指定页面", async () => {
    const calls: string[] = [];
    const { controller, wikiStore, host } = setup({
      seed: { [`${WS}/src/a.ts`]: "a", [`${WS}/src/b.ts`]: "b" },
      behavior: async (req) => {
        calls.push(req.wiki?.plan ? "plan" : req.prompt.includes("《A》") ? "A" : "B");
        if (req.wiki?.save) {
          const title = req.prompt.includes("《A》") ? "A" : "B";
          await req.wiki.save({ title, summary: "s", sources: [`src/${title.toLowerCase()}.ts`], body: "x" });
        }
      },
    });
    await wikiStore.save({ title: "A", summary: "s", sources: ["src/a.ts"], body: "x", workspace: WS });
    await wikiStore.save({ title: "B", summary: "s", sources: ["src/b.ts"], body: "x", workspace: WS });
    await host.fs.write(`${WS}/src/b.ts`, "b2");
    const orig = host.fs.stat;
    host.fs.stat = (async (p: string) => {
      const r = await orig(p);
      return r && norm(p).endsWith("src/b.ts") ? { ...r, mtimeMs: 99999 } : r;
    }) as typeof host.fs.stat;
    await controller.generate(WS, { mode: "stale" });
    expect(calls).toEqual(["B"]);
    calls.length = 0;
    await controller.generate(WS, { mode: "pages", slugs: ["A"] });
    expect(calls).toEqual(["A"]);
  });

  it("撰写者换了标题：仍按计划的标题落盘，不产生孤儿页", async () => {
    const { controller, wikiStore } = setup({
      behavior: async (req) => {
        if (req.wiki?.plan) { await req.wiki.plan([{ title: "订单系统", summary: "s", sources: [] }]); return; }
        await req.wiki?.save?.({ title: "订单模块详解", summary: "s", sources: [], body: "x" });
      },
    });
    const res = await controller.generate(WS);
    expect(res.failed).toEqual([]);
    expect((await wikiStore.summary()).map((p) => p.title)).toEqual(["订单系统"]);
  });

  it("达到 token 上限就停，作业记为可续跑，并报告用量", async () => {
    const pages = [1, 2, 3, 4].map((i) => ({ title: `P${i}`, summary: "s", sources: [] }));
    const { controller, events, files } = setup({
      behavior: planAndWrite(pages),
      tokenBudget: 2500,
      tokensPerRun: 1000,
    });
    const res = await controller.generate(WS);
    // 规划 1000 + 两页 2000 = 3000 ≥ 2500：写完两页后停
    expect(res.budgetExceeded).toBe(true);
    expect(res.done).toBe(2);
    expect(res.usage).toEqual({ inputTokens: 3000, outputTokens: 0 });
    const jobs = await readJobs(files);
    expect(jobs[0].status).toBe("interrupted");
    expect(jobs[0].usage?.inputTokens).toBe(3000);
    const fin = events.find((e) => e.type === "finished");
    expect(fin && "message" in fin && fin.message).toContain("token 上限");
  });

  it("子 Agent 拿到轮次与 token 上限", async () => {
    const reqs: WikiSubAgentRequest[] = [];
    const { controller } = setup({
      behavior: async (req) => {
        reqs.push(req);
        if (req.wiki?.plan) await req.wiki.plan([{ title: "A", summary: "s", sources: [] }]);
        else await req.wiki?.save?.({ title: "A", summary: "s", sources: [], body: "x" });
      },
    });
    await controller.generate(WS);
    expect(reqs[0].maxRounds).toBeGreaterThan(0);
    expect(reqs[0].tokenBudget).toBeGreaterThan(0);
    expect(reqs[1].maxRounds).toBeLessThanOrEqual(reqs[0].maxRounds);
  });
});
