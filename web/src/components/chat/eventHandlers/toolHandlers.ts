/**
 * toolHandlers —— 工具调用事件处理（tool_call / tool_result）
 *
 * tool_call：创建/更新工具卡片段
 * tool_result：工具执行完成，更新卡片状态、输出、diff 等
 */

import {
  formatToolDescription, exploreDisplayText, formatLineSuffix,
  isRelayTool, relayToolLabel, firstLine, OUTPUT_TOOLS, toolPhaseText, extractBasename,
} from "../utils";
import type { ToolStatus } from "@/components/ToolCallItem";
import type { ToolSegment } from "../types";
import type { EventHandlerCtx, WsMessage } from "./types";
import { TOOL, TIMEOUT } from "@/lib/constants";

export function handleToolCall(msg: WsMessage, ctx: EventHandlerCtx): void {
  if (ctx.cancelled.current) return;
  if (msg.name === TOOL.DELEGATE_TASK) return;
  // 工具到来意味着本轮 reasoning 已结束，标记所有 streaming reasoning segment 完结（触发自动折叠）
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
  // 兜底：如果打字机 buffer 还有残留（后端漏发 stream_pause），加速排空。
  // 用 drain 而非借 streamEnding 提速——后者会让打字机排空后把消息标记为 success，
  // 可工具轮根本还没结束，消息会提前"完结"。drain 只排空、不收尾。
  const tw = ctx.typewriter;
  if (tw.buffer.current) tw.drain(ctx);
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
      // 软失败工具延迟展示：tool_result 紧随其后，这里不创建段
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
          command: (msg.name === TOOL.EXECUTE_COMMAND || msg.name === TOOL.START_PROCESS) ? (args.command as string) : seg.command,
          cwd: (msg.name === TOOL.EXECUTE_COMMAND || msg.name === TOOL.START_PROCESS) ? ((msg as any).cwd as string) : seg.cwd,
          query: (msg.name === TOOL.SEARCH || msg.name === TOOL.LIST_DIR)
            ? exploreDisplayText(msg.name || "", args, seg.query)
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
      command: (msg.name === TOOL.EXECUTE_COMMAND || msg.name === TOOL.START_PROCESS) ? (args.command as string) : undefined,
      cwd: (msg.name === TOOL.EXECUTE_COMMAND || msg.name === TOOL.START_PROCESS) ? ((msg as any).cwd as string) : undefined,
      query: (msg.name === TOOL.SEARCH || msg.name === TOOL.LIST_DIR)
        ? exploreDisplayText(msg.name || "", args)
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
  if (msg.name === TOOL.DELEGATE_TASK) return;

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
  }, TIMEOUT.TOOL_RESULT_RESET);

  const toolStatus = (msg as any).status as ToolStatus || "success";
  const noopEdit = !!(msg as any).noopEdit;
  ctx.setChatHistory((prev) => {
    const updated = [...prev];
    const last = updated[updated.length - 1];
    // 修复：tool_result 先于 tool_call_start（150ms 队列）到达，且 assistant 消息尚未创建时，
    // 不要丢弃结果。新建一个 assistant 消息并插入 tool 段。
    if (!last || last.role !== "assistant" || !last.segments) {
      const toolStatus: ToolStatus = (msg as any).status === "error" ? "error" : ((msg as any).status === "cancelled" ? "cancelled" : "success");
      const eventId = (msg as any).id as string || "";
      const noMatchName = msg.name || "";
      const noMatchArgs = (msg as any).args as Record<string, unknown> || {};
      const shortName = typeof noMatchArgs.path === "string" ? (noMatchArgs.path as string).split("/").pop()?.split("\\").pop() || "" : "";
      const isExplore = noMatchName === TOOL.SEARCH || noMatchName === TOOL.LIST_DIR;
      const lineSuffix = noMatchName === TOOL.READ_FILE ? formatLineSuffix(noMatchArgs.startLine, noMatchArgs.endLine) : "";
      let desc = `${noMatchName} 完成`;
      if (noMatchName === TOOL.READ_FILE) desc = shortName ? `已读取 ${shortName}${lineSuffix ? ` ${lineSuffix}` : ""}` : "已读取文件";
      else if (noMatchName === TOOL.CREATE_FILE) desc = shortName ? `${noMatchArgs.overwrite === true ? "已覆盖" : "已创建"} ${shortName}` : "已创建文件";
      else if (noMatchName === TOOL.STR_REPLACE) desc = shortName ? `已编辑 ${shortName}` : "已编辑文件";
      else if (noMatchName === TOOL.APPLY_PATCH) {
        const patchDiffs = (msg as any).fileDiffs as { path: string }[] | undefined;
        if (patchDiffs && patchDiffs.length > 0) {
          const names = patchDiffs.map((d) => d.path.split("/").pop()?.split("\\").pop() || d.path).slice(0, 3);
          desc = `已编辑 ${names.join(", ")}${patchDiffs.length > 3 ? ` 等 ${patchDiffs.length} 个文件` : ""}`;
        } else {
          desc = msg.result ? firstLine(msg.result) : "已应用补丁";
        }
      }
      else if (isExplore) desc = exploreDisplayText(noMatchName, noMatchArgs);
      else if (noMatchName === TOOL.EXECUTE_COMMAND) desc = "命令已执行";
      else if (isRelayTool(noMatchName)) desc = relayToolLabel(noMatchName);
      const segment: ToolSegment = {
        type: "tool",
        id: eventId || `tool-${Date.now()}-${noMatchName}`,
        boundId: !!eventId,
        name: noMatchName,
        status: toolStatus,
        description: desc,
        args: noMatchArgs,
        command: (noMatchName === TOOL.EXECUTE_COMMAND || noMatchName === TOOL.START_PROCESS) ? (noMatchArgs.command as string) : undefined,
        query: isExplore ? exploreDisplayText(noMatchName, noMatchArgs) : undefined,
        mcpServer: (msg as any).mcpServer,
        mcpTool: (msg as any).mcpTool,
        output: (noMatchName === TOOL.EXECUTE_COMMAND || OUTPUT_TOOLS.has(noMatchName)) ? (toolStatus === "error" && (msg as any).userMessage ? (msg as any).userMessage : (msg.result || "")) : undefined,
        diff: (msg as any).fileDiff,
        diffs: (msg as any).fileDiffs,
        noopEdit: !!(msg as any).noopEdit,
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
          const isExplore = seg.name === TOOL.SEARCH || seg.name === TOOL.LIST_DIR;
          const pendingDesc = seg.description;
          const parts = pendingDesc.match(/^(.+?)\s+(\S+\.\S+)(?:\s+(\d+-(?:\d+|EOF)))?$/);
          const rawFileName = parts ? parts[2] : null;
          const fileName = (rawFileName ? (rawFileName.split("/").pop()?.split("\\").pop() || rawFileName) : null)
            || extractBasename(seg.args?.path)
            || extractBasename((msg as any).args?.path);
          let lineSuffix = "";
          if (msg.name === TOOL.READ_FILE || seg.name === TOOL.READ_FILE) {
            const fromArgs = formatLineSuffix(
              (msg as any).args?.startLine ?? seg.args?.startLine,
              (msg as any).args?.endLine ?? seg.args?.endLine,
            );
            if (fromArgs) lineSuffix = ` ${fromArgs}`;
          }
          if (!lineSuffix && parts && parts[3]) {
            lineSuffix = ` ${parts[3]}`;
          }
          const hasOutput = seg.name === TOOL.EXECUTE_COMMAND || OUTPUT_TOOLS.has(seg.name);
          let finalDesc: string;
          if (isError && !isExplore && seg.name !== TOOL.CHECK_DIAGNOSTICS) {
            if (seg.name === TOOL.STR_REPLACE || seg.name === TOOL.CREATE_FILE) {
              finalDesc = (msg as any).userMessage || msg.result?.slice(0, 120) || "操作未成功";
            } else if (seg.name === TOOL.READ_FILE && typeof seg.args?.path === "string") {
              finalDesc = seg.args.path;
            } else {
              finalDesc = (msg as any).userMessage || msg.result?.slice(0, 100) || "执行失败";
            }
          } else if (msg.name === TOOL.EXECUTE_COMMAND) {
            finalDesc = "命令已执行";
          } else if (noopEdit && (msg.name === TOOL.STR_REPLACE || msg.name === TOOL.CREATE_FILE || msg.name === TOOL.APPLY_PATCH)) {
            finalDesc = fileName ? `${fileName} 无实际变化` : "无实际内容变化";
          } else if (msg.name === TOOL.CHECK_DIAGNOSTICS) {
            finalDesc = (msg.result || "").includes("无错误") ? "无错误" : "error";
          } else if (isExplore) {
            finalDesc = exploreDisplayText(seg.name, ((msg as any).args || seg.args) as Record<string, unknown>, seg.query);
          } else if (isRelayTool(msg.name || "")) {
            finalDesc = msg.result ? firstLine(msg.result) : relayToolLabel(msg.name || "");
          } else if (msg.name === TOOL.APPLY_PATCH) {
            // apply_patch：从 fileDiffs 提取文件名列表
            const patchDiffs = (msg as any).fileDiffs as { path: string }[] | undefined;
            if (patchDiffs && patchDiffs.length > 0) {
              const names = patchDiffs.map((d) => d.path.split("/").pop()?.split("\\").pop() || d.path).slice(0, 3);
              finalDesc = `已编辑 ${names.join(", ")}${patchDiffs.length > 3 ? ` 等 ${patchDiffs.length} 个文件` : ""}`;
            } else {
              finalDesc = msg.result ? firstLine(msg.result) : "已应用补丁";
            }
          } else if (fileName) {
            const cfResult = msg.result || "";
            const cfVerb = cfResult.includes("已存在") ? "已存在" : cfResult.startsWith("已覆盖") ? "已覆盖" : "已创建";
            const verbMap: Record<string, string> = {
              [TOOL.READ_FILE]: `已读取 ${fileName}${lineSuffix}`,
              [TOOL.CREATE_FILE]: `${cfVerb === "已存在" ? `${fileName} 已存在` : `${cfVerb} ${fileName}`}`,
              [TOOL.STR_REPLACE]: `已编辑 ${fileName}`,
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
            command: seg.name === TOOL.EXECUTE_COMMAND
              ? (((msg as any).args?.command as string) ?? seg.command)
              : seg.command,
            output: hasOutput ? (isError && (msg as any).userMessage ? (msg as any).userMessage : (msg.result || "")) : undefined,
            diff: (msg as any).fileDiff || seg.diff,
            diffs: (msg as any).fileDiffs || seg.diffs,
            noopEdit: (msg as any).noopEdit ?? (seg as any).noopEdit,
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
        const isExplore = noMatchName === TOOL.SEARCH || noMatchName === TOOL.LIST_DIR;
        const lineSuffix = noMatchName === TOOL.READ_FILE ? formatLineSuffix(noMatchArgs.startLine, noMatchArgs.endLine) : "";
        let desc = `${noMatchName} 完成`;
        if (noMatchName === TOOL.READ_FILE) desc = shortName ? `已读取 ${shortName}${lineSuffix ? ` ${lineSuffix}` : ""}` : "已读取文件";
        else if (noMatchName === TOOL.CREATE_FILE) desc = shortName ? `${noMatchArgs.overwrite === true ? "已覆盖" : "已创建"} ${shortName}` : "已创建文件";
        else if (noMatchName === TOOL.STR_REPLACE) desc = shortName ? `已编辑 ${shortName}` : "已编辑文件";
        else if (noMatchName === TOOL.APPLY_PATCH) {
          const patchDiffs = (msg as any).fileDiffs as { path: string }[] | undefined;
          if (patchDiffs && patchDiffs.length > 0) {
            const names = patchDiffs.map((d) => d.path.split("/").pop()?.split("\\").pop() || d.path).slice(0, 3);
            desc = `已编辑 ${names.join(", ")}${patchDiffs.length > 3 ? ` 等 ${patchDiffs.length} 个文件` : ""}`;
          } else {
            desc = msg.result ? firstLine(msg.result) : "已应用补丁";
          }
        }
        else if (isExplore) desc = exploreDisplayText(noMatchName, noMatchArgs);
        else if (noMatchName === TOOL.EXECUTE_COMMAND) desc = "命令已执行";
        else if (isRelayTool(noMatchName)) desc = relayToolLabel(noMatchName);
        segs.push({
          type: "tool",
          id: eventId || `tool-${Date.now()}-${noMatchName}`,
          boundId: !!eventId,
          name: noMatchName,
          status: toolStatus,
          description: desc,
          args: noMatchArgs,
          command: (noMatchName === TOOL.EXECUTE_COMMAND || noMatchName === TOOL.START_PROCESS) ? (noMatchArgs.command as string) : undefined,
          query: isExplore ? exploreDisplayText(noMatchName, noMatchArgs) : undefined,
          mcpServer: (msg as any).mcpServer,
          mcpTool: (msg as any).mcpTool,
          output: (noMatchName === TOOL.EXECUTE_COMMAND || OUTPUT_TOOLS.has(noMatchName)) ? (toolStatus === "error" && (msg as any).userMessage ? (msg as any).userMessage : (msg.result || "")) : undefined,
          diff: (msg as any).fileDiff,
          diffs: (msg as any).fileDiffs,
          noopEdit: !!(msg as any).noopEdit,
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
