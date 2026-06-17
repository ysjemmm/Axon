/**
 * NodeDirectoryBrowser —— 基于 node:fs 的 DirectoryBrowser 实现
 *
 * 迁移自 fsBrowser.ts：列盘符（Windows）/ 列子目录，供前端目录选择器逐层下钻。
 * 接口契约与原 fsBrowser.BrowseResult 完全一致，前端无需改动。
 */

import { readdir, stat } from "node:fs/promises";
import { join, parse, sep } from "node:path";
import { platform } from "node:os";
import { exec } from "node:child_process";
import type { DirectoryBrowser, BrowseResult, DirEntry } from "@axon/core";

export class NodeDirectoryBrowser implements DirectoryBrowser {
  /** 列出 Windows 盘符（C:\、D:\ ...） */
  private async listWindowsDrives(): Promise<DirEntry[]> {
    const fromWmic = await new Promise<DirEntry[]>((resolve) => {
      exec("wmic logicaldisk get name", { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve([]);
        const drives = (stdout || "")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /^[A-Za-z]:$/.test(l))
          .map((d) => ({ name: d, path: `${d}${sep}` }));
        resolve(drives);
      });
    });
    if (fromWmic.length > 0) return fromWmic;

    // 兜底：探测 A-Z 哪些盘可访问
    const result: DirEntry[] = [];
    for (let c = 67; c <= 90; c++) {
      const letter = String.fromCharCode(c);
      const root = `${letter}:${sep}`;
      try {
        await readdir(root);
        result.push({ name: `${letter}:`, path: root });
      } catch {
        // 盘不存在/不可访问，跳过
      }
    }
    return result;
  }

  /** 列出指定目录下的子目录（仅目录，跳过系统卷目录） */
  private async listSubDirs(dirPath: string): Promise<DirEntry[]> {
    const items = await readdir(dirPath, { withFileTypes: true });
    const dirs: DirEntry[] = [];
    for (const item of items) {
      if (!item.isDirectory()) continue;
      if (item.name.startsWith("$")) continue;
      dirs.push({ name: item.name, path: join(dirPath, item.name) });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    return dirs;
  }

  async browse(path?: string): Promise<BrowseResult> {
    const isWindows = platform() === "win32";

    if (!path) {
      if (isWindows) {
        return { current: "", parent: null, isRoot: true, entries: await this.listWindowsDrives() };
      }
      return { current: "/", parent: null, isRoot: false, entries: await this.listSubDirs("/") };
    }

    const st = await stat(path);
    if (!st.isDirectory()) throw new Error(`不是目录: ${path}`);

    const entries = await this.listSubDirs(path);

    let parent: string | null;
    const parsed = parse(path);
    if (parsed.dir === path || parsed.root === path) {
      parent = isWindows ? "" : null;
    } else {
      parent = parsed.dir;
    }

    return { current: path, parent, isRoot: false, entries };
  }

  async isValidDir(path: string): Promise<boolean> {
    try {
      const st = await stat(path);
      return st.isDirectory();
    } catch {
      return false;
    }
  }
}
