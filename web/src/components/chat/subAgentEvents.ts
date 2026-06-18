/**
 * 子 Agent 内部事件应用逻辑
 * 从原 ChatPanel.tsx 拆出：把子 Agent 内部事件应用到对应 delegateId 卡片的 inner segments。
 */

import { formatToolDescription, fallbackIntent, type ToolStatus } from "@/components/ToolCallItem";
import type { WsMessage } from "@/hooks/useWebSocket";
import type { ChatMessage, SubAgentSegment, ToolSegment } from "./types";

/**
 * 把子 Agent 内部事件应用到对应 delegateId 卡片的 inner segments。
 * 这是主 agent segment 累积逻辑的精简版：无打字机，文字直接追加（实时渲染）。
 */
export function updateSubAgentInner(history: ChatMessage[], delegateId: string, event: WsMessage): ChatMessage[] {
  return history.map((m) => {
    if (m.role !== "assistant" || !m.segments) return m;
    let touched = false;
    const segs = m.segments.map((s) => {
      if (s.type !== "subagent" || s.id !== delegateId) return s;
      touched = true;
      return applyEventToSubAgent(s, event);
    });
    return touched ? { ...m, segments: segs } : m;
  });
}

/** 对单个 subagent 段应用一条内部事件，返回新的段对象 */
export function applyEventToSubAgent(sub: SubAgentSegment, event: WsMessage): SubAgentSegment {
  const inner = [...sub.inner];
  const type = event.type;

  if (type === "stream_start") {
    // 子 agent 开始输出文字：末尾确保有空 text segment
    const last = inner[inner.length - 1];
    if (!last || last.type !== "text") inner.push({ type: "text", content: "" });
    return { ...sub, inner, innerStreaming: true };
  }

  if (type === "stream_delta") {
    const last = inner[inner.length - 1];
    if (last && last.type === "text") {
      inner[inner.length - 1] = { ...last, content: last.content + (event.content || "") };
    } else {
      inner.push({ type: "text", content: event.content || "" });
    }
    return { ...sub, inner, innerStreaming: true };
  }

  if (type === "stream_end") {
    return { ...sub, inner, innerStreaming: false };
  }

  if (type === "tool_call") {
    const status = (event as any).status || "pending";
    const args = (event.args as Record<string, unknown>) || {};
    const eventId = (event as any).id as string || "";

    // executing 到来：按 id 或 name 找到对应的 pending 卡片并更新
    if (status === "executing" && eventId) {
      for (let i = inner.length - 1; i >= 0; i--) {
        const seg = inner[i];
        if (seg.type === "tool" && seg.status === "pending" && (seg.id === eventId || (!seg.boundId && seg.name === event.name))) {
          inner[i] = {
            ...seg,
            id: eventId, // 绑定后端真实 id，后续 tool_result 按此精确匹配
            boundId: true,
            description: formatToolDescription(event.name || "", undefined, args),
            args,
            command: event.name === "execute_command" ? (args.command as string) : seg.command,
            cwd: event.name === "execute_command" ? (event as any).cwd : seg.cwd,
            query: (event.name === "search" || event.name === "list_dir") ? ((args.intent as string) || (args.query as string) || seg.query || fallbackIntent(event.name)) : seg.query,
          };
          return { ...sub, inner };
        }
      }
    }

    // pending：新建卡片（流式 tool name 首次到达）
    const toolSeg: ToolSegment = {
      type: "tool",
      id: eventId || `subtool-${Date.now()}-${event.name}-${inner.length}`,
      boundId: !!eventId,
      name: event.name || "",
      status: "pending",
      description: formatToolDescription(event.name || "", undefined, args),
      args,
      command: event.name === "execute_command" ? (args.command as string) : undefined,
      cwd: event.name === "execute_command" ? (event as any).cwd : undefined,
      query: (event.name === "search" || event.name === "list_dir") ? ((args.intent as string) || (args.query as string) || fallbackIntent(event.name)) : undefined,
    };
    inner.push(toolSeg);
    return { ...sub, inner };
  }

  if (type === "tool_result") {
    const toolStatus = ((event as any).status as ToolStatus) || "success";
    const eventId = (event as any).id as string || "";

    // 优先按 id 精确匹配（消除同名多 pending 卡片的错位问题）
    let matchIdx = -1;
    if (eventId) {
      for (let i = inner.length - 1; i >= 0; i--) {
        const s = inner[i];
        if (s.type === "tool" && s.id === eventId) {
          matchIdx = i;
          break;
        }
      }
    }
    // 兜底：按 name + pending 从后往前找（旧事件无 id 时的回退）
    if (matchIdx < 0) {
      for (let i = inner.length - 1; i >= 0; i--) {
        const seg = inner[i];
        if (seg.type === "tool" && seg.name === event.name && seg.status === "pending") {
          matchIdx = i;
          break;
        }
      }
    }

    if (matchIdx >= 0) {
      const seg = inner[matchIdx] as ToolSegment;
      const isExplore = seg.name === "search" || seg.name === "list_dir";
      const parts = seg.description.match(/^(.+?)\s+(\S+\.\S+)(?:\s+(\d+-(?:\d+|EOF)))?$/);
      const fileName = parts ? parts[2] : null;
      const lineSuffix = parts && parts[3] ? ` ${parts[3]}` : "";
      let finalDesc = seg.description;
      if (event.name === "execute_command") finalDesc = "命令已执行";
      else if (event.name === "check_diagnostics") finalDesc = (event.result || "").includes("无错误") ? "无错误" : "error";
      else if (isExplore) finalDesc = seg.query || ((event as any).args?.query as string) || fallbackIntent(seg.name);
      else if (fileName) {
        const evResult = event.result || "";
        const evVerb = evResult.includes("已存在") ? "已存在" : evResult.startsWith("已覆盖") ? "已覆盖" : "已创建";
        const verbMap: Record<string, string> = {
          read_file: `已读取 ${fileName}${lineSuffix}`,
          create_file: `${evVerb === "已存在" ? `${fileName} 已存在` : `${evVerb} ${fileName}`}`,
          str_replace: `已编辑 ${fileName}`,
        };
        finalDesc = verbMap[event.name || ""] || `已完成 ${fileName}`;
      } else if (toolStatus === "error") {
        finalDesc = event.result?.slice(0, 100) || "执行失败";
      }
      inner[matchIdx] = {
        ...seg,
        status: toolStatus,
        description: finalDesc,
        args: (event as any).args || seg.args,
        output: event.name === "execute_command" ? (event.result || "") : undefined,
        diff: (event as any).fileDiff || seg.diff,
        diagnostics: (event as any).diagnostics || seg.diagnostics,
        searchResults: (event as any).searchResults || seg.searchResults,
        fetchResult: (event as any).fetchResult || seg.fetchResult,
        powerActivated: (event as any).powerActivated || seg.powerActivated,
      };
    }
    return { ...sub, inner };
  }

  // reasoning_delta 等其他事件：子 agent 卡片内暂不展示思考过程
  return sub;
}
