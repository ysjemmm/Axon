/**
 * VSCodeDirectoryBrowser —— 基于 vscode.workspace.fs 的 DirectoryBrowser 实现
 *
 * 供目录选择器逐层下钻。用 workspace.fs 列子目录（支持远程/虚拟 fs）；
 * 列盘符（Windows 顶层）仍需本机能力，扩展宿主是 Node 环境，故用 node:os/child 兜底探测。
 */

import * as vscode from "vscode";
import { join, parse, sep } from "node:path";
import { platform } from "node:os";
import type { DirectoryBrowser, BrowseResult, DirEntry } from "@axon/core";

export class VSCodeDirectoryBrowser implements DirectoryBrowser {
  /** 探测可访问的 Windows 盘符（扩展宿主在本机时有效） */
  private async listWindowsDrives(): Promise<DirEntry[]> {
    const result: DirEntry[] = [];
    for (let c = 67; c <= 90; c++) {
      const letter = String.fromCharCode(c);
      const root = `${letter}:${sep}`;
      try {
        await vscode.workspace.fs.readDirectory(vscode.Uri.file(root));
        result.push({ name: `${letter}:`, path: root });
      } catch {
        /* 盘不存在/不可访问 */
      }
    }
    return result;
  }

  private async listSubDirs(dirPath: string): Promise<DirEntry[]> {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
    const dirs: DirEntry[] = [];
    for (const [name, type] of entries) {
      if ((type & vscode.FileType.Directory) === 0) continue;
      if (name.startsWith("$")) continue;
      dirs.push({ name, path: join(dirPath, name) });
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

    const st = await vscode.workspace.fs.stat(vscode.Uri.file(path));
    if ((st.type & vscode.FileType.Directory) === 0) throw new Error(`不是目录: ${path}`);

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
      const st = await vscode.workspace.fs.stat(vscode.Uri.file(path));
      return (st.type & vscode.FileType.Directory) !== 0;
    } catch {
      return false;
    }
  }
}
