/**
 * Cowork 附件快照 —— 用户文件被 AI 改写前的原稿副本
 *
 * ── 为什么 Cowork 需要独立的快照，不复用 FsSnapshotter ──
 * FsSnapshotter 备份的是「工作区里即将被编辑的代码」，落在 <cwd>/.axon/snapshots，
 * 用 host.fs.read/write 的文本接口。Cowork 的对象是用户桌面上可能位于任何位置的
 * Office 文档（xlsx/docx/pdf），是二进制 —— 文本接口会把它们整个毁掉。
 * 而且办公文件不该在工作区里留 .axon 目录。
 *
 * 所以这里：
 * - 存放位置：~/.axon/cowork-snapshots/<sessionId>/<轮次>/（用户目录，与工作区解耦）
 * - 复制方式：二进制安全（readBinary/writeBinary，见 host.fs 扩展接口）
 * - 触发时机：Cowork 轮开始时，对本轮附件中【即将被改写】的文件做副本；
 *   纯读取、另存新文件的任务不会产生快照，不浪费磁盘
 *
 * 快照用途有两个：查看改动（原稿 vs 现文件对比）、一键恢复原稿。
 * 对办公用户这就是 Code 侧 diff/回滚 的等价物 —— 他们不敢用 AI 的核心顾虑
 * 不是"AI 改不好"，而是"改坏了怎么办"。
 */

import { join } from "node:path";
import type { AgentHost, HostFileSystem } from "../host/index.js";

/** 快照目录名（挂在用户 .axon 下，与会话存储同级） */
const COWORK_SNAPSHOTS_DIR = "cowork-snapshots";

/**
 * 路径 → 快照文件名：把所有文件系统保留字符替换掉。
 *
 * 只替换 \ 和 / 不够 —— Windows 绝对路径带盘符冒号（C:\Users\...），
 * 冒号是 NTFS 保留字符，写文件会静默失败或落到交替数据流里。
 * 统一替换所有平台保留字符（: * ? " < > |），保证任何路径都能安全落盘。
 */
function snapshotFileName(absPath: string): string {
  return absPath.replace(/[\\/:*?"<>|]+/g, "__");
}

export interface CoworkSnapshotResult {
  /** 成功建立快照的文件绝对路径 */
  snapshotPaths: string[];
  /** 快照根目录（一次轮的所有快照都在这里） */
  snapshotDir: string;
}

export class CoworkSnapshotter {
  /** 归属会话 id（幂等判断用：同一会话重复 enable 不重建） */
  readonly sessionId: string;

  constructor(
    private readonly host: AgentHost,
    private readonly homeDir: string,
    sessionId: string,
  ) {
    this.sessionId = sessionId;
  }

  /** 本轮快照根目录：~/.axon/cowork-snapshots/<sessionId>/<turnId>/ */
  dirFor(turnId: string): string {
    return join(this.homeDir, ".axon", COWORK_SNAPSHOTS_DIR, this.sessionId, turnId);
  }

  /**
   * 为一批文件建立原稿快照。
   *
   * - 文件不存在 → 跳过（没东西可备份；新建文件场景由「产出是 created」表达）
   * - 复制失败 → 跳过并继续（快照是保障能力，不能因为它失败把整个任务拦住）
   *
   * 返回真正完成快照的路径列表；全失败时返回空数组，调用方据此不标记「可恢复」。
   */
  async snapshot(turnId: string, filePaths: string[]): Promise<CoworkSnapshotResult> {
    const dir = this.dirFor(turnId);
    const done: string[] = [];
    if (!this.homeDir) return { snapshotPaths: done, snapshotDir: dir };
    const fs = this.host.fs as HostFileSystem;
    if (!fs.readBinary || !fs.writeBinary) return { snapshotPaths: done, snapshotDir: dir };
    try {
      await this.host.fs.mkdirp(dir);
    } catch {
      return { snapshotPaths: done, snapshotDir: dir };
    }
    for (const absPath of filePaths) {
      try {
        const bytes = await fs.readBinary(absPath);
        if (!bytes || bytes.length === 0) continue;
        const name = snapshotFileName(absPath);
        await fs.writeBinary(join(dir, name), bytes);
        done.push(absPath);
      } catch {
        // 单个文件失败不影响其他文件
      }
    }
    return { snapshotPaths: done, snapshotDir: dir };
  }

  /** 读取某轮某文件的原稿；没有快照返回 null */
  async readOriginal(snapshotDir: string, absPath: string): Promise<Uint8Array | null> {
    try {
      const fs = this.host.fs as HostFileSystem;
      if (!fs.readBinary) return null;
      return await fs.readBinary(join(snapshotDir, snapshotFileName(absPath)));
    } catch {
      return null;
    }
  }

  /** 用原稿覆盖现文件；成功返回 true */
  async restore(snapshotDir: string, absPath: string): Promise<boolean> {
    try {
      const bytes = await this.readOriginal(snapshotDir, absPath);
      if (!bytes) return false;
      const fs = this.host.fs as HostFileSystem;
      if (!fs.writeBinary) return false;
      await fs.writeBinary(absPath, bytes);
      return true;
    } catch {
      return false;
    }
  }
}
