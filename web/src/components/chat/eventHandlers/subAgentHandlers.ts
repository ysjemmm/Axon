/**
 * subAgentHandlers —— 子 Agent 事件处理
 * sub_agent_start / sub_agent_event / sub_agent_end / error
 */

import type { ToolStatus } from "@/components/ToolCallItem";
import { updateSubAgentInner } from "../subAgentEvents";
import type { EventHandlerCtx, WsMessage } from "./types";

export function handleSubAgentStart(msg: WsMessage, ctx: EventHandlerCtx): void {
  if (ctx.cancelled.current) return;
  ctx.setChatHistory((prev) => {
    const updated = [...prev];
    const last = updated[updated.length - 1];
    const curGen = ctx.turnGeneration.current;
    if (last && last.role === "assistant" && last.turnGen !== curGen) return prev;
    const delegateId = (msg as any).delegateId as string || `sub-${Date.now()}`;
    const seg = {
      type: "subagent" as const,
      id: delegateId,
      intent: ((msg as any).intent as string) || "委托子 Agent 执行任务",
      skill: ((msg as any).skill as string) || null,
      prompt: ((msg as any).prompt as string) || "",
      status: "running" as const,
      innerStreaming: true,
      inner: [],
    };
    if (!last || last.role !== "assistant") {
      updated.push({ id: `assistant-${Date.now()}`, role: "assistant", segments: [seg], streaming: true, turnGen: curGen });
    } else {
      updated[updated.length - 1] = { ...last, segments: [...(last.segments || []), seg] };
    }
    return updated;
  });
}

export function handleSubAgentEvent(msg: WsMessage, ctx: EventHandlerCtx): void {
  if (ctx.cancelled.current) return;
  const delegateId = (msg as any).delegateId as string;
  const event = (msg as any).event as WsMessage;
  ctx.setChatHistory((prev) => {
    const last = prev[prev.length - 1];
    if (last && last.role === "assistant" && last.turnGen !== ctx.turnGeneration.current) return prev;
    return updateSubAgentInner(prev, delegateId, event);
  });
}

export function handleSubAgentEnd(msg: WsMessage, ctx: EventHandlerCtx): void {
  if (ctx.cancelled.current) return;
  const delegateId = (msg as any).delegateId as string;
  const result = (msg as any).result as string || "";
  ctx.setChatHistory((prev) => {
    const last = prev[prev.length - 1];
    if (last && last.role === "assistant" && last.turnGen !== ctx.turnGeneration.current) return prev;
    return prev.map((m) => {
      if (m.role !== "assistant" || !m.segments) return m;
      const segs = m.segments.map((s) => {
        if (s.type !== "subagent" || s.id !== delegateId) return s;
        const inner = s.inner.map((seg) =>
          seg.type === "tool" && seg.status === "pending"
            ? { ...seg, status: "success" as ToolStatus }
            : seg);
        return { ...s, status: "done" as const, innerStreaming: false, conclusion: result, inner };
      });
      return { ...m, segments: segs };
    });
  });
}

export function handleError(msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setChatHistory((prev) => [
    ...prev,
    { id: `err-${Date.now()}`, role: "assistant", segments: [{ type: "text", content: `❌ ${msg.content}` }], turnStatus: "error" },
  ]);
  ctx.finishLoading();
  ctx.setReasoning("");
}
