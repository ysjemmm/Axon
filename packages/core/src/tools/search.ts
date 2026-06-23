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

// ─── ripgrep 加速路径 ─────────────────────────────────────────────
// 底层用 ripgrep 替代手写 walk：C 级速度，内置 gitignore/IGNORED_DIRS 排除。
// 通过 host.commands.exec 调 rg，失败（未安装/不可用）时优雅回退到 walk。
// 用 Symbol-ish 缓存 rg 路径探测结果，避免每次搜索都探测。

/** rg 可执行文件路径（探测一次后缓存） */
let rgPath: string | null | undefined = undefined;

/**
 * 探测系统可用的 rg 可执行文件路径。
 * 直接使用 @vscode/ripgrep npm 包（Axon IDE 基于 VS Code，一定内置此包），
 * 避免在终端执行 PATH 探测命令产生噪音输出。
 */
async function resolveRgPath(host: AgentHost): Promise<string | null> {
  if (rgPath !== undefined) return rgPath;
  try {
    const req = typeof require === "function"
      ? require
      : (await import("node:module")).default.createRequire(import.meta.url);
    const rgBinPath = req("@vscode/ripgrep/package.json") && req("@vscode/ripgrep").rgPath;
    if (typeof rgBinPath === "string") {
      const st = await host.fs.stat(rgBinPath);
      if (st) {
        rgPath = `"${rgBinPath}"`;
        return rgPath;
      }
    }
  } catch { /* fallthrough */ }
  rgPath = null;
  return null;
}

/**
 * 把 IGNORED_DIRS 集合转成 rg 的 `-g '!xxx'` 参数（排除这些目录）。
 */
function rgIgnoreGlobs(): string {
  const globs = Array.from(IGNORED_DIRS).map((d) => `-g '!${d}'`);
  return globs.join(" ");
}

/**
 * 用 ripgrep 做内容搜索（grep 模式），输出格式对齐 walk 版 searchContent。
 * 返回 null 表示 rg 不可用或执行失败，调用方应回退到 walk。
 */
async function rgSearchContent(
  dir: string,
  regexPattern: string,
  rootCwd: string,
  host: AgentHost,
  includePattern: string | undefined,
  maxMatches: number,
): Promise<string | null> {
  const rgBin = await resolveRgPath(host);
  if (!rgBin) return null;
  // rg 参数：
  //   -i             忽略大小写
  //   -n             显示行号
  //   -C1            前后各1行上下文（对齐 walk 版）
  //   -m 1           每文件最多输出1个匹配就停（控制噪音；如需全部可去掉）
  //   --no-heading   不按文件分块输出（简化解析）
  //   --max-filesize 1M   跳过大文件
  //   -g '!xxx'      排除 IGNORED_DIRS
  //   -g '*.ts'      includePattern（仅含 glob 时直接用）
  const ignoreArgs = rgIgnoreGlobs();
  const includeArg = includePattern
    ? buildRgIncludeArg(includePattern)
    : "";
  // 注意：rgBin 可能是带空格的路径（已含引号），pattern 用 regex.source（已转义）
  // --encoding utf-8 防止中文内容输出乱码
  const cmd = [
    rgBin,
    "-i",
    "-n",
    "-C1",
    `-m ${Math.ceil(maxMatches / 5)}`, // 每文件限制，留余量给最终截断
    "--no-heading",
    "--encoding",
    "utf-8",
    "--max-filesize",
    "1M",
    ignoreArgs,
    includeArg,
    "-e",            // 用 -e 传 pattern，避免 -- 分隔符在 shell 解析歧义
    regexPattern,
    dir,             // 搜索目录（不加额外引号，交给 shell 解析）
  ].filter(Boolean).join(" ");

  try {
    const r = await host.commands!.exec(cmd, {
      cwd: rootCwd,
      timeoutMs: 15000,
    });
    if (r.exitCode !== 0 && r.exitCode !== 1) return null; // 1=无匹配；其他=出错
    if (!r.stdout.trim()) {
      return `未找到匹配 "${regexPattern}" 的内容`;
    }
    // 解析 rg 输出，转成对齐 walk 版的格式
    return parseRgContentOutput(r.stdout, rootCwd, maxMatches);
  } catch {
    return null;
  }
}

/** 把 includePattern（后缀或 glob）转成 rg 的 -g/--type 参数 */
function buildRgIncludeArg(pattern: string): string {
  const p = pattern.trim();
  if (!p) return "";
  // 纯后缀（.ts / .test.ts）→ 用 -g '*xxx'
  if (!/[*?]/.test(p)) {
    return `-g '*${p}'`;
  }
  // glob 模式 → 直接透传给 -g
  return `-g '${p}'`;
}

/** 解析 ripgrep --no-heading + -C1 的输出为对齐 walk 版的格式 */
function parseRgContentOutput(stdout: string, rootCwd: string, maxMatches: number): string {
  const matches: string[] = [];
  const lines = stdout.split("\n");
  // 待写入的上下文行（出现在匹配行之前的 CTX 行）
  let pendingCtx: string[] = [];

  for (const line of lines) {
    if (matches.length >= maxMatches) break;
    if (!line.trim()) continue;
    // rg 块分隔符 "--"
    if (line.trim() === "--") {
      pendingCtx = [];
      continue;
    }
    // rg --no-heading 输出格式：path:linenum:content（匹配行）或 path-linenum-content（上下文行）
    const match = line.match(/^(.+?)([:-])(\d+)\2(.*)$/);
    if (!match) continue;
    const [, fPath, sep, lineStr, content] = match;
    const ln = parseInt(lineStr, 10);
    const rel = relative(rootCwd, fPath.replace(/\\/g, "/")).split(sep).join("/");

    if (sep === ":") {
      // 匹配行：把前面累积的上下文 + 本行组合成一个完整结果
      const parts: string[] = [...pendingCtx, `  > ${ln}: ${content.trim().slice(0, 180)}`];
      matches.push(`${rel}:${ln}\n${parts.join("\n")}`);
      pendingCtx = [];
    } else {
      // 上下文行：先累积，等遇到匹配行时一起输出
      pendingCtx.push(`    ${ln}: ${content.trim().slice(0, 180)}`);
    }
  }

  if (matches.length === 0) return `未找到匹配的内容`;
  return `找到 ${matches.length} 处匹配:\n${matches.join("\n")}`;
}

/**
 * 用 ripgrep 做文件名搜索（--files），输出格式对齐 walk 版 searchEntries。
 * 返回 null 表示 rg 不可用或执行失败，调用方应回退到 walk。
 */
async function rgSearchEntries(
  dir: string,
  query: string,
  rootCwd: string,
  kind: "file" | "dir",
  host: AgentHost,
  maxResults: number,
): Promise<string | null> {
  const rgBin = await resolveRgPath(host);
  if (!rgBin) return null;
  const lowerQuery = query.toLowerCase();
  const ignoreArgs = rgIgnoreGlobs();
  // rg --files 列出所有文件（不含目录），用 -g 过滤
  // 文件名搜索：直接列文件再按 query 过滤
  const cmd = [
    rgBin,
    "--files",
    "--encoding",
    "utf-8",
    ignoreArgs,
    dir,
  ].filter(Boolean).join(" ");

  try {
    const r = await host.commands!.exec(cmd, {
      cwd: rootCwd,
      timeoutMs: 15000,
    });
    if (r.exitCode !== 0 && r.exitCode !== 1) return null;
    if (!r.stdout.trim()) return null;

    const allFiles = r.stdout.split("\n").filter(Boolean).map((l) => l.trim());
    const results: string[] = [];

    for (const f of allFiles) {
      if (results.length >= maxResults) break;
      const name = f.split(/[\\/]/).pop() || "";
      if (kind === "file" && name.toLowerCase().includes(lowerQuery)) {
        results.push(f.replace(/\\/g, "/"));
      }
    }

    // 目录搜索：rg --files 只列文件，需从中提取目录名匹配
    if (kind === "dir") {
      const dirSet = new Set<string>();
      for (const f of allFiles) {
        const parts = f.replace(/\\/g, "/").split("/");
        // 去掉末尾文件名，遍历目录段
        for (let i = 0; i < parts.length - 1; i++) {
          const seg = parts[i].toLowerCase();
          if (seg.includes(lowerQuery)) {
            const dirPath = parts.slice(0, i + 1).join("/") + "/";
            dirSet.add(dirPath);
          }
        }
      }
      for (const d of Array.from(dirSet).sort()) {
        if (results.length >= maxResults) break;
        results.push(d);
      }
    }

    const label = kind === "dir" ? "目录" : "文件";
    if (results.length === 0) return `未找到匹配 "${query}" 的${label}`;
    const capped = results.length >= maxResults ? `\n（已截断，仅显示前 ${maxResults} 条）` : "";
    return `找到 ${results.length} 个${label}:\n${results.join("\n")}${capped}`;
  } catch {
    return null;
  }
}

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
  const MAX_RESULTS = 50;
  const lowerQuery = query.toLowerCase();
  const results: string[] = [];

  // ── ripgrep 快速路径 ──
  const rgResult = await rgSearchEntries(dir, query, rootCwd, kind, host, MAX_RESULTS);
  if (rgResult !== null) return rgResult;

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
  const MAX_MATCHES = 50;
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

  // ── ripgrep 快速路径 ──
  // 把处理后的 regex source 作为 rg 的 pattern（确保无效正则已转义）。
  const rgResult = await rgSearchContent(dir, regex.source, rootCwd, host, includePattern, MAX_MATCHES);
  if (rgResult !== null) return rgResult;

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
