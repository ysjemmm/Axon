/**
 * VSCodeFileSystem —— 基于 vscode.workspace.fs 的 HostFileSystem 实现
 *
 * 相比 Node 版的优势：天然支持虚拟文件系统与远程工作区（Remote-SSH / Dev Container /
 * github.dev 等），路径以 Uri 表达。约定与 core 一致：传入【绝对路径字符串】，
 * read/stat 对不存在返回 null。
 */

import * as vscode from "vscode";
import { join, dirname } from "node:path";
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
