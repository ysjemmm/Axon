/**
 * 产物与技能资源的读改工具：edit_artifact / read_artifact / read_skill_file。
 *
 * ── 为什么需要 ──
 * Quest（问答）模式没有任何读写文件的工具，产物只能靠 create_artifact 一次性交付：
 * · 改一处就得把整份 HTML 重新输出一遍，几百行的页面每次小改都要等它重写完，还容易顺手改坏别处；
 * · 产物内容只存在于那次工具调用的参数里，压缩之后、分叉出的新会话里，模型手里没有原文，只能凭印象重写；
 * · use_skill 只返回 SKILL.md 正文和目录，技能里「参考 templates/xxx.html」这类附属文件一概读不到。
 *
 * ── 边界 ──
 * 三个工具都只在固定的目录里操作：产物目录（edit / read_artifact）、已发现的技能与 Power 目录
 * （read_skill_file，只读）。路径一律解析成绝对路径后校验落在这些目录内，碰不到用户仓库，
 * Quest「不碰仓库」的定位不变。
 */

import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type { AgentHost } from "../host/index.js";
import { MAX_ARTIFACT_CHARS, pickVersionedPath, type ArtifactType } from "./artifactFile.js";

/** path 是否落在 root 之内（含 root 本身） */
export function isInsideDir(root: string, path: string): boolean {
  if (!root) return false;
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const TEXT_TYPE_BY_EXT: Record<string, ArtifactType> = {
  ".html": "html", ".htm": "html", ".svg": "svg", ".md": "markdown", ".txt": "text",
};
const LANGUAGE_BY_EXT: Record<string, string> = {
  ".js": "javascript", ".ts": "typescript", ".jsx": "jsx", ".tsx": "tsx", ".py": "python", ".java": "java",
  ".go": "go", ".rs": "rust", ".c": "c", ".cpp": "cpp", ".cs": "csharp", ".rb": "ruby", ".php": "php",
  ".swift": "swift", ".kt": "kotlin", ".sh": "shell", ".ps1": "powershell", ".sql": "sql", ".css": "css",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".xml": "xml", ".vue": "vue",
};
const BINARY_EXTS = new Set([".png", ".gif", ".mp4", ".jpg", ".jpeg", ".webp", ".pdf", ".zip"]);

/** 由扩展名推回产物类型（编辑后的新版本沿用原类型） */
export function artifactTypeOf(path: string): { type: ArtifactType; language?: string } | null {
  const ext = extname(path).toLowerCase();
  if (BINARY_EXTS.has(ext)) return null;
  if (TEXT_TYPE_BY_EXT[ext]) return { type: TEXT_TYPE_BY_EXT[ext] };
  const language = LANGUAGE_BY_EXT[ext];
  return language ? { type: "code", language } : { type: "text" };
}

/** 去掉版本后缀的文件名主体：report-v3.html → report */
function baseStem(path: string): string {
  return basename(path, extname(path)).replace(/-v\d+$/, "");
}

export interface ArtifactEdit {
  oldStr: string;
  newStr: string;
}

/** 依次应用编辑；每个 oldStr 必须恰好出现一次。失败时说清楚是第几处、怎么改（给模型看） */
export function applyArtifactEdits(content: string, edits: ArtifactEdit[]): { ok: true; content: string } | { ok: false; error: string } {
  let next = content;
  for (let i = 0; i < edits.length; i++) {
    const { oldStr, newStr } = edits[i];
    if (!oldStr) return { ok: false, error: `第 ${i + 1} 处编辑的 oldStr 为空。oldStr 必须是产物里一段原样存在的文本。` };
    const first = next.indexOf(oldStr);
    if (first < 0) {
      return {
        ok: false,
        error: `第 ${i + 1} 处编辑没找到 oldStr（必须与产物当前内容逐字符一致，含空格缩进换行）。` +
          `先用 read_artifact 读一下产物的最新内容再改；前面的编辑都没有生效。`,
      };
    }
    if (next.indexOf(oldStr, first + oldStr.length) >= 0) {
      return { ok: false, error: `第 ${i + 1} 处编辑的 oldStr 在产物里出现了不止一次，请多带几行上下文使它唯一；前面的编辑都没有生效。` };
    }
    next = next.slice(0, first) + newStr + next.slice(first + oldStr.length);
  }
  return { ok: true, content: next };
}

export interface ArtifactToolDeps {
  host: AgentHost;
  /** 产物目录；空串表示还没法确定（会话未建立） */
  artifactDir: string;
}

export interface EditedArtifact {
  path: string;
  title: string;
  type: ArtifactType;
  language?: string;
  size: number;
  version: number;
}

/** edit_artifact：在已有产物上做局部修改，存成新版本（旧版本保留，用户可能正在看或已经发给别人） */
export async function editArtifact(
  deps: ArtifactToolDeps,
  args: Record<string, unknown>,
): Promise<{ ok: true; artifact: EditedArtifact; result: string } | { ok: false; result: string; userMessage: string }> {
  const path = typeof args.path === "string" ? args.path.trim() : "";
  const rawEdits = Array.isArray(args.edits) ? args.edits : [];
  const edits = rawEdits
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({ oldStr: typeof e.oldStr === "string" ? e.oldStr : "", newStr: typeof e.newStr === "string" ? e.newStr : "" }));
  if (!path) return { ok: false, result: "缺少 path：传要修改的产物路径（create_artifact / read_artifact 返回的那个绝对路径）。", userMessage: "没有指定要修改的产物" };
  if (edits.length === 0) return { ok: false, result: "缺少 edits：至少传一处 { oldStr, newStr }。要整份重写请用 create_artifact。", userMessage: "没有给出要修改的内容" };
  if (!deps.artifactDir) return { ok: false, result: "当前无法确定产物目录（会话尚未建立），稍后再试。", userMessage: "暂时无法确定产物保存位置" };
  if (!isInsideDir(deps.artifactDir, path)) {
    return { ok: false, result: `只能修改产物目录（${deps.artifactDir}）里的文件。用 read_artifact 不带参数可以列出已有产物。`, userMessage: "只能修改产物目录里的文件" };
  }
  const kind = artifactTypeOf(path);
  if (!kind) return { ok: false, result: "这是二进制产物（图片 / 视频），不能按文本修改；请重新生成。", userMessage: "这类产物不能按文本修改" };

  const current = await deps.host.fs.read(path);
  if (current === null) return { ok: false, result: `产物不存在：${path}。用 read_artifact 不带参数可以列出已有产物。`, userMessage: "要修改的产物不存在" };
  const applied = applyArtifactEdits(current, edits);
  if (!applied.ok) return { ok: false, result: applied.error, userMessage: "修改没有匹配到产物里的内容，未保存" };
  if (applied.content.length > MAX_ARTIFACT_CHARS) {
    return { ok: false, result: `修改后超过产物上限（${MAX_ARTIFACT_CHARS} 字符），请精简内容。`, userMessage: "修改后的产物过大，未保存" };
  }

  const ext = extname(path);
  const stem = baseStem(path);
  const newPath = await pickVersionedPath(dirname(path), stem, ext, async (p) => !!(await deps.host.fs.stat(p)));
  await deps.host.fs.write(newPath, applied.content);
  const versionMatch = /-v(\d+)\.[^.]+$/.exec(newPath);
  const version = versionMatch ? Number(versionMatch[1]) : 1;
  const size = Buffer.byteLength(applied.content, "utf8");
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : stem;
  return {
    ok: true,
    artifact: { path: newPath, title, type: kind.type, ...(kind.language ? { language: kind.language } : {}), size, version },
    result: `已修改 ${edits.length} 处，保存为第 ${version} 版：${newPath}（${size} 字节，旧版本保留）。界面已显示新版本卡片，回复里简短说明改了什么即可。`,
  };
}

/** 读文本文件的上限：再长就截断，提示用 edit 按片段改 */
const READ_LIMIT = 40_000;

async function listDir(host: AgentHost, dir: string, limit = 100): Promise<string> {
  let entries: Array<{ name: string; isDir: boolean }> = [];
  try {
    entries = await host.fs.readdir(dir);
  } catch {
    return "（目录不存在或无法读取）";
  }
  if (entries.length === 0) return "（空）";
  const lines: string[] = [];
  for (const e of entries.slice(0, limit)) {
    const abs = resolve(dir, e.name);
    if (e.isDir) {
      lines.push(`- ${e.name}/`);
      continue;
    }
    const st = await host.fs.stat(abs).catch(() => null);
    const size = typeof st?.size === "number" ? `（${st.size} 字节）` : "";
    lines.push(`- ${abs}${size}`);
  }
  if (entries.length > limit) lines.push(`…另有 ${entries.length - limit} 项未列出`);
  return lines.join("\n");
}

async function readText(host: AgentHost, path: string): Promise<string | null> {
  const content = await host.fs.read(path);
  if (content === null) return null;
  if (content.length <= READ_LIMIT) return content;
  return `${content.slice(0, READ_LIMIT)}\n\n…（内容过长，只显示前 ${READ_LIMIT} 字符，共 ${content.length} 字符）`;
}

/** read_artifact：不带 path 列出产物目录；带 path 读一份产物的当前内容 */
export async function readArtifact(deps: ArtifactToolDeps, args: Record<string, unknown>): Promise<{ ok: boolean; result: string }> {
  if (!deps.artifactDir) return { ok: false, result: "当前无法确定产物目录（会话尚未建立）。" };
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!path) return { ok: true, result: `产物目录：${deps.artifactDir}\n${await listDir(deps.host, deps.artifactDir)}` };
  if (!isInsideDir(deps.artifactDir, path)) return { ok: false, result: `只能读取产物目录（${deps.artifactDir}）里的文件；不带 path 调用可以列出已有产物。` };
  if (!artifactTypeOf(path)) return { ok: true, result: `${path} 是二进制产物（图片 / 视频），没有可读的文本内容。` };
  const content = await readText(deps.host, path);
  if (content === null) return { ok: false, result: `产物不存在：${path}。不带 path 调用可以列出已有产物。` };
  return { ok: true, result: content };
}

/**
 * read_skill_file：读技能 / Power 目录里的附属文件（模板、参考资料、示例）。只读。
 * 相对路径按最近一次 use_skill 加载的技能目录解析。
 */
export async function readSkillFile(
  host: AgentHost,
  allowedRoots: string[],
  args: Record<string, unknown>,
  baseDir?: string,
): Promise<{ ok: boolean; result: string }> {
  const raw = typeof args.path === "string" ? args.path.trim() : "";
  if (!raw) return { ok: false, result: "缺少 path：传技能目录里的文件路径（绝对路径，或相对于最近加载的技能目录）。" };
  const path = isAbsolute(raw) ? raw : baseDir ? resolve(baseDir, raw) : "";
  if (!path) return { ok: false, result: "相对路径需要先用 use_skill 加载技能；或者传绝对路径。" };
  const roots = allowedRoots.filter(Boolean);
  if (!roots.some((root) => isInsideDir(root, path))) {
    return { ok: false, result: "只能读取技能或 Power 目录里的文件（use_skill / activate_power 返回的目录）。" };
  }
  const st = await host.fs.stat(path).catch(() => null);
  if (!st) return { ok: false, result: `文件不存在：${path}` };
  if (st.isDir) return { ok: true, result: `${path}/\n${await listDir(host, path)}` };
  if (BINARY_EXTS.has(extname(path).toLowerCase())) return { ok: true, result: `${path} 是二进制文件，没有可读的文本内容。` };
  const content = await readText(host, path);
  return content === null ? { ok: false, result: `文件不存在：${path}` } : { ok: true, result: content };
}
