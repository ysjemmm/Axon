/**
 * eventHandlers/index.ts —— 事件路由器
 *
 * createEventHandler(ctx) 返回一个稳定的 (msg) => void 函数，
 * 内部按 msg.type 分发到对应 handler 模块。
 */

import type { EventHandlerCtx, WsMessage } from "./types";
import { AGENT_EVENT } from "@/lib/constants";

import { handleStreamStart, handleStreamDelta, handleStreamPause, handleStreamEnd } from "./streamHandlers";
import { handleToolCall, handleToolResult } from "./toolHandlers";
import {
  handleSessionCreated, handleSessionLoaded, handleSessionError,
  handleCompactingStart, handleCompactionNeeded, handleCompactionMigrated, handleCompactingEnd,
  handleCreditBudgetPaused,
} from "./sessionHandlers";
import {
  handleStatus, handleRetry, handleContextOverflow, handleTokenUsage, handleReasoningDelta,
  handleEditsUpdated, handleEditUndoResult,
  handleWorkspaceSet, handleEditModeSet, handleWorkspaceError,
  handleConfirmToolRequest, handleToolConfirmTimeout, handleToolWaitingInput,
  handleConfirmCommandRequest, handleCommandBlocked, handleToolHistoryMismatch,
  handleFocusRelay, handleRelayUpdated, handleRelayDeleted,
  clearWaitingInput,
} from "./stateHandlers";
import { handleTurnCancelled } from "./turnHandlers";
import { handleSubAgentStart, handleSubAgentEvent, handleSubAgentEnd, handleError, handleParallelBatchStart } from "./subAgentHandlers";

export function createEventHandler(ctx: EventHandlerCtx): (msg: WsMessage) => void {
  return (msg: WsMessage) => {
    switch (msg.type) {
      // ── 流式文本 ──
      case AGENT_EVENT.STREAM_START:
        clearWaitingInput(ctx);
        handleStreamStart(msg, ctx);
        return;
      case AGENT_EVENT.STREAM_DELTA:
        clearWaitingInput(ctx);
        handleStreamDelta(msg, ctx);
        return;
      case AGENT_EVENT.STREAM_PAUSE:
        handleStreamPause(msg, ctx);
        return;
      case AGENT_EVENT.STREAM_END:
        clearWaitingInput(ctx);
        handleStreamEnd(msg, ctx);
        return;

      // ── 工具调用 ──
      case AGENT_EVENT.TOOL_CALL:
        handleToolCall(msg, ctx);
        return;
      case AGENT_EVENT.TOOL_RESULT:
        // tool_result 也清除等待输入状态（在 handler 内部处理）
        handleToolResult(msg, ctx);
        return;
      case AGENT_EVENT.TOOL_WAITING_INPUT:
        handleToolWaitingInput(msg, ctx);
        return;

      // ── 轮次 ──
      case AGENT_EVENT.TURN_CANCELLED:
        clearWaitingInput(ctx);
        handleTurnCancelled(msg, ctx);
        return;

      // ── 会话生命周期 ──
      case AGENT_EVENT.SESSION_CREATED:
        handleSessionCreated(msg, ctx);
        return;
      case AGENT_EVENT.SESSION_LOADED:
        handleSessionLoaded(msg, ctx);
        return;
      case AGENT_EVENT.SESSION_ERROR:
        handleSessionError(msg, ctx);
        return;

      // ── 压缩 ──
      case AGENT_EVENT.COMPACTING_START:
        handleCompactingStart(msg, ctx);
        return;
      case AGENT_EVENT.COMPACTION_NEEDED:
        handleCompactionNeeded(msg, ctx);
        return;
      case AGENT_EVENT.COMPACTION_MIGRATED:
        handleCompactionMigrated(msg, ctx);
        return;
      case AGENT_EVENT.COMPACTING_END:
        handleCompactingEnd(msg, ctx);
        return;

      // ── Credits 预算门 ──
      case AGENT_EVENT.CREDIT_BUDGET_PAUSED:
        handleCreditBudgetPaused(msg, ctx);
        return;

      // ── 状态 ──
      case AGENT_EVENT.STATUS:
        handleStatus(msg, ctx);
        return;
      case AGENT_EVENT.RETRY:
        handleRetry(msg, ctx);
        return;
      case AGENT_EVENT.CONTEXT_OVERFLOW:
        handleContextOverflow(msg, ctx);
        return;
      case AGENT_EVENT.REASONING_DELTA:
        handleReasoningDelta(msg, ctx);
        return;
      case AGENT_EVENT.TOKEN_USAGE:
        handleTokenUsage(msg, ctx);
        return;
      case AGENT_EVENT.EDITS_UPDATED:
        handleEditsUpdated(msg, ctx);
        return;
      case AGENT_EVENT.EDIT_UNDO_RESULT:
        handleEditUndoResult(msg, ctx);
        return;
      case AGENT_EVENT.WORKSPACE_SET:
        handleWorkspaceSet(msg, ctx);
        return;
      case AGENT_EVENT.EDIT_MODE_SET:
        handleEditModeSet(msg, ctx);
        return;
      case AGENT_EVENT.WORKSPACE_ERROR:
        handleWorkspaceError(msg, ctx);
        return;

      // ── 确认门 ──
      case AGENT_EVENT.CONFIRM_TOOL_REQUEST:
        handleConfirmToolRequest(msg, ctx);
        return;
      case AGENT_EVENT.TOOL_CONFIRM_TIMEOUT:
        handleToolConfirmTimeout(msg, ctx);
        return;
      case AGENT_EVENT.CONFIRM_COMMAND_REQUEST:
        handleConfirmCommandRequest(msg, ctx);
        return;
      case AGENT_EVENT.COMMAND_BLOCKED:
        handleCommandBlocked(msg, ctx);
        return;
      case AGENT_EVENT.TOOL_HISTORY_MISMATCH:
        handleToolHistoryMismatch(msg, ctx);
        return;

      // ── Relay ──
      case AGENT_EVENT.FOCUS_RELAY:
        handleFocusRelay(msg, ctx);
        return;
      case AGENT_EVENT.RELAY_UPDATED:
        handleRelayUpdated(msg, ctx);
        return;
      case AGENT_EVENT.RELAY_DELETED:
        handleRelayDeleted(msg, ctx);
        return;

      // ── 子 Agent ──
      case AGENT_EVENT.SUB_AGENT_START:
        handleSubAgentStart(msg, ctx);
        return;
      case AGENT_EVENT.SUB_AGENT_EVENT:
        handleSubAgentEvent(msg, ctx);
        return;
      case AGENT_EVENT.SUB_AGENT_END:
        handleSubAgentEnd(msg, ctx);
        return;

      // ── 并行调研/执行：批量创建 subagent 卡片，后续事件按 delegateId 路由进各自卡片 ──
      case AGENT_EVENT.PARALLEL_RESEARCH_START:
      case AGENT_EVENT.PARALLEL_EXECUTE_START:
        handleParallelBatchStart(msg, ctx);
        return;
      // parallel_*_end：各子 Agent 已各自收到 sub_agent_end，批次级事件无需额外处理

      // ── 错误 ──
      case AGENT_EVENT.ERROR:
        handleError(msg, ctx);
        return;

      // ── 其他/忽略 ──
      default:
        return;
    }
  };
}

export type { EventHandlerCtx, WsMessage };
