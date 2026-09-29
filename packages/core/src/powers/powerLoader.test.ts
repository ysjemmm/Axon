import { beforeEach, describe, expect, it } from "vitest";
import {
  PowerRegistry,
  builtinPowersConfigPath,
  globalPowersDir,
  setBuiltinPowersDir,
  workspacePowersDir,
} from "./powerLoader.js";
import type { AgentHost } from "../host/index.js";

/** 归一化路径：Windows 的 join 产出反斜杠，统一成正斜杠便于比对 */
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * 极简内存 fs host：只实现 powerLoader 用到的方法。
 * 目录集合由文件路径自动推导，省去手工维护。
 */
function memHost(files: Record<string, string>) {
  const F = new Map<string, string>();
  const D = new Set<string>();
  const addDirChain = (n: string) => {
    const parts = n.split("/");
    for (let i = 1; i < parts.length; i++) D.add(parts.slice(0, i).join("/"));
  };
  for (const [p, c] of Object.entries(files)) {
    const n = norm(p);
    F.set(n, c);
    addDirChain(n);
  }

  const host = {
    fs: {
      read: async (p: string) => F.get(norm(p)) ?? null,
      write: async (p: string, c: string) => {
        const n = norm(p);
        F.set(n, c);
        addDirChain(n);
      },
      append: async () => {},
      stat: async (p: string) => {
        const n = norm(p);
        if (D.has(n)) return { isFile: false, isDir: true, size: 0 };
        if (F.has(n)) return { isFile: true, isDir: false, size: (F.get(n) || "").length };
        return null;
      },
      readdir: async (p: string) => {
        const prefix = `${norm(p)}/`;
        const names = new Map<string, boolean>();
        for (const d of D) {
          if (!d.startsWith(prefix)) continue;
          const rest = d.slice(prefix.length);
          if (rest && !rest.includes("/")) names.set(rest, true);
        }
        for (const f of F.keys()) {
          if (!f.startsWith(prefix)) continue;
          const rest = f.slice(prefix.length);
          if (rest && !rest.includes("/")) names.set(rest, false);
        }
        return [...names.entries()].map(([name, isDir]) => ({ name, isDir }));
      },
      mkdirp: async () => {},
      remove: async (p: string) => {
        const n = norm(p);
        if (F.delete(n) || D.delete(n)) return;
        throw new Error(`ENOENT: ${p}`);
      },
    },
    commands: {} as never,
    diagnostics: {} as never,
    browser: {} as never,
    edits: {} as never,
  } as unknown as AgentHost;

  return { host, F };
}

const HOME = "C:\\Users\\u";
const WS = "C:\\ws";
const BUILTIN = "C:\\ext\\media\\powers";

/** 造一个 power 目录（POWER.md + 可选 skills） */
function powerAt(root: string, name: string, skills: string[] = []): Record<string, string> {
  const files: Record<string, string> = {
    [`${root}\\${name}\\POWER.md`]: `---\nname: ${name}\ndescription: ${name} 的描述\nkeywords: [k1, k2]\n---\n${name} 的正文`,
  };
  for (const s of skills) {
    files[`${root}\\${name}\\skills\\${s}\\SKILL.md`] = `---\nname: ${s}\ndescription: ${s}\n---\n`;
  }
  return files;
}

describe("内置 Power（默认关闭）", () => {
  beforeEach(() => setBuiltinPowersDir(null));

  it("未列入用户级启用名单 → 默认禁用，但能被发现", async () => {
    setBuiltinPowersDir(BUILTIN);
    const { host } = memHost(powerAt(BUILTIN, "doc-forge", ["excel"]));
    const metas = await new PowerRegistry([WS], host, HOME).discover();
    const m = metas.find((x) => x.name === "doc-forge");
    expect(m).toBeTruthy();
    expect(m!.source).toBe("builtin");
    expect(m!.enabled).toBe(false);
    expect(m!.skillCount).toBe(1);
  });

  it("列入启用名单后变为启用", async () => {
    setBuiltinPowersDir(BUILTIN);
    const { host } = memHost({
      ...powerAt(BUILTIN, "doc-forge"),
      [builtinPowersConfigPath(HOME)]: JSON.stringify({ enabled: ["doc-forge"] }),
    });
    const metas = await new PowerRegistry([WS], host, HOME).discover();
    expect(metas.find((x) => x.name === "doc-forge")!.enabled).toBe(true);
  });

  it("启用状态写用户级配置，而不是往产物目录里写标记文件", async () => {
    setBuiltinPowersDir(BUILTIN);
    const { host, F } = memHost(powerAt(BUILTIN, "doc-forge"));
    const registry = new PowerRegistry([WS], host, HOME);
    const meta = (await registry.discover()).find((x) => x.name === "doc-forge")!;

    await registry.setEnabled(meta, true);

    expect(JSON.parse(F.get(norm(builtinPowersConfigPath(HOME)))!).enabled).toEqual(["doc-forge"]);
    // 产物目录必须保持干净（否则升级覆盖后标记会丢，且扩展包通常只读）
    expect(F.has(norm(`${BUILTIN}\\doc-forge\\.disabled`))).toBe(false);
    expect(F.has(norm(`${BUILTIN}\\doc-forge\\.enabled`))).toBe(false);
    expect((await registry.discover()).find((x) => x.name === "doc-forge")!.enabled).toBe(true);
  });

  it("再次禁用时从名单移除，且不影响名单里其它条目", async () => {
    setBuiltinPowersDir(BUILTIN);
    const { host } = memHost({
      ...powerAt(BUILTIN, "doc-forge"),
      [builtinPowersConfigPath(HOME)]: JSON.stringify({ enabled: ["doc-forge", "other"] }),
    });
    const registry = new PowerRegistry([WS], host, HOME);
    const meta = (await registry.discover()).find((x) => x.name === "doc-forge")!;

    await registry.setEnabled(meta, false);

    expect((await registry.discover()).find((x) => x.name === "doc-forge")!.enabled).toBe(false);
    const cfg = JSON.parse((await host.fs.read(builtinPowersConfigPath(HOME)))!);
    expect(cfg.enabled).toEqual(["other"]);
  });

  it("未启用时 load 返回 null（AI 即便凭记忆激活也拿不到）", async () => {
    setBuiltinPowersDir(BUILTIN);
    const { host } = memHost(powerAt(BUILTIN, "doc-forge"));
    expect(await new PowerRegistry([WS], host, HOME).load("doc-forge")).toBeNull();
  });

  it("启用后可 load 到正文", async () => {
    setBuiltinPowersDir(BUILTIN);
    const { host } = memHost({
      ...powerAt(BUILTIN, "doc-forge"),
      [builtinPowersConfigPath(HOME)]: JSON.stringify({ enabled: ["doc-forge"] }),
    });
    const loaded = await new PowerRegistry([WS], host, HOME).load("doc-forge");
    expect(loaded?.body).toContain("doc-forge 的正文");
  });

  it("工作区同名 Power 覆盖内置（且不受内置『默认关闭』影响）", async () => {
    setBuiltinPowersDir(BUILTIN);
    const { host } = memHost({
      ...powerAt(BUILTIN, "doc-forge"),
      ...powerAt(workspacePowersDir(WS), "doc-forge"),
    });
    const metas = await new PowerRegistry([WS], host, HOME).discover();
    const hits = metas.filter((x) => x.name === "doc-forge");
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("workspace");
    expect(hits[0].enabled).toBe(true);
  });

  it("未注入内置根目录时不产生 builtin 来源", async () => {
    const { host } = memHost(powerAt(BUILTIN, "doc-forge"));
    const metas = await new PowerRegistry([WS], host, HOME).discover();
    expect(metas.filter((m) => m.source === "builtin")).toHaveLength(0);
  });

  it("非内置 Power 的启停仍走 .disabled 标记（既有行为不变）", async () => {
    const { host, F } = memHost(powerAt(globalPowersDir(HOME), "user-power"));
    const registry = new PowerRegistry([WS], host, HOME);
    const meta = (await registry.discover()).find((x) => x.name === "user-power")!;
    expect(meta.enabled).toBe(true);

    await registry.setEnabled(meta, false);
    expect(F.has(norm(`${globalPowersDir(HOME)}\\user-power\\.disabled`))).toBe(true);
    expect((await registry.discover()).find((x) => x.name === "user-power")!.enabled).toBe(false);

    await registry.setEnabled((await registry.discover()).find((x) => x.name === "user-power")!, true);
    expect(F.has(norm(`${globalPowersDir(HOME)}\\user-power\\.disabled`))).toBe(false);
  });

  it("启用名单文件损坏时退化为『全部未启用』，不抛错", async () => {
    setBuiltinPowersDir(BUILTIN);
    const { host } = memHost({
      ...powerAt(BUILTIN, "doc-forge"),
      [builtinPowersConfigPath(HOME)]: "{ 这不是合法 json",
    });
    const metas = await new PowerRegistry([WS], host, HOME).discover();
    expect(metas.find((x) => x.name === "doc-forge")!.enabled).toBe(false);
  });
});
