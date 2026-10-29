import { describe, expect, it } from "vitest";
import type { AgentHost } from "../host/index.js";
import { executeToolCall } from "./execute.js";
import { isAxonTmpPath, pruneAxonTmp } from "./axonTmp.js";

const norm = (p: string) => p.replace(/\\/g, "/");

function makeHost(files: Record<string, string> = {}, mtimes: Record<string, number> = {}) {
  const store = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  const times = new Map(Object.entries(mtimes).map(([k, v]) => [norm(k), v]));
  let edited = false;
  const host = {
    fs: {
      read: async (p: string) => store.get(norm(p)) ?? null,
      write: async (p: string, c: string) => { store.set(norm(p), c); },
      mkdirp: async () => {},
      remove: async (p: string) => { store.delete(norm(p)); },
      stat: async (p: string) => (store.has(norm(p)) ? { isFile: true, isDir: false, mtimeMs: times.get(norm(p)) ?? Date.now() } : null),
      readdir: async (p: string) => {
        const prefix = `${norm(p)}/`;
        return [...store.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
          .map((k) => ({ name: k.slice(prefix.length), path: k, isFile: true, isDir: false }));
      },
    },
    edits: { readEffective: async () => { edited = true; return { content: "", existsOnDisk: false, fromPending: false }; } },
  } as unknown as AgentHost;
  return { host, store, wasEdited: () => edited };
}

describe("create_file temporary", () => {
  it("写进 .axon/tmp/、不走改动审阅，并让 .axon/.gitignore 忽略 tmp/", async () => {
    const { host, store, wasEdited } = makeHost();
    const meta: Record<string, unknown> = {};
    const out = await executeToolCall("create_file", { path: "scripts/verify-round8.cjs", content: "console.log(1)", temporary: true }, "/ws", host, meta as never, ["/ws"]);
    expect(store.get("/ws/.axon/tmp/verify-round8.cjs")).toBe("console.log(1)");
    expect(store.has("/ws/scripts/verify-round8.cjs")).toBe(false);
    expect(wasEdited()).toBe(false);
    expect(meta.tempFile).toBe(norm("/ws/.axon/tmp/verify-round8.cjs"));
    expect(out).toContain(".axon/tmp/verify-round8.cjs");
    expect(store.get("/ws/.axon/.gitignore")).toMatch(/^\/tmp\/$/m);
  });

  it("路径本身在 .axon/tmp/ 下也按临时文件处理；同名直接覆盖", async () => {
    const { host, store } = makeHost({ "/ws/.axon/tmp/a.js": "old" });
    await executeToolCall("create_file", { path: ".axon/tmp/a.js", content: "new" }, "/ws", host, {} as never, ["/ws"]);
    expect(store.get("/ws/.axon/tmp/a.js")).toBe("new");
  });

  it("用户自己的 .gitignore 缺 tmp/ 时只补一行", async () => {
    const { host, store } = makeHost({ "/ws/.axon/.gitignore": "# mine\n/relays/\n" });
    await executeToolCall("create_file", { path: "x.js", content: "", temporary: true }, "/ws", host, {} as never, ["/ws"]);
    expect(store.get("/ws/.axon/.gitignore")).toBe("# mine\n/relays/\n#   tmp/ —— AI 写的一次性验证脚本，用完即弃\n/tmp/\n");
  });

  it("过期的临时文件会被清掉", async () => {
    const old = Date.now() - 10 * 24 * 3600 * 1000;
    const { host, store } = makeHost({ "/ws/.axon/tmp/old.js": "", "/ws/.axon/tmp/new.js": "" }, { "/ws/.axon/tmp/old.js": old });
    expect(await pruneAxonTmp(host, "/ws")).toBe(1);
    expect(store.has("/ws/.axon/tmp/old.js")).toBe(false);
    expect(store.has("/ws/.axon/tmp/new.js")).toBe(true);
  });

  it("isAxonTmpPath", () => {
    expect(isAxonTmpPath("D:\\ws\\.axon\\tmp\\a.js")).toBe(true);
    expect(isAxonTmpPath(".axon/tmp/a.js")).toBe(true);
    expect(isAxonTmpPath("src/tmp/a.js")).toBe(false);
  });
});
