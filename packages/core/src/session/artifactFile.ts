/**
 * artifactFile —— 产物的类型、文件名与版本化命名规则（纯函数，无 IO）
 *
 * 产物由模型通过 create_artifact 工具交付：给标题、类型和完整内容，后端负责决定
 * 「写成什么文件名」。文件名不能直接信模型——它可能带路径分隔符（..\..\x）、
 * 带 Windows 非法字符、或者撞上保留设备名，直接拼进路径会写出目录之外。
 */

import { basename, extname, join } from "node:path";

/** 产物类型：决定落盘扩展名，也是前端选择预览方式的依据 */
export type ArtifactType = "html" | "svg" | "markdown" | "code" | "text";

export const ARTIFACT_TYPES: readonly ArtifactType[] = ["html", "svg", "markdown", "code", "text"];

/** 单个产物内容上限（字符）。超出多半是模型把整个项目塞进来了，应拆成多个文件 */
export const MAX_ARTIFACT_CHARS = 500_000;

/** 标题转文件名主干后的最大长度，避免超出系统路径限制 */
const MAX_STEM_LENGTH = 80;

/** Windows 保留设备名：用作文件名会指向设备而不是文件 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 各类型的默认扩展名；code 类型由 language 决定，这里给兜底 */
const DEFAULT_EXT: Record<ArtifactType, string> = {
  html: ".html",
  svg: ".svg",
  markdown: ".md",
  code: ".txt",
  text: ".txt",
};

/** code 类型常见语言 → 扩展名。不在表里的退回 .txt，而不是把 language 原样拼进扩展名 */
const CODE_EXT: Record<string, string> = {
  javascript: ".js", js: ".js", typescript: ".ts", ts: ".ts", jsx: ".jsx", tsx: ".tsx",
  python: ".py", py: ".py", java: ".java", go: ".go", rust: ".rs", c: ".c", cpp: ".cpp",
  csharp: ".cs", ruby: ".rb", php: ".php", swift: ".swift", kotlin: ".kt",
  shell: ".sh", bash: ".sh", sh: ".sh", powershell: ".ps1", sql: ".sql",
  css: ".css", json: ".json", yaml: ".yml", yml: ".yml", xml: ".xml", toml: ".toml",
};

export function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === "string" && (ARTIFACT_TYPES as readonly string[]).includes(value);
}

/**
 * 把标题清洗成安全的文件名主干（不含扩展名）。
 *
 * - 只取 basename：丢弃任何目录部分，杜绝 "../../x" 逃出产物目录
 * - 非法字符（Windows 保留字符、控制字符）统一替换成 "-"
 * - 去掉首尾的点和空白（Windows 不允许文件名以点/空格结尾）
 * - 撞保留设备名则加下划线前缀
 * - 清洗后为空（例如标题全是符号）退回 "artifact"
 */
export function sanitizeStem(title: string): string {
  const base = basename(String(title ?? "").replace(/\\/g, "/"));
  // 先去掉用户可能自带的扩展名，扩展名统一由类型决定。
  // 点前面必须还有内容才算扩展名：否则 ".env" / "...hidden" 这类以点开头的标题
  // 会被整个吃光，白白退回兜底名。
  const noExt = base.replace(/(?<=[^.])\.[a-z0-9]{1,8}$/i, "");
  let stem = noExt
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "");
  if (stem.length > MAX_STEM_LENGTH) stem = stem.slice(0, MAX_STEM_LENGTH).replace(/[.\s-]+$/g, "");
  if (!stem) return "artifact";
  if (WINDOWS_RESERVED.test(stem)) stem = `_${stem}`;
  return stem;
}

/** 按类型（code 再看 language）决定扩展名 */
export function artifactExtension(type: ArtifactType, language?: string): string {
  if (type === "code" && language) {
    return CODE_EXT[language.trim().toLowerCase()] ?? DEFAULT_EXT.code;
  }
  return DEFAULT_EXT[type];
}

/**
 * 选一个不与已有文件冲突的文件名（同名产物视为新版本，不覆盖旧文件）。
 *
 * 第一次叫 report.html，之后依次 report-v2.html、report-v3.html……
 * 用户可能在预览旧版、或把旧版发给了别人，悄悄覆盖会让他们拿到的东西变了。
 *
 * exists 由调用方注入（真实场景是 host.fs.stat），保持本函数无 IO、可测。
 * 上限 999 是防御：理论上不会走到，真走到说明目录里有大量同名文件，宁可报错也别死循环。
 */
export async function pickVersionedPath(
  dir: string,
  stem: string,
  ext: string,
  exists: (absPath: string) => Promise<boolean>,
): Promise<string> {
  const first = join(dir, `${stem}${ext}`);
  if (!(await exists(first))) return first;
  for (let v = 2; v <= 999; v++) {
    const candidate = join(dir, `${stem}-v${v}${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`产物目录里已有超过 999 个同名文件（${stem}${ext}），请换一个标题`);
}

/** 工具入参校验结果 */
export type ArtifactArgsResult =
  | { ok: true; title: string; type: ArtifactType; content: string; language?: string }
  | { ok: false; error: string };

/**
 * 校验 create_artifact 的入参。错误信息是给模型看的：要说清楚哪里不对、怎么改，
 * 否则它会原样重试。
 */
export function parseArtifactArgs(args: Record<string, unknown>): ArtifactArgsResult {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return { ok: false, error: "缺少 title。请给产物起一个简短的标题，例如“登录页原型”。" };

  if (!isArtifactType(args.type)) {
    return { ok: false, error: `type 必须是 ${ARTIFACT_TYPES.join(" / ")} 之一，收到：${String(args.type)}。` };
  }

  const content = typeof args.content === "string" ? args.content : "";
  if (!content.trim()) return { ok: false, error: "content 为空。请传入产物的完整内容。" };
  if (content.length > MAX_ARTIFACT_CHARS) {
    return {
      ok: false,
      error: `content 过长（${content.length} 字符，上限 ${MAX_ARTIFACT_CHARS}）。请精简内容，或拆成多个产物分别创建。`,
    };
  }

  const language = typeof args.language === "string" && args.language.trim() ? args.language.trim() : undefined;
  return { ok: true, title, type: args.type, content, language };
}

/** 从路径取展示用的文件名 */
export function artifactFileName(absPath: string): string {
  return basename(absPath);
}

/** 扩展名（含点，小写） */
export function artifactExt(absPath: string): string {
  return extname(absPath).toLowerCase();
}
