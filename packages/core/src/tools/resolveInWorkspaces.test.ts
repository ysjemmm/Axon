import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInWorkspaces } from "./search.js";
import type { AgentHost } from "../host/index.js";
import { readdir, stat } from "node:fs/promises";

/** 只用到 fs.stat / fs.readdir 的最小 host */
const host = {
  fs: {
    stat: async (p: string) => stat(p).then(() => ({}), () => null),
    readdir: async (p: string) => (await readdir(p, { withFileTypes: true })).map((d) => ({ name: d.name, isFile: d.isFile(), isDir: d.isDirectory() })),
  },
} as unknown as AgentHost;

function workspace(files: string[]): string {
  const ws = mkdtempSync(join(tmpdir(), "axon-resolve-"));
  for (const f of files) {
    mkdirSync(join(ws, f, ".."), { recursive: true });
    writeFileSync(join(ws, f), "x");
  }
  return ws;
}

describe("相对路径解析", () => {
  it("新建文件不去别处找同名文件", async () => {
    const ws = workspace(["src/old/index.ts"]);
    expect(await resolveInWorkspaces("src/new/index.ts", ws, host, [ws], { create: true })).toBe(join(ws, "src/new/index.ts"));
    expect(await resolveInWorkspaces("index.ts", ws, host, [ws], { create: true })).toBe(join(ws, "index.ts"));
  });

  it("目录不同的同名文件不算：src/new/index.ts 不会被认成 src/old/index.ts", async () => {
    const ws = workspace(["src/old/index.ts"]);
    expect(await resolveInWorkspaces("src/new/index.ts", ws, host, [ws])).toBe(join(ws, "src/new/index.ts"));
  });

  it("少写了前面几级目录：唯一匹配时找回来", async () => {
    const ws = workspace(["packages/app/src/main.js"]);
    expect(await resolveInWorkspaces("src/main.js", ws, host, [ws])).toBe(join(ws, "packages/app/src/main.js"));
  });

  it("匹配到多个就不猜；隐藏目录（.axon 快照等）不进", async () => {
    const ws = workspace(["a/util.ts", "b/util.ts", ".axon/snapshots/s1/turn-1/__new__/notes.md"]);
    expect(await resolveInWorkspaces("util.ts", ws, host, [ws])).toBe(join(ws, "util.ts"));
    expect(await resolveInWorkspaces("notes.md", ws, host, [ws])).toBe(join(ws, "notes.md"));
  });
});
