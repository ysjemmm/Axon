/**
 * toolHandlers —— 工具调用事件处理（tool_call / tool_result）
 *
 * tool_call：创建/更新工具卡片段
 * tool_result：工具执行完成，更新卡片状态、输出、diff 等
 */

import {
  formatToolDescription, fallbackIntent, formatLineSuffix,
  isRelayTool, relayToolLabel, firstLine, OUTPUT_TOOLS, toolPhaseText, extractBasename,
} from "../utils";
import type { ToolStatus } from "@/components/ToolCallItem";
import type { ToolSegment } from "../types";
import type { EventHandlerCtx, WsMessage } from "./types";

export function handleToolCall(msg: WsMessage, ctx: EventHandlerCtx): void {
  if (ctx.cancelled.current) return;
  if (msg.name === "delegate_task") return;
  // 兜底：如果打字机 buffer 还有残留（后端漏发 stream_pause），先 flush 掉，
  // 否则工具卡片插入后，残留文字会追加到错误的 segment 或丢失。
  const tw = ctx.typewriter;
  if (tw.buffer.current || tw.raf.current) {
    if (tw.raf.current) {
      cancelAnimationFrame(tw.raf.current);
      tw.raf.current = null;
    }
    tw.flush(ctx);
  }
  ctx.setStatusText(toolPhaseText(msg.name || ""));
  ctx.setStatusPhase("tool");
  ctx.setChatHistory((prev) => {
    const updated = [...prev];
    const last = updated[updated.length - 1];
    const curGen = ctx.turnGeneration.current;
    if (last && last.role === "assistant" && last.turnGen !== curGen) return prev;
    const msgStatus = (msg as any).status as string | undefined;
    const args = (msg.args as Record<string, unknown>) || {};
    const eventId = (msg as any).id as string || "";

    if (msgStatus === "success") {
      // 软失败工具延迟展示：tool_result 紧随其后，这里不创建 pending 段
      return prev;
    }

    // status="executing"：尝试更新已有的 pending 段（匹配 id 或 name）
    if (last?.role === "assistant" && last.segments && msgStatus === "executing") {
      const segs = [...last.segments];
      let idx = -1;
      if (eventId) {
        for (let i = segs.length - 1; i >= 0; i--) {
          const s = segs[i];
          if (s.type === "tool" && s.status === "pending" && (s.id === eventId || (!s.boundId && s.name === msg.name))) {
            idx = i; break;
          }
        }
      } else {
        const lastSeg = segs[segs.length - 1];
        if (lastSeg?.type === "tool" && lastSeg.name === msg.name && lastSeg.status === "pending") {
          idx = segs.length - 1;
        }
      }
      if (idx >= 0) {
        const seg = segs[idx] as ToolSegment;
        segs[idx] = {
          ...seg,
          id: eventId || seg.id,
          boundId: eventId ? true : seg.boundId,
          status: "pending",
          description: formatToolDescription(msg.name || "", undefined, args),
          args,
          command: (msg.name === "execute_command" || msg.name === "start_process") ? (args.command as string) : seg.command,
          cwd: (msg.name === "execute_command" || msg.name === "start_process") ? ((msg as any).cwd as string) : seg.cwd,
          query: (msg.name === "search" || msg.name === "list_dir")
            ? ((args.intent as string) || seg.query || fallbackIntent(msg.name))
            : seg.query,
        };
        updated[updated.length - 1] = { ...last, segments: segs };
        return updated;
      }
      // executing 找不到匹配的 pending 段 → 不返回 prev，继续往下走到「新建工具段」。
      // 原因：pending 事件可能还在 useToolCallQueue 的 150ms 延时队列里没处理，
      // 如果这里 return prev，tool_result 也找不到段、fallback 创建一张瞬间 success 的段，
      // 最后队列的 pending 事件再创建一张重复段——导致乱序+重复。
    }

    // 新建工具段（先查重：pending 事件可能在 150ms 延迟队列里，此时 executing 已建过段）
    if (eventId && last?.role === "assistant" && last.segments) {
      for (let i = last.segments.length - 1; i >= 0; i--) {
        const s = last.segments[i];
        if (s.type === "tool" && s.id === eventId) return prev;
      }
    }
    const toolSeg: ToolSegment = {
      type: "tool",
      id: eventId || `tool-${Date.now()}-${msg.name}`,
      boundId: !!eventId,
      name: msg.name || "",
      status: "pending",
      description: formatToolDescription(msg.name || "", undefined, args),
      args,
      command: (msg.name === "execute_command" || msg.name === "start_process") ? (args.command as string) : undefined,
      cwd: (msg.name === "execute_command" || msg.name === "start_process") ? ((msg as any).cwd as string) : undefined,
      query: (msg.name === "search" || msg.name === "list_dir")
        ? ((args.intent as string) || fallbackIntent(msg.name))
        : undefined,
      mcpServer: (msg as any).mcpServer,
      mcpTool: (msg as any).mcpTool,
    };

    if (!last || last.role !== "assistant") {
      updated.push({ id: `assistant-${Date.now()}`, role: "assistant", segments: [toolSeg], streaming: true, turnGen: ctx.turnGeneration.current });
    } else {
      updated[updated.length - 1] = { ...last, segments: [...(last.segments || []), toolSeg] };
    }
    return updated;
  });
}

export function handleToolResult(msg: WsMessage, ctx: EventHandlerCtx): void {
  if (ctx.cancelled.current) return;
  if (msg.name === "delegate_task") return;

  // 清除该卡片的等待输入状态
  const toolCallId = (msg as any).id as string | undefined;
  if (toolCallId) {
    ctx.setWaitingInputIds((prev) => {
      const next = new Set(prev);
      next.delete(toolCallId);
      return next;
    });
  }

  // 延迟重置状态
  if (ctx.toolResultResetTimer.current) clearTimeout(ctx.toolResultResetTimer.current);
  ctx.toolResultResetTimer.current = setTimeout(() => {
    ctx.setStatusText("思考中...");
    ctx.setStatusPhase("thinking");
    ctx.toolResultResetTimer.current = null;
  }, 300);

  const toolStatus = (msg as any).status as ToolStatus || "success";
  ctx.setChatHistory((prev) => {
    const updated = [...prev];
    const last = updated[updated.length - 1];
    // 修复：tool_result 先于 tool_call_start（150ms 队列）到达，且 assistant 消息尚未创建时，
    // 不要丢弃结果。新建一个 assistant 消息并插入 tool 段。
    if (!last || last.role !== "assistant" || !last.segments) {
      const toolStatus: ToolStatus = msg.status === "error" ? "error" : (msg.status === "cancelled" ? "cancelled" : "success");
      const eventId = (msg as any).id as string || "";
      const noMatchName = msg.name || "";
      const noMatchArgs = (msg as any).args as Record<string, unknown> || {};
      const shortName = typeof noMatchArgs.path === "string" ? (noMatchArgs.path as string).split("/").pop()?.split("\\").pop() || "" : "";
      const isExplore = noMatchName === "search" || noMatchName === "list_dir";
      const lineSuffix = noMatchName === "read_file" ? formatLineSuffix(noMatchArgs.startLine, noMatchArgs.endLine) : "";
      let desc = `${noMatchName} 完成`;
      if (noMatchName === "read_file") desc = shortName ? `已读取 ${shortName}${lineSuffix ? ` ${lineSuffix}` : ""}` : "已读取文件";
      else if (noMatchName === "create_file") desc = shortName ? `${noMatchArgs.overwrite === true ? "已覆盖" : "已创建"} ${shortName}` : "已创建文件";
      else if (noMatchName === "str_replace") desc = shortName ? `已编辑 ${shortName}` : "已编辑文件";
      else if (isExplore) desc = (noMatchArgs.intent as string) || fallbackIntent(noMatchName);
      else if (noMatchName === "execute_command") desc = "命令已执行";
      else if (isRelayTool(noMatchName)) desc = relayToolLabel(noMatchName);
      const segment: ToolSegment = {
        type: "tool",
        id: eventId || `tool-${Date.now()}-${noMatchName}`,
        boundId: !!eventId,
        name: noMatchName,
        status: toolStatus,
        description: desc,
        args: noMatchArgs,
        command: (noMatchName === "execute_command" || noMatchName === "start_process") ? (noMatchArgs.command as string) : undefined,
        query: isExplore ? ((noMatchArgs.intent as string) || fallbackIntent(noMatchName)) : undefined,
        mcpServer: (msg as any).mcpServer,
        mcpTool: (msg as any).mcpTool,
        output: (noMatchName === "execute_command" || OUTPUT_TOOLS.has(noMatchName)) ? (toolStatus === "error" && (msg as any).userMessage ? (msg as any).userMessage : (msg.result || "")) : undefined,
        diff: (msg as any).fileDiff,
        diffs: (msg as any).fileDiffs,
        diagnostics: (msg as any).diagnostics,
        searchResults: (msg as any).searchResults,
        fetchResult: (msg as any).fetchResult,
        powerActivated: (msg as any).powerActivated,
        pending: (msg as any).pending,
        hidden: (msg as any).hidden,
        resolvedPath: (msg as any).resolvedPath,
      };
      updated.push({ id: `assistant-${Date.now()}`, role: "assistant", segments: [segment], streaming: true, turnGen: ctx.turnGeneration.current });
      return updated;
    }

    if (last?.role === "assistant" && last.segments) {
      const curGen = ctx.turnGeneration.current;
      if (last.turnGen !== curGen) return prev;
      const segs = [...last.segments];
      const eventId = (msg as any).id as string || "";
      let matchIdx = -1;
      if (eventId) {
        for (let i = segs.length - 1; i >= 0; i--) {
          const s = segs[i];
          if (s.type === "tool" && s.id === eventId) { matchIdx = i; break; }
        }
      }
      if (matchIdx < 0) {
        for (let i = segs.length - 1; i >= 0; i--) {
          const s = segs[i];
          if (s.type === "tool" && s.name === msg.name && s.status === "pending") { matchIdx = i; break; }
        }
      }
      if (matchIdx >= 0) {
        const seg = segs[matchIdx] as ToolSegment;
        if (seg.type === "tool") {
          const isError = toolStatus === "error";
          const isExplore = seg.name === "search" || seg.name === "list_dir";
          const pendingDesc = seg.description;
          const parts = pendingDesc.match(/^(.+?)\s+(\S+\.\S+)(?:\s+(\d+-(?:\d+|EOF)))?$/);
          const rawFileName = parts ? parts[2] : null;
          const fileName = (rawFileName ? (rawFileName.split("/").pop()?.split("\\").pop() || rawFileName) : null)
            || extractBasename(seg.args?.path)
            || extractBasename((msg as any).args?.path);
          let lineSuffix = "";
          if (msg.name === "read_file" || seg.name === "read_file") {
            const fromArgs = formatLineSuffix(
              (msg as any).args?.startLine ?? seg.args?.startLine,
              (msg as any).args?.endLine ?? seg.args?.endLine,
            );
            if (fromArgs) lineSuffix = ` ${fromArgs}`;
          }
          if (!lineSuffix && parts && parts[3]) {
            lineSuffix = ` ${parts[3]}`;
          }
          const hasOutput = seg.name === "execute_command" || OUTPUT_TOOLS.has(seg.name);
          let finalDesc: string;
          if (isError && !isExplore && seg.name !== "check_diagnostics") {
            if (seg.name === "str_replace" || seg.name === "create_file") {
              finalDesc = (msg as any).userMessage || msg.result?.slice(0, 120) || "操作未成功";
            } else if (seg.name === "read_file" && typeof seg.args?.path === "string") {
              finalDesc = seg.args.path;
            } else {
              finalDesc = (msg as any).userMessage || msg.result?.slice(0, 100) || "执行失败";
            }
          } else if (msg.name === "execute_command") {
            finalDesc = "命令已执行";
          } else if (msg.name === "check_diagnostics") {
            finalDesc = (msg.result || "").includes("无错误") ? "无错误" : "error";
          } else if (isExplore) {
            finalDesc = seg.query || fallbackIntent(seg.name);
          } else if (isRelayTool(msg.name || "")) {
            finalDesc = msg.result ? firstLine(msg.result) : relayToolLabel(msg.name || "");
          } else if (fileName) {
            const cfResult = msg.result || "";
            const cfVerb = cfResult.includes("已存在") ? "已存在" : cfResult.startsWith("已覆盖") ? "已覆盖" : "已创建";
            const verbMap: Record<string, string> = {
              read_file: `已读取 ${fileName}${lineSuffix}`,
              create_file: `${cfVerb === "已存在" ? `${fileName} 已存在` : `${cfVerb} ${fileName}`}`,
              str_replace: `已编辑 ${fileName}`,
            };
            finalDesc = verbMap[msg.name || ""] || `已完成 ${fileName}`;
          } else {
            if ((msg as any).mcpTool || seg.mcpTool) {
              finalDesc = `调用 ${(msg as any).mcpTool || seg.mcpTool}`;
            } else {
              finalDesc = msg.result?.slice(0, 60) || seg.description;
            }
          }
          segs[matchIdx] = {
            ...seg,
            status: toolStatus,
            description: finalDesc,
            args: (msg as any).args || seg.args,
            mcpServer: (msg as any).mcpServer || seg.mcpServer,
            mcpTool: (msg as any).mcpTool || seg.mcpTool,
            command: seg.name === "execute_command"
              ? (((msg as any).args?.command as string) ?? seg.command)
              : seg.command,
            output: hasOutput ? (isError && (msg as any).userMessage ? (msg as any).userMessage : (msg.result || "")) : undefined,
            diff: (msg as any).fileDiff || seg.diff,
            diffs: (msg as any).fileDiffs || seg.diffs,
            diagnostics: (msg as any).diagnostics || seg.diagnostics,
            searchResults: (msg as any).searchResults || seg.searchResults,
            fetchResult: (msg as any).fetchResult || seg.fetchResult,
            powerActivated: (msg as any).powerActivated || seg.powerActivated,
            pending: (msg as any).pending ?? seg.pending,
            hidden: (msg as any).hidden ?? seg.hidden,
            resolvedPath: (msg as any).resolvedPath || seg.resolvedPath,
          };
        }
      } else {
        // 无匹配段：tool_result 先于 tool_call 到达（软失败工具）
        const noMatchName = msg.name || "";
        const noMatchArgs = (msg as any).args as Record<string, unknown> || {};
        const shortName = typeof noMatchArgs.path === "string" ? (noMatchArgs.path as string).split("/").pop()?.split("\\").pop() || "" : "";
        const isExplore = noMatchName === "search" || noMatchName === "list_dir";
        const lineSuffix = noMatchName === "read_file" ? formatLineSuffix(noMatchArgs.startLine, noMatchArgs.endLine) : "";
        let desc = `${noMatchName} 完成`;
        if (noMatchName === "read_file") desc = shortName ? `已读取 ${shortName}${lineSuffix ? ` ${lineSuffix}` : ""}` : "已读取文件";
        else if (noMatchName === "create_file") desc = shortName ? `${noMatchArgs.overwrite === true ? "已覆盖" : "已创建"} ${shortName}` : "已创建文件";
        else if (noMatchName === "str_replace") desc = shortName ? `已编辑 ${shortName}` : "已编辑文件";
        else if (isExplore) desc = (noMatchArgs.intent as string) || fallbackIntent(noMatchName);
        else if (noMatchName === "execute_command") desc = "命令已执行";
        else if (isRelayTool(noMatchName)) desc = relayToolLabel(noMatchName);
        segs.push({
          type: "tool",
          id: eventId || `tool-${Date.now()}-${noMatchName}`,
          boundId: !!eventId,
          name: noMatchName,
          status: toolStatus,
          description: desc,
          args: noMatchArgs,
          command: (noMatchName === "execute_command" || noMatchName === "start_process") ? (noMatchArgs.command as string) : undefined,
          query: isExplore ? ((noMatchArgs.intent as string) || fallbackIntent(noMatchName)) : undefined,
          mcpServer: (msg as any).mcpServer,
          mcpTool: (msg as any).mcpTool,
          output: (noMatchName === "execute_command" || OUTPUT_TOOLS.has(noMatchName)) ? (toolStatus === "error" && (msg as any).userMessage ? (msg as any).userMessage : (msg.result || "")) : undefined,
          diff: (msg as any).fileDiff,
          diffs: (msg as any).fileDiffs,
          diagnostics: (msg as any).diagnostics,
          searchResults: (msg as any).searchResults,
          fetchResult: (msg as any).fetchResult,
          powerActivated: (msg as any).powerActivated,
          pending: (msg as any).pending,
          hidden: (msg as any).hidden,
          resolvedPath: (msg as any).resolvedPath,
        });
        updated[updated.length - 1] = { ...last, segments: segs };
        return updated;
      }
      updated[updated.length - 1] = { ...last, segments: segs };
      return updated;
    }
    return prev;
  });
}
