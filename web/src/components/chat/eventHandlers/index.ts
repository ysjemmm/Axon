/**
 * eventHandlers/index.ts —— 事件路由器
 *
 * createEventHandler(ctx) 返回一个稳定的 (msg) => void 函数，
 * 内部按 msg.type 分发到对应 handler 模块。
 */

import type { EventHandlerCtx, WsMessage } from "./types";

import { handleStreamStart, handleStreamDelta, handleStreamPause, handleStreamEnd } from "./streamHandlers";
import { handleToolCall, handleToolResult } from "./toolHandlers";
import {
  handleSessionCreated, handleSessionLoaded, handleSessionError,
  handleCompactingStart, handleCompactionNeeded, handleCompactionMigrated, handleCompactingEnd,
} from "./sessionHandlers";
import {
  handleStatus, handleTokenUsage, handleReasoningDelta,
  handleEditsUpdated, handleEditUndoResult,
  handleWorkspaceSet, handleEditModeSet, handleWorkspaceError,
  handleConfirmToolRequest, handleToolWaitingInput,
  handleConfirmCommandRequest, handleCommandBlocked,
  handleFocusRelay, handleRelayUpdated, handleRelayDeleted,
  clearWaitingInput,
} from "./stateHandlers";
import { handleTurnCancelled } from "./turnHandlers";
import { handleSubAgentStart, handleSubAgentEvent, handleSubAgentEnd, handleError } from "./subAgentHandlers";

export function createEventHandler(ctx: EventHandlerCtx): (msg: WsMessage) => void {
  return (msg: WsMessage) => {
    switch (msg.type) {
      // ── 流式文本 ──
      case "stream_start":
        clearWaitingInput(ctx);
        handleStreamStart(msg, ctx);
        return;
      case "stream_delta":
        clearWaitingInput(ctx);
        handleStreamDelta(msg, ctx);
        return;
      case "stream_pause":
        handleStreamPause(msg, ctx);
        return;
      case "stream_end":
        clearWaitingInput(ctx);
        handleStreamEnd(msg, ctx);
        return;

      // ── 工具调用 ──
      case "tool_call":
        handleToolCall(msg, ctx);
        return;
      case "tool_result":
        // tool_result 也清除等待输入状态（在 handler 内部处理）
        handleToolResult(msg, ctx);
        return;
      case "tool_waiting_input":
        handleToolWaitingInput(msg, ctx);
        return;

      // ── 轮次 ──
      case "turn_cancelled":
        clearWaitingInput(ctx);
        handleTurnCancelled(msg, ctx);
        return;

      // ── 会话生命周期 ──
      case "session_created":
        handleSessionCreated(msg, ctx);
        return;
      case "session_loaded":
        handleSessionLoaded(msg, ctx);
        return;
      case "session_error":
        handleSessionError(msg, ctx);
        return;

      // ── 压缩 ──
      case "compacting_start":
        handleCompactingStart(msg, ctx);
        return;
      case "compaction_needed":
        handleCompactionNeeded(msg, ctx);
        return;
      case "compaction_migrated":
        handleCompactionMigrated(msg, ctx);
        return;
      case "compacting_end":
        handleCompactingEnd(msg, ctx);
        return;

      // ── 状态 ──
      case "status":
        handleStatus(msg, ctx);
        return;
      case "reasoning_delta":
        handleReasoningDelta(msg, ctx);
        return;
      case "token_usage":
        handleTokenUsage(msg, ctx);
        return;
      case "edits_updated":
        handleEditsUpdated(msg, ctx);
        return;
      case "edit_undo_result":
        handleEditUndoResult(msg, ctx);
        return;
      case "workspace_set":
        handleWorkspaceSet(msg, ctx);
        return;
      case "edit_mode_set":
        handleEditModeSet(msg, ctx);
        return;
      case "workspace_error":
        handleWorkspaceError(msg, ctx);
        return;

      // ── 确认门 ──
      case "confirm_tool_request":
        handleConfirmToolRequest(msg, ctx);
        return;
      case "confirm_command_request":
        handleConfirmCommandRequest(msg, ctx);
        return;
      case "command_blocked":
        handleCommandBlocked(msg, ctx);
        return;

      // ── Relay ──
      case "focus_relay":
        handleFocusRelay(msg, ctx);
        return;
      case "relay_updated":
        handleRelayUpdated(msg, ctx);
        return;
      case "relay_deleted":
        handleRelayDeleted(msg, ctx);
        return;

      // ── 子 Agent ──
      case "sub_agent_start":
        handleSubAgentStart(msg, ctx);
        return;
      case "sub_agent_event":
        handleSubAgentEvent(msg, ctx);
        return;
      case "sub_agent_end":
        handleSubAgentEnd(msg, ctx);
        return;

      // ── 错误 ──
      case "error":
        handleError(msg, ctx);
        return;

      // ── 其他/忽略 ──
      default:
        return;
    }
  };
}

export type { EventHandlerCtx, WsMessage };
