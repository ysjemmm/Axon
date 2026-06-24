/**
 * Git 快照策略
 *
 * 使用 refs/axon/snapshots/{id} 命名空间存储快照：
 * - 不出现在 git tag / git stash / git branch 列表中（对用户完全不可见）
 * - 是正常 ref，不会被 git gc 回收
 * - 回滚用 git checkout <ref> -- . （只恢复文件，不切分支）
 * - 用户即使在终端手动操作也不会意外删除
 *
 * 原理：git stash create 会创建悬空 commit（dangling commit），但它不会出现在
 * git stash list 中。但 stash 有被用户误删风险。使用自定义 ref 命名空间更安全——
 * git update-ref refs/axon/snapshots/{id} <tree-ish> 创建的 ref 对用户完全透明。
 */

import type { Snapshot, Snapshotter } from "./types.js";
import type { AgentHost } from "../host/index.js";

const REF_PREFIX = "refs/axon/snapshots/";

export class GitSnapshotter implements Snapshotter {
  readonly name = "git";
  private host: AgentHost;
  private cwd: string;
  private available = false;

  constructor(host: AgentHost, cwd: string) {
    this.host = host;
    this.cwd = cwd;
  }

  async init(): Promise<boolean> {
    try {
      const r = await this.host.commands.exec("git rev-parse --is-inside-work-tree", {
        cwd: this.cwd,
        timeoutMs: 3000,
      });
      this.available = r.exitCode === 0 && r.stdout.trim() === "true";
    } catch {
      this.available = false;
    }
    return this.available;
  }

  async create(id: string, _files: string[]): Promise<boolean> {
    if (!this.available) return false;
    try {
      const refName = `${REF_PREFIX}${id}`;

      // git stash create 会创建一个包含当前工作区完整状态的悬空 commit
      // （包括未 staged 的修改和未 tracked 的文件），不修改 index、不弹 stash、不切分支。
      // 然后存到 refs/axon/snapshots/{id} 命名空间。
      // 这比 git add -A + write-tree 更可靠——后者只记录 index 状态，
      // 如果 index 是干净的就会丢失未 staged 的改动。
      const stashResult = await this.host.commands.exec(
        "git stash create",
        { cwd: this.cwd, timeoutMs: 8000 },
      );
      let commitHash: string;

      if (stashResult.exitCode === 0 && stashResult.stdout.trim()) {
        // stash create 返回了 commit hash（有改动时）
        commitHash = stashResult.stdout.trim();
      } else {
        // 没有改动（工作区干净）→ 用当前 HEAD 作为快照
        const headResult = await this.host.commands.exec(
          "git rev-parse HEAD",
          { cwd: this.cwd, timeoutMs: 3000 },
        );
        if (headResult.exitCode !== 0) return false;
        commitHash = headResult.stdout.trim();
      }

      // 存到自定义 ref 命名空间
      const updateResult = await this.host.commands.exec(
        `git update-ref ${refName} ${commitHash}`,
        { cwd: this.cwd, timeoutMs: 3000 },
      );
      return updateResult.exitCode === 0;
    } catch {
      return false;
    }
  }

  async restore(id: string): Promise<boolean> {
    if (!this.available) return false;
    try {
      const refName = `${REF_PREFIX}${id}`;
      // 验证 ref 存在
      const verify = await this.host.commands.exec(
        `git rev-parse --verify ${refName}`,
        { cwd: this.cwd, timeoutMs: 3000 },
      );
      if (verify.exitCode !== 0) return false;

      // 从快照 commit 恢复文件到工作区
      // git checkout <commit> -- . 将 index 和工作区都恢复到该 commit 的文件状态
      const checkout = await this.host.commands.exec(
        `git checkout ${refName} -- .`,
        { cwd: this.cwd, timeoutMs: 10000 },
      );
      return checkout.exitCode === 0;
    } catch {
      return false;
    }
  }

  async list(): Promise<Snapshot[]> {
    if (!this.available) return [];
    try {
      const r = await this.host.commands.exec(
        `git for-each-ref --format="%(refname:short) %(creatordate:unix)" ${REF_PREFIX}`,
        { cwd: this.cwd, timeoutMs: 3000 },
      );
      if (r.exitCode !== 0) return [];
      const snapshots: Snapshot[] = [];
      for (const line of r.stdout.trim().split("\n").filter(Boolean)) {
        const [refPath, timestamp] = line.trim().split(/\s+/);
        const id = refPath.replace("axon/snapshots/", "");
        const createdAt = parseInt(timestamp, 10) || Date.now();
        snapshots.push({ id, createdAt, label: `Git 快照 ${id}`, files: [] });
      }
      return snapshots.sort((a, b) => b.createdAt - a.createdAt);
    } catch {
      return [];
    }
  }

  async remove(id: string): Promise<boolean> {
    if (!this.available) return false;
    try {
      const r = await this.host.commands.exec(
        `git update-ref -d ${REF_PREFIX}${id}`,
        { cwd: this.cwd, timeoutMs: 3000 },
      );
      return r.exitCode === 0;
    } catch {
      return false;
    }
  }
}
