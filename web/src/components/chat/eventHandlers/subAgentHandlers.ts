/**
 * subAgentHandlers —— 子 Agent 事件处理
 * sub_agent_start / sub_agent_event / sub_agent_end / error
 */

import { isToolInFlight, type ToolStatus } from "@/components/ToolCallItem";
import { updateSubAgentInner } from "../subAgentEvents";
import type { EventHandlerCtx, WsMessage } from "./types";
import { finalizeStreamingTurnAsError } from "./turnHandlers";

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

/**
 * parallel_research_start / parallel_execute_start：一次性创建多个 subagent 段（并列展示），
 * 复用 sub_agent_start 的单个卡片渲染逻辑——每个子任务的 delegateId 对应一个卡片，
 * 后续 sub_agent_event / sub_agent_end 会按 delegateId 路由进各自的卡片。
 *
 * 这两个事件此前完全没有前端处理（掉进事件路由的 default 分支），导致 parallel_research
 * 执行期间用户只能看到外层一张"执行中"的卡片，看不到 N 路子 Agent 各自在做什么、进度如何——
 * 长调研任务体验上等同于卡死无反馈。
 */
export function handleParallelBatchStart(msg: WsMessage, ctx: EventHandlerCtx): void {
  if (ctx.cancelled.current) return;
  const tasks = ((msg as any).tasks as { delegateId: string; intent: string; prompt: string }[]) || [];
  if (tasks.length === 0) return;
  ctx.setChatHistory((prev) => {
    const updated = [...prev];
    const last = updated[updated.length - 1];
    const curGen = ctx.turnGeneration.current;
    if (last && last.role === "assistant" && last.turnGen !== curGen) return prev;
    const newSegs = tasks.map((t) => ({
      type: "subagent" as const,
      id: t.delegateId,
      intent: t.intent || "并行子任务",
      skill: null,
      prompt: t.prompt || "",
      status: "running" as const,
      innerStreaming: true,
      inner: [],
    }));
    if (!last || last.role !== "assistant") {
      updated.push({ id: `assistant-${Date.now()}`, role: "assistant", segments: newSegs, streaming: true, turnGen: curGen });
    } else {
      updated[updated.length - 1] = { ...last, segments: [...(last.segments || []), ...newSegs] };
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
        // 子 agent 已结束：内部还没跑完的卡片（排队中/执行中）一并收成 success
        const inner = s.inner.map((seg) =>
          seg.type === "tool" && isToolInFlight(seg.status)
            ? { ...seg, status: "success" as ToolStatus }
            : seg);
        return { ...s, status: "done" as const, innerStreaming: false, conclusion: result, inner };
      });
      return { ...m, segments: segs };
    });
  });
}

export function handleError(msg: WsMessage, ctx: EventHandlerCtx): void {
  // 先给正在进行中的那条消息落终态，再追加错误消息。
  //
  // 顺序不能反：finalizeStreamingTurnAsError 找的是"最后一条仍在 streaming 的 assistant 消息"，
  // 一旦 ❌ 消息先入队，它就成了最后一条 assistant——而它 streaming 为假，收尾函数直接返回，
  // 真正卡着的那条反而被跳过。
  //
  // 早先这里只追加 ❌ 消息 + 收 isLoading，上一条消息的 streaming 没人清：输入框解锁了，
  // 但它的头部图标继续转、"Axon" 名字不出现、思考块保持展开。而这条路径（extension.ts 里
  // hub.dispatch 抛非 abort 异常时 emit 的 error 事件）之后不会再有 stream_end，
  // 那条消息就永久停在进行中。
  finalizeStreamingTurnAsError(ctx);
  ctx.setChatHistory((prev) => [
    ...prev,
    { id: `err-${Date.now()}`, role: "assistant", segments: [{ type: "text", content: `❌ ${msg.content}` }], turnStatus: "error" },
  ]);
  ctx.finishLoading();
  ctx.setReasoning("");
}
