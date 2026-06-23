/**
 * streamHandlers —— 流式文本事件处理（stream_start/delta/pause/end）
 */

import type { EventHandlerCtx, WsMessage } from "./types";

export function handleStreamStart(_msg: WsMessage, ctx: EventHandlerCtx): void {
  const tw = ctx.typewriter;
  ctx.cancelled.current = false;
  tw.buffer.current = "";
  ctx.setReasoning("");
  ctx.setStatusText("正在回复...");
  ctx.setStatusPhase("responding");
  ctx.setChatHistory((prev) => {
    const updated = [...prev];
    const last = updated[updated.length - 1];
    if (last?.role === "assistant") {
      const segs = [...(last.segments || [])];
      const lastSeg = segs[segs.length - 1];
      if (!lastSeg || lastSeg.type !== "text") {
        segs.push({ type: "text", content: "" });
      }
      updated[updated.length - 1] = { ...last, segments: segs, streaming: true, turnStatus: "running", turnGen: ctx.turnGeneration.current };
      return updated;
    }
    return [...prev, { id: `assistant-${Date.now()}`, role: "assistant", segments: [{ type: "text", content: "" }], streaming: true, turnStatus: "running", turnGen: ctx.turnGeneration.current }];
  });
  tw.start(ctx);
}

export function handleStreamDelta(msg: WsMessage, ctx: EventHandlerCtx): void {
  if (ctx.cancelled.current) return;
  ctx.typewriter.buffer.current += (msg.content || "");
}

export function handleStreamPause(_msg: WsMessage, ctx: EventHandlerCtx): void {
  if (ctx.cancelled.current) return;
  const tw = ctx.typewriter;
  if (tw.raf.current) {
    cancelAnimationFrame(tw.raf.current);
    tw.raf.current = null;
  }
  tw.flush(ctx);
}

export function handleStreamEnd(msg: WsMessage, ctx: EventHandlerCtx): void {
  if (ctx.cancelled.current) return;
  const tw = ctx.typewriter;
  const stats = {
    elapsed: (msg as any).elapsed || 0,
    tokens: (msg as any).tokens || 0,
    model: (msg as any).model as string | undefined,
    credits: (msg as any).credits as number | undefined,
    creditDetail: (msg as any).creditDetail as any | undefined,
  };
  // 打字机还在跑 → 标记收尾，tick 会在 buffer 排空后自动 flush + finishLoading
  if (tw.raf.current) {
    tw.streamEnding.current = stats;
    return;
  }
  // 没有 RAF → 直接 flush 残余 + 更新终态
  const remaining = tw.buffer.current;
  tw.buffer.current = "";
  ctx.setChatHistory((prev) => {
    const updated = [...prev];
    const last = updated[updated.length - 1];
    if (last?.role === "assistant" && last.segments) {
      const segs = [...last.segments];
      if (remaining) {
        let textIdx = -1;
        for (let i = segs.length - 1; i >= 0; i--) {
          if (segs[i].type === "text") { textIdx = i; break; }
        }
        if (textIdx >= 0) {
          const textSeg = segs[textIdx];
          segs[textIdx] = { type: "text" as const, content: (textSeg as any).content + remaining } as any;
        }
      }
      updated[updated.length - 1] = { ...last, segments: segs, streaming: false, turnStats: stats, turnStatus: "success" };
    }
    return updated;
  });
  ctx.finishLoading();
}
