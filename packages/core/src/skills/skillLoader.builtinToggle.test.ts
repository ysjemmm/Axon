import { describe, expect, it } from "vitest";
import { SkillRegistry, builtinSkillsConfigPath, globalSkillsDir } from "./skillLoader.js";
import type { AgentHost } from "../host/index.js";

/** 归一化路径：Windows 的 join 产出反斜杠，统一成正斜杠便于比对 */
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** 极简内存 fs host：目录集合由文件路径自动推导 */
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
const CFG = builtinSkillsConfigPath(HOME);

/** 造一个普通（非内置）skill 目录 */
function skillAt(root: string, name: string): Record<string, string> {
  return { [`${root}\\${name}\\SKILL.md`]: `---\nname: ${name}\ndescription: ${name}\n---\n正文` };
}

function registryWith(files: Record<string, string>) {
  const { host, F } = memHost(files);
  return { reg: new SkillRegistry([WS], host, HOME), F, host };
}

/** 取某内置 skill 的元信息 */
async function builtinMeta(reg: SkillRegistry, name: string) {
  return (await reg.discover()).find((m) => m.name === name && m.source === "builtin");
}

describe("内置 skill 支持禁用", () => {
  it("默认全部启用（与内置 Power 的默认关闭相反）", async () => {
    const { reg } = registryWith({});
    const metas = (await reg.discover()).filter((m) => m.source === "builtin");
    expect(metas.length).toBeGreaterThan(0);
    expect(metas.every((m) => !m.disabled)).toBe(true);
  });

  it("禁用后写用户级名单，且不往任何 skill 目录写标记文件", async () => {
    const { reg, F } = registryWith({});
    const meta = (await builtinMeta(reg, "brainstorming"))!;
    await reg.setEnabled(meta, true);

    expect(norm(CFG)).toBeTruthy();
    expect(JSON.parse(F.get(norm(CFG))!).disabled).toEqual(["brainstorming"]);
    // 除配置文件外不应产生任何写入（内置 skill 没有磁盘目录）
    expect([...F.keys()]).toEqual([norm(CFG)]);
  });

  it("禁用后：discover 标记为已禁用、不再进 skill 清单、也加载不到", async () => {
    const { reg } = registryWith({ [CFG]: JSON.stringify({ disabled: ["code-quality"] }) });
    const meta = (await builtinMeta(reg, "code-quality"))!;
    expect(meta.disabled).toBe(true);

    const prompt = await reg.buildSkillsPrompt();
    expect(prompt).not.toContain("code-quality");
    // 别的内置 skill 不受牵连
    expect(prompt).toContain("systematic-debugging");

    // AI 即便凭记忆调用也拿不到（load 对已禁用的返回 null）
    expect(await reg.load("code-quality")).toBeNull();
  });

  it("重新启用：从名单移除，且不影响名单里的其它条目", async () => {
    const { reg, F } = registryWith({
      [CFG]: JSON.stringify({ disabled: ["systematic-debugging", "code-quality"] }),
    });
    const meta = (await builtinMeta(reg, "code-quality"))!;
    await reg.setEnabled(meta, false);

    expect(JSON.parse(F.get(norm(CFG))!).disabled).toEqual(["systematic-debugging"]);
    expect((await builtinMeta(reg, "code-quality"))!.disabled).toBe(false);
    expect((await builtinMeta(reg, "systematic-debugging"))!.disabled).toBe(true);
  });

  it("禁用名单文件损坏时退化为全部启用，不抛错", async () => {
    const { reg } = registryWith({ [CFG]: "{ 这不是合法 json" });
    const metas = (await reg.discover()).filter((m) => m.source === "builtin");
    expect(metas.every((m) => !m.disabled)).toBe(true);
  });

  it("非内置 skill 的启停仍走自身目录的 .disabled（既有行为不变）", async () => {
    const { reg, F } = registryWith(skillAt(globalSkillsDir(HOME), "user-skill"));
    const meta = (await reg.discover()).find((m) => m.name === "user-skill")!;
    expect(meta.disabled).toBe(false);

    await reg.setEnabled(meta, true);
    expect(F.has(norm(`${globalSkillsDir(HOME)}\\user-skill\\.disabled`))).toBe(true);
    expect((await reg.discover()).find((m) => m.name === "user-skill")!.disabled).toBe(true);
    // 不应因为禁一个普通 skill 就凭空创建内置名单文件
    expect(F.has(norm(CFG))).toBe(false);

    await reg.setEnabled((await reg.discover()).find((m) => m.name === "user-skill")!, false);
    expect(F.has(norm(`${globalSkillsDir(HOME)}\\user-skill\\.disabled`))).toBe(false);
  });

  it("工作区放同名 skill 可覆盖被禁用的内置项（禁用名单不阻断覆盖）", async () => {
    const { reg } = registryWith({
      [CFG]: JSON.stringify({ disabled: ["code-quality"] }),
      ...skillAt("C:\\ws\\.axon\\skills", "code-quality"),
    });
    const meta = (await reg.discover()).find((m) => m.name === "code-quality")!;
    // 覆盖后来源是工作区，且是启用的——用户的定制不会被内置禁用名单误伤
    expect(meta.source).toBe("workspace");
    expect(meta.disabled).toBe(false);
  });
});
