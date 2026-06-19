/**
 * VSCodeEditPresenter —— EditPresenter 实现（编辑单元制）
 *
 * 与 NodeEditPresenter 同构，落盘走 vscode.workspace.fs，并保留原生 diff 呈现器。
 * 暂存区以「编辑单元」（editId = `${toolCallId}::${path}`）为最小管理单元：
 *   - 同一文件多次工具调用 → 多个独立单元，可逐次接受/拒绝/撤销
 *   - 所有 present 立即写盘（磁盘 = 全部单元叠加的最新态）
 *   - reject / undo 用上下文指纹反向【该单元】的 hunk；定位歧义/重叠时保守失败
 *
 * target 匹配：editId（精确）或 path/absPath（整文件）。整文件/全部操作按新→旧逆序反向。
 */

import * as vscode from "vscode";
import { dirname } from "node:path";
import type { EditPresenter, EditMode, FileEdit, FileDiff, UndoableEdit, UndoResult } from "@axon/core";
import { reverseApplyHunks } from "@axon/core";
import { PendingDiffPresenter } from "./pendingDiff.js";

const td = new TextDecoder("utf-8");
const te = new TextEncoder();

export class VSCodeEditPresenter implements EditPresenter {
  private mode: EditMode = "manual";
  /** key 为 editId（缺省回退 absPath）。Map 保留插入顺序 = 改动先后 */
  private pending = new Map<string, FileEdit>();
  /** 已接受、可撤销的改动（key 为 editId） */
  private accepted = new Map<string, UndoableEdit>();
  /** 文件级原始快照（absPath → AI 首次改动前的内容/是否存在），用于「整文件撤销」永远安全回退 */
  private fileOriginals = new Map<string, { content: string; existed: boolean }>();
  /** 本 presenter 最近一次写入各文件的内容（删除用 null），整文件撤销前用于检测外部改动 */
  private lastWritten = new Map<string, string | null>();
  private diff: PendingDiffPresenter | null = null;
  private useNativeDiff = true;

  getMode(): EditMode { return this.mode; }
  setMode(mode: EditMode): void { this.mode = mode; }
  disableNativeDiff(): void { this.useNativeDiff = false; }

  private keyOf(edit: { editId?: string; absPath: string }): string {
    return edit.editId || edit.absPath;
  }

  /** 该文件最新的待确认单元内容（diff 呈现器回查用） */
  private latestPendingContent(absPath: string): string | null {
    let latest: string | null = null;
    for (const e of this.pending.values()) if (e.absPath === absPath) latest = e.newContent;
    return latest;
  }

  private ensureDiff(): PendingDiffPresenter {
    if (!this.diff) {
      this.diff = new PendingDiffPresenter((absPath) => this.latestPendingContent(absPath));
    }
    return this.diff;
  }

  /** 该文件是否还有待确认单元；没有则关闭原生 diff 视图 */
  private closeDiffIfNoneLeft(absPath: string): void {
    const stillPending = [...this.pending.values()].some((e) => e.absPath === absPath);
    if (!stillPending) this.diff?.close(absPath);
  }

  private async writeDisk(absPath: string, content: string): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirname(absPath)));
    } catch { /* 已存在忽略 */ }
    await vscode.workspace.fs.writeFile(vscode.Uri.file(absPath), te.encode(content));
  }

  private async readDisk(absPath: string): Promise<string | null> {
    try {
      return td.decode(await vscode.workspace.fs.readFile(vscode.Uri.file(absPath)));
    } catch {
      return null;
    }
  }

  async present(edit: FileEdit): Promise<string> {
    if (this.mode === "auto") {
      const thisFull = !edit.hunks || edit.hunks.length === 0;
      // 记录文件级原始快照（首次改动该文件时），用于整文件安全回退
      if (!this.fileOriginals.has(edit.absPath)) {
        this.fileOriginals.set(edit.absPath, { content: edit.originalContent, existed: !edit.isNew });
      }
      await this.writeDisk(edit.absPath, edit.newContent);
      this.lastWritten.set(edit.absPath, edit.newContent);
      // auto = 自动确认的 manual：落盘后直接记为「已接受、可撤销」，使 auto 改动同样支持撤销。
      // 同一文件多次工具调用按 editId 聚合 hunks（与 manual accept 语义一致）。
      const key = this.keyOf(edit);
      const existing = this.accepted.get(key);
      this.accepted.set(key, {
        path: edit.path,
        absPath: edit.absPath,
        editId: edit.editId || key,
        isCreate: (existing?.isCreate ?? false) || thisFull,
        isNew: existing ? existing.isNew : edit.isNew,
        originalContent: existing ? existing.originalContent : edit.originalContent,
        hunks: [...(existing?.hunks ?? []), ...((thisFull ? [] : edit.hunks) ?? [])],
        acceptedAt: Date.now(),
      });
      return "";
    }
    const key = this.keyOf(edit);
    const existing = this.pending.get(key);
    const thisFull = !edit.hunks || edit.hunks.length === 0;
    if (!this.fileOriginals.has(edit.absPath)) {
      this.fileOriginals.set(edit.absPath, { content: edit.originalContent, existed: !edit.isNew });
    }
    this.pending.set(key, {
      path: edit.path,
      absPath: edit.absPath,
      editId: edit.editId,
      originalContent: existing ? existing.originalContent : edit.originalContent,
      newContent: edit.newContent,
      isNew: existing ? existing.isNew : edit.isNew,
      hunks: [...(existing?.hunks ?? []), ...(edit.hunks ?? [])],
      fullRewrite: (existing?.fullRewrite ?? false) || thisFull,
    });
    await this.writeDisk(edit.absPath, edit.newContent);
    this.lastWritten.set(edit.absPath, edit.newContent);
    return "（改动已写入磁盘并标记为待确认。你可以正常测试此文件。用户拒绝时会自动回滚。）";
  }

  async readEffective(absPath: string): Promise<{ content: string; fromPending: boolean; existsOnDisk: boolean }> {
    const latest = this.latestPendingContent(absPath);
    if (latest !== null) {
      const isNew = [...this.pending.values()].some((e) => e.absPath === absPath && e.isNew);
      return { content: latest, fromPending: true, existsOnDisk: !isNew };
    }
    const disk = await this.readDisk(absPath);
    if (disk === null) return { content: "", fromPending: false, existsOnDisk: false };
    return { content: disk, fromPending: false, existsOnDisk: true };
  }

  private matchPending(target?: string): [string, FileEdit][] {
    const all = [...this.pending.entries()];
    if (!target) return all;
    return all.filter(([key, e]) => key === target || e.editId === target || e.path === target || e.absPath === target);
  }

  async accept(target?: string): Promise<string[]> {
    const targets = this.matchPending(target);
    const accepted: string[] = [];
    for (const [key, edit] of targets) {
      // 不重写磁盘：present 时已落盘，磁盘已是全部单元叠加的最新态（避免覆盖其它单元改动）
      this.pending.delete(key);
      this.accepted.set(key, {
        path: edit.path,
        absPath: edit.absPath,
        editId: edit.editId || key,
        isCreate: edit.fullRewrite ?? false,
        isNew: edit.isNew,
        originalContent: edit.originalContent,
        hunks: (edit.fullRewrite ? [] : edit.hunks) ?? [],
        acceptedAt: Date.now(),
      });
      this.closeDiffIfNoneLeft(edit.absPath);
      accepted.push(edit.path);
    }
    return accepted;
  }

  async reject(target?: string): Promise<string[]> {
    const targets = this.matchPending(target).reverse(); // 新→旧逆序反向
    const rejected: string[] = [];
    for (const [key, edit] of targets) {
      const ok = await this.revertUnitOnDisk(edit);
      if (ok) {
        this.pending.delete(key);
        this.cleanupFileOriginal(edit.absPath);
        this.closeDiffIfNoneLeft(edit.absPath);
        rejected.push(edit.path);
      }
    }
    return rejected;
  }

  private async revertUnitOnDisk(unit: { absPath: string; isNew: boolean; fullRewrite?: boolean; isCreate?: boolean; originalContent: string; hunks?: FileEdit["hunks"] }): Promise<boolean> {
    const isFull = unit.fullRewrite ?? unit.isCreate ?? false; // pending 用 fullRewrite，已接受记录用 isCreate
    if (isFull) {
      try {
        if (unit.isNew) {
          const others = [...this.pending.values(), ...this.accepted.values()].filter((e) => e.absPath === unit.absPath && e !== unit).length;
          if (others === 0) {
            try { await vscode.workspace.fs.delete(vscode.Uri.file(unit.absPath)); } catch { /* 已不存在 */ }
            this.lastWritten.set(unit.absPath, null);
          } else {
            await this.writeDisk(unit.absPath, unit.originalContent);
            this.lastWritten.set(unit.absPath, unit.originalContent);
          }
        } else {
          await this.writeDisk(unit.absPath, unit.originalContent);
          this.lastWritten.set(unit.absPath, unit.originalContent);
        }
        return true;
      } catch {
        return false;
      }
    }
    const current = await this.readDisk(unit.absPath);
    if (current === null) return false;
    const res = reverseApplyHunks(current, unit.hunks ?? []);
    if (!res.ok || res.content === undefined) return false;
    try {
      await this.writeDisk(unit.absPath, res.content);
      this.lastWritten.set(unit.absPath, res.content);
      return true;
    } catch {
      return false;
    }
  }

  getUndoablePaths(): string[] {
    return [...this.accepted.values()].sort((a, b) => b.acceptedAt - a.acceptedAt).map((e) => e.path);
  }

  getUndoableEditIds(): string[] {
    return [...this.accepted.values()].sort((a, b) => b.acceptedAt - a.acceptedAt).map((e) => e.editId);
  }

  async undo(target: string): Promise<UndoResult> {
    // 单元级撤销（target = editId）
    const unitEntry = [...this.accepted.entries()].find(([key, e]) => key === target || e.editId === target);
    if (unitEntry) {
      const [key, rec] = unitEntry;
      const ok = await this.revertUnitOnDisk(rec);
      if (!ok) return { ok: false, reason: "无法安全撤销这一次：它所依赖的上下文已因其它撤销/改动而变化。同一文件的多次改动请按从新到旧的顺序撤销。" };
      this.accepted.delete(key);
      this.cleanupFileOriginal(rec.absPath);
      this.closeDiffIfNoneLeft(rec.absPath);
      return { ok: true, path: rec.path };
    }
    // 整文件撤销（target = path/absPath）：恢复 AI 改动前的原始快照——永远安全
    const fileUnits = [...this.accepted.entries()].filter(([key, e]) => e.path === target || e.absPath === target);
    if (fileUnits.length === 0) return { ok: false, reason: "没有可撤销的改动记录" };
    const absPath = fileUnits[0][1].absPath;
    const relPath = fileUnits[0][1].path;
    const snap = this.fileOriginals.get(absPath);
    // 外部改动检测：磁盘 ≠ 最近写入内容 → 文件被外部改过，保守放弃以免覆盖
    const expected = this.lastWritten.get(absPath);
    if (snap && expected !== undefined) {
      const current = await this.readDisk(absPath);
      const diskMatches = expected === null ? current === null : current === expected;
      if (!diskMatches) {
        return { ok: false, reason: "文件在改动后被外部修改过，已取消整文件撤销以免覆盖你的改动" };
      }
    }
    try {
      if (snap && !snap.existed) {
        try { await vscode.workspace.fs.delete(vscode.Uri.file(absPath)); } catch { /* 已不存在 */ }
        this.lastWritten.set(absPath, null);
      } else if (snap) {
        await this.writeDisk(absPath, snap.content);
        this.lastWritten.set(absPath, snap.content);
      } else {
        const ordered = fileUnits.map(([, e]) => e).reverse();
        for (const u of ordered) {
          const ok = await this.revertUnitOnDisk(u);
          if (!ok) return { ok: false, reason: "无法安全整文件撤销，请逐次按从新到旧撤销" };
        }
      }
    } catch (err) {
      return { ok: false, reason: `撤销失败：${(err as Error).message}` };
    }
    for (const [k, e] of [...this.accepted.entries()]) if (e.absPath === absPath) this.accepted.delete(k);
    for (const [k, e] of [...this.pending.entries()]) if (e.absPath === absPath) this.pending.delete(k);
    this.fileOriginals.delete(absPath);
    this.diff?.close(absPath);
    return { ok: true, path: relPath };
  }

  /** 文件已无任何待确认/已接受单元时，清掉其原始快照 */
  private cleanupFileOriginal(absPath: string): void {
    const stillReferenced = [...this.pending.values(), ...this.accepted.values()].some((e) => e.absPath === absPath);
    if (!stillReferenced) this.fileOriginals.delete(absPath);
  }

  hasPending(): boolean { return this.pending.size > 0; }

  getPendingPaths(): string[] {
    return [...new Set([...this.pending.values()].map((e) => e.path))];
  }

  getPendingEditIds(): string[] {
    return [...this.pending.values()].map((e) => e.editId || e.absPath);
  }

  getPendingDiffs(): FileDiff[] {
    const byPath = new Map<string, { oldContent: string; newContent: string }>();
    for (const e of this.pending.values()) {
      const cur = byPath.get(e.path);
      if (!cur) byPath.set(e.path, { oldContent: e.originalContent, newContent: e.newContent });
      else cur.newContent = e.newContent;
    }
    return [...byPath.entries()].map(([path, d]) => ({ path, oldContent: d.oldContent, newContent: d.newContent }));
  }

  serialize(): FileEdit[] {
    return [...this.pending.values()].map((e) => ({ ...e }));
  }

  restore(edits: FileEdit[]): void {
    this.pending.clear();
    this.fileOriginals.clear();
    for (const e of edits) {
      this.pending.set(this.keyOf(e), { ...e });
      if (!this.fileOriginals.has(e.absPath)) {
        this.fileOriginals.set(e.absPath, { content: e.originalContent, existed: !e.isNew });
      }
    }
  }

  fork(mode: EditMode): EditPresenter {
    const p = new VSCodeEditPresenter();
    p.setMode(mode);
    p.disableNativeDiff();
    return p;
  }
}
