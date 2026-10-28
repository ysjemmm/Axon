import { describe, expect, it } from "vitest";
import { basename, dirname, join, resolve } from "node:path";
import { applyArtifactEdits, artifactTypeOf, editArtifact, isInsideDir, readArtifact, readSkillFile } from "./artifactTools.js";

/** 内存文件系统：只实现这几个工具用到的方法 */
function memHost(files: Record<string, string>, dirs: string[] = []) {
  const fs = {
    read: async (p: string) => (p in files ? files[p] : null),
    write: async (p: string, c: string) => { files[p] = c; },
    stat: async (p: string) => (p in files ? { isFile: true, isDir: false, size: files[p].length } : dirs.includes(p) ? { isFile: false, isDir: true } : null),
    // 用 dirname / basename 而不是字符串拼 "/"：实现在 Windows 上会把这些路径 resolve 成
    // D:\... 形式，父目录分隔符是反斜杠，按正斜杠比较会一个都匹配不上。
    readdir: async (d: string) => Object.keys(files)
      .filter((p) => dirname(p) === d)
      .map((p) => ({ name: basename(p), isFile: true, isDir: false })),
  };
  return { fs } as any;
}

/**
 * ⚠️ 必须过一遍 resolve：实现内部用 resolve/join 把路径规范成绝对路径，
 * Windows 上 `/home/u/...` 会变成 `D:\home\u\...`。fixture 里若用原始 POSIX 串作键，
 * 与实现查找的路径永远对不上，测试在 Windows 上必然失败。
 */
const DIR = resolve("/home/u/.axon/artifacts/s1");

describe("产物路径与类型", () => {
  it("只认产物目录之内的路径", () => {
    expect(isInsideDir(DIR, join(DIR, "a.html"))).toBe(true);
    expect(isInsideDir(DIR, join(DIR, "../s2/a.html"))).toBe(false);
    expect(isInsideDir(DIR, "/etc/passwd")).toBe(false);
  });

  it("按扩展名推回产物类型，二进制不可编辑", () => {
    expect(artifactTypeOf("x/report-v2.html")).toEqual({ type: "html" });
    expect(artifactTypeOf("x/a.py")).toEqual({ type: "code", language: "python" });
    expect(artifactTypeOf("x/a.png")).toBeNull();
  });
});

describe("edit_artifact", () => {
  it("逐处替换，oldStr 必须恰好出现一次", () => {
    expect(applyArtifactEdits("<b>红</b>", [{ oldStr: "红", newStr: "蓝" }])).toEqual({ ok: true, content: "<b>蓝</b>" });
    expect(applyArtifactEdits("a a", [{ oldStr: "a", newStr: "b" }]).ok).toBe(false);
    expect(applyArtifactEdits("abc", [{ oldStr: "x", newStr: "y" }]).ok).toBe(false);
  });

  it("存成新版本，旧版本保留", async () => {
    const files: Record<string, string> = { [join(DIR, "page.html")]: "<button>旧</button>" };
    const out = await editArtifact({ host: memHost(files), artifactDir: DIR }, {
      path: join(DIR, "page.html"), edits: [{ oldStr: "旧", newStr: "新" }],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.artifact).toMatchObject({ path: join(DIR, "page-v2.html"), type: "html", version: 2, title: "page" });
    expect(files[join(DIR, "page-v2.html")]).toBe("<button>新</button>");
    expect(files[join(DIR, "page.html")]).toBe("<button>旧</button>");
  });

  it("改第 2 版时新版本接着编号，而不是 page-v2-v2", async () => {
    const files: Record<string, string> = { [join(DIR, "page.html")]: "v1", [join(DIR, "page-v2.html")]: "v2 内容" };
    const out = await editArtifact({ host: memHost(files), artifactDir: DIR }, {
      path: join(DIR, "page-v2.html"), edits: [{ oldStr: "内容", newStr: "改过" }],
    });
    expect(out.ok && out.artifact.path).toBe(join(DIR, "page-v3.html"));
  });

  it("拒绝产物目录之外的文件", async () => {
    const out = await editArtifact({ host: memHost({ "/repo/src/a.ts": "x" }), artifactDir: DIR }, {
      path: "/repo/src/a.ts", edits: [{ oldStr: "x", newStr: "y" }],
    });
    expect(out.ok).toBe(false);
  });
});

describe("read_artifact / read_skill_file", () => {
  it("不带 path 列出产物，带 path 读内容，目录外拒绝", async () => {
    const host = memHost({ [join(DIR, "a.html")]: "<h1>A</h1>" });
    expect((await readArtifact({ host, artifactDir: DIR }, {})).result).toContain("a.html");
    expect((await readArtifact({ host, artifactDir: DIR }, { path: join(DIR, "a.html") })).result).toBe("<h1>A</h1>");
    expect((await readArtifact({ host, artifactDir: DIR }, { path: "/repo/x.ts" })).ok).toBe(false);
  });

  it("只能读技能 / Power 目录，相对路径按最近加载的技能目录解析", async () => {
    // 同 DIR：过 resolve 才与实现解析出的形式一致（Windows 下带盘符）
    const skill = resolve("/home/u/.axon/skills/design");
    // 用 join 而不是手拼 "/"：Windows 上 skill 带反斜杠，混拼出来的键与实现解析结果不一致
    const host = memHost({ [join(skill, "templates/card.html")]: "<div>card</div>", "/repo/secret.env": "KEY=1" });
    expect((await readSkillFile(host, [skill], { path: "templates/card.html" }, skill)).result).toBe("<div>card</div>");
    expect((await readSkillFile(host, [skill], { path: "/repo/secret.env" }, skill)).ok).toBe(false);
    expect((await readSkillFile(host, [skill], { path: "../../../../repo/secret.env" }, skill)).ok).toBe(false);
  });
});
