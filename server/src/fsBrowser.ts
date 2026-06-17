/**
 * 文件系统目录浏览服务
 *
 * 为前端"目录选择器"提供逐层下钻能力（列盘符、列子目录）。
 * 抽象成 DirectoryBrowser 接口，便于将来迁移到桌面端（Electron/Tauri
 * 可替换为原生对话框实现），前端只依赖此契约的返回结构。
 */

import { readdir, stat } from "node:fs/promises";
import { join, parse, sep } from "node:path";
import { platform } from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** 目录项 */
export interface DirEntry {
  name: string;
  path: string; // 绝对路径
}

/** 浏览结果 */
export interface BrowseResult {
  /** 当前所在路径（盘符根列表时为空字符串） */
  current: string;
  /** 上级目录路径（已在盘符列表层时为 null） */
  parent: string | null;
  /** 是否为盘符根列表（Windows 顶层） */
  isRoot: boolean;
  /** 子目录列表 */
  entries: DirEntry[];
}

/** 浏览能力契约：桌面端可提供原生实现替换之 */
export interface DirectoryBrowser {
  browse(path?: string): Promise<BrowseResult>;
  isValidDir(path: string): Promise<boolean>;
}

/** 基于 Node fs 的实现（Web + 后端 Node 架构） */
export class NodeDirectoryBrowser implements DirectoryBrowser {
  /** 列出 Windows 盘符（C:\、D:\ ...） */
  private async listWindowsDrives(): Promise<DirEntry[]> {
    try {
      // 用 wmic 获取盘符；失败则退回探测常见盘符
      const { stdout } = await execAsync("wmic logicaldisk get name", { timeout: 5000 });
      const drives = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^[A-Za-z]:$/.test(l))
        .map((d) => ({ name: d, path: `${d}${sep}` }));
      if (drives.length > 0) return drives;
    } catch {
      // 忽略，走兜底
    }
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

  /** 列出指定目录下的子目录（仅目录，跳过无权限项） */
  private async listSubDirs(dirPath: string): Promise<DirEntry[]> {
    const items = await readdir(dirPath, { withFileTypes: true });
    const dirs: DirEntry[] = [];
    for (const item of items) {
      if (!item.isDirectory()) continue;
      // 跳过明显的隐藏/系统目录（以 . 开头的保留，用户项目常用；仅跳过 $ 开头的系统卷目录）
      if (item.name.startsWith("$")) continue;
      dirs.push({ name: item.name, path: join(dirPath, item.name) });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    return dirs;
  }

  async browse(path?: string): Promise<BrowseResult> {
    const isWindows = platform() === "win32";

    // 无路径：Windows 返回盘符列表；非 Windows 从根 / 开始
    if (!path) {
      if (isWindows) {
        return { current: "", parent: null, isRoot: true, entries: await this.listWindowsDrives() };
      }
      return { current: "/", parent: null, isRoot: false, entries: await this.listSubDirs("/") };
    }

    // 校验目录
    const st = await stat(path);
    if (!st.isDirectory()) {
      throw new Error(`不是目录: ${path}`);
    }

    const entries = await this.listSubDirs(path);

    // 计算上级目录
    let parent: string | null;
    const parsed = parse(path);
    if (parsed.dir === path || parsed.root === path) {
      // 已在盘符根（如 C:\）：上级回到盘符列表（Windows）或 null
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

/** 默认单例 */
export const directoryBrowser: DirectoryBrowser = new NodeDirectoryBrowser();
