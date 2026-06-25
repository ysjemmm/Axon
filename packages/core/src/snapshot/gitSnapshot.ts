/**
 * Git 快照策略
 *
 * 使用 refs/axon/snapshots/{id} 命名空间存储快照：
 * - 不出现在 git tag / git stash / git branch 列表中（对用户完全不可见）
 * - 是正常 ref，不会被 git gc 回收
 * - 回滚用 git checkout <ref> -- . （只恢复文件，不切分支）
 * - 用户即使在终端手动操作也不会意外删除
 *
 * 所有 git 命令通过 child_process 直接执行（绕过终端），
 * 避免终端 ANSI 污染 / Shell Integration 不可靠 / 弹窗干扰用户。
 */

import type { Snapshot, Snapshotter } from "./types.js";
import type { AgentHost } from "../host/index.js";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const REF_PREFIX = "refs/axon/snapshots/";

/** 从 "turn-10" 中提取数字 10，无法解析返回 0 */
function turnNum(id: string): number {
  const m = id.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * 直接用 child_process 执行 git 命令（绕过终端捕获）。
 * 快照是内部操作，不应弹出终端窗口干扰用户，也不依赖 Shell Integration 的输出捕获。
 * 返回 [stdout, exitCode]。
 */
async function gitDirect(cwd: string, args: string[], timeoutMs = 8000): Promise<[string, number]> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    return [stdout.trim(), 0];
  } catch (e: any) {
    // git 命令失败时 stdout 可能在 e.stdout 里（例如 stash create 有改动时 stderr 有 warning）
    const out = (e.stdout || "").trim();
    if (e.code === "ENOENT") return ["", -1]; // git 不存在
    return [out, e.code ?? 1];
  }
}

export class GitSnapshotter implements Snapshotter {
  readonly name = "git";
  private cwd: string;
  private available = false;

  constructor(_host: AgentHost, cwd: string) {
    this.cwd = cwd;
  }

  async init(): Promise<boolean> {
    try {
      const [out, code] = await gitDirect(this.cwd, ["rev-parse", "--is-inside-work-tree"], 3000);
      this.available = code === 0 && out === "true";
    } catch {
      this.available = false;
    }
    console.log(`[snapshot] init: cwd=${this.cwd} available=${this.available}`);
    return this.available;
  }

  async create(id: string, _files: string[]): Promise<boolean> {
    if (!this.available) return false;
    try {
      // git stash create：创建包含当前工作区完整状态的悬空 commit
      // （包括未 staged 的修改和未 tracked 的文件），不修改 index、不弹 stash、不切分支。
      const [stashOut, stashCode] = await gitDirect(this.cwd, ["stash", "create"], 8000);
      let commitHash: string;

      if (stashCode === 0 && stashOut) {
        commitHash = stashOut;
      } else {
        // 工作区干净 → 用当前 HEAD
        const [headOut, headCode] = await gitDirect(this.cwd, ["rev-parse", "HEAD"], 3000);
        if (headCode !== 0) return false;
        commitHash = headOut;
      }

      const [, updateCode] = await gitDirect(
        this.cwd,
        ["update-ref", `${REF_PREFIX}${id}`, commitHash],
        3000,
      );
      console.log(`[snapshot] create ${id}: cwd=${this.cwd} hash=${commitHash} ok=${updateCode === 0}`);
      return updateCode === 0;
    } catch {
      return false;
    }
  }

  async restore(id: string): Promise<boolean> {
    if (!this.available) return false;
    try {
      const refName = `${REF_PREFIX}${id}`;
      const [, verifyCode] = await gitDirect(this.cwd, ["rev-parse", "--verify", refName], 3000);
      if (verifyCode !== 0) return false;
      const [, checkoutCode] = await gitDirect(this.cwd, ["checkout", refName, "--", "."], 15000);
      console.log(`[snapshot] restore ${id}: ok=${checkoutCode === 0}`);
      return checkoutCode === 0;
    } catch {
      return false;
    }
  }

  async list(): Promise<Snapshot[]> {
    if (!this.available) return [];
    try {
      const [out, code] = await gitDirect(
        this.cwd,
        ["for-each-ref", "--format=%(refname:short) %(creatordate:unix)", REF_PREFIX],
        3000,
      );
      if (code !== 0) return [];
      const snapshots: Snapshot[] = [];
      for (const line of out.split("\n").filter(Boolean)) {
        const [refPath, timestamp] = line.trim().split(/\s+/);
        const id = refPath.replace("axon/snapshots/", "");
        const createdAt = parseInt(timestamp, 10) || 0;
        snapshots.push({ id, createdAt, label: `Git 快照 ${id}`, files: [] });
      }
      snapshots.sort((a, b) => {
        if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
        return turnNum(b.id) - turnNum(a.id);
      });
      console.log(`[snapshot] list: cwd=${this.cwd} count=${snapshots.length}`);
      return snapshots;
    } catch {
      return [];
    }
  }

  async remove(id: string): Promise<boolean> {
    if (!this.available) return false;
    try {
      const [, code] = await gitDirect(this.cwd, ["update-ref", "-d", `${REF_PREFIX}${id}`], 3000);
      return code === 0;
    } catch {
      return false;
    }
  }
}
