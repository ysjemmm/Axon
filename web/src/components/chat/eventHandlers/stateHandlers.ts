/**
 * stateHandlers —— 状态类事件处理
 * status / reasoning_delta / edits_updated / edit_undo_result / token_usage /
 * workspace_set / edit_mode_set / workspace_error / confirm_tool_request /
 * tool_waiting_input / confirm_command_request / command_blocked / focus_relay /
 * relay_updated / relay_deleted
 */

import { MODELS, findModel } from "@/components/ModelSelector";
import { getRelay, type RelayData } from "@/lib/apiClient";
import { segEditUnits, extractBasename } from "../utils";
import type { CommandApproval } from "../useChatSession";
import type { EventHandlerCtx, WsMessage } from "./types";

export function handleStatus(msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setStatusText((msg as any).content as string || "思考中...");
  ctx.setStatusPhase((msg as any).phase as string || "thinking");
}

export function handleTokenUsage(msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setTokenUsage({
    used: msg.used as number,
    max: msg.max as number,
    cumulative: (msg as any).cumulative ?? 0,
  });
}

export function handleReasoningDelta(msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setReasoning((prev) => prev + ((msg as any).content || ""));
  if (ctx.statusPhaseRef.current === "thinking") {
    ctx.setStatusText("正在推理...");
    ctx.setStatusPhase("reasoning");
  }
}

export function handleEditsUpdated(msg: WsMessage, ctx: EventHandlerCtx): void {
  const pending = ((msg as any).pending as string[]) || [];
  ctx.setPendingPaths(pending);
  if (pending.length === 0) ctx.setPendingExpanded(false);
  const diffs = ((msg as any).diffs as { path: string; oldContent: string; newContent: string }[]) || [];
  const diffMap: Record<string, { oldContent: string; newContent: string }> = {};
  for (const d of diffs) diffMap[d.path] = { oldContent: d.oldContent, newContent: d.newContent };
  ctx.setPendingDiffs(diffMap);
  const rejected = ((msg as any).rejected as string[]) || [];
  const pendingEditIds = new Set(((msg as any).pendingEditIds as string[]) || []);
  const undoableEditIds = new Set(((msg as any).undoableEditIds as string[]) || []);
  const rejectedSet = new Set(rejected);
  ctx.setChatHistory((prev) => {
    let changed = false;
    const updated = prev.map((chatMsg) => {
      if (chatMsg.role !== "assistant" || !chatMsg.segments) return chatMsg;
      const newSegs = chatMsg.segments.map((seg) => {
        if (seg.type !== "tool") return seg;
        const units = segEditUnits(seg);
        if (units.length === 0) return seg;
        const perFilePending = units.filter((u) => u.editId && pendingEditIds.has(u.editId)).map((u) => u.path);
        const perFileUndoable = units.filter((u) => u.editId && undoableEditIds.has(u.editId)).map((u) => u.path);
        const shouldBePending = perFilePending.length > 0;
        const wasRejected = units.some((u) => rejectedSet.has(u.path));
        const shouldBeUndoable = perFileUndoable.length > 0;
        const prevPP = seg.pendingPaths || [];
        const ppChanged = perFilePending.length !== prevPP.length || perFilePending.some((p) => !prevPP.includes(p));
        const prevUP = (seg as any).undoablePaths || [];
        const upChanged = perFileUndoable.length !== prevUP.length || perFileUndoable.some((p: string) => !prevUP.includes(p));
        const needsUpdate =
          (!!seg.pending !== shouldBePending) ||
          (wasRejected && !seg.rejected) ||
          (!!seg.undoable !== shouldBeUndoable) ||
          ppChanged || upChanged;
        if (needsUpdate) {
          changed = true;
          return {
            ...seg,
            pending: shouldBePending || undefined,
            rejected: wasRejected || seg.rejected || undefined,
            undoable: shouldBeUndoable || undefined,
            pendingPaths: perFilePending.length > 0 ? perFilePending : undefined,
            undoablePaths: perFileUndoable.length > 0 ? perFileUndoable : undefined,
          };
        }
        return seg;
      });
      return newSegs !== chatMsg.segments ? { ...chatMsg, segments: newSegs } : chatMsg;
    });
    return changed ? updated : prev;
  });
}

export function handleEditUndoResult(msg: WsMessage, ctx: EventHandlerCtx): void {
  const target = (msg as any).path as string;
  const ok = (msg as any).ok as boolean;
  const reason = (msg as any).reason as string | undefined;
  if (ok) {
    ctx.setChatHistory((prev) => {
      let changed = false;
      const updated = prev.map((chatMsg) => {
        if (chatMsg.role !== "assistant" || !chatMsg.segments) return chatMsg;
        const newSegs = chatMsg.segments.map((seg) => {
          if (seg.type !== "tool") return seg;
          const units = segEditUnits(seg);
          const hit = units.filter((u) => (u.editId && u.editId === target) || u.path === target).map((u) => u.path);
          if (hit.length === 0) return seg;
          changed = true;
          const prevRP = (seg as any).revertedPaths as string[] | undefined;
          const revertedPaths = Array.from(new Set([...(prevRP || []), ...hit]));
          const allPaths = units.map((u) => u.path);
          const allReverted = allPaths.length > 0 && allPaths.every((p) => revertedPaths.includes(p));
          const remainUndoable = ((seg as any).undoablePaths as string[] | undefined || []).filter((p) => !hit.includes(p));
          return {
            ...seg,
            revertedPaths,
            reverted: allReverted || undefined,
            undoable: remainUndoable.length > 0 || undefined,
            undoablePaths: remainUndoable.length > 0 ? remainUndoable : undefined,
          };
        });
        return newSegs !== chatMsg.segments ? { ...chatMsg, segments: newSegs } : chatMsg;
      });
      return changed ? updated : prev;
    });
  } else {
    ctx.setUndoNotice({ id: Date.now(), text: reason || "无法撤销该改动" });
  }
}

export function handleWorkspaceSet(msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setWorkspace((msg as any).workspace || "");
  if ((msg as any).workspaces) ctx.setWorkspaces((msg as any).workspaces);
  if ("groupId" in (msg as any)) ctx.setCurrentGroupId((msg as any).groupId || null);
}

export function handleEditModeSet(msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setEditMode((msg as any).mode === "auto" ? "auto" : "manual");
}

export function handleWorkspaceError(msg: WsMessage, _ctx: EventHandlerCtx): void {
  console.error("[workspace]", (msg as any).message);
}

export function handleConfirmToolRequest(msg: WsMessage, ctx: EventHandlerCtx): void {
  const toolName = (msg as any).toolName as string;
  const args = (msg as any).args as Record<string, unknown>;
  const kind = ((msg as any).kind as string) || "relay";
  const label = (msg as any).label as string | undefined;
  const title = label || (typeof args?.title === "string" ? args.title : "Relay 工作流");
  ctx.setToolConfirm({ toolName, title, kind });
}

export function handleToolWaitingInput(msg: WsMessage, ctx: EventHandlerCtx): void {
  const toolCallId = (msg as any).toolCallId as string | undefined;
  if (toolCallId) {
    ctx.setWaitingInputIds((prev) => new Set(prev).add(toolCallId));
  }
}

export function handleConfirmCommandRequest(msg: WsMessage, ctx: EventHandlerCtx): void {
  const toolCallId = ((msg as any).id as string) || ((msg as any).requestId as string);
  const danger = (msg as any).danger as string | undefined;
  ctx.setCommandApprovals((m) => ({
    ...m,
    [toolCallId]: {
      requestId: (msg as any).requestId as string,
      command: (msg as any).command as string,
      options: ((msg as any).options as CommandApproval["options"]) || [],
      danger,
    },
  }));
}

export function handleCommandBlocked(msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setCommandBlocked({
    requestId: (msg as any).requestId as string | undefined,
    command: (msg as any).command as string,
    reason: (msg as any).reason as string,
    dangerous: (msg as any).dangerous as boolean | undefined,
  });
}

export function handleFocusRelay(msg: WsMessage, ctx: EventHandlerCtx): void {
  const relayId = (msg as any).relayId as string | undefined;
  if (relayId) {
    ctx.setFocusRelayId(relayId);
    getRelay(relayId).then((relay: RelayData) => {
      ctx.setLiveRelay(relay);
      ctx.setHasRelay(true);
    }).catch(() => { /* relay 可能已被删除 */ });
  }
}

export function handleRelayUpdated(msg: WsMessage, ctx: EventHandlerCtx): void {
  const relay = (msg as any).relay as RelayData | undefined;
  if (relay) {
    ctx.setLiveRelay(relay);
    ctx.setHasRelay(true);
    ctx.setFocusRelayId(relay.id);
  }
}

export function handleRelayDeleted(msg: WsMessage, ctx: EventHandlerCtx): void {
  const relayId = (msg as any).relayId as string | undefined;
  if (relayId) ctx.setDeletedRelayId(relayId);
}

/** 清除等待输入状态（stream_delta/stream_start/stream_end/turn_cancelled 时调用） */
export function clearWaitingInput(ctx: EventHandlerCtx): void {
  ctx.setWaitingInputIds(new Set());
}

/** 从 path 提取 basename（重导出供其他 handler 用） */
export { extractBasename, MODELS, findModel };
