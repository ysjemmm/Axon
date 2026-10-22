import { describe, expect, it } from "vitest";
import { basename, dirname, join, resolve } from "node:path";
import {
  MAX_ARTIFACT_CHARS,
  artifactExtension,
  parseArtifactArgs,
  pickVersionedPath,
  sanitizeStem,
} from "./artifactFile.js";

describe("sanitizeStem 文件名清洗", () => {
  it("普通标题保留（含中文和空格）", () => {
    expect(sanitizeStem("登录页 原型")).toBe("登录页 原型");
  });

  it("路径穿越被截成最后一段，不会逃出产物目录", () => {
    expect(sanitizeStem("../../etc/passwd")).toBe("passwd");
    expect(sanitizeStem("..\\..\\Windows\\system32")).toBe("system32");
    expect(sanitizeStem("/abs/path/report")).toBe("report");
  });

  it("清洗结果拼进目录后依然落在该目录之内", () => {
    const dir = resolve("/data/artifacts/s1");
    for (const evil of ["../../x", "..\\..\\x", "/etc/x", "a/../../b", "....//x"]) {
      const target = resolve(join(dir, `${sanitizeStem(evil)}.html`));
      expect(dirname(target)).toBe(dir);
    }
  });

  it("Windows 非法字符被替换", () => {
    const out = sanitizeStem('a<b>c:d"e|f?g*h');
    expect(out).not.toMatch(/[<>:"|?*]/);
    expect(out.length).toBeGreaterThan(0);
  });

  it("控制字符被替换", () => {
    expect(sanitizeStem("a\u0000b\u001fc")).not.toMatch(/[\u0000-\u001f]/);
  });

  it("用户自带扩展名会被去掉，扩展名只由类型决定", () => {
    expect(sanitizeStem("index.html")).toBe("index");
    expect(sanitizeStem("run.sh")).toBe("run");
  });

  it("首尾的点和空白被去掉（Windows 不允许以点/空格结尾）", () => {
    expect(sanitizeStem("  report. ")).toBe("report");
    expect(sanitizeStem("...hidden")).toBe("hidden");
  });

  it("Windows 保留设备名加下划线前缀", () => {
    expect(sanitizeStem("CON")).toBe("_CON");
    expect(sanitizeStem("nul")).toBe("_nul");
    expect(sanitizeStem("COM1")).toBe("_COM1");
  });

  it("清洗后为空退回 artifact", () => {
    expect(sanitizeStem("")).toBe("artifact");
    expect(sanitizeStem("***")).toBe("artifact");
    expect(sanitizeStem("...")).toBe("artifact");
  });

  it("超长标题被截断", () => {
    expect(sanitizeStem("a".repeat(500)).length).toBeLessThanOrEqual(80);
  });
});

describe("artifactExtension 扩展名", () => {
  it("按类型决定", () => {
    expect(artifactExtension("html")).toBe(".html");
    expect(artifactExtension("svg")).toBe(".svg");
    expect(artifactExtension("markdown")).toBe(".md");
    expect(artifactExtension("text")).toBe(".txt");
  });

  it("code 类型按语言决定，大小写不敏感", () => {
    expect(artifactExtension("code", "python")).toBe(".py");
    expect(artifactExtension("code", "TypeScript")).toBe(".ts");
  });

  it("code 类型语言未知或缺省 → .txt，不把 language 原样拼进扩展名", () => {
    expect(artifactExtension("code", "weird-lang")).toBe(".txt");
    expect(artifactExtension("code", "../../evil")).toBe(".txt");
    expect(artifactExtension("code")).toBe(".txt");
  });
});

describe("pickVersionedPath 同名版本化", () => {
  const dir = resolve("/data/artifacts/s1");

  it("没有冲突 → 原名", async () => {
    const p = await pickVersionedPath(dir, "report", ".html", async () => false);
    expect(basename(p)).toBe("report.html");
  });

  it("原名已存在 → v2", async () => {
    const taken = new Set([join(dir, "report.html")]);
    const p = await pickVersionedPath(dir, "report", ".html", async (x) => taken.has(x));
    expect(basename(p)).toBe("report-v2.html");
  });

  it("v2 也存在 → v3", async () => {
    const taken = new Set([join(dir, "report.html"), join(dir, "report-v2.html")]);
    const p = await pickVersionedPath(dir, "report", ".html", async (x) => taken.has(x));
    expect(basename(p)).toBe("report-v3.html");
  });

  it("全部冲突 → 抛错而不是死循环", async () => {
    await expect(pickVersionedPath(dir, "r", ".md", async () => true)).rejects.toThrow(/999/);
  });
});

describe("parseArtifactArgs 入参校验", () => {
  const valid = { title: "登录页", type: "html", content: "<html></html>" };

  it("合法入参通过", () => {
    const r = parseArtifactArgs(valid);
    expect(r).toMatchObject({ ok: true, title: "登录页", type: "html" });
  });

  it("缺 title / 空 title", () => {
    expect(parseArtifactArgs({ ...valid, title: "" })).toMatchObject({ ok: false });
    expect(parseArtifactArgs({ ...valid, title: "   " })).toMatchObject({ ok: false });
    expect(parseArtifactArgs({ type: "html", content: "x" })).toMatchObject({ ok: false });
  });

  it("type 不合法会点名合法取值，方便模型自行纠正", () => {
    const r = parseArtifactArgs({ ...valid, type: "pdf" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/html/);
  });

  it("content 为空 / 全空白", () => {
    expect(parseArtifactArgs({ ...valid, content: "" })).toMatchObject({ ok: false });
    expect(parseArtifactArgs({ ...valid, content: "  \n " })).toMatchObject({ ok: false });
  });

  it("content 超长被拒，并提示拆分", () => {
    const r = parseArtifactArgs({ ...valid, content: "x".repeat(MAX_ARTIFACT_CHARS + 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/拆/);
  });

  it("language 空白视为未提供", () => {
    const r = parseArtifactArgs({ ...valid, type: "code", language: "  " });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.language).toBeUndefined();
  });
});
