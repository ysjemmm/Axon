/**
 * VSCodeFileSystem —— 基于 vscode.workspace.fs 的 HostFileSystem 实现
 *
 * 相比 Node 版的优势：天然支持虚拟文件系统与远程工作区（Remote-SSH / Dev Container /
 * github.dev 等），路径以 Uri 表达。约定与 core 一致：传入【绝对路径字符串】，
 * read/stat 对不存在返回 null。
 */

import * as vscode from "vscode";
import { join, dirname } from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import type { HostFileSystem, DirChild, StatInfo } from "@axon/core";

const td = new TextDecoder("utf-8");
const te = new TextEncoder();

export class VSCodeFileSystem implements HostFileSystem {
  private uri(absPath: string): vscode.Uri {
    return vscode.Uri.file(absPath);
  }

  async read(absPath: string): Promise<string | null> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.uri(absPath));
      return td.decode(bytes);
    } catch {
      return null;
    }
  }

  async write(absPath: string, content: string): Promise<void> {
    const uri = this.uri(absPath);
    // 父目录不存在时显式创建（writeFile 多数实现会自动创建，但显式更稳妥）
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(absPath)));
    } catch {
      /* 已存在或无需创建，忽略 */
    }
    await vscode.workspace.fs.writeFile(uri, te.encode(content));
  }

  /**
   * 追加写。这是本类唯一绕开 vscode.workspace.fs 的方法——因为它没有追加语义，
   * 只有全量 writeFile。用 read + write 模拟追加会退化成 O(n²)：每追加一行都要
   * 把整个文件读进内存再整个写回，日志类文件（session trace 能长到几十 MB）会被
   * 这个模式活活拖死，而且中途失败就是整文件损坏而非丢一行。
   *
   * 代价是失去虚拟文件系统支持。这里可以接受：扩展只声明了 `main` 入口（Node 扩展宿主，
   * 无 web 扩展形态），Remote-SSH / Dev Container 下扩展进程本就跑在目标机上，
   * node:fs 访问到的正是同一个文件系统。若将来要支持 web 扩展，这个方法是唯一的阻塞点。
   */
  async append(absPath: string, content: string): Promise<void> {
    await mkdir(dirname(absPath), { recursive: true });
    await appendFile(absPath, content, "utf-8");
  }

  async stat(absPath: string): Promise<StatInfo | null> {
    try {
      const st = await vscode.workspace.fs.stat(this.uri(absPath));
      return {
        isFile: (st.type & vscode.FileType.File) !== 0,
        isDir: (st.type & vscode.FileType.Directory) !== 0,
      };
    } catch {
      return null;
    }
  }

  async readdir(absPath: string): Promise<DirChild[]> {
    const entries = await vscode.workspace.fs.readDirectory(this.uri(absPath));
    return entries.map(([name, type]) => ({
      name,
      path: join(absPath, name),
      isFile: (type & vscode.FileType.File) !== 0,
      isDir: (type & vscode.FileType.Directory) !== 0,
    }));
  }

  async mkdirp(absPath: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.uri(absPath));
  }

  async remove(absPath: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.uri(absPath), { recursive: true, useTrash: false });
    } catch {
      /* 不存在视为成功 */
    }
  }
}
