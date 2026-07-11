import { ToolName, type ToolMeta } from "../tools/index.js";
import { truncateForTrace } from "./sessionTraceWriter.js";

/** recordToolOutcome 的后置同步输入。 */
export interface ToolOutcomePostSyncInput {
  toolName: string;
  toolCallId: string;
  status: "success" | "error";
  commandWasEdited?: string;
  result: string;
  meta: ToolMeta;
  isPending: boolean;
  turnCount: number;
}

/** post-sync 的副作用依赖。 */
export interface ToolOutcomePostSyncDeps {
  trace: (type: string, payload?: unknown, turn?: number) => void;
  markLastToolMessageTransient: () => void;
  enqueueScreenshot: (dataUrl: string) => void;
  sendEditsUpdated: (rejected?: string[]) => void;
  onPendingChanged?: () => void;
}

/**
 * ToolOutcomePostSync —— 工具结果记录后的后置同步动作。
 *
 * 从 AgentSession.recordToolOutcome 抽出的第三层：
 * - trace("tool.result")
 * - transient 标记落到最后一条 tool 消息
 * - screenshot_page 截图挂队列
 * - edits_updated / pendingChanged 同步
 */
export class ToolOutcomePostSync {
  constructor(private readonly deps: ToolOutcomePostSyncDeps) {}

  run(input: ToolOutcomePostSyncInput): void {
    const { toolName, toolCallId, status, commandWasEdited, result, meta, isPending, turnCount } = input;

    this.deps.trace("tool.result", {
      toolName,
      toolCallId,
      status,
      commandWasEdited,
      userMessage: meta.userMessage,
      hidden: meta.hidden,
      pending: isPending,
      resultPreview: truncateForTrace(result, 2000),
    }, turnCount);

    if ((meta as any).__markTransientApplied) {
      this.deps.markLastToolMessageTransient();
      delete (meta as any).__markTransientApplied;
    }

    if (meta.screenshotDataUrl) {
      this.deps.enqueueScreenshot(meta.screenshotDataUrl);
    }

    if (isPending) {
      this.deps.sendEditsUpdated();
      this.deps.onPendingChanged?.();
    } else if (status === "success" && (toolName === ToolName.StrReplace || toolName === ToolName.CreateFile || toolName === ToolName.ApplyPatch)) {
      this.deps.sendEditsUpdated();
    }
  }
}
