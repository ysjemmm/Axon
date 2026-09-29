import { afterEach, describe, expect, it } from "vitest";
import { SkillRegistry, isBuiltinPowerBundledSkill, globalSkillsDir, workspaceSkillsDir } from "./skillLoader.js";
import { setBuiltinPowersDir } from "../powers/powerLoader.js";
import type { AgentHost } from "../host/index.js";

/** 归一化路径：Windows 的 join 产出反斜杠，统一成正斜杠便于比对 */
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** 极简内存 fs host：目录集合由文件路径自动推导 */
function memHost(files: Record<string, string>): AgentHost {
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
  return {
    fs: {
      read: async (p: string) => F.get(norm(p)) ?? null,
      write: async () => {},
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
      remove: async () => {},
    },
    commands: {} as never,
    diagnostics: {} as never,
    browser: {} as never,
    edits: {} as never,
  } as unknown as AgentHost;
}

const HOME = "C:\\Users\\u";
const WS = "C:\\ws";
/** 模拟内置 Power 的捆绑 skill 目录（产物包内） */
const POWER_SKILLS_DIR = "C:\\ext\\media\\powers\\doc-forge\\skills";

/** 造一个 skill 目录（SKILL.md） */
function skillAt(root: string, name: string, desc = `${name} 的描述`): Record<string, string> {
  return { [`${root}\\${name}\\SKILL.md`]: `---\nname: ${name}\ndescription: ${desc}\n---\n${name} 正文` };
}

afterEach(() => setBuiltinPowersDir(null));

describe("Power 捆绑的 skills 进入 skill 发现链路", () => {
  it("注入 power skill 目录后，其中的 skill 被发现且来源为 power", async () => {
    const host = memHost(skillAt(POWER_SKILLS_DIR, "excel"));
    const reg = new SkillRegistry([WS], host, HOME, async () => [POWER_SKILLS_DIR]);
    const m = (await reg.discover()).find((x) => x.name === "excel");
    expect(m).toBeTruthy();
    expect(m!.source).toBe("power");
  });

  it("未注入时不出现（退回改动前的行为，不误报）", async () => {
    const host = memHost(skillAt(POWER_SKILLS_DIR, "excel"));
    const reg = new SkillRegistry([WS], host, HOME);
    expect((await reg.discover()).find((x) => x.name === "excel")).toBeUndefined();
  });

  it("能 load 到 Power 捆绑 skill 的正文（这正是此前断掉的链路）", async () => {
    const host = memHost(skillAt(POWER_SKILLS_DIR, "excel"));
    const reg = new SkillRegistry([WS], host, HOME, async () => [POWER_SKILLS_DIR]);
    const loaded = await reg.load("excel");
    expect(loaded?.body).toContain("excel 正文");
  });

  it("优先级：Power 覆盖同名全局 skill", async () => {
    const host = memHost({
      ...skillAt(globalSkillsDir(HOME), "excel", "全局版"),
      ...skillAt(POWER_SKILLS_DIR, "excel", "Power 版"),
    });
    const reg = new SkillRegistry([WS], host, HOME, async () => [POWER_SKILLS_DIR]);
    const m = (await reg.discover()).find((x) => x.name === "excel");
    expect(m!.source).toBe("power");
    expect(m!.description).toBe("Power 版");
  });

  it("优先级：项目级 skill 覆盖同名 Power skill", async () => {
    const host = memHost({
      ...skillAt(POWER_SKILLS_DIR, "excel", "Power 版"),
      ...skillAt(workspaceSkillsDir(WS), "excel", "项目版"),
    });
    const reg = new SkillRegistry([WS], host, HOME, async () => [POWER_SKILLS_DIR]);
    const m = (await reg.discover()).find((x) => x.name === "excel");
    expect(m!.source).toBe("workspace");
    expect(m!.description).toBe("项目版");
  });

  it("skill 清单里给 Power 来源加 [Power] 标记", async () => {
    const host = memHost(skillAt(POWER_SKILLS_DIR, "excel"));
    const reg = new SkillRegistry([WS], host, HOME, async () => [POWER_SKILLS_DIR]);
    expect(await reg.buildSkillsPrompt()).toContain("[Power] excel");
  });

  it("Power 目录提供者抛错时静默退化，不影响常规 skill 的发现", async () => {
    const host = memHost(skillAt(globalSkillsDir(HOME), "user-skill"));
    const reg = new SkillRegistry([WS], host, HOME, async () => {
      throw new Error("power 侧异常");
    });
    const metas = await reg.discover();
    expect(metas.find((x) => x.name === "user-skill")).toBeTruthy();
  });
});

describe("isBuiltinPowerBundledSkill：内置 Power 的只读捆绑判断", () => {
  it("位于内置 Power 根下 → true", () => {
    setBuiltinPowersDir("C:\\ext\\media\\powers");
    expect(isBuiltinPowerBundledSkill("power", "C:\\ext\\media\\powers\\doc-forge\\skills\\excel")).toBe(true);
  });

  it("用户自己装的 Power（非内置根）→ false", () => {
    setBuiltinPowersDir("C:\\ext\\media\\powers");
    expect(isBuiltinPowerBundledSkill("power", `${globalSkillsDir(HOME)}\\my-power\\skills\\x`)).toBe(false);
  });

  it("非 power 来源一律 false", () => {
    setBuiltinPowersDir("C:\\ext\\media\\powers");
    expect(isBuiltinPowerBundledSkill("global", "C:\\ext\\media\\powers\\x")).toBe(false);
    expect(isBuiltinPowerBundledSkill("builtin", "")).toBe(false);
  });

  it("未注入内置根时不判定（web/CLI 等无内置目录的形态）", () => {
    setBuiltinPowersDir(null);
    expect(isBuiltinPowerBundledSkill("power", "C:\\ext\\media\\powers\\x")).toBe(false);
  });

  it("大小写与斜杠方向不敏感", () => {
    setBuiltinPowersDir("C:\\Ext\\Media\\Powers");
    expect(isBuiltinPowerBundledSkill("power", "c:/ext/media/powers/doc-forge/skills/excel")).toBe(true);
  });
});
