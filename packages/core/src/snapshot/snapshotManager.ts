/**
 * SnapshotManager —— 快照系统管理器（门面 + 策略选择）
 *
 * 职责：
 * 1. 自动检测项目是否为 git 仓库，选择对应策略（GitSnapshotter / FsSnapshotter）
 * 2. 对外提供统一的 create / restore / list / remove 接口
 * 3. 按 turn 粒度聚合同一轮内的多次文件修改
 *
 * 使用方式：
 *   const mgr = new SnapshotManager(host, cwd);
 *   await mgr.init();
 *   await mgr.beforeEdit("turn-42", ["/abs/path/to/file.ts"]);
 *   // ... AI 执行写文件操作 ...
 *   await mgr.restore("turn-42");  // 用户点回滚
 */

import { GitSnapshotter } from "./gitSnapshot.js";
import { FsSnapshotter } from "./fsSnapshot.js";
import type { Snapshot, Snapshotter } from "./types.js";
import type { AgentHost } from "../host/index.js";

/** 会触发快照的工具名称 */
export const SNAPSHOT_TOOLS = new Set(["str_replace", "create_file", "apply_patch"]);

/** FIFO 保留上限：超过此值的快照会被自动删除（最旧的先删） */
const MAX_SNAPSHOTS = 30;

export class SnapshotManager {
  private strategy: Snapshotter | null = null;
  /** 已初始化（策略已选定） */
  private initialized = false;

  constructor(
    private host: AgentHost,
    private cwd: string,
  ) {}

  /**
   * 初始化：检测 git 可用性并选择策略。
   * 优先 git，不可用时退化为文件系统快照。
   * 即使两者都失败也不抛错（快照是"尽力而为"的增强功能，不能阻断主流程）。
   */
  async init(): Promise<void> {
    // ① 尝试 Git 策略
    const git = new GitSnapshotter(this.host, this.cwd);
    if (await git.init()) {
      this.strategy = git;
      this.initialized = true;
      console.debug("[snapshot] strategy: git (refs/axon/snapshots/)");
      return;
    }
    // ② 退化：文件系统策略
    const fs = new FsSnapshotter(this.host, this.cwd);
    if (await fs.init()) {
      this.strategy = fs;
      this.initialized = true;
      console.debug("[snapshot] strategy: filesystem (.axon/snapshots/)");
      return;
    }
    // ③ 都不可用：静默降级（不报错，仅打日志）
    console.warn("[snapshot] no strategy available, snapshots disabled");
    this.initialized = true;
  }

  /**
   * 在写文件操作执行前创建快照。
   * 同一轮（相同 id）的多次修改只在第一次时创建快照。
   */
  async beforeEdit(id: string, files: string[]): Promise<boolean> {
    // lazy init：首次调用时才初始化策略（跑 git 检测等），
    // 避免 AgentSession 构造函数触发命令执行弹出终端面板
    if (!this.initialized) {
      this.initialized = true;
      await this.init();
    }
    if (!this.strategy) return false;
    // 同一轮已快照过 → 跳过（不算新创建）
    if (this._snapshotdTurns.has(id)) return false;
    this._snapshotdTurns.add(id);

    const ok = await this.strategy.create(id, files);
    if (!ok) {
      this._snapshotdTurns.delete(id);
      console.warn(`[snapshot] create failed for turn ${id}`);
      return false;
    }
    // FIFO 裁剪：超过上限时删除最旧的快照
    await this.prune();
    return true;
  }
  private _snapshotdTurns = new Set<string>();

  /** FIFO 裁剪：保留最近 MAX_SNAPSHOTS 条，删除多余的旧快照 */
  private async prune(): Promise<void> {
    try {
      const all = await this.strategy!.list();
      if (all.length <= MAX_SNAPSHOTS) return;
      // list 已按 createdAt 倒序（最新在前），尾部是最旧的
      const toRemove = all.slice(MAX_SNAPSHOTS);
      for (const snap of toRemove) {
        await this.strategy!.remove(snap.id).catch(() => {});
        this._snapshotdTurns.delete(snap.id);
      }
      if (toRemove.length > 0) {
        console.debug(`[snapshot] FIFO prune: removed ${toRemove.length} old snapshots, kept ${MAX_SNAPSHOTS}`);
      }
    } catch {
      // 裁剪失败不影响主流程
    }
  }

  /** 回滚到指定快照 */
  async restore(id: string): Promise<boolean> {
    if (!this.initialized) {
      this.initialized = true;
      await this.init();
    }
    if (!this.strategy) return false;
    return this.strategy.restore(id);
  }

  /** 列出所有快照 */
  async list(): Promise<Snapshot[]> {
    if (!this.initialized) {
      this.initialized = true;
      await this.init();
    }
    if (!this.strategy) return [];
    return this.strategy.list();
  }

  /** 删除指定快照 */
  async remove(id: string): Promise<boolean> {
    if (!this.strategy) return false;
    return this.strategy.remove(id);
  }

  /** 当前使用的策略名称 */
  get strategyName(): string {
    return this.strategy?.name ?? "disabled";
  }
}
