/**
 * sessionHandlers —— 会话生命周期 + 压缩事件处理
 * session_created / session_loaded / session_error /
 * compacting_start / compaction_needed / compaction_migrated / compacting_end
 */

import {
  exploreDisplayText, formatLineSuffix,
  isRelayTool, relayToolLabel, firstLine, OUTPUT_TOOLS,
} from "../utils";
import type { ToolStatus } from "@/components/ToolCallItem";
import type { AttachedFile, BackgroundNoticeInfo, ChatMessage, ContextBreakdown, UserSegment } from "../types";
import type { EventHandlerCtx, WsMessage } from "./types";
import type { PendingSteer } from "../useChatSession";
import { sealReasoning } from "../reasoningPlacement";
import { finalizeStreamingTurnAsError } from "./turnHandlers";
import { artifactReadDescription } from "../artifactMeta";

export function handleSessionCreated(msg: WsMessage, ctx: EventHandlerCtx): void {
  if (ctx.compactionMigratedRef.current) return;
  // 先认领新会话：sessionId prop 由 null 变为新 id 会触发加载 effect，
  // 此时 ownedSessionId 已指向新 id，effect 命中"自己创建、非重连"跳过分支，
  // 不会清空历史 / 重置 isLoading（否则首条消息的流式状态会被冲掉）。
  ctx.ownedSessionId.current = (msg as any).sessionId;
  ctx.setReasoning(""); // 新会话：清空上一条会话残留的思考过程
  ctx.onSessionCreatedRef.current((msg as any).sessionId);
  if ((msg as any).workspace) ctx.setWorkspace((msg as any).workspace);
  if ((msg as any).workspaces) ctx.setWorkspaces((msg as any).workspaces);
}

export function handleSessionError(msg: WsMessage, ctx: EventHandlerCtx): void {
  console.error("[session]", (msg as any).message || msg);
  // 消息自己的终态必须一起落。早先这里只收 isLoading，那条还在 streaming 的 assistant
  // 消息就永远停在"进行中"：头部图标一直转、思考块不折叠——而后端这条路径不会再发
  // stream_end / turn_cancelled，前端没有第二次收尾机会。详见 finalizeStreamingTurnAsError。
  finalizeStreamingTurnAsError(ctx);
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
  // 随会话一起恢复记忆（后端在 session_loaded 里附带）：分叉出的会话只带记忆、
  // 不带历史，若不在加载时回填，记忆面板会显示为空、与后端实际注入的内容对不上。
  if (typeof (msg as any).memory === "string") ctx.setMemory((msg as any).memory);
  const activePendingPaths: string[] = (msg as any).pendingPaths || [];
  const activePendingEditIds: Set<string> = new Set((msg as any).pendingEditIds || []);
  const restored: ChatMessage[] = [];
  let currentAssistant: ChatMessage | null = null;
  let seq = 0;

  for (const m of messages) {
    if (m.role === "system") continue;

    // 压缩留下的「摘要 + 确认」两条是给模型的上下文，不是对话：摘要显示成一条可展开的
    // 「早期对话已压缩」分隔，确认那句不显示。早先它们原样显示成用户气泡和一句 AI 回复。
    if (m.role === "user" && typeof m.content === "string" && m.content.startsWith("[对话历史摘要]")) {
      if (currentAssistant) {
        restored.push(currentAssistant);
        currentAssistant = null;
      }
      restored.push({
        id: `hist-summary-${seq++}`,
        role: "system" as any,
        content: "[早期对话已压缩]",
        summary: m.content.replace(/^\[对话历史摘要\]\n?/, ""),
      });
      continue;
    }
    if (m.role === "assistant" && typeof m.content === "string" && m.content.startsWith("明白，我已了解之前的对话内容")) continue;

    if (m.role === "user") {
      if ((m as any)._screenshotInjection) continue;
      // 回复过程中并入的后台任务通知：不显示，前后两段回复接在同一条里
      if ((m as any)._bgInline) continue;
      if (currentAssistant) {
        restored.push(currentAssistant);
        currentAssistant = null;
      }
      // 压缩时被钉在摘要后的当前请求：存档里已有一份副本显示过，这里不再重复
      if ((m as any)._shownInArchive && !(m as any)._archived) continue;
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
      const clientMessageId = (m as any).clientMessageId as string | undefined;
      const effort = typeof (m as any).effort === "string" ? (m as any).effort : undefined;
      const backgroundNotice = (m as any).backgroundNotice as BackgroundNoticeInfo | undefined;
      restored.push({
        id: clientMessageId || `hist-u-${seq++}`, role: "user", timestamp: (m as any).timestamp as number | undefined,
        // 后台任务通知：content 是给模型的长文本，界面只显示那一行标签
        content: backgroundNotice ? (displayText ?? backgroundNotice.label) : bodyText,
        images, attachedFiles, userSegments: restoredSegments, effort,
        ...(backgroundNotice ? { backgroundNotice } : {}),
        ...((m as any)._archived ? { archived: true } : {}),
      });
    } else if (m.role === "assistant") {
      // 正文来源分两种，必须都读：
      // · 正常回复：content 就是正文。
      // · 工具轮（带 tool_calls）：content 恒为 null（那是发给模型的上下文，塞正文会让模型
      //   把自己的过渡叙述当范例、每轮照抄同一句式），真正的正文只在 displayContent 里。
      // 早先这里只读 content，于是重启后工具之间夹杂的正文全部消失——它当时只存在于
      // 内存态的 stream_delta 里，刷新即失。
      const rawText = typeof m.content === "string" && m.content.trim()
        ? m.content
        : typeof (m as any).displayContent === "string"
          ? ((m as any).displayContent as string)
          : "";
      const text = rawText.trim();
      const hasToolCalls = m.tool_calls && m.tool_calls.length > 0;

      if (!currentAssistant) {
        currentAssistant = { id: `hist-a-${seq++}`, role: "assistant", segments: [], ...((m as any)._archived ? { archived: true } : {}) };
      }

      if (text) {
        currentAssistant.segments!.push({ type: "text", content: text });
      }

      if ((m as any).turnStats) {
        const stats = (m as any).turnStats as NonNullable<ChatMessage["turnStats"]>;
        // 老会话的统计里没有完成时间：用这一轮提问的时间 + 用时推算
        const askedAt = [...restored].reverse().find((r) => r.role === "user")?.timestamp;
        currentAssistant.turnStats = stats.completedAt || !askedAt ? stats : { ...stats, completedAt: askedAt + (stats.elapsed || 0) };
        // 尊重后端落盘的终止状态。早先这里无条件写 "success"，把 errorTurnHandler 特意持久化的
        // turnStatus（"cancelled" / "error"）直接抹掉——于是一轮失败的回复在刷新后显示为正常完成，
        // 连 Credits 后面的 (?) 不确定标记都没了，用户无从得知那轮其实中断了。
        // 只认这两个终态值：正常完成的轮次压根不写 turnStatus（只有 turnStats），走 "success"；
        // "running"/"pending" 是运行中状态，即便意外落盘也不能还原，否则 UI 会以为本轮仍在进行。
        const persisted = (m as any).turnStatus;
        currentAssistant.turnStatus = persisted === "cancelled" || persisted === "error" ? persisted : "success";
      }

      // 折叠组摘要落在组内第一条工具轮消息上（见后端 summarizeToolGroups）
      const groupSummary = (m as any).displayGroupSummary as { toolCallId?: string; text?: string } | undefined;

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
          const isExplore = toolName === "search" || toolName === "list_dir";
          const lineSuffix = toolName === "read_file" ? formatLineSuffix(tcArgs.startLine, tcArgs.endLine) : "";
          const readNameWithLines = shortName + (lineSuffix ? ` ${lineSuffix}` : "");
          let desc: string;
          switch (toolName) {
            case "read_file": desc = shortName ? `已读取 ${readNameWithLines}` : "已读取文件"; break;
            case "create_file": desc = shortName ? `${tcArgs.overwrite === true ? "已覆盖" : "已创建"} ${shortName}` : "已创建文件"; break;
            case "str_replace": desc = shortName ? `已编辑 ${shortName}` : "已编辑文件"; break;
            case "apply_patch": desc = "正在应用补丁..."; break;
            case "execute_command": desc = "命令已执行"; break;
            case "search":
            case "list_dir": desc = exploreDisplayText(toolName, tcArgs); break;
            case "relay_create":
            case "relay_save_doc":
            case "relay_advance":
            case "relay_update_task":
            case "relay_review_task":
            case "parallel_research":
            case "parallel_execute":
              desc = relayToolLabel(toolName);
              break;
            default: desc = artifactReadDescription(toolName, tcArgs) ?? `已完成 ${toolName}`;
          }
          currentAssistant.segments!.push({
            type: "tool",
            id: tc.id || `tool-${seq++}-${currentAssistant.segments!.length}`,
            name: toolName,
            status: "success",
            description: desc,
            args: tcArgs,
            command: (toolName === "execute_command" || toolName === "start_process") ? (tcArgs.command as string) : undefined,
            query: isExplore ? exploreDisplayText(toolName, tcArgs) : undefined,
            groupSummary: groupSummary?.toolCallId === tc.id ? groupSummary?.text || undefined : undefined,
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
            if (seg.name === "apply_patch") {
              const patchDiffs = (m as any).fileDiffs as { path: string }[] | undefined;
              if (patchDiffs && patchDiffs.length > 0) {
                const names = patchDiffs.map((d: { path: string }) => d.path.split("/").pop()?.split("\\").pop() || d.path).slice(0, 3);
                const prefix = toolStatus === "error" ? "部分编辑 " : "已编辑 ";
                seg.description = `${prefix}${names.join(", ")}${patchDiffs.length > 3 ? ` 等 ${patchDiffs.length} 个文件` : ""}`;
              } else if (toolStatus === "success") {
                seg.description = toolContent ? firstLine(toolContent) : "已应用补丁";
              } else if (toolStatus === "error") {
                seg.description = (m as any).userMessage || toolContent.slice(0, 120) || "补丁应用失败";
              }
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
            // 产物卡片靠它还原：落盘的工具消息带着 artifact，重开会话才不会丢卡片
            if ((m as any).artifact) seg.artifact = (m as any).artifact;
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
    // ⚠️ 只填 used 作为占位，**不要**用前端模型注册表的 contextWindow 覆盖 max。
    // max 必须以后端 token_usage 推来的权威窗口为准——后端判定手动压缩的 35% 阈值、以及
    // 是否注入「上下文已较满，建议开新会话」提醒，用的都是它自己的 getContextWindow()。
    // 前端拿注册表的值覆盖分母，会让圆环的分母与后端的分母不是同一个数：中转站的自定义模型名
    // （如 deepseek-v4-flash）前端报大窗口、后端只认兜底窗口时，圆环显示 18%，
    // 而后端已按自己的分母判定 ≥60%，直接命令模型提醒用户「上下文快满了」。
    // contextWindow / contextBreakdown 由后端随会话下发（与 token_usage 同一来源），可以直接用；
    // 旧后端没有这两个字段时保持原样，等下一轮 token_usage。
    const contextWindow = (msg as any).contextWindow as number | undefined;
    const breakdown = (msg as any).contextBreakdown as ContextBreakdown | undefined;
    ctx.setTokenUsage((prev) => ({
      ...prev,
      used: totalTokens,
      ...(contextWindow && contextWindow > 0 ? { max: contextWindow, maxFromBackend: true } : {}),
      breakdown,
    }));
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

export function handleCompactingStart(msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setIsCompacting(true);
  ctx.setCompactingMessage("整理上下文...");
  ctx.setStatusText((msg as any).inline ? "上下文接近上限，正在整理..." : "正在压缩上下文...");
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
  ctx.setCompactingMessage(null);
  const ok = (msg as any).success as boolean;
  const endMsg = (msg as any).message as string || (ok ? "上下文已压缩" : "压缩失败");
  // 回答进行中的自动压缩：当前回复还在流式输出，往历史末尾插分隔线会把它截成两段。
  // 只更新状态行；重新打开会话时，摘要照常显示成「早期对话已压缩」分隔。
  if ((msg as any).inline) {
    if (!ok) ctx.setUndoNotice({ id: Date.now(), text: endMsg });
    ctx.setStatusText(ok && (msg as any).message ? endMsg : "思考中...");
    return;
  }
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

export function handleCreditBudgetPaused(msg: WsMessage, ctx: EventHandlerCtx): void {
  ctx.setCreditBudgetPaused({
    spent: (msg as any).spent as number,
    threshold: (msg as any).threshold as number,
    usage: (msg as any).usage as string | undefined,
  });
  ctx.setStatusText("任务花费较高，等待确认...");
}

/**
 * 后台任务结束，后端替 Agent 发起了一轮：插入一行通知（作为本轮的「用户消息」），进入回复中。
 * 和 useChatSession.sendNow 做同样的轮次准备，只是不向后端发消息——这一轮是后端自己开的。
 */
export function handleBackgroundTurn(msg: WsMessage, ctx: EventHandlerCtx): void {
  const m = msg as WsMessage & { clientMessageId?: string; label?: string; notice?: BackgroundNoticeInfo };
  const id = m.clientMessageId || `bg-notice-${Date.now()}`;
  // 上一段回复的字还在打：先结清，否则剩下的字会接到这一轮的回复里
  ctx.typewriter.settle(ctx);
  const gen = ++ctx.turnGeneration.current;
  ctx.currentTurnClientMessageId.current = id;
  ctx.cancelled.current = false;
  ctx.setChatHistory((prev) => [...prev, {
    id,
    role: "user",
    timestamp: Date.now(),
    content: m.label || "后台任务结束",
    backgroundNotice: m.notice ?? { label: m.label || "后台任务结束", tasks: [] },
    turnGen: gen,
  }]);
  ctx.setIsLoading(true);
  ctx.setReasoning("");
  ctx.setStatusText("查看后台任务结果...");
  ctx.setStatusPhase("thinking");
  const startedAt = Date.now();
  ctx.turnStartTime.current = startedAt;
  ctx.setTurnStartedAt(startedAt);
}

/** 插话对应的用户气泡（和 useChatSession.sendNow 里用户消息的形状一致） */
function steerBubble(steer: PendingSteer, gen: number): ChatMessage {
  const ub = steer.payload.userBubble;
  return {
    id: steer.id,
    role: "user",
    timestamp: Date.now(),
    content: ub.content,
    images: ub.images && ub.images.length > 0 ? [...ub.images] : undefined,
    attachedFiles: ub.attachedFiles && ub.attachedFiles.length > 0 ? ub.attachedFiles : undefined,
    userSegments: ub.segments && ub.segments.length > 0 ? ub.segments : undefined,
    effort: ub.effort,
    turnGen: gen,
  };
}

function takeSteers(ctx: EventHandlerCtx, ids: string[]): PendingSteer[] {
  const picked = ctx.pendingSteersRef.current.filter((s) => ids.includes(s.id));
  ctx.setPendingSteers((prev) => prev.filter((s) => !ids.includes(s.id)));
  return picked;
}

/**
 * 插话已经插进对话：在时间线上把它放到此刻的位置——收起当前这段回复，插入用户气泡，
 * 后面的输出接在一段新的回复里（重开会话时历史也是这个形状）。
 */
export function handleSteerAbsorbed(msg: WsMessage, ctx: EventHandlerCtx): void {
  const ids = ((msg as { clientMessageIds?: string[] }).clientMessageIds ?? []);
  const steers = takeSteers(ctx, ids);
  if (steers.length === 0) return;
  // 打字机里还没出完的字先落到当前这段回复里，再插气泡，顺序才对
  ctx.typewriter.flush(ctx);
  const gen = ctx.turnGeneration.current;
  ctx.setChatHistory((prev) => {
    const updated = [...prev];
    const last = updated[updated.length - 1];
    if (last?.role === "assistant" && last.streaming) {
      updated[updated.length - 1] = { ...last, segments: sealReasoning(last.segments || []) ?? last.segments, streaming: false };
    }
    updated.push(...steers.map((s) => steerBubble(s, gen)));
    updated.push({ id: `assistant-${Date.now()}`, role: "assistant", segments: [], streaming: true, turnStatus: "running", turnGen: gen });
    return updated;
  });
  ctx.currentTurnClientMessageId.current = steers[steers.length - 1].id;
  ctx.setStatusText("看到你的补充，继续处理...");
}

/** 这一轮没来得及插入：后端拿插话开了新一轮。和 sendNow 一样准备新一轮，只是不再发消息 */
export function handleSteerTurn(msg: WsMessage, ctx: EventHandlerCtx): void {
  const ids = ((msg as { clientMessageIds?: string[] }).clientMessageIds ?? []);
  const steers = takeSteers(ctx, ids);
  ctx.typewriter.settle(ctx);
  const gen = ++ctx.turnGeneration.current;
  ctx.currentTurnClientMessageId.current = ids[0] ?? null;
  ctx.cancelled.current = false;
  if (steers.length > 0) ctx.setChatHistory((prev) => [...prev, ...steers.map((s) => steerBubble(s, gen))]);
  ctx.setIsLoading(true);
  ctx.setReasoning("");
  ctx.setStatusText("思考中...");
  ctx.setStatusPhase("thinking");
  const startedAt = Date.now();
  ctx.turnStartTime.current = startedAt;
  ctx.setTurnStartedAt(startedAt);
}

/** 撤回结果：撤回成功就把它从待发里去掉；已经被模型看到的撤不回，保持原样等它出现在时间线上 */
export function handleSteerCancelled(msg: WsMessage, ctx: EventHandlerCtx): void {
  const m = msg as { clientMessageId?: string; ok?: boolean };
  if (m.ok && m.clientMessageId) ctx.setPendingSteers((prev) => prev.filter((s) => s.id !== m.clientMessageId));
}
