/**
 * turnHandlers —— 轮次取消/错误事件处理
 */

import type { CreditDetail } from "../types";
import { sealReasoning } from "../reasoningPlacement";
import type { EventHandlerCtx, WsMessage } from "./types";

/**
 * 这条"轮次收尾事件"是否属于**用户取消的那一轮**、且已被新一轮超越（应整段丢弃）。
 *
 * ── 为什么需要它 ──
 * 一次用户取消，后端会从**不止一条**收尾事件里挑着发：cancel() 里同步发出的 turn_cancelled
 * 兜底、agent loop 解栈时补发的那条 turn_cancelled、取消路径的 stream_end。它们都可能比前端
 * 把下一条排队消息真正发出去还晚 —— 前端收到 cancel 后立刻本地收尾，出队 effect 随即放行，
 * 50ms 后 sendNow 就发了新一轮。迟到的收尾落到新一轮身上时，会无条件收掉新一轮的
 * loading/状态文字（对话区看起来"没开始"），并顺势把出队闸门打开，让再下一条排队消息
 * 也发出去（两条排队任务并跑）。
 *
 * 判据 = 「代数已被新一轮超越」+「这条终态确实不可能属于当前轮」：
 *   · elapsed === 0        → 取消兜底事件的签名（elapsed 恒为 0）；当前轮不可能时长为 0
 *   · elapsed > 当前轮年龄  → 终态报的是**它自己那一轮**的时长，不可能超过该轮的年龄
 *                            （年龄 = 当前轮开始至今）；超过即属于更早的一轮
 * 反过来，确实属于当前轮的收尾不会被误伤：它的 elapsed 必然 ≤ 年龄（后端那一轮就落在
 * 「sendNow → 收到事件」这段里），于是 provider abort_error、预算门「停止」、删除运行中的 relay
 * 这些"终止当前轮"的路径仍照常收 loading —— 不会回到"后端自发终止后 loading 永久卡住"的老问题。
 *
 * 调用方负责再叠加自己的语义约束：turn_cancelled 还要求 reason === "cancelled"
 * （reason "error" 只可能终止当前轮）；stream_end 不带 reason，只能靠这里的时间线判据。
 */
export function isStaleCancelledTurnEnd(ctx: EventHandlerCtx, msg: WsMessage): boolean {
  const cancelledGeneration = ctx.cancelledTurnGeneration.current;
  // 没有取消标记（后端自发终止、或新一轮还没出现）→ 不是陈旧事件
  if (cancelledGeneration === null || cancelledGeneration >= ctx.turnGeneration.current) return false;
  const rawElapsed = (msg as { elapsed?: unknown }).elapsed;
  const eventElapsed = typeof rawElapsed === "number" ? rawElapsed : 0;
  const currentTurnAge = Date.now() - (ctx.turnStartTime.current || Date.now());
  return eventElapsed === 0 || eventElapsed > currentTurnAge;
}

/**
 * 异常收尾：把最后一条仍在流式中的 assistant 消息落成终态。
 *
 * ── 为什么需要它 ──
 * 一轮的"结束"由**两个**独立标志表达，缺一不可：
 * · isLoading            控制输入框（发送/停止按钮）与 ChatPanel 的 pending 头部
 * · message.streaming    控制这条消息自己的头部（AxonSpark 是否转、"Axon" 名字是否出现、
 *                        思考块是否自动折叠、底部 Credits/Elapsed 是否显示）
 *
 * 正常路径（打字机 finalizeStreaming / turn_cancelled / 断线 / cancelTurn）两个都收。
 * 但两条**错误**路径早先只调了 finishLoading()，没人管 streaming：
 *   · session_error（handleSessionError）
 *   · error（handleError，extension.ts 里 hub.dispatch 抛非 abort 异常时发的就是这个）
 * 结果是输入框解锁了、消息头部却永远在转圈，看起来"AI 还在回复但其实早停了"。
 * 后端这两条路径都不发 stream_end / turn_cancelled，所以前端不会再有第二次机会收尾。
 *
 * ── 顺带做的两件事 ──
 * ① 打字机先 flush 再 cancel：flush 把已到达但还没出字的残余写进当前消息（异常不等于要吞字），
 *    cancel 停掉 RAF 循环。不 cancel 的话循环会一直空转，而且后续 handleError 追加 ❌ 消息后，
 *    appendToLastText 会把残余写到那条 ❌ 消息上——串到错误的消息里去。
 * ② 清空状态文字：留着陈旧值会让之后任何"loading 但消息还没建好"的瞬间闪出上一轮的文案
 *    （如"正在推理..."）。与 turn_cancelled、断线处理保持同一套收尾动作。
 */
export function finalizeStreamingTurnAsError(ctx: EventHandlerCtx): void {
  ctx.typewriter.flush(ctx);
  ctx.typewriter.cancel();
  ctx.setChatHistory((prev) => {
    // 反向找最后一条 assistant 消息：只有它可能还挂着 streaming。
    // 已经是终态就原样返回，避免把正常完成的一轮误标成 error。
    for (let i = prev.length - 1; i >= 0; i--) {
      const m = prev[i];
      if (m.role !== "assistant") continue;
      if (!m.streaming) return prev;
      const updated = [...prev];
      // 出错收尾同样要给思考段封口，否则思考块会永久转圈、不显示耗时
      const sealed = sealReasoning(m.segments || []);
      updated[i] = { ...m, streaming: false, turnStatus: "error", ...(sealed ? { segments: sealed } : {}) };
      return updated;
    }
    return prev;
  });
  ctx.setStatusText("");
  ctx.setStatusPhase("");
}

export function handleTurnCancelled(msg: WsMessage, ctx: EventHandlerCtx): void {
  // ── 治本：事件自带轮次标识时，直接按标识归属，不再靠时间线推断 ──
  // 后端现在会在收尾事件上原样带回本轮用户消息的 clientMessageId（见 agentSession.send）。
  // 标识与当前轮不一致 ⇒ 这是**已经过去那一轮**的收尾，必须丢弃：否则它会把新一轮的
  // loading / 状态文字抹掉（表现为"排队消息已发出、对话区却没开始"），
  // 并重新打开出队闸门（表现为"两条排队消息并发跑"）。
  // 高可用：老后端不带该字段时落到下面的 elapsed 推断，行为与改动前一致。
  const evTurnId = (msg as any).clientMessageId as string | undefined;
  const curTurnId = ctx.currentTurnClientMessageId.current;
  if (evTurnId && curTurnId && evTurnId !== curTurnId) return;
  // 终止原因由后端给出：abort_error（provider/网关异常）是 "error"，用户取消 / 预算暂停是 "cancelled"。
  // 早先前端一律硬编码成 "cancelled"，于是后端落盘的 "error" 在实时界面上被抹平——
  // 用户看到的"已取消"其实可能是"网关挂了"，两者无从区分。
  // 兼容旧后端：不带 reason 时按 "cancelled" 处理（与改动前行为一致）。
  const reason: "cancelled" | "error" = (msg as any).reason === "error" ? "error" : "cancelled";

  // ── 甩掉"用户取消的那一轮"迟到的收尾 ──────────────────────────────────
  // reason "error"（provider/网关 abort_error）只可能终止当前轮，永远不算陈旧（见 isStaleCancelledTurnEnd）。
  if (reason === "cancelled" && isStaleCancelledTurnEnd(ctx, msg)) {
    // 上一轮已由 cancelTurn 在本地落了终态，这里整段丢弃即可。
    // ⚠️ 只清消息守卫，**不清** cancelledTurnGeneration：同一轮取消的收尾事件不止一条，
    // 标记若在此被清掉，紧随其后的那一条就会被当成"当前轮的终态"去收新一轮的 loading。
    ctx.cancelledTurnMsgId.current = null;
    return;
  }
  const stats = {
    elapsed: (msg as any).elapsed || 0,
    tokens: (msg as any).tokens || 0,
    model: (msg as any).model as string | undefined,
    modelName: (msg as any).modelName as string | undefined,
    providerName: (msg as any).providerName as string | undefined,
    effort: (msg as any).effort as string | undefined,
    credits: (msg as any).credits as number | undefined,
    creditDetail: (msg as any).creditDetail as CreditDetail | undefined,
    billing: (msg as any).billing,
    usage: (msg as any).usage,
    cost: (msg as any).cost,
  };
  const targetMsgId = ctx.cancelledTurnMsgId.current;
  ctx.cancelledTurnMsgId.current = null;
  const fallbackId = `assistant-${reason}-${Date.now()}`;
  ctx.setChatHistory((prev) => {
    let found = false;
    const updated = [...prev];
    for (let i = updated.length - 1; i >= 0; i--) {
      if (updated[i].role === "assistant") {
        if (targetMsgId && updated[i].id !== targetMsgId) continue;
        const sealedSegments = sealReasoning(updated[i].segments || []);
        updated[i] = {
          ...updated[i],
          streaming: false,
          turnStatus: reason,
          turnStats: stats,
          ...(sealedSegments ? { segments: sealedSegments } : {}),
        };
        found = true;
        break;
      }
    }
    if (!found) {
      updated.push({
        id: fallbackId,
        role: "assistant",
        timestamp: Date.now(),
        segments: [],
        streaming: false,
        turnStatus: reason,
        turnStats: stats,
        turnGen: ctx.turnGeneration.current,
      });
    }
    return updated;
  });
  ctx.setReasoning("");

  // turn_cancelled 是本轮的终结事件，**无论由谁发起**，所以这里必须无条件收掉 loading 态。
  //
  // 早先这里被 `if (ctx.cancelled.current)` 挡着，而那个标志恰好只在「用户点停止」时为真——
  // 也就是唯一**不需要**它的那条路径（cancelTurn 自己已经调过 finishLoading）。
  // 后端自发终止的两条路径反而被排除了：
  //   · agentSession 的 abort_error（provider/网关异常）
  //   · CreditBudgetGate 硬暂停后用户选「停止」（走 credit_budget_choice，不是 cancelTurn）
  // 这两种情况下 cancelled.current 是 false，于是消息已落终态（streaming=false）而 isLoading
  // 仍为 true。ChatPanel 的 showPendingAssistantHeader = isLoading && !assistantTurnStarted
  // 因此恒真，消息下方永久挂着一个"进行中"头部，显示的还是上一阶段残留的 statusText
  // （如"正在推理..."）——看起来像凭空又起了一轮，其实只是卡住的 loading + 陈旧文字。
  //
  // 「用户取消后立刻发新消息、迟到的 turn_cancelled 才到」这类陈旧事件已在函数开头被甩掉
  // （判据见那里），所以这里的无条件收尾只作用于**确实属于当前轮**的终态：
  // 走到这里要么没有取消标记，要么 reason/时长表明它不可能属于更早的一轮。
  // handleTurnError 也是无条件 finishLoading，行为在此保持一致。
  ctx.finishLoading();
  // 状态文字一并清空：留着陈旧值会让之后任何"loading 但消息还没建好"的瞬间闪出上一轮的文字。
  // 与断线处理（useChatSession 的 !connected 分支）保持同一套收尾动作。
  ctx.setStatusText("");
  ctx.setStatusPhase("");
}

export function handleTurnError(msg: WsMessage, ctx: EventHandlerCtx): void {
  console.error("[session]", (msg as any).message || msg);
  // 与另外两条错误路径共用同一套收尾（顺带补上打字机停机与状态文字清空，
  // 早先这里只置了 streaming/turnStatus）。
  finalizeStreamingTurnAsError(ctx);
  ctx.finishLoading();
}
