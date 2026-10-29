import { describe, expect, it, vi } from "vitest";
import type { AgentHost } from "../host/index.js";
import {
  WIKI_GITIGNORE_CONTENT,
  WIKI_JOB_KEEP,
  WikiStore,
  buildWikiIndexPrompt,
  buildWikiRecall,
  normalizeWikiCategory,
  parseWikiFrontmatter,
  pendingPages,
  serializeWikiPage,
  wikiRecallSignature,
  wikiDir,
  wikiGitignorePath,
  wikiSlug,
  wikiStatePath,
} from "./wikiStore.js";
import type { WikiPageSummary, WikiRecall } from "./wikiStore.js";

/** 归一化路径：Windows 上 join 产出反斜杠，比较前统一 */
const norm = (p: string) => p.replace(/\\/g, "/");

const WS = "D:/ws/axon";

/**
 * 内存宿主。文件内容 + mtime 双表：mtime 单独维护，才能在测试里「改内容 = 改 mtime」，
 * 精确模拟真实文件系统上「源文件被编辑」这一动作。
 */
function makeHost(opts: { files?: Record<string, string>; mtimes?: Record<string, number> } = {}) {
  const store = new Map<string, string>();
  const mtimes = new Map<string, number>();
  for (const [k, v] of Object.entries(opts.files ?? {})) store.set(norm(k), v);
  for (const [k, v] of Object.entries(opts.mtimes ?? {})) mtimes.set(norm(k), v);

  const fs = {
    read: vi.fn(async (p: string) => store.get(norm(p)) ?? null),
    write: vi.fn(async (p: string, c: string) => { store.set(norm(p), c); }),
    append: vi.fn(async (p: string, c: string) => { const k = norm(p); store.set(k, (store.get(k) ?? "") + c); }),
    // 必须声明参数类型：否则 mock.calls 退化为 `[][]`，后续断言里解构 `[p]` 会类型报错
    mkdirp: vi.fn(async (_p: string) => { /* noop */ }),
    remove: vi.fn(async (p: string) => { const k = norm(p); store.delete(k); mtimes.delete(k); }),
    readdir: vi.fn(async (p: string) => {
      const prefix = `${norm(p)}/`;
      const seen = new Map<string, boolean>();
      for (const k of store.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (!rest) continue;
        const seg = rest.split("/")[0];
        const isDir = rest.includes("/");
        if (!seen.has(seg)) seen.set(seg, isDir);
      }
      return [...seen.entries()].map(([name, isDir]) => ({ name, path: `${norm(p)}/${name}`, isFile: !isDir, isDir }));
    }),
    stat: vi.fn(async (p: string) => {
      const k = norm(p);
      if (store.has(k)) return { isFile: true, isDir: false, mtimeMs: mtimes.get(k) ?? 1000 };
      const prefix = `${k}/`;
      if ([...store.keys()].some((x) => x.startsWith(prefix))) return { isFile: false, isDir: true };
      return null;
    }),
  };
  return { host: { fs } as unknown as AgentHost, store, mtimes, fs };
}

/** 造一个已存在的页面文件（含 frontmatter），供 list/read/checkStale 用例预置现场 */
function pageFile(root: string, slug: string, opts: { title: string; summary: string; sources: string[]; body?: string }) {
  return {
    path: `${root}/.axon/wiki/${slug}.md`,
    content: serializeWikiPage({
      title: opts.title,
      summary: opts.summary,
      sources: opts.sources,
      generatedAt: "2026-09-20T10:00:00.000Z",
      body: opts.body ?? "正文",
    }),
  };
}

// ── slug ────────────────────────────────────────────────────────────────────

describe("wikiSlug · 标题转文件名", () => {
  it("保留中文（文档目录要能肉眼浏览，不该被压成拼音或哈希）", () => {
    expect(wikiSlug("订单系统")).toBe("订单系统");
    expect(wikiSlug("支付流程 概览")).toBe("支付流程-概览");
  });

  it("剔除各平台文件名非法字符", () => {
    expect(wikiSlug('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
  });

  it("去掉首尾的点与横线（避免生成隐藏文件）", () => {
    expect(wikiSlug(".hidden.")).toBe("hidden");
    expect(wikiSlug("--x--")).toBe("x");
  });

  it("空标题或全非法字符回退为 untitled", () => {
    expect(wikiSlug("")).toBe("untitled");
    expect(wikiSlug("///")).toBe("untitled");
  });

  it("截断到 60 字符", () => {
    expect(wikiSlug("あ".repeat(100)).length).toBe(60);
  });
});

// ── frontmatter ─────────────────────────────────────────────────────────────

describe("parseWikiFrontmatter · 解析", () => {
  it("解析标量与字符串列表（sources 是列表，这正是不能复用 skillLoader.parseFrontmatter 的原因）", () => {
    const raw = [
      "---",
      "title: 订单系统",
      "summary: 订单的创建与流转",
      "sources:",
      "  - src/order/service.ts",
      "  - src/order/model.ts",
      "generatedAt: 2026-09-20T10:00:00.000Z",
      "---",
      "",
      "正文内容",
    ].join("\n");

    const { meta, body } = parseWikiFrontmatter(raw);
    expect(meta.title).toBe("订单系统");
    expect(meta.summary).toBe("订单的创建与流转");
    expect(meta.sources).toEqual(["src/order/service.ts", "src/order/model.ts"]);
    expect(meta.generatedAt).toBe("2026-09-20T10:00:00.000Z");
    expect(body.trim()).toBe("正文内容");
  });

  it("值里含冒号时不被截断", () => {
    const { meta } = parseWikiFrontmatter("---\ntitle: 订单: 核心链路\n---\n");
    expect(meta.title).toBe("订单: 核心链路");
  });

  it("去掉成对引号", () => {
    const { meta } = parseWikiFrontmatter('---\ntitle: "带引号"\nsummary: \'单引号\'\n---\n');
    expect(meta.title).toBe("带引号");
    expect(meta.summary).toBe("单引号");
  });

  it("空 sources 列表", () => {
    const { meta } = parseWikiFrontmatter("---\ntitle: x\nsources:\n---\n正文");
    expect(meta.sources).toEqual([]);
  });

  it("无 frontmatter 时按「无元信息」处理，不抛错（用户手改坏了不该让整页不可读）", () => {
    const { meta, body } = parseWikiFrontmatter("就是一段普通 markdown");
    expect(meta).toEqual({});
    expect(body).toBe("就是一段普通 markdown");
  });

  it("未知字段被忽略", () => {
    const { meta } = parseWikiFrontmatter("---\ntitle: x\nunknownField: y\n---\n");
    expect(meta.title).toBe("x");
    expect((meta as Record<string, unknown>).unknownField).toBeUndefined();
  });
});

describe("serializeWikiPage ↔ parseWikiFrontmatter · 往返", () => {
  it("往返后关键字段一致", () => {
    const original = {
      title: "订单系统",
      summary: "一句话",
      sources: ["a.ts", "b/c.ts"],
      generatedAt: "2026-09-20T10:00:00.000Z",
      body: "## 小节\n\n内容",
    };
    const { meta, body } = parseWikiFrontmatter(serializeWikiPage(original));
    expect(meta.title).toBe(original.title);
    expect(meta.summary).toBe(original.summary);
    expect(meta.sources).toEqual(original.sources);
    expect(meta.generatedAt).toBe(original.generatedAt);
    expect(body.trim()).toBe(original.body);
  });

  it("标题/摘要里的换行被压平（它们必须是单行字段，否则解析会错位）", () => {
    const text = serializeWikiPage({ title: "多\n行", summary: "也\n是", sources: [], body: "x" });
    const { meta } = parseWikiFrontmatter(text);
    expect(meta.title).toBe("多 行");
    expect(meta.summary).toBe("也 是");
  });
});

// ── 读写往返 ────────────────────────────────────────────────────────────────

describe("WikiStore · 读写", () => {
  it("save 后 list/read 能取回，且落盘路径符合约定", async () => {
    const { host, store } = makeHost({ files: { "D:/ws/axon/src/a.ts": "x" } });
    const w = new WikiStore(WS, host);

    const meta = await w.save({ title: "订单系统", summary: "一句话", sources: ["src/a.ts"], body: "# 正文" });
    expect(meta?.slug).toBe("订单系统");
    expect(norm(wikiDir(WS)) + "/订单系统.md").toBe("D:/ws/axon/.axon/wiki/订单系统.md");
    expect(store.has("D:/ws/axon/.axon/wiki/订单系统.md")).toBe(true);

    const list = await w.list();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("订单系统");
    expect(list[0].sources).toEqual(["src/a.ts"]);

    const page = await w.read("订单系统");
    expect(page?.body.trim()).toBe("# 正文");
  });

  it("同 title 再次 save 是就地更新（不新建第二页）", async () => {
    const { host } = makeHost();
    const w = new WikiStore(WS, host);
    await w.save({ title: "订单系统", summary: "v1", sources: [], body: "旧" });
    await w.save({ title: "订单系统", summary: "v2", sources: [], body: "新" });

    expect(await w.list()).toHaveLength(1);
    expect((await w.read("订单系统"))?.body.trim()).toBe("新");
  });

  it("读不存在的页面返回 null", async () => {
    const { host } = makeHost();
    expect(await new WikiStore(WS, host).read("没有这页")).toBeNull();
  });

  it("目录不存在时 list 返回空数组（不抛错）", async () => {
    const { host } = makeHost();
    expect(await new WikiStore(WS, host).list()).toEqual([]);
  });

  it("忽略非 .md 与隐藏文件（.state.json 不该被当成页面）", async () => {
    const { host } = makeHost({
      files: {
        "D:/ws/axon/.axon/wiki/.state.json": "{}",
        "D:/ws/axon/.axon/wiki/notes.txt": "x",
        "D:/ws/axon/.axon/wiki/.hidden.md": "---\ntitle: 隐藏\n---\n",
        "D:/ws/axon/.axon/wiki/real.md": "---\ntitle: 真页面\n---\n",
      },
    });
    const list = await new WikiStore(WS, host).list();
    expect(list.map((p) => p.slug)).toEqual(["real"]);
  });

  it("手改坏了 frontmatter 时回退用文件名作标题", async () => {
    const { host } = makeHost({ files: { "D:/ws/axon/.axon/wiki/broken.md": "没有 frontmatter" } });
    const list = await new WikiStore(WS, host).list();
    expect(list[0].title).toBe("broken");
    expect(list[0].sources).toEqual([]);
  });

  it("remove 同时清掉状态记录", async () => {
    const { host, store } = makeHost();
    const w = new WikiStore(WS, host);
    await w.save({ title: "订单系统", summary: "s", sources: ["src/a.ts"], body: "x" });
    expect(await w.remove("订单系统")).toBe(true);

    expect(await w.list()).toEqual([]);
    const state = JSON.parse(store.get("D:/ws/axon/.axon/wiki/.state.json") ?? "{}");
    expect(state.pages["订单系统"]).toBeUndefined();
  });
});

// ── 按应用删除 ──────────────────────────────────────────────────────────────

describe("WikiStore · 按应用删除（removeWorkspace）", () => {
  const WS2 = "D:/ws/other";

  it("删除该应用的全部页面，并返回删除的页数", async () => {
    const { host } = makeHost();
    const w = new WikiStore(WS, host);
    await w.save({ title: "A", summary: "", sources: [], body: "x" });
    await w.save({ title: "B", summary: "", sources: [], body: "y" });

    expect(await w.removeWorkspace(WS)).toBe(2);
    expect(await w.list()).toEqual([]);
  });

  it("同时清掉状态记录，不留孤儿（否则陈旧检测会去核对已不存在的页）", async () => {
    const { host, store } = makeHost();
    const w = new WikiStore(WS, host);
    await w.save({ title: "A", summary: "", sources: [], body: "x" });

    await w.removeWorkspace(WS);
    const state = JSON.parse(store.get("D:/ws/axon/.axon/wiki/.state.json") ?? "{}");
    expect(state.pages["A"]).toBeUndefined();
  });

  it("一并清掉该应用的作业记录 —— 否则它仍被判为「可续跑」，续跑出的正是刚删掉的那批页", async () => {
    const { host } = makeHost();
    const w = new WikiStore(WS, host);
    await w.startJob({ workspace: WS, planned: ["A", "B"] });
    await w.save({ title: "A", summary: "", sources: [], body: "x" });

    await w.removeWorkspace(WS);
    expect(await w.getResumableJob(WS)).toBeNull();
  });

  it("只动目标应用：另一个工作区的页面与记录不受影响", async () => {
    const other = pageFile(WS2, "别处的页", { title: "别处的页", summary: "", sources: [] });
    const { host, store } = makeHost({ files: { [other.path]: other.content } });
    const w = new WikiStore([WS, WS2], host);
    await w.save({ title: "本地的页", summary: "", sources: [], body: "x" });

    expect(await w.removeWorkspace(WS)).toBe(1);

    expect((await w.list()).map((p) => p.slug)).toEqual(["别处的页"]);
    expect(store.has(norm(`${WS2}/.axon/wiki/别处的页.md`))).toBe(true);
  });

  it("该应用没有页面时返回 0（目录缺失也不抛错）", async () => {
    const { host } = makeHost();
    await expect(new WikiStore(WS, host).removeWorkspace(WS)).resolves.toBe(0);
  });
});

// ── 多根 ────────────────────────────────────────────────────────────────────

describe("WikiStore · 多工作区", () => {
  const WS2 = "D:/ws/other";

  it("写入落首根，读取跨根合并", async () => {
    const { host } = makeHost({
      files: { [pageFile(WS2, "别处的页", { title: "别处的页", summary: "", sources: [] }).path]: pageFile(WS2, "别处的页", { title: "别处的页", summary: "", sources: [] }).content },
    });
    const w = new WikiStore([WS, WS2], host);

    await w.save({ title: "本地的页", summary: "", sources: [], body: "x" });

    const list = await w.list();
    expect(list.map((p) => p.slug).sort()).toEqual(["别处的页", "本地的页"].sort());
    // 新页落在首根
    expect((await w.read("本地的页"))?.slug).toBe("本地的页");
  });
});

// ── 陈旧检测 ────────────────────────────────────────────────────────────────

describe("WikiStore · 陈旧检测", () => {
  /** 造一个「已生成」的现场：页面存在 + 状态记录了源文件当时的 mtime */
  async function generated(opts: { mtime: number; sources?: string[] }) {
    const sources = opts.sources ?? ["src/a.ts"];
    const page = pageFile(WS, "订单系统", { title: "订单系统", summary: "", sources });
    const files: Record<string, string> = {
      [page.path]: page.content,
    };
    const mtimes: Record<string, number> = {};
    const stateSources: Record<string, number> = {};
    for (const s of sources) {
      files[`${WS}/${s}`] = "内容";
      mtimes[`${WS}/${s}`] = opts.mtime;
      stateSources[s] = opts.mtime;
    }
    files[wikiStatePath(WS)] = JSON.stringify({ version: 1, pages: { 订单系统: { sources: stateSources, generatedAt: "2026-09-20T10:00:00.000Z" } } });
    return makeHost({ files, mtimes });
  }

  it("源文件 mtime 未变 → 不陈旧", async () => {
    const { host } = await generated({ mtime: 1000 });
    const [info] = await new WikiStore(WS, host).checkStale();
    expect(info.stale).toBe(false);
    expect(info.unknown).toBe(false);
    expect(info.changedSources).toEqual([]);
  });

  it("源文件 mtime 变化 → 陈旧，并列出变化的文件", async () => {
    const { host, fs } = await generated({ mtime: 1000 });
    // 模拟源文件被编辑：真实文件系统上编辑会推进 mtime
    fs.stat.mockImplementation(async (p: string) => {
      const k = norm(p);
      if (k === `${WS}/src/a.ts`) return { isFile: true, isDir: false, mtimeMs: 2000 };
      return { isFile: true, isDir: false, mtimeMs: 1000 };
    });

    const [info] = await new WikiStore(WS, host).checkStale();
    expect(info.stale).toBe(true);
    expect(info.changedSources).toEqual(["src/a.ts"]);
  });

  it("源文件已不存在 → 陈旧（依据消失，结论不再可靠）", async () => {
    const { host, store } = await generated({ mtime: 1000 });
    store.delete(`${WS}/src/a.ts`);

    const [info] = await new WikiStore(WS, host).checkStale();
    expect(info.stale).toBe(true);
    expect(info.changedSources).toEqual(["src/a.ts"]);
  });

  it("没有生成时快照（如 fresh clone 后 state 被 ignore）→ unknown，而不是满屏误报", async () => {
    const { host } = makeHost({
      files: { [pageFile(WS, "订单系统", { title: "订单系统", summary: "", sources: ["src/a.ts"] }).path]: pageFile(WS, "订单系统", { title: "订单系统", summary: "", sources: ["src/a.ts"] }).content },
    });
    const [info] = await new WikiStore(WS, host).checkStale();
    expect(info.unknown).toBe(true);
    expect(info.stale).toBe(false);
  });

  it("状态文件损坏 → 视为 unknown，不崩", async () => {
    const { host } = await generated({ mtime: 1000 });
    await host.fs.write(wikiStatePath(WS), "{ 这不是合法 json");
    const [info] = await new WikiStore(WS, host).checkStale();
    expect(info.unknown).toBe(true);
  });

  it("宿主拿不到 mtime（虚拟文件系统）→ 跳过不判，而不是误报「没变」", async () => {
    const { host, fs } = await generated({ mtime: 1000 });
    fs.stat.mockImplementation(async (p: string) => {
      const k = norm(p);
      if (k === `${WS}/src/a.ts`) return { isFile: true, isDir: false }; // 无 mtimeMs
      return { isFile: true, isDir: false, mtimeMs: 1000 };
    });

    const [info] = await new WikiStore(WS, host).checkStale();
    expect(info.stale).toBe(false);
    expect(info.unknown).toBe(false);
  });

  it("sources 为空 → 永不陈旧（没有依据可失效）", async () => {
    const { host } = makeHost();
    const w = new WikiStore(WS, host);
    await w.save({ title: "无依据页", summary: "", sources: [], body: "x" });
    const [info] = await w.checkStale();
    expect(info.stale).toBe(false);
    expect(info.unknown).toBe(false);
  });

  it("多个源文件时只列出变化的那几个", async () => {
    const { host, fs } = await generated({ mtime: 1000, sources: ["src/a.ts", "src/b.ts"] });
    fs.stat.mockImplementation(async (p: string) => {
      const k = norm(p);
      return { isFile: true, isDir: false, mtimeMs: k === `${WS}/src/b.ts` ? 2000 : 1000 };
    });

    const [info] = await new WikiStore(WS, host).checkStale();
    expect(info.stale).toBe(true);
    expect(info.changedSources).toEqual(["src/b.ts"]);
  });

  it("save 会采集源文件当前 mtime 作为将来的判定水位", async () => {
    const { host, store } = makeHost({
      files: { "D:/ws/axon/src/a.ts": "内容", "D:/ws/axon/src/b.ts": "内容" },
      mtimes: { "D:/ws/axon/src/a.ts": 111, "D:/ws/axon/src/b.ts": 222 },
    });
    await new WikiStore(WS, host).save({ title: "X", summary: "", sources: ["src/a.ts", "src/b.ts"], body: "x" });

    const state = JSON.parse(store.get("D:/ws/axon/.axon/wiki/.state.json") ?? "{}");
    expect(state.pages.X.sources).toEqual({ "src/a.ts": 111, "src/b.ts": 222 });
  });
});

// ── gitignore ───────────────────────────────────────────────────────────────

describe("WikiStore · .axon/.gitignore", () => {
  it("首次 save 时自动创建：只忽略本机产物与可能带密钥的配置，项目配置照常入库", async () => {
    const { host, store } = makeHost();
    const w = new WikiStore(WS, host);
    await w.save({ title: "X", summary: "", sources: [], body: "x" });

    const content = store.get(norm(wikiGitignorePath(WS)))!;
    expect(content).toBe(WIKI_GITIGNORE_CONTENT);
    expect(content).toContain("/relays/");
    expect(content).toContain("/settings/providers.json");
    // 不再一刀切忽略整个 .axon：AXON.md、skills/ 等要能提交
    expect(content).not.toMatch(/^\/\*$/m);
  });

  it("旧版自动生成的 .gitignore（原样未改）会升级", async () => {
    const legacy = "# Axon 本地状态：本目录除 wiki/ 外一律不入库\n#   relays/ —— 某次任务的中间产物（run-scoped），任务结束即历史，不必共享\n#   本机机器产物（trace 等）落在 ~/.axon/projects/ 下，不在本目录\n/*\n!.gitignore\n!wiki/\n";
    const { host, store } = makeHost({ files: { "D:/ws/axon/.axon/.gitignore": legacy } });
    await new WikiStore(WS, host).save({ title: "X", summary: "", sources: [], body: "x" });
    expect(store.get(norm(wikiGitignorePath(WS)))).toBe(WIKI_GITIGNORE_CONTENT);
  });

  it("已存在时不覆盖（用户可能自己加过规则）", async () => {
    const custom = "# 我自己写的\n/*\n!wiki/\n!my-notes/\n";
    const { host, store } = makeHost({ files: { "D:/ws/axon/.axon/.gitignore": custom } });
    await new WikiStore(WS, host).save({ title: "X", summary: "", sources: [], body: "x" });
    expect(store.get(norm(wikiGitignorePath(WS)))).toBe(custom);
  });
});

// ── 边界 ────────────────────────────────────────────────────────────────────

describe("WikiStore · 边界", () => {
  it("无可用根（空数组）时 save 返回 null 而不抛错", async () => {
    const { host } = makeHost();
    expect(await new WikiStore([], host).save({ title: "X", summary: "", sources: [], body: "" })).toBeNull();
  });

  it("sources 中的空白项被清理", async () => {
    const { host } = makeHost({ files: { "D:/ws/axon/a.ts": "x" } });
    const meta = await new WikiStore(WS, host).save({ title: "X", summary: "", sources: [" a.ts ", "", "  "], body: "" });
    expect(meta?.sources).toEqual(["a.ts"]);
  });

  it("sources 规整：绝对路径转相对、反斜杠转正斜杠、./ 去掉、重复去掉；越界与不存在的丢弃", async () => {
    const { host } = makeHost({ files: { "D:/ws/axon/src/a.ts": "x", "D:/ws/axon/src/b.ts": "y" } });
    const meta = await new WikiStore(WS, host).save({
      title: "X", summary: "", body: "",
      sources: ["D:\\ws\\axon\\src\\a.ts", "./src/b.ts", "src\\a.ts", "../other/c.ts", "D:/elsewhere/d.ts", "src/ghost.ts"],
    });
    expect(meta?.sources).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("pathExists 用到的目录判断：wiki 目录不存在时 save 仍能成功（靠 mkdirp）", async () => {
    const { host, fs } = makeHost();
    await new WikiStore(WS, host).save({ title: "X", summary: "", sources: [], body: "" });
    expect(fs.mkdirp).toHaveBeenCalled();
    expect(fs.mkdirp.mock.calls.some(([p]: [string]) => norm(p) === norm(wikiDir(WS)))).toBe(true);
  });
});

// ── summary（呈现端聚合视图） ──────────────────────────────────────────────

describe("WikiStore · summary 聚合视图", () => {
  it("返回页面元信息 + 绝对路径 + 陈旧状态（呈现端一步拿全，不必自己拼目录）", async () => {
    // 必须真的有这个源文件：否则 save 采不到水位、检测会判「依据消失」→ stale，
    // 那条语义由下面的「引用的源文件不存在」用例专门覆盖
    const { host } = makeHost({
      files: { "D:/ws/axon/src/a.ts": "内容" },
      mtimes: { "D:/ws/axon/src/a.ts": 1000 },
    });
    const w = new WikiStore(WS, host);
    await w.save({ title: "订单系统", summary: "一句话", sources: ["src/a.ts"], body: "x" });

    const [s] = await w.summary();
    expect(s.title).toBe("订单系统");
    expect(s.summary).toBe("一句话");
    expect(norm(s.path)).toBe(`${norm(WS)}/.axon/wiki/订单系统.md`);
    // 刚生成、源文件未动 → 既不陈旧也不是未知
    expect(s.stale).toBe(false);
    expect(s.unknown).toBe(false);
  });

  it("生成时引用了不存在的文件 → 不记进 sources，页面不会一生成就「待复核」", async () => {
    const { host } = makeHost({ files: { "D:/ws/axon/src/a.ts": "x" } });
    const w = new WikiStore(WS, host);
    await w.save({ title: "X", summary: "", sources: ["src/a.ts", "src/ghost.ts"], body: "" });

    const [s] = await w.summary();
    expect(s.sources).toEqual(["src/a.ts"]);
    expect(s.stale).toBe(false);
  });

  it("依据文件生成后被删掉 → 判为需要复核", async () => {
    const { host, store } = makeHost({ files: { "D:/ws/axon/src/a.ts": "x" } });
    const w = new WikiStore(WS, host);
    await w.save({ title: "X", summary: "", sources: ["src/a.ts"], body: "" });
    store.delete("D:/ws/axon/src/a.ts");
    const [s] = await w.summary();
    expect(s.stale).toBe(true);
    expect(s.changedSources).toEqual(["src/a.ts"]);
  });

  it("markReviewed 重新记录时间戳，「待复核」消失", async () => {
    const { host } = makeHost({ files: { "D:/ws/axon/src/a.ts": "x" } });
    const w = new WikiStore(WS, host);
    await w.save({ title: "X", summary: "", sources: ["src/a.ts"], body: "" });
    // 源文件被改过：内容变了，stat 拿到新的 mtime
    await host.fs.write("D:/ws/axon/src/a.ts", "changed");
    const orig = host.fs.stat;
    host.fs.stat = (async (p: string) => {
      const r = await orig(p);
      return r && norm(p).endsWith("src/a.ts") ? { ...r, mtimeMs: 5000 } : r;
    }) as typeof host.fs.stat;
    expect((await w.summary())[0].stale).toBe(true);
    expect(await w.markReviewed("X", WS)).toBe(true);
    expect((await w.summary())[0].stale).toBe(false);
  });

  it("写状态时在 wiki/ 下放 .gitignore 挡住 .state.json", async () => {
    const { host, store } = makeHost({ files: { "D:/ws/axon/src/a.ts": "x" } });
    await new WikiStore(WS, host).save({ title: "X", summary: "", sources: ["src/a.ts"], body: "" });
    const ig = store.get("D:/ws/axon/.axon/wiki/.gitignore");
    expect(ig).toContain(".*");
    expect(ig).toContain("!.gitignore");
  });

  it("状态文件写坏了（半截 JSON）→ 退回备份，不丢其它页的记录", async () => {
    const { host, store } = makeHost({ files: { "D:/ws/axon/src/a.ts": "x" } });
    const w = new WikiStore(WS, host);
    await w.save({ title: "A", summary: "", sources: ["src/a.ts"], body: "" });
    store.set("D:/ws/axon/.axon/wiki/.state.json", "{\"version\":1,\"pa");
    await w.save({ title: "B", summary: "", sources: ["src/a.ts"], body: "" });
    const state = JSON.parse(store.get("D:/ws/axon/.axon/wiki/.state.json")!);
    expect(Object.keys(state.pages).sort()).toEqual(["A", "B"]);
  });

  it("没有 wiki 时返回空数组（侧边栏据此显示空状态）", async () => {
    const { host } = makeHost();
    expect(await new WikiStore(WS, host).summary()).toEqual([]);
  });

  it("按标题排序：列表要便于查找，顺序必须稳定", async () => {
    const { host } = makeHost();
    const w = new WikiStore(WS, host);
    await w.save({ title: "B页", summary: "", sources: [], body: "" });
    await w.save({ title: "A页", summary: "", sources: [], body: "" });
    await w.save({ title: "C页", summary: "", sources: [], body: "" });
    expect((await w.summary()).map((p) => p.title)).toEqual(["A页", "B页", "C页"]);
  });

  it("没有生成时快照 → unknown 而非 stale（fresh clone 后不该满屏警告）", async () => {
    const { host } = makeHost({
      files: { "D:/ws/axon/.axon/wiki/x.md": "---\ntitle: X\nsources:\n  - src/a.ts\n---\n正文" },
    });
    const [s] = await new WikiStore(WS, host).summary();
    expect(s.unknown).toBe(true);
    expect(s.stale).toBe(false);
  });

  it("源文件变化 → stale，并带出具体是哪个文件变了", async () => {
    const { host } = makeHost({
      files: {
        "D:/ws/axon/src/a.ts": "内容",
        // state 记录生成时 mtime = 100
        "D:/ws/axon/.axon/wiki/.state.json": JSON.stringify({
          version: 1,
          pages: { x: { sources: { "src/a.ts": 100 }, generatedAt: "2026-09-20T10:00:00.000Z" } },
        }),
        "D:/ws/axon/.axon/wiki/x.md": "---\ntitle: X\nsources:\n  - src/a.ts\n---\n",
      },
      // 当前 mtime = 999，与记录不符
      mtimes: { "D:/ws/axon/src/a.ts": 999 },
    });

    const [s] = await new WikiStore(WS, host).summary();
    expect(s.stale).toBe(true);
    expect(s.changedSources).toEqual(["src/a.ts"]);
  });

  it("多工作区同名页面各自保留（按 工作区 + slug 区分），删除只删指定工作区的", async () => {
    const WS2 = "D:/ws/other";
    const { host } = makeHost({
      files: {
        "D:/ws/axon/.axon/wiki/x.md": "---\ntitle: 首根版本\n---\n",
        "D:/ws/other/.axon/wiki/x.md": "---\ntitle: 次根版本\n---\n",
      },
    });
    const w = new WikiStore([WS, WS2], host);
    const list = await w.summary();
    expect(list.map((p) => p.title).sort()).toEqual(["次根版本", "首根版本"]);
    expect(await w.remove("x", WS2)).toBe(true);
    const after = await w.summary();
    expect(after.map((p) => p.title)).toEqual(["首根版本"]);
  });
});

// ── 索引注入（buildWikiIndexPrompt） ────────────────────────────────────────

/** 构造一条 WikiPageSummary（只写关心的字段，其余给默认值） */
function mkPage(title: string, over: Partial<WikiPageSummary> = {}): WikiPageSummary {
  return {
    slug: title,
    title,
    summary: "",
    sources: [],
    workspace: WS,
    path: `${WS}/.axon/wiki/${title}.md`,
    stale: false,
    unknown: false,
    changedSources: [],
    ...over,
  };
}

describe("buildWikiIndexPrompt · 索引注入", () => {
  it("没有页面时返回 null —— 未使用 Wiki 的项目完全不注入（这是最重要的一条）", () => {
    expect(buildWikiIndexPrompt([])).toBeNull();
  });

  it("列出标题与摘要，并说明正文用 read_file 读取", () => {
    const text = buildWikiIndexPrompt([mkPage("订单系统", { summary: "订单的创建与流转" })])!;
    expect(text).toContain("订单系统");
    expect(text).toContain("订单的创建与流转");
    expect(text).toContain("read_file");
    expect(text).toContain(".axon/wiki/");
  });

  it("陈旧页面带 ⚠️，并提示引用前核实（过时比没有更糟）", () => {
    const text = buildWikiIndexPrompt([mkPage("订单系统", { stale: true, changedSources: ["src/a.ts"] })])!;
    expect(text).toContain("⚠️");
    expect(text).toContain("核实");
  });

  it("unknown（缺生成快照）不加 ⚠️ —— 判不了不等于已失效，不制造噪声", () => {
    const text = buildWikiIndexPrompt([mkPage("订单系统", { unknown: true })])!;
    // 注意：header 的说明文字里本就含「⚠️」二字，所以这里要断言的是【页面行】没被标记，
    // 而不是整段不含该符号 —— 后者永远失败，且也没测到真正关心的东西。
    expect(text).toContain("- 订单系统");
    expect(text).not.toContain("- ⚠️");
  });

  it("单工作区不加工作区前缀（最常见情形省长度）", () => {
    const text = buildWikiIndexPrompt([mkPage("订单系统")])!;
    expect(text).not.toContain("axon ｜");
    expect(text).not.toContain("D:/ws/axon ｜");
  });

  it("多工作区时加工作区名区分归属（同名页面只能靠它分辨）", () => {
    const text = buildWikiIndexPrompt([
      mkPage("订单系统", { workspace: "D:/ws/axon" }),
      mkPage("支付流程", { workspace: "D:/ws/other" }),
    ])!;
    expect(text).toContain("axon ｜ 订单系统");
    expect(text).toContain("other ｜ 支付流程");
  });

  it("页面数超上限时截断，并告知总数与查看方式", () => {
    const pages = Array.from({ length: 40 }, (_, i) => mkPage(`页${i}`));
    const text = buildWikiIndexPrompt(pages, { maxPages: 5, maxChars: 100000 })!;
    expect(text).toContain("页0");
    expect(text).not.toContain("页5");
    expect(text).toContain("共 40 页");
    expect(text).toContain("此处列前 5 页");
  });

  it("字符预算封顶：页面再多，注入长度也不会无界增长", () => {
    const pages = Array.from({ length: 200 }, (_, i) => mkPage(`很长的页面标题第${i}号`, { summary: "这是一段较长的摘要说明".repeat(3) }));
    const text = buildWikiIndexPrompt(pages, { maxChars: 500 })!;
    // 上限约束的是「清单部分」；尾部还有一句固定长度的截断说明，故留出余量
    expect(text.length).toBeLessThanOrEqual(500 + 120);
  });

  it("摘要超长时截断并加省略号（摘要本该是一句话）", () => {
    const long = "很长的摘要".repeat(30);
    const text = buildWikiIndexPrompt([mkPage("X", { summary: long })])!;
    expect(text).toContain("…");
    // 断言「摘要原文没有整段出现」，而不是比较整段长度 ——
    // 整段还含固定长度的 header，拿它跟摘要长度比没有意义。
    expect(text).not.toContain(long);
  });

  it("无摘要时不出现多余的冒号", () => {
    const text = buildWikiIndexPrompt([mkPage("X")])!;
    expect(text).toContain("- X");
    expect(text).not.toContain("- X：");
  });

  it("上限小到连一页都放不下时返回 null，而不是注入一个只有说明的空壳", () => {
    expect(buildWikiIndexPrompt([mkPage("X")], { maxChars: 10 })).toBeNull();
  });

  it("WikiStore.buildIndexPrompt 走通 summary → 索引（端到端）", async () => {
    const { host } = makeHost();
    const w = new WikiStore(WS, host);
    await w.save({ title: "订单系统", summary: "订单流转", sources: [], body: "正文不该出现在索引里" });

    const text = await w.buildIndexPrompt();
    expect(text).toContain("订单系统");
    expect(text).toContain("订单流转");
    // 关键：注入的是索引，正文不跟着进提示词
    expect(text).not.toContain("正文不该出现在索引里");
  });

  it("WikiStore 无页面时 buildIndexPrompt 返回 null", async () => {
    const { host } = makeHost();
    expect(await new WikiStore(WS, host).buildIndexPrompt()).toBeNull();
  });
});

// ── 记忆召回（结构化清单 + 变化签名） ───────────────────────────────────────

describe("buildWikiRecall · 结构化召回", () => {
  it("无页面时返回 null（未使用 Wiki 的项目零成本）", () => {
    expect(buildWikiRecall([])).toBeNull();
  });

  it("清单与注入文本出自同一次计算：列出的页与文本一致", () => {
    const recall = buildWikiRecall([mkPage("订单系统"), mkPage("鉴权流程", { stale: true })])!;
    expect(recall.total).toBe(2);
    expect(recall.pages).toEqual([
      { title: "订单系统", stale: false },
      { title: "鉴权流程", stale: true },
    ]);
    expect(recall.prompt).toContain("订单系统");
    expect(recall.prompt).toContain("⚠️ 鉴权流程");
  });

  it("截断时 total 记全量、pages 只记实际注入的（卡片据此提示「另有 N 页未注入」）", () => {
    const pages = Array.from({ length: 40 }, (_, i) => mkPage(`页${i}`));
    const recall = buildWikiRecall(pages, { maxPages: 5, maxChars: 100000 })!;
    expect(recall.total).toBe(40);
    expect(recall.pages).toHaveLength(5);
  });
});

describe("wikiRecallSignature · 变化判定", () => {
  const mk = (titles: string[], total = titles.length): WikiRecall => ({
    prompt: "",
    total,
    staleTotal: 0,
    pages: titles.map((title) => ({ title, stale: false })),
  });

  it("同一批页面 → 签名相同（稳定期静默，不刷屏）", () => {
    expect(wikiRecallSignature(mk(["A", "B"]))).toBe(wikiRecallSignature(mk(["A", "B"])));
  });

  it("页面增删 → 签名变化（这才该提示）", () => {
    expect(wikiRecallSignature(mk(["A"]))).not.toBe(wikiRecallSignature(mk(["A", "B"])));
  });

  it("某页转陈旧 → 签名变化（依据变了，最该被看见）", () => {
    const before: WikiRecall = { prompt: "", total: 1, staleTotal: 0, pages: [{ title: "A", stale: false }] };
    const after: WikiRecall = { prompt: "", total: 1, staleTotal: 0, pages: [{ title: "A", stale: true }] };
    expect(wikiRecallSignature(before)).not.toBe(wikiRecallSignature(after));
  });

  it("页面集合与陈旧状态都没变、只是摘要变了 → 签名不变（边界没变就不打断）", () => {
    const a: WikiRecall = { prompt: "摘要甲", total: 1, staleTotal: 0, pages: [{ title: "A", stale: false }] };
    const b: WikiRecall = { prompt: "摘要乙", total: 1, staleTotal: 0, pages: [{ title: "A", stale: false }] };
    expect(wikiRecallSignature(a)).toBe(wikiRecallSignature(b));
  });

  it("总数变了但列出的页没变（截断口径变化）→ 签名变化", () => {
    expect(wikiRecallSignature(mk(["A"], 1))).not.toBe(wikiRecallSignature(mk(["A"], 5)));
  });
});

// ── 目标工作区（生成是写操作，必须锁定单一仓库） ────────────────────────────

describe("WikiStore · 目标工作区", () => {
  const WS2 = "D:/ws/other";

  it("save 可显式指定目标工作区，不默认落到主工作区", async () => {
    // 这是最重要的一条：会话 cwd 是 WS，但用户要求为 WS2 生成。
    // 若默认写主工作区，页面会进错仓库、还会被提交上去。
    const { host, store } = makeHost();
    const w = new WikiStore([WS, WS2], host);

    await w.save({ title: "X", summary: "", sources: [], body: "x", workspace: WS2 });

    expect(store.has(norm(`${WS2}/.axon/wiki/X.md`))).toBe(true);
    expect(store.has(norm(`${WS}/.axon/wiki/X.md`))).toBe(false);
  });

  it("不指定 workspace 时仍落主工作区（保持既有行为）", async () => {
    const { host, store } = makeHost();
    await new WikiStore([WS, WS2], host).save({ title: "X", summary: "", sources: [], body: "x" });
    expect(store.has(norm(`${WS}/.axon/wiki/X.md`))).toBe(true);
  });

  it("指定目标时，源文件 mtime 快照按该工作区解析", async () => {
    const { host, store } = makeHost({
      files: { [`${WS2}/src/a.ts`]: "内容" },
      mtimes: { [`${WS2}/src/a.ts`]: 777 },
    });
    await new WikiStore([WS, WS2], host).save({ title: "X", summary: "", sources: ["src/a.ts"], body: "x", workspace: WS2 });

    const state = JSON.parse(store.get(norm(`${WS2}/.axon/wiki/.state.json`)) ?? "{}");
    expect(state.pages.X.sources).toEqual({ "src/a.ts": 777 });
  });

  it("指定目标时，.gitignore 建在目标工作区", async () => {
    const { host, store } = makeHost();
    await new WikiStore([WS, WS2], host).save({ title: "X", summary: "", sources: [], body: "x", workspace: WS2 });
    expect(store.has(norm(`${WS2}/.axon/.gitignore`))).toBe(true);
  });
});

// ── 生成作业 ────────────────────────────────────────────────────────────────

describe("pendingPages · 续跑计算", () => {
  it("计划减去已完成", () => {
    expect(pendingPages({ planned: ["a", "b", "c"], done: ["b"] })).toEqual(["a", "c"]);
  });

  it("全部完成 → 空（无可续跑）", () => {
    expect(pendingPages({ planned: ["a"], done: ["a"] })).toEqual([]);
  });

  it("done 里的多余项（页面已被删）不影响计划", () => {
    expect(pendingPages({ planned: ["a"], done: ["a", "ghost"] })).toEqual([]);
  });
});

describe("WikiStore · 生成作业", () => {
  it("startJob 建出 running 作业，并记住目标工作区", async () => {
    const { host } = makeHost();
    const w = new WikiStore(WS, host);
    const job = await w.startJob({ workspace: WS, planned: ["订单系统", "支付流程"], model: "m1", sessionId: "s-1" });

    expect(job.status).toBe("running");
    expect(job.workspace).toBe(WS);
    expect(job.planned).toEqual(["订单系统", "支付流程"]);
    expect(job.done).toEqual([]);
    // sessionId 只留作溯源
    expect(job.sessionId).toBe("s-1");
  });

  it("save 会自动把该页记入运行中作业的 done（调用方不必手动推进进度）", async () => {
    const { host } = makeHost();
    const w = new WikiStore(WS, host);
    await w.startJob({ workspace: WS, planned: ["A", "B"] });

    await w.save({ title: "A", summary: "", sources: [], body: "x" });

    const job = await w.getResumableJob(WS);
    expect(job?.done).toEqual(["A"]);
    expect(pendingPages(job!)).toEqual(["B"]);
  });

  it("save 一个不在计划里的页，不会污染作业进度", async () => {
    const { host } = makeHost();
    const w = new WikiStore(WS, host);
    await w.startJob({ workspace: WS, planned: ["A"] });
    await w.save({ title: "无关页", summary: "", sources: [], body: "x" });
    expect((await w.getResumableJob(WS))?.done).toEqual([]);
  });

  it("中断后 getResumableJob 仍能返回它（跨会话/跨重启续跑的依据）", async () => {
    const { host } = makeHost();
    const w = new WikiStore(WS, host);
    const job = await w.startJob({ workspace: WS, planned: ["A", "B", "C"] });
    await w.save({ title: "A", summary: "", sources: [], body: "x" });

    // 模拟进程被关掉：没有 finishJob，状态停在 running
    const resumed = await w.getResumableJob(WS);
    expect(resumed?.id).toBe(job.id);
    expect(pendingPages(resumed!)).toEqual(["B", "C"]);
  });

  it("全部完成后 getResumableJob 返回 null", async () => {
    const { host } = makeHost();
    const w = new WikiStore(WS, host);
    await w.startJob({ workspace: WS, planned: ["A"] });
    await w.save({ title: "A", summary: "", sources: [], body: "x" });
    expect(await w.getResumableJob(WS)).toBeNull();
  });

  it("没有作业时 getResumableJob 返回 null", async () => {
    const { host } = makeHost();
    expect(await new WikiStore(WS, host).getResumableJob(WS)).toBeNull();
  });

  it("开新作业会把遗留的 running 标为 interrupted（那个作业其实早已随进程结束）", async () => {
    const { host, store } = makeHost();
    const w = new WikiStore(WS, host);
    const old = await w.startJob({ workspace: WS, planned: ["A", "B"] });
    await w.startJob({ workspace: WS, planned: ["C"] });

    const jobs = JSON.parse(store.get(norm(`${WS}/.axon/wiki/.state.json`)) ?? "{}").jobs as { id: string; status: string }[];
    expect(jobs.find((j) => j.id === old.id)?.status).toBe("interrupted");
    // 新作业在，且排在最前（最新的优先被续跑取到）
    expect(jobs[0].status).toBe("running");
  });

  it("finishJob 落终态与失败原因", async () => {
    const { host, store } = makeHost();
    const w = new WikiStore(WS, host);
    const job = await w.startJob({ workspace: WS, planned: ["A"] });
    await w.finishJob(job.id, "failed", "模型调用超时");

    const saved = (JSON.parse(store.get(norm(`${WS}/.axon/wiki/.state.json`)) ?? "{}").jobs as { id: string; status: string; error?: string }[])
      .find((j) => j.id === job.id);
    expect(saved?.status).toBe("failed");
    expect(saved?.error).toBe("模型调用超时");
  });

  it("finishJob 遇到未知 id 时静默返回（记录可能已被保留策略清掉）", async () => {
    const { host } = makeHost();
    const w = new WikiStore(WS, host);
    await expect(w.finishJob("不存在的作业", "done")).resolves.toBeUndefined();
  });

  it("删掉页面会把它从 done 里摘掉，重回待生成", async () => {
    const { host } = makeHost();
    const w = new WikiStore(WS, host);
    await w.startJob({ workspace: WS, planned: ["A", "B"] });
    await w.save({ title: "A", summary: "", sources: [], body: "x" });
    await w.remove("A");

    // 否则续跑会以为 A 已完成而跳过 → 这页永久缺失且无人察觉
    expect(pendingPages((await w.getResumableJob(WS))!)).toEqual(["A", "B"]);
  });

  it("作业记录按上限保留，不会无限攒", async () => {
    const { host } = makeHost();
    const w = new WikiStore(WS, host);
    for (let i = 0; i < WIKI_JOB_KEEP + 4; i++) {
      await w.startJob({ workspace: WS, planned: [`p${i}`] });
    }
    const raw = await host.fs.read(`${WS}/.axon/wiki/.state.json`);
    expect((JSON.parse(raw ?? "{}").jobs as unknown[]).length).toBe(WIKI_JOB_KEEP);
  });
});


describe("WikiStore · 内容指纹", () => {
  it("时间戳变了但内容没变（切分支 / 重新 clone）→ 不算过期", async () => {
    const { host } = makeHost({ files: { "D:/ws/axon/src/a.ts": "x" } });
    const w = new WikiStore(WS, host);
    await w.save({ title: "X", summary: "", sources: ["src/a.ts"], body: "" });
    const orig = host.fs.stat;
    host.fs.stat = (async (p: string) => {
      const r = await orig(p);
      return r && norm(p).endsWith("src/a.ts") ? { ...r, mtimeMs: 777 } : r;
    }) as typeof host.fs.stat;
    expect((await w.summary())[0].stale).toBe(false);
  });

  it("没有本机状态（队友刚 clone）也能按指纹判断，而不是「未知」", async () => {
    const { host, store } = makeHost({ files: { "D:/ws/axon/src/a.ts": "x" } });
    const w = new WikiStore(WS, host);
    await w.save({ title: "X", summary: "", sources: ["src/a.ts"], body: "" });
    store.delete("D:/ws/axon/.axon/wiki/.state.json");
    store.delete("D:/ws/axon/.axon/wiki/.state.json.bak");
    const [fresh] = await w.summary();
    expect(fresh.unknown).toBe(false);
    expect(fresh.stale).toBe(false);
    store.set("D:/ws/axon/src/a.ts", "y");
    const orig = host.fs.stat;
    host.fs.stat = (async (p: string) => {
      const r = await orig(p);
      return r && norm(p).endsWith("src/a.ts") ? { ...r, mtimeMs: 2222 } : r;
    }) as typeof host.fs.stat;
    const [stale] = await new WikiStore(WS, host).summary();
    expect(stale.stale).toBe(true);
  });

  it("CRLF 与 LF 视为同一内容", async () => {
    const { host, store } = makeHost({ files: { "D:/ws/axon/src/a.ts": "a\nb\n" } });
    const w = new WikiStore(WS, host);
    await w.save({ title: "X", summary: "", sources: ["src/a.ts"], body: "" });
    store.delete("D:/ws/axon/.axon/wiki/.state.json");
    store.delete("D:/ws/axon/.axon/wiki/.state.json.bak");
    store.set("D:/ws/axon/src/a.ts", "a\r\nb\r\n");
    const orig = host.fs.stat;
    host.fs.stat = (async (p: string) => {
      const r = await orig(p);
      return r && norm(p).endsWith("src/a.ts") ? { ...r, mtimeMs: 3333 } : r;
    }) as typeof host.fs.stat;
    expect((await new WikiStore(WS, host).summary())[0].stale).toBe(false);
  });

  it("指纹写进 frontmatter，可往返解析", () => {
    const text = serializeWikiPage({ title: "T", summary: "s", sources: ["src/a.ts"], sourceHashes: { "src/a.ts": "abc123def456" }, body: "x" });
    expect(parseWikiFrontmatter(text).meta.sourceHashes).toEqual({ "src/a.ts": "abc123def456" });
  });

  it("分类变体收敛到固定五类", () => {
    expect(normalizeWikiCategory("架构设计")).toBe("架构");
    expect(normalizeWikiCategory("Overview")).toBe("概览");
    expect(normalizeWikiCategory("业务模型")).toBe("领域");
    expect(normalizeWikiCategory("奇怪的分类")).toBe("奇怪的分类");
  });

  it("文件名只差大小写时沿用已有文件，截断不切坏 emoji", async () => {
    const { host } = makeHost();
    const w = new WikiStore(WS, host);
    await w.save({ title: "API", summary: "", sources: [], body: "1" });
    const second = await w.save({ title: "api", summary: "", sources: [], body: "2" });
    expect(second?.slug).toBe("API");
    expect(Array.from(wikiSlug("😀".repeat(70))).length).toBe(60);
  });
});
