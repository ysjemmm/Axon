/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * 工具的搜索/路径解析/列目录逻辑（迁移自 server/src/tools.ts）
 *
 * 与执行端解耦：所有文件系统访问（readdir/stat/read）都走注入的 AgentHost.fs，
 * 不再直接 import node:fs/promises。路径计算仍用 node:path（纯计算，与形态无关）。
 *
 * 逐字符保留原有业务逻辑与模型可见的输出文本，只把 fs 访问换成 host.fs：
 *   - entry.isDirectory() → child.isDir
 *   - entry.isFile()      → child.isFile
 *   - readdir(dir, {withFileTypes:true}) → host.fs.readdir(dir)（返回 DirChild[]）
 *   - stat(path)          → host.fs.stat(path)（不存在返回 null）
 *   - readFile(path)      → host.fs.read(path)（不存在返回 null）
 */

import { join, relative, resolve, sep } from "node:path";
import { IGNORED_DIRS } from "./safety.js";
import type { AgentHost } from "../host/index.js";

/**
 * 多工作区路径解析：尝试在 cwd 下 resolve，如果文件不存在则遍历其他 workspaces 找到它。
 * 支持相对路径（如 "src/main/xxx"）和绝对路径。
 * 返回 resolve 后的绝对路径。
 */
export async function resolveInWorkspaces(
  filePath: string,
  cwd: string,
  host: AgentHost,
  workspaces?: string[],
): Promise<string> {
  // 绝对路径直接返回
  const primary = resolve(cwd, filePath);
  if (filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath)) {
    return primary;
  }
  // 先检查主工作区
  if (await host.fs.stat(primary)) {
    return primary;
  }
  // 候选工作区列表：含 cwd 与所有绑定工作区（去重）
  const candidateRoots = Array.from(new Set([cwd, ...(workspaces || [])]));
  // 1) 在每个工作区下按相对路径直接尝试
  for (const ws of candidateRoots) {
    if (ws === cwd) continue; // cwd 上面已试过
    const candidate = resolve(ws, filePath);
    if (await host.fs.stat(candidate)) {
      return candidate;
    }
  }
  // 2) 兜底：用文件名（basename）在所有工作区中递归搜索（单/多工作区都适用）
  //    解决"模型给了 main.js 但文件实际在 src/main.js"这类相对路径不精确的情况
  const baseName = filePath.split("/").pop()?.split("\\").pop() || "";
  if (baseName && baseName.includes(".")) {
    for (const ws of candidateRoots) {
      const found = await findFileByName(ws, baseName, host);
      if (found) return found;
    }
  }
  // 都找不到，返回原始 resolve 结果（后续会报文件不存在的错）
  return primary;
}

/** 在目录中递归查找文件名匹配的第一个文件（深度限制 5 层） */
export async function findFileByName(
  dir: string,
  name: string,
  host: AgentHost,
  depth = 0,
): Promise<string | null> {
  if (depth > 5) return null;
  try {
    const entries = await host.fs.readdir(dir);
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isFile && entry.name === name) return full;
      if (entry.isDir && depth < 5) {
        const found = await findFileByName(full, name, host, depth + 1);
        if (found) return found;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 找出给定绝对路径属于哪个工作区（用作相对路径基准）。
 * 取能作为该路径前缀的最长工作区；都不匹配时回退到该路径本身。
 */
export function owningWorkspace(absPath: string, workspaces: string[]): string {
  const normalized = absPath.replace(/\\/g, "/");
  let best = "";
  for (const ws of workspaces) {
    const wsNorm = ws.replace(/\\/g, "/");
    if (normalized === wsNorm || normalized.startsWith(wsNorm + "/")) {
      if (wsNorm.length > best.length) best = ws;
    }
  }
  return best || absPath;
}

/** 按名称搜索文件或目录（kind=file 搜文件，kind=dir 搜目录） */
export async function searchEntries(
  dir: string,
  query: string,
  rootCwd: string,
  kind: "file" | "dir",
  host: AgentHost,
): Promise<string> {
  const MAX_RESULTS = 100;
  const lowerQuery = query.toLowerCase();
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    if (results.length >= MAX_RESULTS) return;
    let entries;
    try {
      entries = await host.fs.readdir(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) return;
      if (entry.isDir && IGNORED_DIRS.has(entry.name)) continue;
      const full = join(current, entry.name);
      const matched = entry.name.toLowerCase().includes(lowerQuery);
      if (entry.isDir) {
        if (kind === "dir" && matched) {
          results.push(relative(rootCwd, full).split(sep).join("/") + "/");
        }
        await walk(full);
      } else if (kind === "file" && matched) {
        results.push(relative(rootCwd, full).split(sep).join("/"));
      }
    }
  }

  await walk(dir);
  const label = kind === "dir" ? "目录" : "文件";
  if (results.length === 0) return `未找到匹配 "${query}" 的${label}`;
  const capped = results.length >= MAX_RESULTS ? `\n（已截断，仅显示前 ${MAX_RESULTS} 条）` : "";
  return `找到 ${results.length} 个${label}:\n${results.join("\n")}${capped}`;
}

/**
 * 列出目录结构（树形）。
 * - 到达 maxDepth 上限时，仍有子内容的目录标记 "(未展开)"，提示模型可深入或换 search
 * - 总条数上限 MAX_ENTRIES，超出则标记 "(已截断)"
 */
export async function listDir(
  dir: string,
  rootCwd: string,
  maxDepth: number,
  host: AgentHost,
): Promise<string> {
  const MAX_ENTRIES = 200;
  const lines: string[] = [];
  let truncated = false;

  // 入口目录不存在/不是目录时，快速失败给出明确信息
  const st = await host.fs.stat(dir);
  if (!st) {
    throw new Error(
      `list_dir 失败：目录 ${relative(rootCwd, dir).split(sep).join("/") || "."} 不存在或无法访问。` +
      `请确认路径是否正确。`
    );
  }
  if (!st.isDir) {
    throw new Error(
      `list_dir 失败：${relative(rootCwd, dir).split(sep).join("/") || "."} 不是目录。` +
      `如需查看文件内容请用 read_file。`
    );
  }

  async function walk(current: string, curDepth: number, _prefix: string): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await host.fs.readdir(current);
    } catch {
      return;
    }
    // 目录在前、文件在后，各自按名称排序
    entries.sort((a, b) => {
      const ad = a.isDir ? 0 : 1;
      const bd = b.isDir ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (lines.length >= MAX_ENTRIES) {
        truncated = true;
        return;
      }
      if (entry.isDir && IGNORED_DIRS.has(entry.name)) continue;

      // 输出从工作区根开始的完整相对路径（模型可直接复制用于 read_file/str_replace 的 path 参数）
      const full = join(current, entry.name);
      const relPath = relative(rootCwd, full).split(sep).join("/");

      if (entry.isDir) {
        if (curDepth >= maxDepth) {
          const hasChildren = await dirHasVisibleEntries(full, host);
          lines.push(`${relPath}/${hasChildren ? " (未展开)" : ""}`);
        } else {
          lines.push(`${relPath}/`);
          await walk(full, curDepth + 1, "");
        }
      } else {
        lines.push(`${relPath}`);
      }
    }
  }

  await walk(dir, 1, "");

  const relRoot = relative(rootCwd, dir).split(sep).join("/") || ".";
  if (lines.length === 0) return `目录 ${relRoot} 为空（已跳过 node_modules、.git 等）`;
  const cappedNote = truncated ? `\n（已截断，仅显示前 ${MAX_ENTRIES} 条；可对具体子目录单独 list_dir 或用 search 精确定位）` : "";
  return `${relRoot}/\n${lines.join("\n")}${cappedNote}`;
}

/** 判断目录下是否还有未被忽略的可见条目（用于决定是否标记"未展开"） */
export async function dirHasVisibleEntries(dir: string, host: AgentHost): Promise<boolean> {
  try {
    const entries = await host.fs.readdir(dir);
    return entries.some((e) => !(e.isDir && IGNORED_DIRS.has(e.name)));
  } catch {
    return false;
  }
}

/**
 * 把 glob 模式编译为锚定正则。
 * - `**` → 任意字符（含 /）；`*` → 段内任意（不含 /）；`?` → 单个非 / 字符
 * - 其余正则元字符转义
 */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // 吸收 **/ 里的斜杠，避免强制要求一层目录
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/**
 * 判断文件是否匹配 includePattern。向后兼容两种写法：
 * - 无 glob 元字符（如 ".ts"、".test.ts"）：按后缀匹配（文件名或相对路径以其结尾）——保持旧约定
 * - 含 glob（如 "*.ts"、"**\/*.ts"、"src/**\/*.ts"）：编译为正则匹配；含 / 的对相对路径匹配，否则对文件名匹配
 */
export function fileMatchesInclude(relPath: string, fileName: string, pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return true;
  if (!/[*?]/.test(p)) {
    return fileName.endsWith(p) || relPath.endsWith(p);
  }
  const target = p.includes("/") ? relPath : fileName;
  try {
    return globToRegExp(p).test(target);
  } catch {
    // 万一构造正则失败，退回后缀匹配，绝不静默吞掉全部结果
    return fileName.endsWith(p) || relPath.endsWith(p);
  }
}

/** 按内容搜索（类似 grep） */
export async function searchContent(
  dir: string,
  query: string,
  rootCwd: string,
  host: AgentHost,
  includePattern?: string,
): Promise<string> {
  const MAX_MATCHES = 100;
  const MAX_FILE_SIZE = 1024 * 1024; // 1MB，跳过过大文件
  const matches: string[] = [];

  let regex: RegExp;
  try {
    regex = new RegExp(query, "i");
  } catch {
    // query 整体不是合法正则时：如果含 |（用户意图是 OR 搜索），逐段转义后再用 | 拼接，保留 OR 语义
    if (query.includes("|")) {
      const safeAlternatives = query.split("|")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      regex = new RegExp(safeAlternatives.join("|"), "i");
    } else {
      regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
  }

  async function walk(current: string): Promise<void> {
    if (matches.length >= MAX_MATCHES) return;
    let entries;
    try {
      entries = await host.fs.readdir(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES) return;
      if (entry.isDir && IGNORED_DIRS.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDir) {
        await walk(full);
        continue;
      }
      // 文件类型过滤：兼容后缀（".ts"）与 glob（"*.ts"、"**/*.ts"）两种写法
      const relPath = relative(rootCwd, full).split(sep).join("/");
      if (includePattern && !fileMatchesInclude(relPath, entry.name, includePattern)) continue;
      // 读取文件内容；不存在/无法读取（二进制等）返回 null，跳过。
      // 过大文件跳过（host.fs 不暴露文件字节大小，改以读取后的内容长度作为阈值判断）
      const content = await host.fs.read(full);
      if (content === null) continue;
      if (content.length > MAX_FILE_SIZE) continue;
      const fileLines = content.split("\n");
      const totalLines = fileLines.length;
      for (let i = 0; i < fileLines.length; i++) {
        if (matches.length >= MAX_MATCHES) break;
        if (regex.test(fileLines[i])) {
          // 返回匹配行及前后各1行上下文，标注文件总行数
          const ctxStart = Math.max(0, i - 1);
          const ctxEnd = Math.min(fileLines.length - 1, i + 1);
          const ctxLines: string[] = [];
          for (let j = ctxStart; j <= ctxEnd; j++) {
            const prefix = j === i ? ">" : " ";
            ctxLines.push(`  ${prefix} ${j + 1}: ${fileLines[j].trimEnd().slice(0, 180)}`);
          }
          matches.push(`${relPath}:${i + 1} (共${totalLines}行)\n${ctxLines.join("\n")}`);
        }
      }
    }
  }

  await walk(dir);
  if (matches.length === 0) return `未找到匹配 "${query}" 的内容`;
  const capped = matches.length >= MAX_MATCHES ? `\n（已截断，仅显示前 ${MAX_MATCHES} 条。建议用 includePattern 或更精确的 query 缩小范围）` : "";
  return `找到 ${matches.length} 处匹配:\n${matches.join("\n")}${capped}`;
}

/**
 * 合并多个工作区的搜索结果。
 * - 单工作区：直接返回该工作区结果，保持原有输出格式不变
 * - 多工作区：为每个有命中的工作区加上根路径标识，跳过无结果的工作区；全部无命中时给出统一的升级建议
 */
export function mergeMultiRootResults(roots: string[], parts: string[]): string {
  const noResultHint = '。换词时请锚定你刚搜的原始词根（保留用户原话里的名词），只替换动词前缀（get/create/gen/batch）并用 | 组合重试；不要重新解读整句需求跑去搜别的语义方向（那样越搜越偏、浪费 token），也不要把提示里的示例词当成项目里真实存在的符号。也可加 includePattern 缩小范围。连续两次搜空就回到原始词重新想，别急着 read_file 碰运气。';
  const scopeInfo = roots.length > 1
    ? `（搜索范围：${roots.length} 个工作区 → ${roots.join("、")}）`
    : `（搜索范围：${roots[0]}）`;

  if (roots.length === 1) {
    const text = parts[0];
    return text.startsWith("未找到") ? `${text} ${scopeInfo}${noResultHint}` : text;
  }

  const hitBlocks: string[] = [];
  for (let i = 0; i < roots.length; i++) {
    const text = parts[i];
    if (text.startsWith("未找到")) continue;
    hitBlocks.push(`【工作区: ${roots[i]}】\n${text}`);
  }
  if (hitBlocks.length === 0) {
    return `在全部 ${roots.length} 个工作区中均未找到匹配内容 ${scopeInfo}${noResultHint}`;
  }
  return hitBlocks.join("\n\n");
}
