import { describe, it, expect } from "vitest";
import { sep } from "node:path";
import { SnapshotManager } from "./snapshotManager.js";
import type { AgentHost } from "../host/index.js";

/** 内存文件系统 fake host（快照只用 fs 读写） */
function fakeHost() {
  const files = new Map<string, string>();
  const host = {
    fs: {
      mkdirp: async (_p: string) => {},
      read: async (p: string) => files.get(p) ?? null,
      write: async (p: string, c: string) => {
        files.set(p, c);
      },
      remove: async (p: string) => {
        for (const k of [...files.keys()]) {
          if (k === p || k.startsWith(p + sep)) files.delete(k);
        }
      },
      readdir: async (p: string) => {
        const seen = new Map<string, boolean>();
        for (const k of files.keys()) {
          if (!k.startsWith(p + sep)) continue;
          const rest = k.slice(p.length + 1);
          const seg = rest.split(sep)[0];
          if (!seen.has(seg)) seen.set(seg, rest.includes(sep));
        }
        return [...seen.entries()].map(([name, isDir]) => ({ isDir, path: p + sep + name }));
      },
    },
  };
  return { host: host as unknown as AgentHost, files };
}

/** 非 git 目录路径：GitSnapshotter 探测失败 → 退化 FsSnapshotter，走 fake fs */
const CWD = "d:/projects/axon-snapshot-verify-no-git/tmp-cwd";

describe("SnapshotManager 快照只维护在内存", () => {
  it("运行中创建的快照正常出现在列表", async () => {
    const { host } = fakeHost();
    const mgr = new SnapshotManager(host, CWD);
    await mgr.beforeEdit("turn-1", [`${CWD}/a.ts`]);
    await mgr.beforeEdit("turn-2", [`${CWD}/b.ts`]);
    const list = await mgr.list();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.id).sort()).toEqual(["turn-1", "turn-2"]);
  });

  it("重启（新实例）后历史快照被清理，列表从零开始", async () => {
    const { host, files } = fakeHost();
    const old = new SnapshotManager(host, CWD);
    await old.beforeEdit("turn-old", [`${CWD}/a.ts`]);
    expect(await old.list()).toHaveLength(1);

    // 模拟进程重启：同一持久层（fake fs）、全新 manager
    const fresh = new SnapshotManager(host, CWD);
    await fresh.beforeEdit("turn-new", [`${CWD}/b.ts`]); // lazy init → 清理历史
    const list = await fresh.list();
    expect(list.map((s) => s.id)).toEqual(["turn-new"]);
    // 磁盘上的旧快照备份也不再残留
    expect([...files.keys()].some((k) => k.includes("turn-old"))).toBe(false);
  });

  it("重启后未产生新快照时列表为空（不扫历史）", async () => {
    const { host } = fakeHost();
    const old = new SnapshotManager(host, CWD);
    await old.beforeEdit("turn-old", [`${CWD}/a.ts`]);
    const fresh = new SnapshotManager(host, CWD);
    expect(await fresh.list()).toEqual([]);
  });
});
