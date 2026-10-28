import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { RelayStore } from "./relayStore.js";

/** 最小的真实文件系统 host：只实现 RelayStore 用到的几个方法 */
function fsHost(): any {
  return {
    fs: {
      read: async (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
      write: async (p: string, c: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); },
      stat: async (p: string) => { try { const s = statSync(p); return { isDir: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; } },
      readdir: async (p: string) => readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, isDir: d.isDirectory() })),
      mkdirp: async (p: string) => { mkdirSync(p, { recursive: true }); },
      remove: async (p: string) => { rmSync(p, { recursive: true, force: true }); },
      append: async () => {},
    },
  };
}

describe("Relay 列表跨多个根", () => {
  it("列出会话工作区里建的 relay，并带上它所在的根", async () => {
    const sessionWs = mkdtempSync(join(tmpdir(), "relay-ws-"));
    const vscodeFolder = mkdtempSync(join(tmpdir(), "relay-folder-"));
    const host = fsHost();
    // 会话工作区（Axon 里另选的文件夹）下建一个 relay
    const created = await new RelayStore([sessionWs], host).create({ title: "部署名清洗小工具", summary: "s" });
    // 只扫 VS Code 文件夹时看不到它；把会话工作区也作为根就能看到，且知道它在哪
    expect(await new RelayStore([vscodeFolder], host).list()).toHaveLength(0);
    const listed = await new RelayStore([vscodeFolder, sessionWs], host).list();
    expect(listed.map((r) => r.id)).toEqual([created.id]);
    expect(listed[0].root).toBe(sessionWs);
  });
});
