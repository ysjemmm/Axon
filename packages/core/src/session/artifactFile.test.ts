import { describe, expect, it } from "vitest";
import { basename, dirname, join, resolve } from "node:path";
import {
  MAX_ARTIFACT_CHARS,
  artifactExtension,
  parseArtifactArgs,
  parseRenderMediaArgs,
  isArtifactType,
  pickVersionedPath,
  sanitizeStem,
} from "./artifactFile.js";
import { MEDIA_LIMITS } from "../host/mediaRenderer.js";

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

describe("媒体产物类型", () => {
  it("gif / mp4 有对应扩展名", () => {
    expect(artifactExtension("gif")).toBe(".gif");
    expect(artifactExtension("mp4")).toBe(".mp4");
  });

  it("create_artifact 不接受 gif / mp4——模型给不出合法的二进制内容，放进来只会诱导它塞 base64", () => {
    expect(isArtifactType("gif")).toBe(false);
    expect(isArtifactType("mp4")).toBe(false);
    const r = parseArtifactArgs({ title: "x", type: "mp4", content: "AAAA" });
    expect(r.ok).toBe(false);
  });
});

describe("parseRenderMediaArgs 入参校验", () => {
  const valid = { title: "冒泡排序", html: "<html></html>", format: "mp4" };

  it("合法入参通过，缺省值按格式取默认", () => {
    const r = parseRenderMediaArgs(valid);
    expect(r).toMatchObject({ ok: true, format: "mp4", width: 1280, height: 720, fps: 24, durationSec: 5 });
    const g = parseRenderMediaArgs({ ...valid, format: "gif" });
    expect(g).toMatchObject({ ok: true, format: "gif", width: 640, height: 360, fps: 12, durationSec: 3 });
  });

  it("缺 title / html / 非法 format 都报错，且错误信息点明怎么改", () => {
    expect(parseRenderMediaArgs({ ...valid, title: " " })).toMatchObject({ ok: false });
    expect(parseRenderMediaArgs({ ...valid, html: "  \n" })).toMatchObject({ ok: false });
    const bad = parseRenderMediaArgs({ ...valid, format: "avi" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/gif|mp4/);
  });

  it("GIF 带旁白直接报错，而不是悄悄丢掉旁白（用户会拿到哑片还以为是我们坏了）", () => {
    const r = parseRenderMediaArgs({ ...valid, format: "gif", narration: "你好" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/mp4/);
  });

  it("mp4 带旁白保留旁白，空白旁白视为没有", () => {
    const a = parseRenderMediaArgs({ ...valid, narration: "  大家好  " });
    expect(a).toMatchObject({ ok: true, narration: "大家好" });
    const b = parseRenderMediaArgs({ ...valid, narration: "   " });
    expect(b.ok && b.narration).toBeFalsy();
  });

  it("旁白过长被拒", () => {
    const r = parseRenderMediaArgs({ ...valid, narration: "字".repeat(MEDIA_LIMITS.maxNarrationChars + 1) });
    expect(r.ok).toBe(false);
  });

  it("时长越界被钳制并记入 notes，而不是报错", () => {
    const r = parseRenderMediaArgs({ ...valid, durationSec: 9999 });
    expect(r).toMatchObject({ ok: true, durationSec: MEDIA_LIMITS.maxDurationSec });
    if (r.ok) expect(r.notes.join("")).toMatch(/时长/);
    const g = parseRenderMediaArgs({ ...valid, format: "gif", durationSec: 60 });
    expect(g).toMatchObject({ ok: true, durationSec: MEDIA_LIMITS.maxGifDurationSec });
  });

  it("宽高被钳制到上限并取偶数（yuv420p 要求偶数）", () => {
    const r = parseRenderMediaArgs({ ...valid, width: 1281, height: 721 });
    expect(r).toMatchObject({ ok: true, width: 1280, height: 720 });
    const big = parseRenderMediaArgs({ ...valid, width: 99999, height: 99999 });
    expect(big).toMatchObject({ ok: true, width: MEDIA_LIMITS.maxWidth, height: MEDIA_LIMITS.maxHeight });
    const tiny = parseRenderMediaArgs({ ...valid, width: 3, height: 3 });
    expect(tiny).toMatchObject({ ok: true, width: MEDIA_LIMITS.minSize, height: MEDIA_LIMITS.minSize });
  });

  it("时长 × 帧率超过总帧数上限时降帧率，保证渲染时间可控", () => {
    const r = parseRenderMediaArgs({ ...valid, durationSec: 60, fps: 30 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.durationSec * r.fps).toBeLessThanOrEqual(MEDIA_LIMITS.maxFrames);
      expect(r.notes.join("")).toMatch(/帧/);
    }
  });

  it("模型把数字写成字符串也能识别；无法解析的值走默认", () => {
    const r = parseRenderMediaArgs({ ...valid, durationSec: "8", fps: "abc" });
    expect(r).toMatchObject({ ok: true, durationSec: 8, fps: 24 });
  });

  it("html 超长被拒", () => {
    const r = parseRenderMediaArgs({ ...valid, html: "x".repeat(MAX_ARTIFACT_CHARS + 1) });
    expect(r.ok).toBe(false);
  });
});
