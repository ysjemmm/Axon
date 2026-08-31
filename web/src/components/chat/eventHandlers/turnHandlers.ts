/**
 * turnHandlers —— 轮次取消/错误事件处理
 */

import type { CreditDetail } from "../types";
import type { EventHandlerCtx, WsMessage } from "./types";

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
      updated[i] = { ...m, streaming: false, turnStatus: "error" };
      return updated;
    }
    return prev;
  });
  ctx.setStatusText("");
  ctx.setStatusPhase("");
}

export function handleTurnCancelled(msg: WsMessage, ctx: EventHandlerCtx): void {
  const stats = {
    elapsed: (msg as any).elapsed || 0,
    tokens: (msg as any).tokens || 0,
    model: (msg as any).model as string | undefined,
    modelName: (msg as any).modelName as string | undefined,
    credits: (msg as any).credits as number | undefined,
    creditDetail: (msg as any).creditDetail as CreditDetail | undefined,
  };
  // 终止原因由后端给出：abort_error（provider/网关异常）是 "error"，用户取消 / 预算暂停是 "cancelled"。
  // 早先前端一律硬编码成 "cancelled"，于是后端落盘的 "error" 在实时界面上被抹平——
  // 用户看到的"已取消"其实可能是"网关挂了"，两者无从区分。
  // 兼容旧后端：不带 reason 时按 "cancelled" 处理（与改动前行为一致）。
  const reason: "cancelled" | "error" = (msg as any).reason === "error" ? "error" : "cancelled";
  const targetMsgId = ctx.cancelledTurnMsgId.current;
  ctx.cancelledTurnMsgId.current = null;
  const fallbackId = `assistant-${reason}-${Date.now()}`;
  ctx.setChatHistory((prev) => {
    let found = false;
    const updated = [...prev];
    for (let i = updated.length - 1; i >= 0; i--) {
      if (updated[i].role === "assistant") {
        if (targetMsgId && updated[i].id !== targetMsgId) continue;
        updated[i] = {
          ...updated[i],
          streaming: false,
          turnStatus: reason,
          turnStats: stats,
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
  // 代价：极少数情况下（用户取消后立刻发新消息，迟到的 turn_cancelled 才到）会把新一轮的
  // loading 提前收掉。事件本身不带 turn 代数，前端无法精确甩掉这类陈旧事件。但那只是
  // spinner 早收，消息仍靠 streaming 标志正常渲染，可自愈；相比必然复现的永久卡死，值得。
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
