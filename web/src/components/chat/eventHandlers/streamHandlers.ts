/**
 * streamHandlers —— 流式文本事件处理（stream_start/delta/pause/end）
 */

import type { EventHandlerCtx, WsMessage } from "./types";

export function handleStreamStart(_msg: WsMessage, ctx: EventHandlerCtx): void {
  const tw = ctx.typewriter;
  ctx.cancelled.current = false;
  // 不能直接 `buffer.current = ""`：截断续写（finish_reason=length）等场景下后端会再发一次
  // stream_start，此时上一轮可能还有没出完的字，清空就是吞字。
  // 改为先把残余写进**当前**（也就是上一轮的）text segment，再往下新建本轮的空 segment——
  // 两个 setChatHistory updater 按调用顺序执行，所以残余落在新段之前，顺序是对的。
  tw.flush(ctx);
  // 不再清空全局 reasoning 状态（已改为 segment 内联渲染）
  ctx.setStatusText("正在回复...");
  ctx.setStatusPhase("responding");
  ctx.setChatHistory((prev) => {
    const updated = [...prev];
    const last = updated[updated.length - 1];
    // 复用最后一个 assistant 消息，但仅当它仍在 streaming 状态（同轮续写）。
    // 如果已结束（streaming=false，可能是上一轮截断续写或新一轮），则新建 assistant 消息，
    // 避免把不同轮次/续写的内容错误拼接在一起。
    if (last?.role === "assistant" && last.streaming) {
      const segs = [...(last.segments || [])];
      // 把上一轮的 reasoning segment 标记为完结（streaming=false）
      for (let i = segs.length - 1; i >= 0; i--) {
        const seg = segs[i];
        if (seg.type === "reasoning" && seg.streaming) {
          segs[i] = { ...seg, streaming: false };
          break;
        }
      }
      // 重试成功：移除 retry segment（重连已成功，不再需要展示）
      const cleaned = segs.filter((s) => s.type !== "retry");
      const lastSeg = cleaned[cleaned.length - 1];
      // 自动续写（finish_reason=length）时，现有 text segment 已有内容，
      // 新建一个 text segment 以区分两段内容，避免前后拼接导致时序混乱。
      if (lastSeg?.type === "text" && (lastSeg as any).content?.length > 0) {
        cleaned.push({ type: "text", content: "" });
      } else if (!lastSeg || lastSeg.type !== "text") {
        cleaned.push({ type: "text", content: "" });
      }
      updated[updated.length - 1] = { ...last, segments: cleaned, streaming: true, turnStatus: "running", turnGen: ctx.turnGeneration.current };
      return updated;
    }
    // 无符合条件的 assistant 消息 → 新建
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
  // stream_pause 意味着即将出工具卡片，需要把 buffer 排空后再插卡片。
  //
  // 早先是"停掉 RAF + 瞬间 flush"，前提假设是"pause 时 buffer 残留通常只有几十个字符"。
  // 这个假设不成立：模型的 text block 和 tool_use block 是紧挨着来的，几百字可能在
  // 一两百毫秒内吐完，RAF 还没消化几帧，于是残余"啪"地一次性冒出、紧接着卡片弹出。
  //
  // 改为加速逐帧排空（400ms 封顶）。排空期间事件队列会暂缓放行后续卡片事件，
  // 卡片自然接在文字讲完之后出现。
  ctx.typewriter.drain(ctx);
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
  // stream_end 意味着整轮结束，标记所有还在 streaming 的 reasoning segment 完结
  ctx.setChatHistory((prev) => {
    const last = prev[prev.length - 1];
    if (!last || last.role !== "assistant" || !last.segments) return prev;
    let changed = false;
    const segs = last.segments.map((s) => {
      if (s.type === "reasoning" && (s as any).streaming) {
        changed = true;
        return { ...s, streaming: false };
      }
      return s;
    });
    if (!changed) return prev;
    const updated = [...prev];
    updated[updated.length - 1] = { ...last, segments: segs };
    return updated;
  });
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
