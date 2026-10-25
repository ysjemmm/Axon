/**
 * artifactFile —— 产物的类型、文件名与版本化命名规则（纯函数，无 IO）
 *
 * 产物由模型通过 create_artifact 工具交付：给标题、类型和完整内容，后端负责决定
 * 「写成什么文件名」。文件名不能直接信模型——它可能带路径分隔符（..\..\x）、
 * 带 Windows 非法字符、或者撞上保留设备名，直接拼进路径会写出目录之外。
 */

import { basename, extname, join } from "node:path";
import { MEDIA_DEFAULTS, MEDIA_LIMITS, type MediaFormat } from "../host/mediaRenderer.js";
import { IMAGE_LIMITS } from "../host/imageGenerator.js";

/** 文本类产物：由模型把完整内容作为字符串交付（create_artifact） */
export type TextArtifactType = "html" | "svg" | "markdown" | "code" | "text";

/** 媒体类产物：由后端渲染得到的二进制文件（render_media），模型给不出这类内容 */
export type MediaArtifactType = MediaFormat;

/** 图片类产物：由文生图得到（generate_image），模型同样给不出这类内容 */
export type ImageArtifactType = "png";

/** 产物类型：决定落盘扩展名，也是前端选择预览方式的依据 */
export type ArtifactType = TextArtifactType | MediaArtifactType | ImageArtifactType;

/**
 * create_artifact 接受的类型——只含文本类。
 * 刻意不含 gif / mp4：模型无法用字符串给出合法的二进制内容，放进来只会诱导它塞 base64。
 */
export const ARTIFACT_TYPES: readonly TextArtifactType[] = ["html", "svg", "markdown", "code", "text"];

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
  gif: ".gif",
  mp4: ".mp4",
  png: ".png",
};

/** code 类型常见语言 → 扩展名。不在表里的退回 .txt，而不是把 language 原样拼进扩展名 */
const CODE_EXT: Record<string, string> = {
  javascript: ".js", js: ".js", typescript: ".ts", ts: ".ts", jsx: ".jsx", tsx: ".tsx",
  python: ".py", py: ".py", java: ".java", go: ".go", rust: ".rs", c: ".c", cpp: ".cpp",
  csharp: ".cs", ruby: ".rb", php: ".php", swift: ".swift", kotlin: ".kt",
  shell: ".sh", bash: ".sh", sh: ".sh", powershell: ".ps1", sql: ".sql",
  css: ".css", json: ".json", yaml: ".yml", yml: ".yml", xml: ".xml", toml: ".toml",
};

/** 是否为 create_artifact 可接受的（文本类）产物类型 */
export function isArtifactType(value: unknown): value is TextArtifactType {
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
  | { ok: true; title: string; type: TextArtifactType; content: string; language?: string }
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

/** render_media 入参校验结果（数值已按限额钳制，notes 记录被调整过的地方） */
export type RenderMediaArgsResult =
  | {
      ok: true;
      title: string;
      html: string;
      format: MediaFormat;
      durationSec: number;
      fps: number;
      width: number;
      height: number;
      narration?: string;
      /** 被自动调整的参数说明，随结果回给模型，由它如实告诉用户 */
      notes: string[];
    }
  | { ok: false; error: string };

/** 接受数字或数字字符串（模型偶尔把数字写成字符串），其余视为未提供 */
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** 向下取偶：yuv420p 编码要求宽高为偶数 */
function toEven(n: number): number {
  const v = Math.floor(n);
  return v % 2 === 0 ? v : v - 1;
}

/**
 * 校验 render_media 的入参。
 *
 * 原则：越界的数值一律钳制并记入 notes（模型多半只是估错了范围，没必要为此多烧一轮）；
 * 只有"缺必填项"和"自相矛盾"才报错。
 * 自相矛盾的典型就是 gif + 旁白：GIF 容器没有音轨，悄悄丢掉旁白会让用户拿到一个哑片
 * 还以为是我们坏了，所以直接报错、点明出路。
 */
export function parseRenderMediaArgs(args: Record<string, unknown>): RenderMediaArgsResult {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return { ok: false, error: "缺少 title。请给成片起一个简短的标题，例如“冒泡排序演示”。" };

  const html = typeof args.html === "string" ? args.html : "";
  if (!html.trim()) return { ok: false, error: "html 为空。请传入完整的单文件 HTML（样式与脚本内联）。" };
  if (html.length > MAX_ARTIFACT_CHARS) {
    return {
      ok: false,
      error: `html 过长（${html.length} 字符，上限 ${MAX_ARTIFACT_CHARS}）。请精简，动画不需要内嵌大块数据。`,
    };
  }

  const format = args.format;
  if (format !== "gif" && format !== "mp4") {
    return { ok: false, error: `format 必须是 gif 或 mp4，收到：${String(format)}。需要声音必须选 mp4。` };
  }

  const narrationRaw = typeof args.narration === "string" ? args.narration.trim() : "";
  if (narrationRaw && format === "gif") {
    return {
      ok: false,
      error:
        "GIF 没有音轨，无法带旁白。用户要声音就把 format 改成 mp4；只要无声循环动画就去掉 narration。" +
        "两种都要的话，分两次调用。",
    };
  }
  if (narrationRaw.length > MEDIA_LIMITS.maxNarrationChars) {
    return {
      ok: false,
      error: `narration 过长（${narrationRaw.length} 字，上限 ${MEDIA_LIMITS.maxNarrationChars}）。请精简旁白，或拆成多段分别渲染。`,
    };
  }

  const notes: string[] = [];
  const isGif = format === "gif";
  const def = MEDIA_DEFAULTS[format];
  const maxDuration = isGif ? MEDIA_LIMITS.maxGifDurationSec : MEDIA_LIMITS.maxDurationSec;
  const maxFps = isGif ? MEDIA_LIMITS.maxGifFps : MEDIA_LIMITS.maxFps;
  // 单边放宽到长边上限（1920），再靠总像素兜住整体规模：
  // 只按宽高分别卡死的话，竖屏 1080×1920 会被压成 1080×1080 的方形。
  const maxEdge = isGif
    ? Math.max(MEDIA_LIMITS.maxGifWidth, MEDIA_LIMITS.maxGifHeight)
    : Math.max(MEDIA_LIMITS.maxWidth, MEDIA_LIMITS.maxHeight);
  const maxPixels = isGif
    ? MEDIA_LIMITS.maxGifWidth * MEDIA_LIMITS.maxGifHeight
    : MEDIA_LIMITS.maxWidth * MEDIA_LIMITS.maxHeight;

  const rawDuration = toNumber(args.durationSec) ?? def.durationSec;
  const durationSec = clamp(rawDuration, 1, maxDuration);
  if (durationSec !== rawDuration) notes.push(`时长已调整为 ${durationSec} 秒（${format} 允许 1~${maxDuration} 秒）`);

  const rawFps = toNumber(args.fps) ?? def.fps;
  let fps = Math.round(clamp(rawFps, 1, maxFps));
  if (fps !== rawFps) notes.push(`帧率已调整为 ${fps}（${format} 允许 1~${maxFps}）`);
  if (durationSec * fps > MEDIA_LIMITS.maxFrames) {
    fps = Math.max(1, Math.floor(MEDIA_LIMITS.maxFrames / durationSec));
    notes.push(`总帧数超过上限 ${MEDIA_LIMITS.maxFrames}，帧率降为 ${fps}`);
  }

  const rawWidth = toNumber(args.width) ?? def.width;
  const rawHeight = toNumber(args.height) ?? def.height;
  let width = toEven(clamp(rawWidth, MEDIA_LIMITS.minSize, maxEdge));
  let height = toEven(clamp(rawHeight, MEDIA_LIMITS.minSize, maxEdge));
  if (width * height > maxPixels) {
    const scale = Math.sqrt(maxPixels / (width * height));
    width = Math.max(MEDIA_LIMITS.minSize, toEven(Math.floor(width * scale)));
    height = Math.max(MEDIA_LIMITS.minSize, toEven(Math.floor(height * scale)));
  }
  if (width !== rawWidth || height !== rawHeight) {
    notes.push(`画面尺寸已调整为 ${width}x${height}（单边 ${MEDIA_LIMITS.minSize}~${maxEdge}，总像素不超过 ${maxPixels}，且为偶数）`);
  }

  return {
    ok: true,
    title,
    html,
    format,
    durationSec,
    fps,
    width,
    height,
    ...(narrationRaw ? { narration: narrationRaw } : {}),
    notes,
  };
}

/** generate_image 入参校验结果（数值已钳制，notes 记录被调整过的地方） */
export type GenerateImageArgsResult =
  | {
      ok: true;
      title: string;
      prompt: string;
      negativePrompt?: string;
      width: number;
      height: number;
      count: number;
      notes: string[];
    }
  | { ok: false; error: string };

/**
 * 校验 generate_image 的入参。
 *
 * 原则与 render_media 一致：越界数值钳制并记入 notes，只有「缺必填项」才报错。
 * 尺寸不取偶数 —— PNG 是逐像素位图，没有 yuv420p 那种偶数约束。
 */
export function parseGenerateImageArgs(args: Record<string, unknown>): GenerateImageArgsResult {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) {
    return { ok: false, error: "缺少 prompt。请描述画面：主体、风格、构图、光线、色调。" };
  }
  if (prompt.length > IMAGE_LIMITS.maxPromptChars) {
    return {
      ok: false,
      error: `prompt 过长（${prompt.length} 字符，上限 ${IMAGE_LIMITS.maxPromptChars}）。请精简描述。`,
    };
  }

  const negativeRaw = typeof args.negativePrompt === "string" ? args.negativePrompt.trim() : "";
  if (negativeRaw.length > IMAGE_LIMITS.maxNegativeChars) {
    return {
      ok: false,
      error: `negativePrompt 过长（${negativeRaw.length} 字符，上限 ${IMAGE_LIMITS.maxNegativeChars}）。`,
    };
  }

  const notes: string[] = [];
  const rawCount = toNumber(args.count) ?? 1;
  const count = Math.round(clamp(rawCount, 1, IMAGE_LIMITS.maxCount));
  if (count !== rawCount) notes.push(`张数已调整为 ${count}（允许 1~${IMAGE_LIMITS.maxCount}）`);

  const rawWidth = toNumber(args.width) ?? 1024;
  const rawHeight = toNumber(args.height) ?? 1024;
  const width = Math.round(clamp(rawWidth, IMAGE_LIMITS.minSize, IMAGE_LIMITS.maxSize));
  const height = Math.round(clamp(rawHeight, IMAGE_LIMITS.minSize, IMAGE_LIMITS.maxSize));
  if (width !== rawWidth || height !== rawHeight) {
    notes.push(`画面尺寸已调整为 ${width}x${height}（单边 ${IMAGE_LIMITS.minSize}~${IMAGE_LIMITS.maxSize}）`);
  }

  const titleRaw = typeof args.title === "string" ? args.title.trim() : "";
  // 没给标题就用提示词前 20 字做文件名主干，避免产物目录里出现一堆 image.png
  const title = titleRaw || prompt.slice(0, 20).replace(/[\r\n]+/g, " ");

  return {
    ok: true,
    title,
    prompt,
    ...(negativeRaw ? { negativePrompt: negativeRaw } : {}),
    width,
    height,
    count,
    notes,
  };
}

/** 扩展名（含点，小写） */
export function artifactExt(absPath: string): string {
  return extname(absPath).toLowerCase();
}
