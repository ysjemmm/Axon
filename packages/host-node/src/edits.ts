/**
 * NodeEditPresenter —— 基于内存暂存区 + node:fs 的 EditPresenter 实现
 *
 * 暂存区以「编辑单元」（editId = `${toolCallId}::${path}`）为最小管理单元：
 *   - 同一文件被多次工具调用修改 → 多个独立单元，可逐次接受/拒绝/撤销
 *   - 所有 present 都立即写盘（磁盘始终是「全部单元叠加」的最新态）
 *   - accept：单元移入已接受区（内容留盘，可撤销）
 *   - reject / undo：用上下文指纹反向【该单元】的 hunk（其余改动保留）；定位歧义/重叠时保守失败
 *
 * target 匹配规则：editId（精确到一次改动）或 path/absPath（整文件所有单元）。
 * 整文件/全部操作按「新 → 旧」逆序反向，等价于逐层剥离，可完整重建原始内容；
 * 单独拒绝/撤销中间某次改动时，若后续改动与之重叠导致指纹定位失败，则保守放弃并提示。
 */

import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { EditPresenter, EditMode, FileEdit, FileDiff, UndoableEdit, UndoResult } from "@axon/core";
import { reverseApplyHunks } from "@axon/core";

export class NodeEditPresenter implements EditPresenter {
  private mode: EditMode = "manual";
  /** key 为 editId（缺省回退 absPath）。Map 保留插入顺序 = 改动先后顺序 */
  private pending = new Map<string, FileEdit>();
  /** 已接受、可撤销的改动（key 为 editId） */
  private accepted = new Map<string, UndoableEdit>();
  /** 文件级原始快照（absPath → AI 首次改动前的内容/是否存在），用于「整文件撤销」永远安全回退 */
  private fileOriginals = new Map<string, { content: string; existed: boolean }>();
  /** 本 presenter 最近一次写入各文件的内容（absPath → content；删除用 null）。
   * 整文件撤销前用它检测「文件是否被外部改动过」，避免覆盖用户/命令的外部修改。 */
  private lastWritten = new Map<string, string | null>();

  getMode(): EditMode {
    return this.mode;
  }

  setMode(mode: EditMode): void {
    this.mode = mode;
  }

  /** 单元 key：优先 editId，回退 absPath（auto 模式或旧数据） */
  private keyOf(edit: { editId?: string; absPath: string }): string {
    return edit.editId || edit.absPath;
  }

  async present(edit: FileEdit): Promise<string> {
    if (this.mode === "auto") {
      const thisFull = !edit.hunks || edit.hunks.length === 0;
      if (!this.fileOriginals.has(edit.absPath)) {
        this.fileOriginals.set(edit.absPath, { content: edit.originalContent, existed: !edit.isNew });
      }
      await mkdir(dirname(edit.absPath), { recursive: true });
      await writeFile(edit.absPath, edit.newContent, "utf-8");
      this.lastWritten.set(edit.absPath, edit.newContent);
      // auto = 自动确认的 manual：落盘后直接记为「已接受、可撤销」，使 auto 改动同样支持撤销。
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
    // manual：先落盘（让 execute_command 等系统级操作能访问），标记为待确认。
    const key = this.keyOf(edit);
    const existing = this.pending.get(key); // 同 editId 再次 present（罕见）→ 合并
    const thisFull = !edit.hunks || edit.hunks.length === 0; // 无 hunks = 整文件写入（create_file / patch add）
    // 文件级原始快照：仅在该文件首次被改动时捕获（AI 改动前的真实内容），用于整文件安全回退
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
    await mkdir(dirname(edit.absPath), { recursive: true });
    await writeFile(edit.absPath, edit.newContent, "utf-8");
    this.lastWritten.set(edit.absPath, edit.newContent);
    return "（改动已写入磁盘并标记为待确认。你可以正常测试此文件。用户拒绝时会自动回滚。）";
  }

  async readEffective(absPath: string): Promise<{ content: string; fromPending: boolean; existsOnDisk: boolean }> {
    // 取该文件最新的待确认单元（插入顺序最后一个）
    let latest: FileEdit | undefined;
    for (const e of this.pending.values()) if (e.absPath === absPath) latest = e;
    if (latest) {
      return { content: latest.newContent, fromPending: true, existsOnDisk: !latest.isNew };
    }
    try {
      const content = await readFile(absPath, "utf-8");
      return { content, fromPending: false, existsOnDisk: true };
    } catch {
      return { content: "", fromPending: false, existsOnDisk: false };
    }
  }

  /** 找出匹配 target 的待确认单元（editId / path / absPath），按插入顺序 */
  private matchPending(target?: string): [string, FileEdit][] {
    const all = [...this.pending.entries()];
    if (!target) return all;
    return all.filter(([key, e]) => key === target || e.editId === target || e.path === target || e.absPath === target);
  }

  async accept(target?: string): Promise<string[]> {
    const targets = this.matchPending(target);
    const accepted: string[] = [];
    for (const [key, edit] of targets) {
      // 不重写磁盘：present 时已落盘，磁盘已是全部单元叠加的最新态。
      // 重写该单元的 newContent 会覆盖掉其它单元的改动（单元制下必须避免）。
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
      accepted.push(edit.path);
    }
    return accepted;
  }

  async reject(target?: string): Promise<string[]> {
    // 逆序（新→旧）反向，保证整文件/全部拒绝能完整重建原始内容
    const targets = this.matchPending(target).reverse();
    const rejected: string[] = [];
    for (const [key, edit] of targets) {
      const ok = await this.revertUnitOnDisk(edit);
      if (ok) {
        this.pending.delete(key);
        this.cleanupFileOriginal(edit.absPath);
        rejected.push(edit.path);
      }
      // 失败（重叠定位不到）：保留该单元待确认，不强改文件
    }
    return rejected;
  }

  /**
   * 在磁盘上反向掉一个编辑单元。整文件写入走删除/回写；局部改动走指纹反向。
   * @returns 是否成功反向（false = 保守放弃，文件未改动）
   */
  private async revertUnitOnDisk(unit: { absPath: string; isNew: boolean; fullRewrite?: boolean; isCreate?: boolean; originalContent: string; hunks?: FileEdit["hunks"] }): Promise<boolean> {
    const isFull = unit.fullRewrite ?? unit.isCreate ?? false; // pending 用 fullRewrite，已接受记录用 isCreate
    if (isFull) {
      try {
        if (unit.isNew) {
          // 仅当该文件再无其它待确认/已接受单元时才删除，避免误删后续改动
          const others = [...this.pending.values(), ...this.accepted.values()].filter((e) => e.absPath === unit.absPath && e !== unit).length;
          if (others === 0) { try { await unlink(unit.absPath); } catch { /* 已不存在 */ } this.lastWritten.set(unit.absPath, null); }
          else { await writeFile(unit.absPath, unit.originalContent, "utf-8"); this.lastWritten.set(unit.absPath, unit.originalContent); }
        } else {
          await writeFile(unit.absPath, unit.originalContent, "utf-8");
          this.lastWritten.set(unit.absPath, unit.originalContent);
        }
        return true;
      } catch {
        return false;
      }
    }
    let current: string;
    try {
      current = await readFile(unit.absPath, "utf-8");
    } catch {
      return false; // 文件没了，无法反向
    }
    const res = reverseApplyHunks(current, unit.hunks ?? []);
    if (!res.ok || res.content === undefined) return false;
    try {
      await writeFile(unit.absPath, res.content, "utf-8");
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
    // 单元级撤销（target = editId）：反向该单元的 hunk（链断/重叠时保守失败）
    const unitEntry = [...this.accepted.entries()].find(([key, e]) => key === target || e.editId === target);
    if (unitEntry) {
      const [key, rec] = unitEntry;
      const ok = await this.revertUnitOnDisk(rec);
      if (!ok) {
        return { ok: false, reason: "无法安全撤销这一次：它所依赖的上下文已因其它撤销/改动而变化。同一文件的多次改动请按从新到旧的顺序撤销。" };
      }
      this.accepted.delete(key);
      this.cleanupFileOriginal(rec.absPath);
      return { ok: true, path: rec.path };
    }
    // 整文件撤销（target = path/absPath）：恢复到 AI 改动前的原始快照——永远安全，不依赖 hunk 链
    const fileUnits = [...this.accepted.entries()].filter(([key, e]) => e.path === target || e.absPath === target);
    if (fileUnits.length === 0) {
      const available = [...this.accepted.values()].map((e) => e.editId);
      console.warn(`[edits.undo] 未找到匹配: target="${target}", accepted editIds: [${available.join(", ")}]`);
      return { ok: false, reason: "没有可撤销的改动记录" };
    }
    const absPath = fileUnits[0][1].absPath;
    const relPath = fileUnits[0][1].path;
    const snap = this.fileOriginals.get(absPath);
    // 外部改动检测：若当前磁盘内容 ≠ 我们最近写入的内容，说明文件被外部（用户/命令）改过，
    // 强行恢复快照会覆盖这些外部改动 → 保守放弃，避免数据丢失。
    const expected = this.lastWritten.get(absPath);
    if (snap && expected !== undefined) {
      const current = await readFile(absPath, "utf-8").catch(() => null);
      const diskMatches = expected === null ? current === null : current === expected;
      if (!diskMatches) {
        return { ok: false, reason: "文件在改动后被外部修改过，已取消整文件撤销以免覆盖你的改动" };
      }
    }
    try {
      if (snap && !snap.existed) {
        try { await unlink(absPath); } catch { /* 已不存在 */ }
        this.lastWritten.set(absPath, null);
      } else if (snap) {
        await writeFile(absPath, snap.content, "utf-8");
        this.lastWritten.set(absPath, snap.content);
      } else {
        // 无快照（异常兜底）：逐单元逆序反向
        const ordered = fileUnits.map(([, e]) => e).reverse();
        let current = await readFile(absPath, "utf-8").catch(() => null);
        if (current === null) return { ok: false, reason: "文件已不存在，无法撤销" };
        for (const u of ordered) {
          const ok = await this.revertUnitOnDisk(u);
          if (!ok) return { ok: false, reason: "无法安全整文件撤销，请逐次按从新到旧撤销" };
        }
      }
    } catch (err) {
      return { ok: false, reason: `撤销失败：${(err as Error).message}` };
    }
    // 清理该文件的所有待确认/已接受单元与快照（整文件已回到原始态）
    for (const [k, e] of [...this.accepted.entries()]) if (e.absPath === absPath) this.accepted.delete(k);
    for (const [k, e] of [...this.pending.entries()]) if (e.absPath === absPath) this.pending.delete(k);
    this.fileOriginals.delete(absPath);
    return { ok: true, path: relPath };
  }

  /** 文件已无任何待确认/已接受单元时，清掉其原始快照 */
  private cleanupFileOriginal(absPath: string): void {
    const stillReferenced = [...this.pending.values(), ...this.accepted.values()].some((e) => e.absPath === absPath);
    if (!stillReferenced) this.fileOriginals.delete(absPath);
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  getPendingPaths(): string[] {
    return [...new Set([...this.pending.values()].map((e) => e.path))];
  }

  getPendingEditIds(): string[] {
    return [...this.pending.values()].map((e) => e.editId || e.absPath);
  }

  getPendingDiffs(): FileDiff[] {
    // 按文件聚合：oldContent = 该文件最早单元的原始内容，newContent = 最新单元内容
    const byPath = new Map<string, { oldContent: string; newContent: string }>();
    for (const e of this.pending.values()) {
      const cur = byPath.get(e.path);
      if (!cur) byPath.set(e.path, { oldContent: e.originalContent, newContent: e.newContent });
      else cur.newContent = e.newContent; // 保留最早 oldContent，更新到最新 newContent
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
      // 重建文件级原始快照（按插入顺序，首个单元的 originalContent = 真实原始内容）
      if (!this.fileOriginals.has(e.absPath)) {
        this.fileOriginals.set(e.absPath, { content: e.originalContent, existed: !e.isNew });
      }
    }
  }

  fork(mode: EditMode): EditPresenter {
    const p = new NodeEditPresenter();
    p.setMode(mode);
    return p;
  }
}
