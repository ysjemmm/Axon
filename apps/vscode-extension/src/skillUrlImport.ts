/**
 * 从 GitHub 链接直接导入技能 / 能力包目录。
 *
 * 场景：用户手上往往只有仓库里某个子目录的地址，例如
 *   https://github.com/lemomo-ai/lemo-opuscar/tree/main/plugin/skills/lemo-opuscar
 * 以前必须先把整个仓库 clone 下来、再在文件对话框里一层层翻到那一层；
 * 这里直接按链接把该子目录抓到本地临时目录，后续走与本地导入完全相同的复制 / 校验流程。
 *
 * 实现只用 GitHub 公开接口：
 *  - 一次 `git/trees/{ref}?recursive=1` 拿到文件清单（只下载目标目录下的文件，不拉无关内容）
 *  - 内容从 raw.githubusercontent.com 取（不消耗接口配额）
 *  - 分支名含斜杠时 raw 域名无法区分 ref 与路径，退回 contents 接口取 base64
 * 设置 GITHUB_TOKEN / GH_TOKEN 环境变量可提高接口限额。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";

/** 一次链接导入的目标定位 */
export interface GitHubTarget {
  owner: string;
  repo: string;
  /** 分支 / tag / commit；空串表示用仓库默认分支 */
  ref: string;
  /** 仓库内的子目录路径；空串表示仓库根 */
  path: string;
}

/** 下载结果 */
export interface DownloadedDir {
  /** 下载到本地的目录绝对路径（可直接作为导入源目录） */
  dir: string;
  /** 本次下载的临时根目录，导入完成后应清理 */
  tempRoot: string;
}

interface TreeEntry {
  path: string;
  type: string;
}

interface RepoInfo {
  default_branch?: string;
}

interface TreeResponse {
  tree?: TreeEntry[];
  truncated?: boolean;
}

interface ContentResponse {
  content?: string;
  encoding?: string;
}

/** 文件数量上限：防止用户误贴仓库根地址，把整个大型仓库拉下来 */
const MAX_FILES = 500;

/**
 * 解析 GitHub 链接。
 *
 * 支持三种形态：
 *  - `https://github.com/<owner>/<repo>`                      → 仓库根
 *  - `https://github.com/<owner>/<repo>/tree/<ref>/<path...>` → 子目录
 *  - `https://github.com/<owner>/<repo>/blob/<ref>/<path...>` → 该文件所在目录
 *
 * 其它形态（GitLab、gist、非 GitHub 域名等）返回 null，由调用方给出提示。
 */
export function parseGitHubUrl(raw: string): GitHubTarget | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const repo = segments[1].replace(/\.git$/i, "");
  if (!repo) return null;
  const owner = segments[0];
  const kind = segments[2];

  // 仓库根链接
  if (!kind) return { owner, repo, ref: "", path: "" };
  if (kind !== "tree" && kind !== "blob") return null;

  const rest = segments.slice(3);
  if (rest.length === 0) return null;

  const [ref, ...pathParts] = rest;
  // blob 指向单个文件，取它所在目录
  const pathParts2 = kind === "blob" ? pathParts.slice(0, -1) : pathParts;
  return { owner, repo, ref, path: pathParts2.join("/") };
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "axon-ide-skill-import",
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    const hint =
      res.status === 404
        ? "路径或分支不存在"
        : res.status === 403 || res.status === 429
          ? "接口被限流，可设置 GITHUB_TOKEN 环境变量后重试"
          : res.statusText;
    throw new Error(`GitHub 接口 ${res.status}：${hint}`);
  }
  return (await res.json()) as T;
}

/** 清洗成合法目录名（Windows 不允许 < > : " | ? * 等字符） */
function sanitizeSegment(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/^\.+$/, "-")
    .trim();
  return cleaned || "skill";
}

/** 拼接并确保结果仍在 baseDir 内，防止 `..` 之类的路径逃逸 */
function safeJoin(baseDir: string, rel: string): string | null {
  const base = normalize(baseDir);
  const target = normalize(join(base, rel));
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

/** 取单个文件内容：优先 raw 域名（不计配额），分支名含斜杠时退回 contents 接口 */
async function fetchFileContent(
  owner: string,
  repo: string,
  ref: string,
  filePath: string,
): Promise<Buffer> {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");

  if (!ref.includes("/")) {
    const res = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${encodedPath}`,
      { headers: { "User-Agent": "axon-ide-skill-import" } },
    );
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status !== 404) throw new Error(`下载失败 ${res.status}：${filePath}`);
  }

  const data = await getJson<ContentResponse>(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
  );
  if (!data.content) throw new Error(`无法读取文件内容：${filePath}`);
  return Buffer.from(data.content, data.encoding === "base64" ? "base64" : "utf8");
}

/**
 * 把链接指向的目录下载到本地临时目录。
 *
 * @param target     parseGitHubUrl 的解析结果
 * @param onProgress 进度回调（用于 VS Code 通知栏提示）
 * @returns 下载后的本地目录与临时根目录
 */
export async function downloadGitHubDir(
  target: GitHubTarget,
  onProgress?: (message: string) => void,
): Promise<DownloadedDir> {
  const { owner, repo } = target;

  let ref = target.ref;
  if (!ref) {
    onProgress?.(`读取 ${owner}/${repo} 默认分支…`);
    const info = await getJson<RepoInfo>(`https://api.github.com/repos/${owner}/${repo}`);
    ref = info.default_branch || "main";
  }

  onProgress?.(`读取 ${owner}/${repo}@${ref} 文件清单…`);
  const tree = await getJson<TreeResponse>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  );

  const prefix = target.path ? `${target.path.replace(/\/+$/, "")}/` : "";
  const files = (tree.tree || []).filter((node) => node.type === "blob" && node.path.startsWith(prefix));
  if (files.length === 0) {
    throw new Error(`链接指向的目录里没有文件：${target.path || "（仓库根）"}`);
  }
  if (files.length > MAX_FILES) {
    throw new Error(
      `该链接包含 ${files.length} 个文件（上限 ${MAX_FILES}），多半指向了整个仓库。请改成指向具体技能目录的链接。`,
    );
  }

  const folderName = sanitizeSegment(
    target.path ? target.path.split("/").filter(Boolean).pop() || repo : repo,
  );
  const tempRoot = join(tmpdir(), `axon-skill-import-${Date.now()}`);
  const destDir = join(tempRoot, folderName);

  let done = 0;
  for (const file of files) {
    const rel = prefix ? file.path.slice(prefix.length) : file.path;
    const destPath = safeJoin(destDir, rel);
    if (!destPath) continue; // 路径逃逸，跳过
    await mkdir(dirname(destPath), { recursive: true });
    const content = await fetchFileContent(owner, repo, ref, file.path);
    await writeFile(destPath, content);
    done += 1;
    onProgress?.(`下载 ${done}/${files.length}：${rel}`);
  }

  if (done === 0) throw new Error("没有成功下载任何文件。");
  return { dir: destDir, tempRoot };
}
