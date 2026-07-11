import { looksLikeIncompleteReply, type LoopGuard } from "../agentGuards.js";
import type { NormalizedFinishReason } from "../llm/finishReasonMapper.js";

/** handleNoToolCallTurn 的跨回合状态。 */
export interface NoToolTurnState {
  didSelfCheck: boolean;
  emptyRetried: boolean;
}

/** 无工具 turn 决策输入。 */
export interface NoToolTurnDecisionInput {
  contentBuffer: string;
  finishReason: NormalizedFinishReason;
  guard: LoopGuard;
  ts: NoToolTurnState;
}

/** 无工具 turn 决策结果。 */
export type NoToolTurnDecision =
  | { action: "abort_error" }
  | { action: "continue_truncated" }
  | { action: "continue_incomplete"; forceFinalizePrompt?: boolean }
  | { action: "continue_empty_retry" }
  | { action: "finalize" };

/**
 * NoToolTurnDecider —— 纯粹判断“无工具调用的 turn 下一步该做什么”。
 *
 * 把 handleNoToolCallTurn 里的 if/else 决策树抽成纯逻辑：
 * - error → 非正常中断
 * - truncated → 续写
 * - incomplete → 纠正/强制收尾
 * - empty → 重试一次
 * - 其余 → finalize
 *
 * 调用方负责真正注入消息 / 调 finalize / 落盘，本类只决定动作，不做副作用。
 */
export class NoToolTurnDecider {
  decide(input: NoToolTurnDecisionInput): NoToolTurnDecision {
    const { contentBuffer, finishReason, guard, ts } = input;

    if (finishReason === "error") {
      return { action: "abort_error" };
    }

    if (finishReason === "truncated" && contentBuffer) {
      return { action: "continue_truncated" };
    }

    if (looksLikeIncompleteReply(contentBuffer)) {
      const exceeded = guard.noteIncompleteRetry();
      return exceeded
        ? { action: "continue_incomplete", forceFinalizePrompt: true }
        : { action: "continue_incomplete", forceFinalizePrompt: false };
    }

    ts.didSelfCheck = true;

    if (!contentBuffer && !ts.emptyRetried) {
      ts.emptyRetried = true;
      return { action: "continue_empty_retry" };
    }

    return { action: "finalize" };
  }
}
