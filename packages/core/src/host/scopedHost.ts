/**
 * ScopedHost —— 文件作用域隔离 + 回滚快照的 AgentHost 代理
 *
 * 用于并行执行（parallel_execute）的子 Agent：
 * - 作用域隔离：AI 的文件编辑走 EditPresenter.present()，这里包一层 ScopedEditPresenter，
 *   在 present 时校验目标路径是否在 fileScope 内，越界则抛 ScopeViolationError（快速失败）。
 * - 回滚快照：并行子 Agent 默认 auto 落盘，而 auto 模式的 present 不留撤销记录。
 *   ScopedEditPresenter 在每次写入前捕获文件的"改动前快照"（原始内容 / 是否新建），
 *   汇总到外部传入的 snapshotStore，供批次级"一键回滚"使用。
 *
 * 读操作（fs.read/stat/readdir）不受限。
 */

import type { AgentHost } from "./index.js";
import type { EditPresenter, EditMode, FileEdit, FileDiff, UndoResult } from "./edits.js";
import { resolve, relative, sep } from "node:path";

/** 一处文件改动的回滚快照 */
export interface EditSnapshot {
  /** AI 使用的路径（相对/展示路径，与前端文件变更清单一致） */
  path: string;
  /** 绝对路径 */
  absPath: string;
  /** 改动前的原始内容；新建文件时为 null */
  original: string | null;
  /** 是否为新建文件（回滚=删除） */
  isNew: boolean;
}

/**
 * 创建一个带文件作用域隔离 + 回滚快照的 AgentHost。
 * @param snapshotStore 外部传入的快照收集器（key = absPath），执行完由调用方读取
 */
export function createScopedHost(
  parent: AgentHost,
  fileScope: string[],
  cwd: string,
  snapshotStore?: Map<string, EditSnapshot>,
): AgentHost {
  const scopedEdits = new ScopedEditPresenter(parent.edits.fork("auto"), fileScope, cwd, snapshotStore);
  return {
    fs: parent.fs,
    commands: parent.commands,
    diagnostics: parent.diagnostics,
    browser: parent.browser,
    edits: scopedEdits,
    ideContext: parent.ideContext,
  };
}

/** 写操作越界时抛出的错误 */
export class ScopeViolationError extends Error {
  constructor(path: string, fileScope: string[]) {
    super(
      `文件作用域越界：不允许修改 "${path}"。\n` +
      `当前 Agent 的 fileScope 为：${fileScope.join(", ")}\n` +
      `只能修改 fileScope 范围内的文件，其他路径只读。`
    );
    this.name = "ScopeViolationError";
  }
}

/**
 * 判断给定绝对路径是否在 fileScope 范围内（简化 glob：支持 ** / * / 精确路径 / 目录前缀）。
 */
function isPathInScope(absPath: string, fileScope: string[], cwd: string): boolean {
  if (fileScope.length === 0) return true; // 无限制
  const relPath = relative(cwd, absPath).split(sep).join("/");
  const absNorm = absPath.split(sep).join("/");
  for (const pattern of fileScope) {
    const normPattern = pattern.split(sep).join("/");
    if (globMatch(relPath, normPattern) || globMatch(absNorm, normPattern)) return true;
    const dirPrefix = normPattern.replace(/\/\*\*$/, "").replace(/\*\*$/, "").replace(/\/\*$/, "");
    if (dirPrefix && !dirPrefix.includes("*") && (relPath === dirPrefix || relPath.startsWith(dirPrefix + "/"))) return true;
  }
  return false;
}

/** 简化的 glob 匹配器（支持 ** 和 * 通配符） */
function globMatch(path: string, pattern: string): boolean {
  if (path === pattern) return true;
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      regex += ".*";
      i += 2;
      if (pattern[i] === "/") i++;
    } else if (ch === "*") {
      regex += "[^/]*";
      i++;
    } else if (ch === "?") {
      regex += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(ch)) {
      regex += "\\" + ch;
      i++;
    } else {
      regex += ch;
      i++;
    }
  }
  regex += "$";
  try {
    return new RegExp(regex).test(path);
  } catch {
    return false;
  }
}

/**
 * EditPresenter 代理：present 时做作用域校验 + 快照捕获，其余方法透传底层实例。
 */
class ScopedEditPresenter implements EditPresenter {
  constructor(
    private readonly inner: EditPresenter,
    private readonly fileScope: string[],
    private readonly cwd: string,
    private readonly snapshotStore?: Map<string, EditSnapshot>,
  ) {}

  async present(edit: FileEdit): Promise<string> {
    const absPath = resolve(edit.absPath);
    // 作用域校验：越界写入直接拒绝
    if (!isPathInScope(absPath, this.fileScope, this.cwd)) {
      throw new ScopeViolationError(edit.path, this.fileScope);
    }
    // 首次改动该文件时捕获回滚快照（edit.originalContent 已是最初磁盘原始内容）
    if (this.snapshotStore && !this.snapshotStore.has(absPath)) {
      this.snapshotStore.set(absPath, {
        path: edit.path,
        absPath,
        original: edit.isNew ? null : edit.originalContent,
        isNew: edit.isNew,
      });
    }
    return this.inner.present(edit);
  }

  // 以下方法全部透传底层实例
  getMode(): EditMode { return this.inner.getMode(); }
  setMode(mode: EditMode): void { this.inner.setMode(mode); }
  readEffective(absPath: string) { return this.inner.readEffective(absPath); }
  accept(target?: string): Promise<string[]> { return this.inner.accept(target); }
  reject(target?: string): Promise<string[]> { return this.inner.reject(target); }
  getUndoablePaths(): string[] { return this.inner.getUndoablePaths(); }
  getUndoableEditIds(): string[] { return this.inner.getUndoableEditIds(); }
  undo(target: string): Promise<UndoResult> { return this.inner.undo(target); }
  hasPending(): boolean { return this.inner.hasPending(); }
  getPendingPaths(): string[] { return this.inner.getPendingPaths(); }
  getPendingEditIds(): string[] { return this.inner.getPendingEditIds(); }
  getPendingDiffs(): FileDiff[] { return this.inner.getPendingDiffs(); }
  serialize(): FileEdit[] { return this.inner.serialize(); }
  restore(edits: FileEdit[]): void { this.inner.restore(edits); }
  fork(mode: EditMode): EditPresenter { return this.inner.fork(mode); }
}
