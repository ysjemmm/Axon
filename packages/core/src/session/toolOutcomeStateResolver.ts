import { ToolName, type ToolMeta } from "../tools/index.js";
import type { LoopGuard } from "../agentGuards.js";

/** 记录结果的前置输入。 */
export interface ToolOutcomeStateInput {
  toolName: string;
  toolArgs: Record<string, unknown>;
  result: string;
  status: "success" | "error";
  meta: ToolMeta;
  guard: LoopGuard;
  hostEditMode: "auto" | "manual";
  activeRelayTask?: { changedFiles: Set<string> } | null;
}

/** 记录结果的前置状态输出。 */
export interface ToolOutcomeStateResult {
  mutated: boolean;
  diagnosed: boolean;
  isPending: boolean;
  markTransient: boolean;
  mutatedPaths: string[];
  relayChangedPaths: string[];
}

/**
 * ToolOutcomeStateResolver —— 解析 recordToolOutcome 的前置状态。
 *
 * 从 AgentSession.recordToolOutcome 抽出的第一版纯逻辑：
 * - 软失败是否记为 transient
 * - 是否 mutated / diagnosed
 * - 是否 pending
 * - 改动路径列表（供 mutatedFiles / relay.changedFiles 回填）
 *
 * 这样 recordToolOutcome 剩下的外壳只负责：
 * - 把这些结果写回 session 状态（Set / activeRelayTask）
 * - 调 ToolOutcomeRecorder 发事件/落历史
 */
export class ToolOutcomeStateResolver {
  resolve(input: ToolOutcomeStateInput): ToolOutcomeStateResult {
    const { toolName, toolArgs, result, status, meta, guard, hostEditMode, activeRelayTask } = input;

    const softFail = status === "error" && /(未找到匹配|参数为空|JSON|工具执行失败|调用被拦截|命令未执行|读取失败)/.test(result);
    guard.recordToolResult(status !== "error", softFail, { toolName, args: toolArgs });

    const isEditError = status === "error" && (toolName === ToolName.StrReplace || toolName === ToolName.CreateFile || toolName === ToolName.ApplyPatch);
    const markTransient = isEditError;

    const isPending = hostEditMode === "manual"
      && (toolName === ToolName.StrReplace || toolName === ToolName.CreateFile || toolName === ToolName.ApplyPatch)
      && status === "success";

    let mutated = false;
    if (status === "success" && (toolName === ToolName.StrReplace || toolName === ToolName.CreateFile || toolName === ToolName.ApplyPatch)) {
      mutated = true;
    }

    const mutatedPaths = mutated
      ? ((meta.fileDiffs && meta.fileDiffs.length > 0 ? meta.fileDiffs : (meta.fileDiff ? [meta.fileDiff] : []))
          .map((d) => d.path)
          .filter(Boolean) as string[])
      : [];

    const relayChangedPaths = status === "success" && activeRelayTask
      ? ((meta.fileDiffs && meta.fileDiffs.length > 0 ? meta.fileDiffs : (meta.fileDiff ? [meta.fileDiff] : []))
          .map((d) => d.path)
          .filter(Boolean) as string[])
      : [];

    const diagnosed = status === "success" && toolName === ToolName.CheckDiagnostics;

    return {
      mutated,
      diagnosed,
      isPending,
      markTransient,
      mutatedPaths,
      relayChangedPaths,
    };
  }
}
