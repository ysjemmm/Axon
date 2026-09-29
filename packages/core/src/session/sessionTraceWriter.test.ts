import { describe, expect, it, vi } from "vitest";
import type { AgentHost } from "../host/index.js";
import {
  DEFAULT_TRACE_CONFIG,
  SessionTraceWriter,
  normalizeTraceConfig,
  projectTraceDir,
  pruneOldTraces,
  truncateForTrace,
} from "./sessionTraceWriter.js";

/** 归一化路径：Windows 上 join/resolve 产出反斜杠，比较前统一 */
const norm = (p: string) => p.replace(/\\/g, "/");

const ROOT = "/home/u/.axon/projects/Axon-abc123/traces";

/** 内存 fs：记录写入内容与建过的目录，供断言 */
function makeHost(seed: string[] = []) {
  const store = new Map<string, string>();
  const dirs = new Set<string>();
  for (const f of seed) store.set(norm(f), "");
  const fs = {
    mkdirp: vi.fn(async (p: string) => { dirs.add(norm(p)); }),
    read: vi.fn(async (p: string) => store.get(norm(p)) ?? null),
    write: vi.fn(async (p: string, content: string) => { store.set(norm(p), content); }),
    append: vi.fn(async (p: string, content: string) => {
      const k = norm(p);
      store.set(k, (store.get(k) ?? "") + content);
      dirs.add(norm(k).split("/").slice(0, -1).join("/"));
    }),
    remove: vi.fn(async (p: string) => { store.delete(norm(p)); }),
    readdir: vi.fn(async (p: string) => {
      const prefix = `${norm(p)}/`;
      const names = new Map<string, boolean>();
      for (const k of store.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (rest && !rest.includes("/")) names.set(rest, false);
      }
      return [...names.entries()].map(([name, isDir]) => ({ name, path: `${norm(p)}/${name}`, isFile: !isDir, isDir }));
    }),
  } as any;
  return { host: { fs } as AgentHost, store, dirs, fs };
}

/** 取某文件的所有事件（已解析） */
function events(store: Map<string, string>, filePath: string) {
  const content = store.get(norm(filePath)) || "";
  return content.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const delta = (type: "reasoning.delta" | "text.delta", text: string, turn = 1) => ({
  ts: "t", sessionId: "sid-1", type, turn, payload: { text: { text, truncated: false, originalLength: text.length } },
});

describe("SessionTraceWriter · 落盘位置", () => {
  it("写到注入的 rootDir，与工作区无关", async () => {
    const { host, fs } = makeHost();
    const w = new SessionTraceWriter({ host, rootDir: ROOT });
    await w.init("sid-1");
    // 用 includes 而非 startsWith：Windows 上 resolve 会给 "/home/..." 补上盘符，
    // 得到 "D:/home/..."，前缀断言会假失败。这里要验的是"落在注入的 rootDir 之内"。
    expect(norm(w.getPath())).toContain(ROOT);
    // 文件名含创建时间戳（trace-<epochMs>-<sid>.jsonl），故用正则而非固定串
    expect(norm(w.getPath())).toMatch(/trace-\d+-sid-1\.jsonl$/);
    // 且绝不在工作区里凭空造 .axon
    expect(norm(w.getPath())).not.toContain("/work/");
    expect(fs.append).toHaveBeenCalled();
  });

  it("文件名内嵌创建时间戳 —— 淘汰时按名排序即可判新旧（host 的 stat 没有 mtime）", async () => {
    const { host } = makeHost();
    const w = new SessionTraceWriter({ host, rootDir: ROOT });
    await w.init("sid-1");
    expect(w.getPath()).toMatch(/trace-\d{13}-sid-1\.jsonl$/);
  });

  it("level=off：既不建目录也不写文件", async () => {
    const { host, fs } = makeHost();
    const w = new SessionTraceWriter({ host, rootDir: ROOT, config: { level: "off" } });
    await w.init("sid-1");
    await w.append(delta("reasoning.delta", "x"));
    expect(fs.mkdirp).not.toHaveBeenCalled();
    expect(fs.append).not.toHaveBeenCalled();
    expect(w.isEnabled()).toBe(false);
  });
});

describe("SessionTraceWriter · 等级", () => {
  it("summary：丢弃思考/正文，只留骨架", async () => {
    const { host, store } = makeHost();
    const w = new SessionTraceWriter({ host, rootDir: ROOT, config: { level: "summary" } });
    await w.init("sid-1");
    await w.append(delta("reasoning.delta", "一段很长的思考"));
    await w.append({ ts: "t", sessionId: "sid-1", type: "turn.end", turn: 1, payload: {} });
    const types = events(store, w.getPath()).map((e) => e.type);
    expect(types).toEqual(["session.trace_ready", "turn.end"]);
    expect(JSON.stringify(events(store, w.getPath()))).not.toContain("一段很长的思考");
  });

  it("normal：连续同类增量聚合成一条 block，内容一字不少", async () => {
    const { host, store } = makeHost();
    const w = new SessionTraceWriter({ host, rootDir: ROOT, config: { level: "normal" } });
    await w.init("sid-1");
    await w.append(delta("reasoning.delta", "第一段"));
    await w.append(delta("reasoning.delta", "第二段"));
    await w.append(delta("reasoning.delta", "第三段"));
    await w.append({ ts: "t", sessionId: "sid-1", type: "turn.end", turn: 1, payload: {} });

    const list = events(store, w.getPath());
    const blocks = list.filter((e) => e.type === "reasoning.block");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].payload.text).toBe("第一段第二段第三段");
    expect(blocks[0].payload.chunks).toBe(3);
    // 聚合的价值就在于此：3 条增量只付一次 JSON 外壳
    expect(list.map((e) => e.type)).toEqual(["session.trace_ready", "reasoning.block", "turn.end"]);
  });

  it("normal：思考↔正文交替时按真实先后落成多条 block（顺序不失真）", async () => {
    const { host, store } = makeHost();
    const w = new SessionTraceWriter({ host, rootDir: ROOT, config: { level: "normal" } });
    await w.init("sid-1");
    await w.append(delta("reasoning.delta", "想A"));
    await w.append(delta("text.delta", "说B"));
    await w.append(delta("reasoning.delta", "再想C"));
    await w.flush();

    const types = events(store, w.getPath()).map((e) => e.type);
    expect(types).toEqual(["session.trace_ready", "reasoning.block", "text.block", "reasoning.block"]);
  });

  it("full：逐条落盘，不聚合", async () => {
    const { host, store } = makeHost();
    const w = new SessionTraceWriter({ host, rootDir: ROOT, config: { level: "full" } });
    await w.init("sid-1");
    await w.append(delta("reasoning.delta", "a"));
    await w.append(delta("reasoning.delta", "b"));
    const types = events(store, w.getPath()).map((e) => e.type);
    expect(types).toEqual(["session.trace_ready", "reasoning.delta", "reasoning.delta"]);
  });
});

describe("SessionTraceWriter · 体积上限", () => {
  it("达到单文件上限后停写，并留下 trace.capped 说明", async () => {
    const { host, store } = makeHost();
    // 0.5MB 上限 × 40 块各 2 万字符（合计约 0.8MB），必然触顶
    const w = new SessionTraceWriter({ host, rootDir: ROOT, config: { level: "normal", maxFileMB: 0.5 } });
    await w.init("sid-1");
    for (let i = 0; i < 40; i++) {
      await w.append(delta("text.delta", "x".repeat(20_000)));
      await w.flush();
    }
    const list = events(store, w.getPath());
    expect(list.some((e) => e.type === "trace.capped")).toBe(true);
    // 触顶后不再增长
    const before = (store.get(norm(w.getPath())) || "").length;
    await w.append(delta("text.delta", "y".repeat(5000)));
    await w.flush();
    expect((store.get(norm(w.getPath())) || "").length).toBe(before);
    expect(w.isEnabled()).toBe(false);
  });
});

describe("pruneOldTraces · 保留最近 N 份", () => {
  it("按文件名时间戳升序淘汰，保留最新的 N 份", async () => {
    const mk = (ts: number) => `${ROOT}/trace-${ts}-sid.jsonl`;
    const { host, store, fs } = makeHost([mk(1000), mk(2000), mk(3000), mk(4000)]);
    const removed = await pruneOldTraces(host, ROOT, 2);
    expect(removed).toBe(2);
    // 断言前归一化：写入器用 join 拼路径，Windows 上会是反斜杠
    const removedArgs = (fs.remove as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => norm(c[0]));
    expect(removedArgs).toContain(norm(mk(1000)));
    expect(removedArgs).toContain(norm(mk(2000)));
    const left = [...store.keys()].filter((k) => k.includes("trace-")).map(norm).sort();
    expect(left).toEqual([norm(mk(3000)), norm(mk(4000))].sort());
  });

  it("不匹配命名规则的文件不受影响", async () => {
    const { host, store } = makeHost([`${ROOT}/README.md`, `${ROOT}/trace-1000-a.jsonl`]);
    await pruneOldTraces(host, ROOT, 0);
    expect([...store.keys()].some((k) => k.endsWith("README.md"))).toBe(true);
  });

  it("目录不存在时不抛错、也不去创建它", async () => {
    const { host, fs } = makeHost();
    fs.readdir = vi.fn(async () => { throw new Error("ENOENT"); });
    await expect(pruneOldTraces(host, "/nope", 5)).resolves.toBe(0);
    expect(fs.mkdirp).not.toHaveBeenCalled();
  });
});

describe("projectTraceDir / normalizeTraceConfig", () => {
  it("trace 落在用户目录的项目分区下，绝不落在工作区里", () => {
    const dir = norm(projectTraceDir("/home/u", "/work/my-proj"));
    expect(dir.startsWith("/home/u/.axon/projects/")).toBe(true);
    expect(dir.endsWith("/traces")).toBe(true);
    expect(dir).not.toContain("/work/my-proj/.axon");
  });

  it("同一工作区映射稳定，不同工作区互不冲突", () => {
    expect(projectTraceDir("/home/u", "/work/a")).toBe(projectTraceDir("/home/u", "/work/a"));
    expect(projectTraceDir("/home/u", "/work/a")).not.toBe(projectTraceDir("/home/u", "/work/b"));
  });

  it("非法配置回退默认，不抛错", () => {
    expect(normalizeTraceConfig(null)).toEqual(DEFAULT_TRACE_CONFIG);
    expect(normalizeTraceConfig({ level: "nope" as never, maxFileMB: -1, keepRecentFiles: 0 })).toEqual(DEFAULT_TRACE_CONFIG);
    expect(normalizeTraceConfig({ level: "full", maxFileMB: 5, keepRecentFiles: 3 })).toEqual({ level: "full", maxFileMB: 5, keepRecentFiles: 3 });
  });
});

describe("SessionTraceWriter · 追加写约束", () => {
  it("必须走 append，不得 read+write（否则长会话是 O(n²) I/O）", async () => {
    const { host, fs } = makeHost();
    const w = new SessionTraceWriter({ host, rootDir: ROOT });
    await w.init("sid-1");
    await w.append({ ts: "t1", sessionId: "sid-1", type: "user.input", turn: 1, payload: {} });
    await w.append({ ts: "t2", sessionId: "sid-1", type: "turn.end", turn: 1, payload: {} });
    expect(fs.append).toHaveBeenCalledTimes(3);
    expect(fs.write).not.toHaveBeenCalled();
    expect(fs.read).not.toHaveBeenCalled();
  });
});

describe("truncateForTrace", () => {
  it("短文本不截断", () => {
    expect(truncateForTrace("abc", 10)).toEqual({ text: "abc", truncated: false, originalLength: 3 });
  });

  it("长文本截断并保留原长度", () => {
    expect(truncateForTrace("abcdef", 3)).toEqual({ text: "abc", truncated: true, originalLength: 6 });
  });
});
