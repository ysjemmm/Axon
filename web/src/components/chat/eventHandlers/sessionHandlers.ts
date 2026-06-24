/**
 * sessionHandlers —— 会话生命周期 + 压缩事件处理
 * session_created / session_loaded / session_error /
 * compacting_start / compaction_needed / compaction_migrated / compacting_end
 */

import { MODELS } from "@/components/ModelSelector";
import {
  fallbackIntent, formatLineSuffix,
  isRelayTool, relayToolLabel, firstLine, OUTPUT_TOOLS,
} from "../utils";
import type { ToolStatus } from "@/components/ToolCallItem";
import type { AttachedFile, ChatMessage, UserSegment } from "../types";
import type { EventHandlerCtx, WsMessage } from "./types";

export function handleSessionCreated(msg: WsMessage, ctx: EventHandlerCtx): void {
  if (ctx.compactionMigratedRef.current) return;
  ctx.setReasoning(""); // 新会话：清空上一条会话残留的思考过程
  ctx.onSessionCreatedRef.current((msg as any).sessionId);
  if ((msg as any).workspace) ctx.setWorkspace((msg as any).workspace);
  if ((msg as any).workspaces) ctx.setWorkspaces((msg as any).workspaces);
}

export function handleSessionError(msg: WsMessage, ctx: EventHandlerCtx): void {
  console.error("[session]", (msg as any).message || msg);
  ctx.finishLoading();
}

export function handleSessionLoaded(msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setIsLoadingSession(false);
  ctx.setReasoning(""); // 切换/恢复会话时清空思考过程残留
  const messages = (msg as any).messages || [];
  const totalTokens = (msg as any).totalTokens || 0;
  if ((msg as any).workspace) ctx.setWorkspace((msg as any).workspace);
  if ((msg as any).workspaces) ctx.setWorkspaces((msg as any).workspaces);
  ctx.setCurrentGroupId((msg as any).workspaceGroupId || null);
  const activePendingPaths: string[] = (msg as any).pendingPaths || [];
  const activePendingEditIds: Set<string> = new Set((msg as any).pendingEditIds || []);
  const restored: ChatMessage[] = [];
  let currentAssistant: ChatMessage | null = null;
  let seq = 0;

  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "user") {
      if ((m as any)._screenshotInjection) continue;
      if (currentAssistant) {
        restored.push(currentAssistant);
        currentAssistant = null;
      }
      let content = "";
      let images: string[] | undefined;
      if (typeof m.content === "string") {
        content = m.content;
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part.type === "text") content = part.text || "";
          if (part.type === "image_url") {
            if (!images) images = [];
            images.push(part.image_url?.url || "");
          }
        }
      }
      const attached = (m as any).attachedFiles as { name: string; size: number }[] | undefined;
      const displayText = (m as any).displayText as string | undefined;
      const bodyText = attached && attached.length > 0 ? (displayText ?? "") : content;
      const attachedFiles: AttachedFile[] | undefined = attached && attached.length > 0
        ? attached.map((f) => ({ name: f.name, size: f.size, content: "" }))
        : undefined;
      const restoredSegments = (m as any).userSegments as UserSegment[] | undefined;
      restored.push({ id: `hist-u-${seq++}`, role: "user", timestamp: (m as any).timestamp as number | undefined, content: bodyText, images, attachedFiles, userSegments: restoredSegments });
    } else if (m.role === "assistant") {
      const text = typeof m.content === "string" ? (m.content || "").trim() : "";
      const hasToolCalls = m.tool_calls && m.tool_calls.length > 0;

      if (!currentAssistant) {
        currentAssistant = { id: `hist-a-${seq++}`, role: "assistant", segments: [] };
      }

      if (text) {
        currentAssistant.segments!.push({ type: "text", content: text });
      }

      if ((m as any).turnStats) {
        currentAssistant.turnStats = (m as any).turnStats;
        currentAssistant.turnStatus = "success";
      }

      if (hasToolCalls) {
        for (const tc of m.tool_calls) {
          let tcArgs: Record<string, unknown> = {};
          try { tcArgs = JSON.parse(tc.function?.arguments || "{}"); } catch { /* ignore */ }
          const toolName = tc.function?.name || "";
          if (toolName === "delegate_task") {
            currentAssistant.segments!.push({
              type: "subagent",
              id: tc.id || `sub-${seq++}`,
              intent: (tcArgs.intent as string) || "委托子 Agent 执行任务",
              skill: (tcArgs.skill as string) || null,
              prompt: (tcArgs.prompt as string) || "",
              status: "done",
              inner: [],
            });
            continue;
          }
          const pathArg = tcArgs.path as string || "";
          const shortName = pathArg ? (pathArg.split("/").pop()?.split("\\").pop() || pathArg) : "";
          const intentArg = (tcArgs.intent as string) || "";
          const isExplore = toolName === "search" || toolName === "list_dir";
          const lineSuffix = toolName === "read_file" ? formatLineSuffix(tcArgs.startLine, tcArgs.endLine) : "";
          const readNameWithLines = shortName + (lineSuffix ? ` ${lineSuffix}` : "");
          let desc: string;
          switch (toolName) {
            case "read_file": desc = shortName ? `已读取 ${readNameWithLines}` : "已读取文件"; break;
            case "create_file": desc = shortName ? `${tcArgs.overwrite === true ? "已覆盖" : "已创建"} ${shortName}` : "已创建文件"; break;
            case "str_replace": desc = shortName ? `已编辑 ${shortName}` : "已编辑文件"; break;
            case "execute_command": desc = "命令已执行"; break;
            case "search":
            case "list_dir": desc = intentArg || fallbackIntent(toolName); break;
            case "relay_create":
            case "relay_save_doc":
            case "relay_advance":
            case "relay_update_task":
            case "relay_review_task":
            case "parallel_research":
            case "parallel_execute":
              desc = relayToolLabel(toolName);
              break;
            default: desc = `已完成 ${toolName}`;
          }
          currentAssistant.segments!.push({
            type: "tool",
            id: tc.id || `tool-${seq++}-${currentAssistant.segments!.length}`,
            name: toolName,
            status: "success",
            description: desc,
            args: tcArgs,
            command: (toolName === "execute_command" || toolName === "start_process") ? (tcArgs.command as string) : undefined,
            query: isExplore ? (intentArg || fallbackIntent(toolName)) : undefined,
          });
        }
      }
    } else if (m.role === "tool") {
      if (currentAssistant?.segments) {
        const toolStatus: ToolStatus = (m as any).status === "error" ? "error" : "success";
        const toolCallId = (m as any).tool_call_id;
        const toolContent = (m as any).content || "";
        for (let i = currentAssistant.segments.length - 1; i >= 0; i--) {
          const seg = currentAssistant.segments[i];
          if (seg.type === "subagent" && seg.id === toolCallId) {
            const conclusion = toolContent.replace(/^子 Agent 已完成任务[^\n]*\n+/, "").trim();
            seg.conclusion = conclusion || undefined;
            seg.inner = conclusion ? [{ type: "text", content: conclusion }] : [];
            break;
          }
          if (seg.type === "tool" && seg.id === toolCallId) {
            seg.status = toolStatus;
            if ((m as any).mcpServer) seg.mcpServer = (m as any).mcpServer;
            if ((m as any).mcpTool) seg.mcpTool = (m as any).mcpTool;
            if (seg.mcpTool && toolStatus === "success") {
              seg.description = `调用 ${seg.mcpTool}`;
            } else if (toolStatus === "error" && seg.name !== "search" && seg.name !== "list_dir" && seg.name !== "execute_command") {
              seg.description = (m as any).userMessage || toolContent.slice(0, 120) || "操作未成功";
              if ((m as any).userMessage) seg.userMessage = (m as any).userMessage;
            }
            if (isRelayTool(seg.name) && toolStatus === "success" && toolContent) {
              seg.description = firstLine(toolContent);
            }
            if (seg.name === "create_file" && toolStatus === "success" && toolContent.startsWith("已覆盖")) {
              const cfName = typeof seg.args?.path === "string" ? (seg.args.path as string).split("/").pop()?.split("\\").pop() : "";
              seg.description = cfName ? `已覆盖 ${cfName}` : "已覆盖文件";
            }
            if (seg.name === "execute_command") {
              seg.output = (m as any).displayContent || toolContent;
              if ((m as any).displayCommand) seg.command = (m as any).displayCommand;
            } else if (OUTPUT_TOOLS.has(seg.name)) {
              seg.output = toolContent;
            }
            if ((m as any).fileDiff) {
              seg.diff = (m as any).fileDiff;
              const diffPath = (m as any).fileDiff.path as string;
              const eid = `${toolCallId}::${diffPath}`;
              if (diffPath && (activePendingEditIds.has(eid) || (activePendingEditIds.size === 0 && activePendingPaths.includes(diffPath)))) {
                seg.pending = true;
                seg.pendingPaths = [diffPath];
              }
            }
            if ((m as any).fileDiffs) {
              seg.diffs = (m as any).fileDiffs;
              const perFilePending = ((m as any).fileDiffs as { path: string }[])
                .map((d) => d.path)
                .filter((p) => p && (activePendingEditIds.has(`${toolCallId}::${p}`) || (activePendingEditIds.size === 0 && activePendingPaths.includes(p))));
              if (perFilePending.length > 0) {
                seg.pending = true;
                seg.pendingPaths = perFilePending;
              }
            }
            if ((m as any).diagnostics) seg.diagnostics = (m as any).diagnostics;
            if ((m as any).searchResults) seg.searchResults = (m as any).searchResults;
            if ((m as any).fetchResult) seg.fetchResult = (m as any).fetchResult;
            if ((m as any).powerActivated) seg.powerActivated = (m as any).powerActivated;
            break;
          }
        }
      }
    }
  }

  if (currentAssistant) {
    if (currentAssistant.segments) {
      currentAssistant.segments = currentAssistant.segments.filter(
        (s) => !(s.type === "text" && !s.content.trim())
      );
    }
    if (currentAssistant.segments && currentAssistant.segments.length > 0) {
      restored.push(currentAssistant);
    }
  }

  ctx.setChatHistory(restored);

  if (totalTokens > 0) {
    const currentModel = MODELS.find((m) => m.id === ctx.modelRef.current);
    ctx.setTokenUsage((prev) => ({ ...prev, used: totalTokens, max: currentModel?.contextWindow || prev.max }));
  }

  const restoredPending = (msg as any).pendingPaths as string[] | undefined;
  if (restoredPending && restoredPending.length > 0) {
    ctx.setPendingPaths(restoredPending);
  }
  const restoredDiffs = (msg as any).pendingDiffs as { path: string; oldContent: string; newContent: string }[] | undefined;
  if (restoredDiffs && restoredDiffs.length > 0) {
    const diffMap: Record<string, { oldContent: string; newContent: string }> = {};
    for (const d of restoredDiffs) diffMap[d.path] = { oldContent: d.oldContent, newContent: d.newContent };
    ctx.setPendingDiffs(diffMap);
  } else {
    ctx.setPendingDiffs({});
  }
}

export function handleCompactingStart(_msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setIsCompacting(true);
  ctx.setStatusText("正在压缩上下文...");
}

export function handleCompactionNeeded(msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setCompactionNeeded({
    currentTokens: (msg as any).currentTokens as number,
    maxTokens: (msg as any).maxTokens as number,
    percent: (msg as any).percent as number,
  });
  ctx.setStatusText("需要压缩上下文...");
}

export function handleCompactionMigrated(msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setIsCompacting(false);
  ctx.setCompactionNeeded(null);
  const newSessionId = (msg as any).newSessionId as string;
  ctx.setCompactionMigrated({
    newSessionId,
    parentSessionId: (msg as any).parentSessionId as string | undefined,
  });
  ctx.onCompactionMigratedRef.current?.(newSessionId);
}

export function handleCompactingEnd(msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setIsCompacting(false);
  const ok = (msg as any).success as boolean;
  const endMsg = (msg as any).message as string || (ok ? "上下文已压缩" : "压缩失败");
  if (!ok) {
    ctx.setUndoNotice({ id: Date.now(), text: endMsg });
  } else {
    ctx.setChatHistory((prev) => {
      const last = prev[prev.length - 1];
      const label = `[${endMsg}]`;
      if ((last as any)?.role === "system" && last.content === label) return prev;
      return [...prev, { id: `compact-${Date.now()}`, role: "system" as any, content: label, timestamp: Date.now() }];
    });
  }
  ctx.setStatusText(ok ? "思考中..." : endMsg);
}
