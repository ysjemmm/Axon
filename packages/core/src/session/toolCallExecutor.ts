/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ToolCallExecutor -- 工具调用执行链（从 AgentSession 解耦）
 *
 * 职责：封装单个工具调用的完整执行流程--
 * - 参数健壮解析 + 空参数防御 + pending/executing 卡片 + 状态提示 + 重复检测
 * - dispatchToolCall 分发（含确认门/子Agent/Relay/MCP/命令门/通用）
 * - recordToolOutcome 落盘（软失败/编辑追踪/事件/历史/截图/待确认列表同步）
 * - runToolDispatch 编排（DefaultToolDispatchHandler 驱动状态机）
 *
 * 状态字段仍留在 session（@internal），本类通过构造注入的 session 引用读写。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  executeToolCall,
  ToolError,
  ToolName,
  ToolCallStatus,
  statusForTool,
  SOFT_FAIL_TOOLS,
  REQUIRED_ARGS_TOOLS,
  type ToolMeta,
} from "../tools/index.js";
import {
  parseToolArguments,
  LoopGuard,
  type StuckTarget,
} from "../agentGuards.js";
import { resolveToolDispatchRoute } from "./toolDispatchRouter.js";
import { resolveInWorkspaces } from "../tools/search.js";
import { MCP_TOOL_PREFIX } from "../mcp/types.js";
import { DefaultToolDispatchHandler } from "../llm/toolDispatchHandler.js";
import { resolveToolKind } from "../llm/toolKindResolver.js";
import type { ToolExecutor } from "../llm/toolExecutor.js";
import type { ToolEvent } from "../llm/toolEventModel.js";
import type { NormalizedToolCall } from "../llm/types.js";
import type { AgentSession } from "../agentSession.js";

/** 跨回合共享的可变标志（从 AgentSession 迁出）。 */
export interface TurnState {
  didMutate: boolean;
  didSelfCheck: boolean;
  emptyRetried: boolean;
  didDiagnose: boolean;
}

export class ToolCallExecutor {
  constructor(private readonly s: AgentSession) {}

  /**
   * 执行单个工具调用的完整流程：
   * 参数健壮解析 -> 空参数防御 -> pending/executing 卡片 -> 状态提示 -> 重复检测 ->
   * dispatchToolCall 分发（含确认门/子Agent/Relay/MCP/命令门/通用）-> recordToolOutcome 落盘。
   */
  async executeSingleToolCall(
    toolCall: NormalizedToolCall,
    toolCalls: NormalizedToolCall[],
    guard: LoopGuard,
    ts: TurnState,
    mutatedFiles: Set<string>,
  ): Promise<void> {
    const toolName = toolCall.name;
    // 多工具串行执行时，让前端有时间渲染上一个工具的终态卡片。
    if (toolCalls.length > 1) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    // 健壮解析参数：模型偶尔生成非法 JSON（如未转义的 Windows 路径反斜杠），
    // 不能让整轮崩掉。解析失败时当作"该工具调用失败"，反馈给模型重写。
    let toolArgs: Record<string, unknown>;
    try {
      toolArgs = parseToolArguments(toolCall.arguments);
    } catch (parseErr) {
      let errMsg = (parseErr as Error).message;
      const jsonFailKey = `json_fail:${toolName}`;
      const jsonFailCount = ((this.s as any).__jsonFailCounts ??= new Map<string, number>());
      jsonFailCount.set(jsonFailKey, (jsonFailCount.get(jsonFailKey) || 0) + 1);
      if (jsonFailCount.get(jsonFailKey)! >= 2 && (toolName === "create_file" || toolName === "str_replace")) {
        errMsg += `\n\n⚠️ 你已经连续 ${jsonFailCount.get(jsonFailKey)} 次因 JSON 格式问题无法调用 ${toolName}。` +
          `这通常是因为文件内容太长/含大量引号嵌套，你无法在 JSON 字符串里完美序列化它。` +
          `请立即换手段：用 execute_command 执行一个 Node 脚本或 PowerShell 命令来写文件` +
          `（如 node -e "require('fs').writeFileSync('path', content)" 或写临时 .mjs 脚本再执行），` +
          `不要再尝试 ${toolName}--它会继续失败。`;
      }
      this.s.send("tool_call", { id: toolCall.id, name: toolName, args: {}, cwd: this.s.cwd, status: ToolCallStatus.Executing });
      this.s.send("tool_result", { id: toolCall.id, name: toolName, args: {}, result: errMsg, status: ToolCallStatus.Error });
      this.s.messages.push({ role: "tool", tool_call_id: toolCall.id, _toolName: toolName, content: errMsg, status: "error" } as any);
      guard.recordToolResult(false, true);
      return;
    }

    // 防御：模型有时生成空参数对象（流式截断/幻觉），直接执行会因缺参数而失败。
    if (this.requiresArguments(toolName) && Object.keys(toolArgs).length === 0) {
      const hint = typeof toolCall.arguments === "string" && toolCall.arguments.trim()
        ? `收到参数原文 "${toolCall.arguments.slice(0, 200)}"`
        : "未收到任何参数（流式输出可能被截断）";
      const errMsg = `${toolName}: 参数为空。${hint}，请重新生成这次调用。`;
      this.s.send("tool_call", { id: toolCall.id, name: toolName, args: {}, cwd: this.s.cwd, status: ToolCallStatus.Executing });
      this.s.send("tool_result", { id: toolCall.id, name: toolName, args: {}, result: errMsg, status: ToolCallStatus.Error, userMessage: "参数缺失" });
      this.s.messages.push({ role: "tool", tool_call_id: toolCall.id, _toolName: toolName, content: errMsg, status: "error" } as any);
      guard.recordToolResult(false, true);
      return;
    }

    const displayCwd = this.s.commandToolExecutor.displayCwd(toolName, toolArgs);
    // 前 2 次软失败不发 tool_call（不闪卡片），直接发带 hidden 的 tool_result。
    if (!SOFT_FAIL_TOOLS.has(toolName)) {
      this.s.send("tool_call", { id: toolCall.id, name: toolName, args: {}, cwd: displayCwd, status: ToolCallStatus.Pending, ...this.s.mcpMetaFor(toolName) });
      this.s.send("tool_call", { id: toolCall.id, name: toolName, args: toolArgs, cwd: displayCwd, status: ToolCallStatus.Executing, ...this.s.mcpMetaFor(toolName) });
    }

    // 推送细化状态（给前端展示具体动作）
    const toolStatus = statusForTool(toolName);
    this.s.send("status", toolStatus);

    // 相同调用重复检测：同名工具 + 完全相同参数
    const verdict = guard.checkToolCall(toolName, toolCall.arguments);

    const meta: ToolMeta = { editId: toolCall.id };
    if (toolName === "execute_command") {
      meta.onWaitingInput = () => this.s.send("tool_waiting_input", { toolCallId: toolCall.id });
    }
    // 按工具类型分发执行（重复拦截 / 子 Agent / 并行 / Relay / 命令门 / MCP / 通用），meta 按引用被填充
    const dispatched = await this.dispatchToolCall(toolName, toolArgs, toolCall.id, verdict, meta, guard);
    const result = dispatched.result;
    const status = dispatched.status;
    const commandWasEdited = dispatched.commandWasEdited;
    toolArgs = dispatched.toolArgs; // 命令可能被用户编辑过，用实际执行的参数继续后续展示/落盘

    // 记录工具结果：软失败/编辑落盘控制、改动追踪、发事件、写入历史（mutatedFiles 就地填充）
    const rec = this.recordToolOutcome(toolCall.id, toolName, toolArgs, result, status, commandWasEdited, meta, displayCwd, guard, mutatedFiles);
    ts.didMutate = ts.didMutate || rec.mutated;
    ts.didDiagnose = ts.didDiagnose || rec.diagnosed;
  }

  /**
   * 按工具类型分发单次工具执行。重复调用拦截 / 子 Agent 委托 / 并行编排 / Relay 工具 /
   * 命令信任门 / MCP / 通用工具，各分支统一产出 result + status；meta 按引用填充（userMessage 等）。
   */
  async dispatchToolCall(
    toolName: string,
    toolArgs: Record<string, unknown>,
    toolCallId: string,
    verdict: { allowed: boolean; message?: string },
    meta: ToolMeta,
    guard: LoopGuard,
  ): Promise<{ result: string; status: "success" | "error"; commandWasEdited?: string; toolArgs: Record<string, unknown> }> {
    let result = "";
    let status: "success" | "error" = "success";
    let commandWasEdited: string | undefined;
    const route = resolveToolDispatchRoute(toolName);

    if (!verdict.allowed) {
      result = verdict.message || "调用被拦截。";
      status = "error";
    } else if (route === "delegate_task" || route === "parallel_research" || route === "parallel_execute") {
      const out = await this.s.delegatedToolExecutor.execute({ toolName, toolArgs, toolCallId });
      result = out.result;
      status = out.status;
    } else if (route === "relay") {
      const out = await this.s.relayToolExecutor.execute({ toolName, toolArgs, meta });
      result = out.result;
      status = out.status;
    } else if (route === "command") {
      const out = await this.s.commandToolExecutor.execute({
        toolName,
        toolArgs,
        toolCallId,
        meta,
      });
      result = out.result;
      status = out.status;
      commandWasEdited = out.commandWasEdited;
      toolArgs = out.toolArgs;
    } else if (route === "mcp") {
      const out = await this.s.mcpToolExecutor.execute({ toolName, toolArgs, meta });
      result = out.result;
      status = out.status;
    } else {
      // check_diagnostics 去重：只保留本会话内 AI 改过且尚未成功诊断的文件。
      // 过滤后为空则直接 no-op，避免无意义地再跑一次 diagnostics。
      if (toolName === ToolName.CheckDiagnostics && Array.isArray(toolArgs.paths)) {
        const originalPaths = toolArgs.paths as string[];
        const kept: string[] = [];
        for (const p of originalPaths) {
          if (!p) continue;
          try {
            const abs = await resolveInWorkspaces(p, this.s.cwd, this.s.host, this.s.workspaces);
            if (this.s.aiTouchedFilesNeedingDiagnostics.has(abs)) kept.push(p);
          } catch {
            kept.push(p);
          }
        }
        if (originalPaths.length > 0 && kept.length === 0) {
          return {
            result: "本次 check_diagnostics 请求中的文件都已在之前成功诊断过，且之后没有再被 AI 改动；已跳过重复诊断。",
            status: "success" as const,
            commandWasEdited: undefined,
            toolArgs,
          };
        }
        toolArgs = { ...toolArgs, paths: kept };
      }

      const out = await this.s.genericToolExecutor.execute({
        toolName,
        toolArgs,
        meta,
        runtime: {
          aiTouchedFilesNeedingDiagnostics: this.s.aiTouchedFilesNeedingDiagnostics,
          mode: this.s.mode,
          turnCount: this.s.turnCount,
          signal: this.s.abortSignal,
          guard,
        },
      });
      result = out.result;
      status = out.status;
    }

    return { result, status, commandWasEdited, toolArgs };
  }

  /**
   * 记录单次工具执行结果：软失败计数/隐藏卡片、编辑工具连续失败落盘控制、改动文件追踪、
   * 发 tool_call(补发)/tool_result 事件、按类型截断后写入对话历史、截图收集、待确认列表同步。
   */
  recordToolOutcome(
    toolCallId: string,
    toolName: string,
    toolArgs: Record<string, unknown>,
    result: string,
    status: "success" | "error",
    commandWasEdited: string | undefined,
    meta: ToolMeta,
    displayCwd: string,
    guard: LoopGuard,
    mutatedFiles: Set<string>,
  ): { mutated: boolean; diagnosed: boolean } {
    const state = this.s.toolOutcomeStateResolver.resolve({
      toolName,
      toolArgs,
      result,
      status,
      meta,
      guard,
      hostEditMode: this.s.host.edits.getMode(),
      activeRelayTask: this.s.activeRelayTask ? { changedFiles: this.s.activeRelayTask.changedFiles } : null,
    });
    if (state.markTransient) {
      meta.hidden = true;
      if (meta.userMessage) delete meta.userMessage;
      (meta as any).__markTransientApplied = true;
    }
    for (const p of state.mutatedPaths) mutatedFiles.add(p);
    void this.s.markAiTouchedFiles(state.mutatedPaths);
    for (const p of state.relayChangedPaths) this.s.activeRelayTask?.changedFiles.add(p);
    let mutated = state.mutated;
    let diagnosed = state.diagnosed;
    const isPending = state.isPending;
    if (toolName === ToolName.CheckDiagnostics) {
      void this.s.markDiagnosedFiles(toolArgs, meta, status);
    }
    const recorded = this.s.toolOutcomeRecorder.record({
      toolCallId,
      toolName,
      toolArgs,
      result,
      status,
      commandWasEdited,
      meta,
      displayCwd,
      guard,
      mutatedFiles,
      mcpMeta: this.s.mcpMetaFor(toolName),
      isPending,
    });
    mutated = mutated || recorded.mutated;
    diagnosed = diagnosed || recorded.diagnosed;
    this.s.toolOutcomePostSync.run({
      toolName,
      toolCallId,
      status,
      commandWasEdited,
      result,
      meta,
      isPending,
      turnCount: this.s.turnCount,
    });

    return { mutated, diagnosed };
  }

  /**
   * 工具轮编排：用 DefaultToolDispatchHandler 驱动本轮工具调用的状态流转。
   */
  async runToolDispatch(
    toolCalls: NormalizedToolCall[],
    guard: LoopGuard,
    ts: TurnState,
    mutatedFiles: Set<string>,
  ): Promise<void> {
    const executor: ToolExecutor = {
      execute: async (req) => {
        const tc = toolCalls.find((t) => t.id === req.callId);
        if (!tc) return { ok: false, error: `未找到工具调用 ${req.callId}` };
        await this.executeSingleToolCall(tc, toolCalls, guard, ts, mutatedFiles);
        return { ok: true };
      },
    };
    const handler = new DefaultToolDispatchHandler(executor);
    const toolDrafts: ToolEvent[] = toolCalls.map((tc) => ({
      type: "tool.phase",
      ts: new Date().toISOString(),
      requestId: `req-${this.s.turnCount}`,
      turnId: `turn-${this.s.turnCount}`,
      source: "tool",
      stage: "runtime",
      phase: "planned",
      callId: tc.id,
      toolName: tc.name,
      toolKind: resolveToolKind(tc.name),
      rawArgsText: tc.arguments,
    }));
    try {
      const out = await handler.handle({
        requestId: `req-${this.s.turnCount}`,
        turnId: `turn-${this.s.turnCount}`,
        toolDrafts,
        toolContexts: [],
      });
      console.log(`[pipeline] ToolDispatchHandler 编排 ${toolDrafts.length} 个工具，stage=${out.stage}`);
    } catch (err) {
      console.warn("[pipeline] ToolDispatchHandler 编排异常（已忽略，工具执行不受影响）:", (err as Error).message);
    }
  }

  /** 工具是否必须有参数（空参数对象视为调用失败）。 */
  requiresArguments(toolName: string): boolean {
    if (REQUIRED_ARGS_TOOLS.has(toolName)) return true;
    if (toolName.startsWith(MCP_TOOL_PREFIX)) return true;
    return false;
  }
}
