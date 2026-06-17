/**
 * JsonFileStorage —— 基于 node:fs 的 SessionStorage 实现
 *
 * 存储位置：~/.axon/sessions/（固定在用户目录，与工作区解耦）。
 * 实现 @axon/core 的 SessionStorage 接口，供 server 与 vscode 扩展（宿主即 Node）共用。
 *
 * 写入安全保障：
 * 1. 原子写入：先写临时文件 → 验证 JSON 完整性 → rename 覆盖目标文件
 * 2. 写锁：同一会话文件的并发写入排队执行，防止交叉覆盖
 * 3. 备份：写入前保留上一版本为 .bak，write 失败可从 .bak 恢复
 */

import { readFile, writeFile, mkdir, readdir, unlink, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { SessionStorage, SessionMeta, SessionData } from "@axon/core";

export class JsonFileStorage implements SessionStorage {
  private baseDir: string;
  /** 每个文件路径一把写锁，防止并发写入交叉 */
  private writeLocks = new Map<string, Promise<void>>();

  /**
   * @param baseStorageDir 会话存储根目录，默认 ~/.axon。与工作区解耦，
   *   避免"还没选工作区时会话存哪"的鸡生蛋问题，也方便桌面端统一管理。
   */
  constructor(baseStorageDir?: string) {
    this.baseDir = join(baseStorageDir || join(homedir(), ".axon"), "sessions");
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
  }

  private sessionPath(id: string): string {
    return join(this.baseDir, `${id}.json`);
  }

  /**
   * 安全写入文件：write-to-temp → validate → rename（原子覆盖）
   * 写入前把旧文件备份为 .bak，write 全程失败时 .bak 仍可手动恢复
   */
  private async safeWrite(filePath: string, data: SessionData): Promise<void> {
    const json = JSON.stringify(data, null, 2);

    try {
      JSON.parse(json);
    } catch (e) {
      throw new Error(`[storage] JSON 序列化验证失败，拒绝写入 ${filePath}: ${(e as Error).message}`);
    }

    const tmpPath = filePath + `.tmp.${Date.now()}`;
    const bakPath = filePath + ".bak";

    await writeFile(tmpPath, json, "utf-8");

    const written = await readFile(tmpPath, "utf-8");
    try {
      JSON.parse(written);
    } catch (e) {
      await unlink(tmpPath).catch(() => {});
      throw new Error(`[storage] 临时文件验证失败，磁盘写入可能不完整: ${(e as Error).message}`);
    }

    try {
      await stat(filePath);
      await rename(filePath, bakPath);
    } catch {
      // 旧文件不存在（新建场景），无需备份
    }

    try {
      await rename(tmpPath, filePath);
    } catch (e) {
      try {
        await rename(bakPath, filePath);
      } catch {
        // 恢复也失败，保持现状
      }
      throw new Error(`[storage] rename 失败: ${(e as Error).message}`);
    }

    await unlink(bakPath).catch(() => {});
  }

  /** 串行化同一文件的写操作，防止并发写入导致数据丢失 */
  private async withWriteLock(filePath: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.writeLocks.get(filePath) || Promise.resolve();
    const current = prev.then(fn, fn);
    this.writeLocks.set(filePath, current);
    try {
      await current;
    } finally {
      if (this.writeLocks.get(filePath) === current) {
        this.writeLocks.delete(filePath);
      }
    }
  }

  async listSessions(): Promise<SessionMeta[]> {
    await this.ensureDir();
    try {
      const files = await readdir(this.baseDir);
      const sessions: SessionMeta[] = [];

      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        if (file.includes(".tmp.") || file.endsWith(".bak")) continue;
        try {
          const raw = await readFile(join(this.baseDir, file), "utf-8");
          const data: SessionData = JSON.parse(raw);
          sessions.push({
            id: data.id,
            title: data.title,
            model: data.model,
            workspace: data.workspace || "",
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            messageCount: data.messages.length,
            mode: data.mode,
          });
        } catch {
          // 跳过损坏的文件
        }
      }

      sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      return sessions;
    } catch {
      return [];
    }
  }

  async getSession(id: string): Promise<SessionData | null> {
    try {
      const raw = await readFile(this.sessionPath(id), "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async createSession(data: Omit<SessionData, "createdAt" | "updatedAt">): Promise<SessionData> {
    await this.ensureDir();
    const now = new Date().toISOString();
    const session: SessionData = {
      ...data,
      id: data.id || randomUUID(),
      workspace: data.workspace || "",
      totalTokens: data.totalTokens || 0,
      createdAt: now,
      updatedAt: now,
    };
    const filePath = this.sessionPath(session.id);
    await this.withWriteLock(filePath, () => this.safeWrite(filePath, session));
    return session;
  }

  async updateSession(
    id: string,
    patch: Partial<Pick<SessionData, "title" | "model" | "provider" | "workspace" | "workspaces" | "workspaceGroupId" | "messages" | "totalTokens" | "pendingEdits">>,
  ): Promise<void> {
    const filePath = this.sessionPath(id);
    await this.withWriteLock(filePath, async () => {
      const session = await this.getSession(id);
      if (!session) return;
      const updated: SessionData = {
        ...session,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      await this.safeWrite(filePath, updated);
    });
  }

  async deleteSession(id: string): Promise<void> {
    const filePath = this.sessionPath(id);
    await this.withWriteLock(filePath, async () => {
      await unlink(filePath).catch(() => {});
      await unlink(filePath + ".bak").catch(() => {});
    });
  }
}
