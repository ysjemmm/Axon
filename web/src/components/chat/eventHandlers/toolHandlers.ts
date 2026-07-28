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
import { isToolInFlight, type ToolStatus } from "@/components/ToolCallItem";
import type { ToolSegment } from "../types";
import type { EventHandlerCtx, WsMessage } from "./types";
import { TOOL, TIMEOUT } from "@/lib/constants";

export function handleToolCall(msg: WsMessage, ctx: EventHandlerCtx): void {
  if (ctx.cancelled.current) return;
  if (msg.name === TOOL.DELEGATE_TASK) return;
  // 工具卡片出现 → 该思考块已经讲完，标记 streaming=false 让它自动折叠。
  //
  // ⚠️ 这里只表达"折叠"这一 UI 意图。reasoning 段的**归属**绝不能依赖这个标志：
  // onToolCallDetected 现在在流式阶段（tool_use 块刚开头）就发 pending 卡片，
  // 而 Claude extended thinking 一轮里的块序列是 thinking → tool_use → thinking → tool_use，
  // 每张提前卡都会走到这里。早先 handleReasoningDelta 靠"找 streaming=true 的段"定位，
  // 段一被关掉，后面的 thinking 增量就只能新建段——一排空的"思考过程"标题就是这么来的。
  // 现在归属由 segment.key（轮次 + 协议块号）决定，与折叠状态彻底解耦。
  ctx.setChatHistory((prev) => {
    const last = prev[prev.length - 1];
    if (!last || last.role !== "assistant" || !last.segments) return prev;
    let changed = false;
    const segs = last.segments.map((s) => {
      if (s.type === "reasoning" && s.streaming) {
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
  // 兜底：还有积压未出字（后端漏发 stream_pause）时加速排空，让文字赶在卡片之前讲完。
  // 只能用 drain——它只排空、不碰终态。借 streamEnding/finish 提速会把整条消息标成
  // success 并 finishLoading()，而此刻工具一个都还没执行，消息就提前"完结"了：
  // 头部停转、输入框解锁，后续 executing/tool_result/下一轮正文却继续往这条消息里追加。
  const tw = ctx.typewriter;
  if (tw.hasPending()) tw.drain(ctx);
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

    // status="executing"：宿主真正开始跑这一个 → 把它从"排队中"转成"执行中"并回填参数。
    // 匹配用 isToolInFlight（queued 或 pending）：绝大多数情况命中的是流式阶段那张 queued 卡。
    if (last?.role === "assistant" && last.segments && msgStatus === "executing") {
      const segs = [...last.segments];
      let idx = -1;
      if (eventId) {
        // ① 先按 id 精确匹配。id 唯一，扫描方向无所谓。
        for (let i = segs.length - 1; i >= 0; i--) {
          const s = segs[i];
          if (s.type === "tool" && s.id === eventId) { idx = i; break; }
        }
        // ② 再按工具名回退（该段还没绑定过 id）。必须**正向**扫，取最早的那个：
        //    后端严格串行、按模型给出的顺序执行，事件是 FIFO 到达的。
        //    早先这里和 ① 合在一个倒序循环里，同名工具一轮出现多次时会认领到最后那个，
        //    于是后来的卡片被提前改成执行中，而最早那张永远等不到自己的事件、
        //    卡在"排队中/执行中"不动——表现就是"某张卡的完成态没渲染出来"。
        if (idx < 0) {
          for (let i = 0; i < segs.length; i++) {
            const s = segs[i];
            if (s.type === "tool" && !s.boundId && s.name === msg.name && isToolInFlight(s.status)) {
              idx = i; break;
            }
          }
        }
      } else {
        // 无 id：同样取最早的未完成同名段，而不是列表末尾那个
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          if (s.type === "tool" && s.name === msg.name && isToolInFlight(s.status)) { idx = i; break; }
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
      // 流式阶段的提前卡（后端 onToolCallDetected 发 status="queued"）只是"已规划、排队等执行"，
      // 此刻工具一个都没开始跑，必须落成 queued 而不是 pending——否则卡片会转圈+写"执行命令中..."，
      // 而后端是严格串行的，同一时刻只有一个工具真在执行。
      status: msgStatus === "queued" ? "queued" : "pending",
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
      // 按 id 没匹配上时才按工具名回退，且**正向**扫描取最早的未完成段：
      // 后端串行执行、结果 FIFO 到达，所以第一条 tool_result 属于最早那个调用。
      // 早先这里倒序扫描取最后一个，一轮里出现多次同名工具（如连续 create_file）时，
      // 第一个结果会被记到最后那张卡上，最早那张卡则永远停在未完成态——
      // 用户看到的就是"排队/执行中的卡都在，成功的卡没出现"。
      if (matchIdx < 0) {
        for (let i = 0; i < segs.length; i++) {
          const s = segs[i];
          if (s.type === "tool" && s.name === msg.name && isToolInFlight(s.status)) { matchIdx = i; break; }
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
