/**
 * VSCodeRipgrepSearch —— HostSearch 实现（进程内 IDE 形态）
 *
 * 直接 spawn 宿主（Code OSS）自带的 ripgrep 二进制完成搜索：
 * - 参数以 argv 数组传给 rg，【绝不拼接 shell 命令字符串】，
 *   从根上规避 PowerShell / cmd / bash 的引号与转义差异，天然跨操作系统。
 * - 用 `--json` 输出，避免解析 Windows 绝对路径里的盘符冒号（C:\...）产生歧义。
 * - rg 二进制路径通过 vscode.env.appRoot 定位（宿主一定内置 @vscode/ripgrep）；
 *   唯一与操作系统相关的信息（二进制名 rg / rg.exe）收敛在 resolveRgPath 一处。
 * - 找不到 rg 二进制 / 进程无法启动 / rg 报错时 Fail-Fast 抛错，不静默返回空结果。
 */

import { env } from "vscode";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import type {
  HostSearch,
  ContentMatch,
  ContentSearchOptions,
  FileSearchOptions,
} from "@axon/core";

const RG_TIMEOUT_MS = 20_000;

/** 解析后的 rg 二进制绝对路径（成功后缓存；失败不缓存以便恢复） */
let cachedRgPath: string | null = null;

/**
 * 定位宿主自带的 ripgrep 二进制。
 * 打包态二进制在 app.asar 外（node_modules.asar.unpacked），开发态在 node_modules。
 * 两处都探测；都不存在再尝试 require 解析（最后兜底）。找不到则抛错（Fail-Fast）。
 */
function resolveRgPath(): string {
  if (cachedRgPath && existsSync(cachedRgPath)) return cachedRgPath;

  const binName = process.platform === "win32" ? "rg.exe" : "rg";
  const candidates = [
    join(env.appRoot, "node_modules.asar.unpacked", "@vscode", "ripgrep", "bin", binName),
    join(env.appRoot, "node_modules", "@vscode", "ripgrep", "bin", binName),
  ];

  // 额外兜底：通过模块解析拿 rgPath（多数情况下扩展上下文解析不到，仅作补充）
  try {
    const req = createRequire(import.meta.url);
    const p = req("@vscode/ripgrep").rgPath as string | undefined;
    if (typeof p === "string") candidates.push(p);
  } catch { /* 解析不到忽略，用 appRoot 候选 */ }

  for (const c of candidates) {
    if (existsSync(c)) {
      cachedRgPath = c;
      return c;
    }
  }
  throw new Error(
    `无法定位 ripgrep 二进制。已尝试：\n${candidates.join("\n")}\n` +
    `请确认宿主（Code OSS）内置了 @vscode/ripgrep。`,
  );
}

/** 把 includePattern（后缀或 glob）转成 rg 的 -g glob 值（不含任何引号，作为独立 argv 传入） */
function includeToGlob(pattern: string): string {
  const p = pattern.trim();
  // 纯后缀（.ts / .test.ts）→ *.ts；含 glob 元字符 → 原样透传
  return /[*?]/.test(p) ? p : `*${p}`;
}

/** 以 argv 数组 spawn rg，逐行回调 onLine；rg 退出/出错时 resolve/reject */
function runRg(
  args: string[],
  onLine: (line: string) => void,
  /** 返回 true 表示提前满足、应主动结束进程 */
  shouldStop?: () => boolean,
): Promise<void> {
  const rgPath = resolveRgPath();
  return new Promise<void>((resolve, reject) => {
    const child = spawn(rgPath, args, { windowsHide: true });
    let stderr = "";
    let buf = "";
    let stopped = false;

    const timer = setTimeout(() => {
      stopped = true;
      child.kill();
    }, RG_TIMEOUT_MS);

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) onLine(line);
        if (shouldStop?.()) {
          stopped = true;
          child.kill();
          return;
        }
        nl = buf.indexOf("\n");
      }
    });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`ripgrep 启动失败：${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buf && !stopped) onLine(buf);
      // rg 退出码：0=有匹配，1=无匹配，2=出错。被主动 kill（stopped）时忽略退出码。
      if (!stopped && code !== null && code !== 0 && code !== 1) {
        reject(new Error(`ripgrep 执行出错（退出码 ${code}）：${stderr.trim() || "(无 stderr)"}`));
        return;
      }
      resolve();
    });
  });
}

interface RgEvent {
  kind: "match" | "context";
  file: string;
  line: number;
  text: string;
}

export class VSCodeRipgrepSearch implements HostSearch {
  async searchContent(opts: ContentSearchOptions): Promise<ContentMatch[]> {
    const { dir, pattern, includePattern, maxMatches, ignoredDirs } = opts;

    const args: string[] = [
      "--json",
      "--ignore-case",
      "--context", "1",
      "--max-filesize", "1M",
      "--encoding", "utf-8",
    ];
    for (const d of ignoredDirs) {
      args.push("-g", `!${d}`);
    }
    if (includePattern) {
      args.push("-g", includeToGlob(includePattern));
    }
    // 用 --regexp 显式传 pattern，--（参数终止符）后传搜索目录，二者均为独立 argv，无需转义
    args.push("--regexp", pattern, "--", dir);

    const events: RgEvent[] = [];
    let matchCount = 0;
    // 提前结束条件：拿到 maxMatches+1 个 match（+1 保证第 maxMatches 个匹配的后置上下文已到达）
    const shouldStop = () => matchCount >= maxMatches + 1;

    await runRg(args, (line) => {
      let evt: any;
      try { evt = JSON.parse(line); } catch { return; }
      if (evt.type !== "match" && evt.type !== "context") return;
      const data = evt.data;
      const text = data?.lines?.text;
      const file = data?.path?.text;
      const ln = data?.line_number;
      // 非 utf-8 内容（text 为 bytes）或缺字段：跳过
      if (typeof text !== "string" || typeof file !== "string" || typeof ln !== "number") return;
      if (evt.type === "match") matchCount++;
      events.push({
        kind: evt.type,
        file,
        line: ln,
        text: text.replace(/\r?\n$/, ""),
      });
    }, shouldStop);

    // 把事件序列组装成带前后各一行上下文的命中
    const out: ContentMatch[] = [];
    for (let i = 0; i < events.length && out.length < maxMatches; i++) {
      const e = events[i];
      if (e.kind !== "match") continue;
      const prev = events[i - 1];
      const next = events[i + 1];
      const before = prev && prev.kind === "context" && prev.file === e.file && prev.line === e.line - 1
        ? prev.text : undefined;
      const after = next && next.kind === "context" && next.file === e.file && next.line === e.line + 1
        ? next.text : undefined;
      out.push({ file: e.file, line: e.line, text: e.text, before, after });
    }
    return out;
  }

  async searchFiles(opts: FileSearchOptions): Promise<string[]> {
    const { dir, query, kind, maxResults, ignoredDirs } = opts;
    const lowerQuery = query.toLowerCase();

    const args: string[] = ["--files", "--encoding", "utf-8"];
    for (const d of ignoredDirs) {
      args.push("-g", `!${d}`);
    }
    args.push("--", dir);

    // rg --files 列出全部文件的绝对路径（因为 dir 是绝对路径）
    const allFiles: string[] = [];
    await runRg(args, (line) => { allFiles.push(line); });

    if (kind === "file") {
      const results: string[] = [];
      for (const f of allFiles) {
        if (results.length >= maxResults) break;
        const name = f.split(/[\\/]/).pop() || "";
        if (name.toLowerCase().includes(lowerQuery)) results.push(f);
      }
      return results;
    }

    // dir 模式：rg --files 只列文件，从路径中提取出名称含 query 的目录
    const dirSet = new Set<string>();
    for (const f of allFiles) {
      const norm = f.replace(/\\/g, "/");
      const parts = norm.split("/");
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i].toLowerCase().includes(lowerQuery)) {
          dirSet.add(parts.slice(0, i + 1).join("/"));
        }
      }
    }
    return Array.from(dirSet).sort().slice(0, maxResults);
  }
}
