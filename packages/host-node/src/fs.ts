/**
 * NodeFileSystem —— 基于 node:fs/promises 的 HostFileSystem 实现
 *
 * 约定：所有路径均为已解析的绝对路径（多工作区解析在 core 内完成）。
 * read/stat 对“不存在”返回 null（把缺失从异常路径变成正常返回值）。
 */

import { readFile, writeFile, mkdir, readdir, stat, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostFileSystem, DirChild, StatInfo } from "@axon/core";

export class NodeFileSystem implements HostFileSystem {
  async read(absPath: string): Promise<string | null> {
    try {
      return await readFile(absPath, "utf-8");
    } catch {
      return null;
    }
  }

  async write(absPath: string, content: string): Promise<void> {
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, "utf-8");
  }

  async stat(absPath: string): Promise<StatInfo | null> {
    try {
      const st = await stat(absPath);
      return { isFile: st.isFile(), isDir: st.isDirectory() };
    } catch {
      return null;
    }
  }

  async readdir(absPath: string): Promise<DirChild[]> {
    const items = await readdir(absPath, { withFileTypes: true });
    return items.map((it) => ({
      name: it.name,
      path: join(absPath, it.name),
      isFile: it.isFile(),
      isDir: it.isDirectory(),
    }));
  }

  async mkdirp(absPath: string): Promise<void> {
    await mkdir(absPath, { recursive: true });
  }

  async remove(absPath: string): Promise<void> {
    await rm(absPath, { recursive: true, force: true });
  }
}
