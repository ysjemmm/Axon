/**
 * EditController —— 待确认改动的接受/拒绝/撤销与并行回滚（从 AgentSession 解耦）
 *
 * 职责单一：把 manual 模式下暂存改动的接受落盘、拒绝丢弃、撤销恢复，以及 parallel_execute
 * auto 落盘文件的快照回滚集中到一处；每次变动后向 AI 注入系统消息（让它感知用户决策）并通知前端。
 *
 * 通过构造注入的 session 引用访问 host.edits / 消息历史 / 持久化回调 / 并行快照（@internal）。
 * 轻量待确认状态查询（pending 路径/diff 等）仍是 host.edits 的薄封装，保留在 session。
 */

import type { AgentSession } from "../agentSession.js";

export class EditController {
  constructor(private readonly s: AgentSession) {}

  /** 推送待确认改动的最新状态给前端（pending 路径 / diff / 可撤销项 / editId 等） */
  sendEditsUpdated(rejected?: string[]): void {
    this.s.send("edits_updated", {
      pending: this.s.getPendingPaths(),
      diffs: this.s.getPendingDiffs(),
      rejected: rejected || [],
      undoable: this.s.getUndoablePaths(),
      pendingEditIds: this.s.host.edits.getPendingEditIds(),
      undoableEditIds: this.s.host.edits.getUndoableEditIds(),
    });
  }

  /**
   * 接受待确认改动并落盘。path 省略时接受全部。
   * 接受后注入系统消息让 AI 感知，并通知前端。
   */
  async accept(path?: string): Promise<void> {
    // 直接用前端回传的 path（即 getPendingPaths() 原值）匹配，不再 resolve(cwd, path)：
    // resolveInWorkspaces 解析出的 absPath 在 basename 兜底 / 多根工作区下常与 resolve(cwd,path) 不等，
    // 重解析会匹配不到 pending 条目，导致接受/拒绝静默失效。
    const acceptedPaths = await this.s.host.edits.accept(path);
    if (acceptedPaths.length > 0) {
      this.s.messages.push({
        role: "system",
        content: `用户已接受并保存对以下文件的改动：${acceptedPaths.join("、")}。这些改动现已写入磁盘。`,
      } as any);
    }
    this.sendEditsUpdated();
    this.s.onPendingChanged?.();
  }

  /**
   * 拒绝待确认改动并丢弃（文件保持原样，从未落盘）。path 省略时拒绝全部。
   * 拒绝后注入系统消息让 AI 感知。
   */
  async reject(path?: string): Promise<void> {
    // 同 accept：直接用前端回传的相对 path / editId 匹配。
    const beforeIds = new Set(this.s.host.edits.getPendingEditIds());
    const rejectedPaths = await this.s.host.edits.reject(path);
    if (rejectedPaths.length > 0) {
      this.s.messages.push({
        role: "system",
        content: `用户拒绝了对以下文件的改动：${rejectedPaths.join("、")}。这些文件保持原样（未被修改）。如果用户的目标仍未达成，请重新考虑实现方式，不要简单重复同样的改动。`,
      } as any);
    }
    // 指定单元拒绝但未成功（与后续改动重叠、指纹定位不到）→ 轻提示，文件保持不动
    if (path && rejectedPaths.length === 0 && beforeIds.has(path)) {
      this.s.send("edit_undo_result", { path, ok: false, reason: "该改动与后续改动重叠，无法单独拒绝这一次，请整体处理" });
    }
    this.sendEditsUpdated(rejectedPaths);
    this.s.onPendingChanged?.();
  }

  /**
   * 撤销一笔已接受的文件改动（反向应用，保守失败不破坏文件）。
   * 成功：注入系统消息让 AI 感知，推送前端更新并发撤销结果（用于轻提示）。
   * 失败：仅发撤销结果（含 reason），文件保持不动。
   * @param path 已接受改动的相对路径（前端从 undoable 列表回传）
   */
  async undo(path: string): Promise<void> {
    const result = await this.s.host.edits.undo(path);
    if (result.ok) {
      this.s.messages.push({
        role: "system",
        content: `用户撤销了对文件 ${result.path || path} 的改动，该文件已恢复到这次改动被接受之前的状态。如果用户的目标因此改变，请据此调整后续行为。`,
      } as any);
      this.sendEditsUpdated();
      this.s.onPendingChanged?.();
    }
    // 无论成功失败都通知前端撤销结果：成功→更新卡片为已撤销；失败→轻提示
    this.s.send("edit_undo_result", { path, ok: result.ok, reason: result.reason });
  }

  /**
   * 回滚一个并行执行（parallel_execute）写入的文件。
   * 并行子 Agent auto 落盘，无原生 undo 记录，靠 parallelSnapshots 里捕获的"改动前快照"恢复：
   * - 新建文件 → 删除
   * - 已存在文件 → 写回原始内容
   * @param path AI 使用的路径（前端从文件变更清单回传）
   */
  async undoParallelFile(path: string): Promise<void> {
    const snap = this.s.parallelSnapshots.get(path);
    if (!snap) {
      this.s.send("parallel_file_reverted", { path, ok: false, reason: "未找到该文件的回滚快照" });
      return;
    }
    try {
      if (snap.isNew) {
        await this.s.host.fs.remove(snap.absPath);
      } else {
        await this.s.host.fs.write(snap.absPath, snap.original ?? "");
      }
      // 回滚成功后移除快照（不可重复回滚）
      this.s.parallelSnapshots.delete(path);
      this.s.send("parallel_file_reverted", { path, ok: true });
    } catch (err) {
      this.s.send("parallel_file_reverted", { path, ok: false, reason: (err as Error).message });
    }
  }
}
