/**
 * 从并行批次中收集所有文件变更
 *
 * 遍历每路 Agent 的 inner segments，提取 create_file / str_replace / apply_patch
 * 工具产生的文件改动，聚合成一个文件变更清单。
 *
 * 状态说明：
 * - 并行子 Agent 默认 auto 落盘，所以文件状态为 "saved"（已确认/已落盘）
 * - 若未来支持 manual 模式，pending 的文件状态为 "pending"（待确认）
 */

import type { ParallelBatch } from "./types";
import type { ToolSegment } from "../chat/types";

export interface FileChange {
  /** 文件路径 */
  path: string;
  /** 来自哪个 Agent（intent） */
  agentIntent: string;
  /** Agent 序号 */
  agentIndex: number;
  /** 状态：saved=已落盘确认，pending=待确认，rejected=已拒绝 */
  status: "saved" | "pending" | "rejected";
  /** 操作类型 */
  action: "create" | "edit";
}

/** 从批次收集所有文件变更（去重，同一文件取最后一次操作） */
export function collectFileChanges(batch: ParallelBatch): FileChange[] {
  const map = new Map<string, FileChange>();

  batch.agents.forEach((agent, agentIndex) => {
    for (const seg of agent.inner) {
      if (seg.type !== "tool") continue;
      const tool = seg as ToolSegment;
      const isEdit = tool.name === "create_file" || tool.name === "str_replace" || tool.name === "apply_patch";
      if (!isEdit) continue;
      // 只收集成功的改动
      if (tool.status !== "success") continue;

      // 单文件改动（create_file / str_replace）
      if (tool.diff?.path) {
        const status: FileChange["status"] = tool.reverted ? "rejected" : tool.pending ? "pending" : "saved";
        map.set(tool.diff.path, {
          path: tool.diff.path,
          agentIntent: agent.intent,
          agentIndex,
          status,
          action: tool.name === "create_file" ? "create" : "edit",
        });
      }

      // 多文件改动（apply_patch）
      if (tool.diffs) {
        for (const d of tool.diffs) {
          if (!d.path) continue;
          const isPending = tool.pendingPaths?.includes(d.path);
          const isReverted = tool.revertedPaths?.includes(d.path);
          const status: FileChange["status"] = isReverted ? "rejected" : isPending ? "pending" : "saved";
          map.set(d.path, {
            path: d.path,
            agentIntent: agent.intent,
            agentIndex,
            status,
            action: "edit",
          });
        }
      }
    }
  });

  return [...map.values()];
}

/** 文件名（从完整路径取最后一段） */
export function basename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}
