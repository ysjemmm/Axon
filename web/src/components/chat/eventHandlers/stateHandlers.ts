/**
 * stateHandlers —— 状态类事件处理
 * status / reasoning_delta / edits_updated / edit_undo_result / token_usage /
 * workspace_set / edit_mode_set / workspace_error / confirm_tool_request /
 * tool_waiting_input / confirm_command_request / command_risk_notice / focus_relay /
 * relay_updated / relay_deleted
 */

import { getModels, findModel } from "@/components/ModelSelector";
import { getRelay, type RelayData } from "@/lib/apiClient";
import { segEditUnits, extractBasename } from "../utils";
import type { CommandApproval } from "../useChatSession";
import type { ReasoningSegment, WikiRecallSegment } from "../types";
import { locateReasoning } from "../reasoningPlacement";
import { stripPendingRetry } from "../retryLifecycle";
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
 *
 * ⚠️ 但「本轮所有思考并入同一段」只在思考连续输出时成立。模型可能在一轮内先出正文、
 *   之后再继续吐思考（已从 trace 验证确实存在），此时同一 key 的思考会被正文打断。
 *   打断后必须另起一块（key 加 `#n` 后缀）并落到末尾，见 reasoningPlacement.ts。
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

/**
 * 清除「正在重试」的 retry 段 —— 重试已恢复（又有产出）时调用。
 *
 * 为什么不能只靠 stream_start 清：后端只在「重试中 / 重试次数已用尽」时发 retry 事件，
 * 成功时不发任何"恢复"信号，只能由前端按"是否又有产出"自行判断。而重试可能发生在
 * 【本轮已经输出过正文之后】——那时轮级的 turnStreamStarted 已是 true，重试成功后继续
 * 输出不会再发 stream_start，只挂在 stream_start 上的清除逻辑就永远不会触发，
 * 「正在重新连接 N/M」于是永久留在消息里（即"重试样式没被清除"）。
 *
 * 幂等：没有待清的段时返回原引用，不触发重渲染。
 */
export function clearPendingRetry(ctx: EventHandlerCtx): void {
  ctx.setChatHistory((prev) => {
    const last = prev[prev.length - 1];
    if (!last || last.role !== "assistant" || !last.segments) return prev;
    const next = stripPendingRetry(last.segments);
    if (!next) return prev;
    const updated = [...prev];
    updated[updated.length - 1] = { ...last, segments: next };
    return updated;
  });
}

export function handleTokenUsage(msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setTokenUsage({
    used: msg.used as number,
    max: msg.max as number,
    cumulative: (msg as any).cumulative ?? 0,
    breakdown: (msg as any).breakdown,
    maxFromBackend: true,
  });
}

export function handleReasoningDelta(msg: WsMessage, ctx: EventHandlerCtx): void {
  const content = (msg as any).content as string || "";
  if (!content) return;
  // 思考增量到达 = 重试已恢复，收掉「正在重试」提示
  clearPendingRetry(ctx);
  const key = reasoningKeyOf(msg);

  ctx.setChatHistory((prev) => {
    const updated = [...prev];
    const last = updated[updated.length - 1];

    // 还没有 assistant 消息（reasoning 先于 stream_start 到达，纯工具轮的常态）→ 建一条
    if (last?.role !== "assistant" || !last.segments) {
      updated.push({
        id: `assistant-${Date.now()}`,
        role: "assistant",
        segments: [{ type: "reasoning", key, content, streaming: true, startedAt: Date.now() } as ReasoningSegment],
        streaming: true,
        turnStatus: "running",
        turnGen: ctx.turnGeneration.current,
      });
      return updated;
    }

    const segs = [...last.segments];
    // 归属与落位交给纯函数（规则与理由见 reasoningPlacement.ts）：
    // 命中本块且它在末尾 → 追加；否则（未命中，或命中的块已被正文/工具打断）→ 另起一块放到末尾。
    const target = locateReasoning(segs, key);
    if (target.kind === "append") {
      const seg = segs[target.index] as ReasoningSegment;
      // 重新置 streaming：本块还在继续吐，若之前被提前折叠过则重新展开
      segs[target.index] = { ...seg, content: seg.content + content, streaming: true, startedAt: seg.startedAt ?? Date.now() };
    } else {
      // 新块一律落到消息末尾：思考是在正文之后恢复的，新块就该显示在最下面。
      // （早先会把新块插到末尾的空 text 占位段之前，那是为了让思考显示在正文上方；
      //  但「正文已经出现之后才到达的思考」按定义属于正文之后，插到前面正是那个
      //  「正文停了、上面的思考还在长」观感的来源。）
      segs.push({ type: "reasoning", key: target.key, content, streaming: true, startedAt: Date.now() } as ReasoningSegment);
    }
    updated[updated.length - 1] = { ...last, segments: segs };
    return updated;
  });

  if (ctx.statusPhaseRef.current === "thinking") {
    ctx.setStatusText("正在推理...");
    ctx.setStatusPhase("reasoning");
  }
}

/**
 * 记忆召回：本轮把哪些项目 Wiki 页面注入了上下文。
 *
 * 事件在 stream_start 之前到达（预取阶段就发了），所以此时通常还没有 assistant 消息 ——
 * 需要先建一条来承载它，这与 reasoning 的处理方式一致。
 *
 * 段刻意落在消息【最前】而非末尾：召回是这一轮开局的前提，读者应先知道 AI 手里有哪些材料，
 * 再看它据此怎么回答。
 *
 * 后端只在召回集合变化时才发（见 AgentSession.announceWikiRecall），所以这里无需去重 ——
 * 稳定期根本不会有事件到达。
 */
export function handleWikiRecall(msg: WsMessage, ctx: EventHandlerCtx): void {
  const pages = ((msg as any).pages as { title: string; stale: boolean }[]) || [];
  if (pages.length === 0) return;
  const total = ((msg as any).total as number) || pages.length;
  const seg: WikiRecallSegment = { type: "wikirecall", total, pages };

  ctx.setChatHistory((prev) => {
    const updated = [...prev];
    const last = updated[updated.length - 1];
    // 还没有 assistant 消息（召回先于 stream_start 到达，纯工具轮的常态）→ 建一条
    if (last?.role !== "assistant" || !last.segments) {
      updated.push({
        id: `assistant-${Date.now()}`,
        role: "assistant",
        segments: [seg],
        streaming: true,
        turnStatus: "running",
        turnGen: ctx.turnGeneration.current,
      });
      return updated;
    }
    // 已有本轮消息（同轮内先出过其它段）：插到最前，保持「先材料、后结论」的阅读顺序
    updated[updated.length - 1] = { ...last, segments: [seg, ...last.segments] };
    return updated;
  });
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

export function handleToolConfirmTimeout(_msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setToolConfirm(null);
}

/** ask_user 提问：把问题与选项交给输入区上方的问答卡片渲染。 */
export function handleAskUserRequest(msg: WsMessage, ctx: EventHandlerCtx): void {
  const toolCallId = (msg as any).toolCallId as string;
  const raw = (msg as any).questions;
  if (!toolCallId || !Array.isArray(raw) || raw.length === 0) return;
  ctx.setAskUser({
    toolCallId,
    questions: raw.map((q: any) => ({
      question: typeof q?.question === "string" ? q.question : "",
      options: Array.isArray(q?.options) ? q.options : [],
      multi: q?.multi === true,
      allowOther: q?.allowOther !== false,
    })),
  });
}

/** ask_form 表单请求：把声明式表单交给输入区上方的表单卡片渲染。 */
export function handleFormRequest(msg: WsMessage, ctx: EventHandlerCtx): void {
  const toolCallId = (msg as any).toolCallId as string;
  const form = (msg as any).form;
  // 字段结构合法性已由 core 侧（formSchema.normalizeFormSpec）保证，这里只挡明显不成形的载荷。
  if (!toolCallId || !form || !Array.isArray(form.fields) || form.fields.length === 0) return;
  ctx.setFormRequest({ toolCallId, spec: form });
}

/** 会话记忆：模型调用 update_memory、或用户导入 .md 之后，把最新内容交给记忆面板 */
export function handleSessionMemory(msg: WsMessage, ctx: EventHandlerCtx): void {
  const memory = (msg as any).memory;
  if (typeof memory !== "string") return;
  ctx.setMemory(memory);
}

/** 记忆的历史版本列表：记忆面板点开「历史版本」时请求 */
export function handleMemoryHistory(msg: WsMessage, ctx: EventHandlerCtx): void {
  const versions = (msg as any).versions;
  ctx.setMemoryHistory(Array.isArray(versions) ? versions : []);
}

/**
 * 会话分叉完成：新会话已创建。交给上层刷新会话列表并切到新会话 ——
 * 分叉出的会话只带记忆、不带历史，用户通常马上就会接着往下做。
 */
export function handleSessionForked(msg: WsMessage, ctx: EventHandlerCtx): void {
  const newSessionId = (msg as any).sessionId as string;
  if (!newSessionId) return;
  ctx.onSessionForkedRef.current?.(newSessionId, (msg as any).sourceId as string | undefined);
}

export function handleToolHistoryMismatch(msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setToolHistoryMismatch({ model: (msg as any).model as string });
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

/**
 * 命令风险提醒：命中风险模式但已信任的命令**照常执行**，本事件只用于把它显示出来。
 * 与审批不同，它不需要用户应答，所以只落一条可关闭/自动消失的提示。
 */
export function handleCommandRiskNotice(msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setCommandRiskNotice({
    id: (msg as any).id as string | undefined,
    command: (msg as any).command as string,
    reason: (msg as any).reason as string,
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
export { extractBasename, getModels, findModel };
