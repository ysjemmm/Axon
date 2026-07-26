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
import type { ReasoningSegment } from "../types";
import type { EventHandlerCtx, WsMessage } from "./types";

/**
 * 计算思考块的身份 key：`轮次:协议块号`。
 *
 * 这是 reasoning 段归属的**唯一**依据。早先靠"从后往前找 streaming=true 的 reasoning 段"
 * 来推断归属，那是一个可被任何提前到达的事件推翻的全局可变状态——工具卡片一提前出、
 * stream_start 一到，段就被关掉，后续思考增量只能新建段，于是出现一排并列的"思考过程"。
 *
 * 三段身份信息的来源与回退：
 * · round —— 后端 agent 循环的轮序号。协议里没有"新一轮 LLM 调用开始"的事件
 *   （stream_start 只在本轮有正文时才发，纯工具轮不发），所以轮边界必须由后端显式给出，
 *   前端无法可靠推断。缺失时退化为 0，表现为整条消息共用一段，不会串轮。
 * · itemId —— Responses API 的 reasoning item id。
 * · partIndex —— Anthropic 的 content block 索引 / Responses 的 summary_index。
 *   Anthropic 一轮内可以有多个 thinking 块（thinking → tool_use → thinking），
 *   块号让它们各自独立成段；块号在每轮内从 0 重新开始，所以必须与 round 组合。
 * · 两者都没有（Chat Completions 的 reasoning_content 是单一无分块流）→ 固定 "0"，
 *   本轮所有思考增量并入同一段，正是期望行为。
 */
function reasoningKeyOf(msg: WsMessage): string {
  const round = (msg as any).round as number | undefined;
  const itemId = (msg as any).itemId as string | undefined;
  const partIndex = (msg as any).partIndex as number | undefined;
  const block = itemId ? `i${itemId}` : (partIndex !== undefined && partIndex !== null ? `p${partIndex}` : "0");
  return `r${round ?? 0}:${block}`;
}

export function handleStatus(msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setStatusText((msg as any).content as string || "思考中...");
  ctx.setStatusPhase((msg as any).phase as string || "thinking");
}

export function handleContextOverflow(_msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setContextOverflow(true);
}

export function handleRetry(msg: WsMessage, ctx: EventHandlerCtx): void {
  const attempt = (msg as any).attempt as number;
  const maxRetries = (msg as any).maxRetries as number;
  const error = (msg as any).error as string;
  const status = (msg as any).status as "retrying" | "failed";

  ctx.setStatusText(status === "retrying" ? `正在重新连接 ${attempt}/${maxRetries}...` : "连接失败");
  ctx.setStatusPhase("thinking");

  ctx.setChatHistory((prev) => {
    const updated = [...prev];
    let last = updated[updated.length - 1];
    // 确保有 assistant 消息
    if (!last || last.role !== "assistant") {
      last = { id: `assistant-${Date.now()}`, role: "assistant", segments: [], streaming: true, turnStatus: "running", turnGen: ctx.turnGeneration.current };
      updated.push(last);
    } else {
      last = { ...last, segments: [...(last.segments || [])] };
      updated[updated.length - 1] = last;
    }
    const segs = last.segments!;
    // 找现有 retry segment 并更新，或新建一个
    const retryIdx = segs.findIndex((s) => s.type === "retry");
    const retrySeg = { type: "retry" as const, attempt, maxRetries, error, status };
    if (retryIdx >= 0) {
      segs[retryIdx] = retrySeg;
    } else {
      segs.push(retrySeg);
    }
    return updated;
  });
}

export function handleTokenUsage(msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setTokenUsage({
    used: msg.used as number,
    max: msg.max as number,
    cumulative: (msg as any).cumulative ?? 0,
  });
}

export function handleReasoningDelta(msg: WsMessage, ctx: EventHandlerCtx): void {
  const content = (msg as any).content as string || "";
  if (!content) return;
  const key = reasoningKeyOf(msg);

  ctx.setChatHistory((prev) => {
    const updated = [...prev];
    const last = updated[updated.length - 1];

    // 还没有 assistant 消息（reasoning 先于 stream_start 到达，纯工具轮的常态）→ 建一条
    if (last?.role !== "assistant" || !last.segments) {
      updated.push({
        id: `assistant-${Date.now()}`,
        role: "assistant",
        segments: [{ type: "reasoning", key, content, streaming: true } as ReasoningSegment],
        streaming: true,
        turnStatus: "running",
        turnGen: ctx.turnGeneration.current,
      });
      return updated;
    }

    const segs = [...last.segments];
    // 按 key 精确定位本思考块。不看 streaming 标志——那只表达 UI 折叠状态，
    // 会被工具卡片/stream_start 提前置 false，用它定位就会把同一个块拆成多段。
    let idx = -1;
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i];
      if (s.type === "reasoning" && (s as ReasoningSegment).key === key) { idx = i; break; }
    }

    if (idx >= 0) {
      const seg = segs[idx] as ReasoningSegment;
      // 重新置 streaming：本块还在继续吐，若之前被提前折叠过则重新展开
      segs[idx] = { ...seg, content: seg.content + content, streaming: true };
    } else {
      const newSeg: ReasoningSegment = { type: "reasoning", key, content, streaming: true };
      // 末尾若是 stream_start 预留的空 text 占位段，把思考插到它前面，
      // 保证思考内容显示在本轮正文之前。
      const lastSeg = segs[segs.length - 1];
      if (lastSeg?.type === "text" && !lastSeg.content.trim()) {
        segs.splice(segs.length - 1, 0, newSeg);
      } else {
        segs.push(newSeg);
      }
    }
    updated[updated.length - 1] = { ...last, segments: segs };
    return updated;
  });

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
