/**
 * 文件系统快照策略（非 Git 项目）
 *
 * 在 .axon/snapshots/{id}/ 下存储被修改文件的原始内容副本。
 * 只备份即将被修改的文件（增量），不全量复制项目。
 * 回滚时逐文件恢复。
 */

import { join, relative } from "node:path";
import type { Snapshot, Snapshotter } from "./types.js";
import type { AgentHost } from "../host/index.js";

const SNAPSHOTS_DIR = ".axon/snapshots";

export class FsSnapshotter implements Snapshotter {
  readonly name = "fs";
  private host: AgentHost;
  private cwd: string;
  private snapshotsDir: string;

  constructor(host: AgentHost, cwd: string) {
    this.host = host;
    this.cwd = cwd;
    this.snapshotsDir = join(cwd, SNAPSHOTS_DIR);
  }

  async init(): Promise<boolean> {
    try {
      await this.host.fs.mkdirp(this.snapshotsDir);
      return true;
    } catch {
      return false;
    }
  }

  async create(id: string, files: string[]): Promise<boolean> {
    try {
      const snapshotDir = join(this.snapshotsDir, id);
      await this.host.fs.mkdirp(snapshotDir);

      for (const absPath of files) {
        const content = await this.host.fs.read(absPath);
        const relPath = relative(this.cwd, absPath);
        const backupPath = join(snapshotDir, relPath);

        if (content !== null) {
          // 文件已存在：备份原始内容
          const backupDir = join(backupPath, "..");
          await this.host.fs.mkdirp(backupDir);
          await this.host.fs.write(backupPath, content);
        } else {
          // 文件不存在（新建文件）：写一个标记文件表示原本不存在
          const markerPath = join(snapshotDir, "__new__", relPath);
          const markerDir = join(markerPath, "..");
          await this.host.fs.mkdirp(markerDir);
          await this.host.fs.write(markerPath, "");
        }
      }
      // 写元数据
      await this.host.fs.write(
        join(snapshotDir, "__meta.json"),
        JSON.stringify({ id, createdAt: Date.now(), files: files.map((f) => relative(this.cwd, f)) }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async restore(id: string): Promise<boolean> {
    try {
      const snapshotDir = join(this.snapshotsDir, id);
      const metaRaw = await this.host.fs.read(join(snapshotDir, "__meta.json"));
      if (!metaRaw) return false;

      const meta = JSON.parse(metaRaw) as { files: string[] };
      for (const relPath of meta.files) {
        const absPath = join(this.cwd, relPath);
        const backupPath = join(snapshotDir, relPath);
        const newMarkerPath = join(snapshotDir, "__new__", relPath);

        const backup = await this.host.fs.read(backupPath);
        if (backup !== null) {
          // 文件在快照前已存在 → 恢复原始内容
          await this.host.fs.write(absPath, backup);
        } else {
          // 文件在快照前不存在（新建文件）→ 删除
          const newMarker = await this.host.fs.read(newMarkerPath);
          if (newMarker !== null) {
            await this.host.fs.remove(absPath);
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<Snapshot[]> {
    try {
      const entries = await this.host.fs.readdir(this.snapshotsDir);
      const snapshots: Snapshot[] = [];
      for (const entry of entries) {
        if (!entry.isDir) continue;
        const metaRaw = await this.host.fs.read(join(entry.path, "__meta.json"));
        if (!metaRaw) continue;
        try {
          const meta = JSON.parse(metaRaw) as { id: string; createdAt: number; files: string[] };
          snapshots.push({
            id: meta.id,
            createdAt: meta.createdAt,
            label: `文件快照 ${meta.id}`,
            files: meta.files,
          });
        } catch { /* 损坏的元数据跳过 */ }
      }
      return snapshots.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      return [];
    }
  }

  async remove(id: string): Promise<boolean> {
    try {
      await this.host.fs.remove(join(this.snapshotsDir, id));
      return true;
    } catch {
      return false;
    }
  }
}
