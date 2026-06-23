/**
 * turnHandlers —— 轮次取消/错误事件处理
 */

import type { CreditDetail } from "../types";
import type { EventHandlerCtx, WsMessage } from "./types";

export function handleTurnCancelled(msg: WsMessage, ctx: EventHandlerCtx): void {
  const stats = {
    elapsed: (msg as any).elapsed || 0,
    tokens: (msg as any).tokens || 0,
    model: (msg as any).model as string | undefined,
    credits: (msg as any).credits as number | undefined,
    creditDetail: (msg as any).creditDetail as CreditDetail | undefined,
  };
  const targetMsgId = ctx.cancelledTurnMsgId.current;
  ctx.cancelledTurnMsgId.current = null;
  const fallbackId = `assistant-cancelled-${Date.now()}`;
  ctx.setChatHistory((prev) => {
    let found = false;
    const updated = [...prev];
    for (let i = updated.length - 1; i >= 0; i--) {
      if (updated[i].role === "assistant") {
        if (targetMsgId && updated[i].id !== targetMsgId) continue;
        updated[i] = {
          ...updated[i],
          streaming: false,
          turnStatus: "cancelled",
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
        turnStatus: "cancelled",
        turnStats: stats,
        turnGen: ctx.turnGeneration.current,
      });
    }
    return updated;
  });
  ctx.setReasoning("");
  if (ctx.cancelled.current) {
    ctx.finishLoading();
  }
}

export function handleTurnError(msg: WsMessage, ctx: EventHandlerCtx): void {
  console.error("[session]", (msg as any).message || msg);
  ctx.setChatHistory((prev) => {
    const updated = [...prev];
    const last = updated[updated.length - 1];
    if (last?.role === "assistant") {
      updated[updated.length - 1] = { ...last, streaming: false, turnStatus: "error" };
    }
    return updated;
  });
  ctx.finishLoading();
}
