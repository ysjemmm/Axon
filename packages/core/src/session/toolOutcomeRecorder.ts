import { toolContentLimit, type ToolMeta } from "../tools/index.js";
import { EDIT_PERSIST_TOOLS } from "../tools/index.js";
import type { LoopGuard } from "../agentGuards.js";

/** ToolOutcomeRecorder 输入：把 agentSession.recordToolOutcome 所需的运行时依赖显式化。 */
export interface ToolOutcomeRecordInput {
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  result: string;
  status: "success" | "error";
  commandWasEdited?: string;
  meta: ToolMeta;
  displayCwd: string;
  guard: LoopGuard;
  mutatedFiles: Set<string>;
  /** MCP 元信息（server/capability）由 agentSession 注入；本协作者只负责拼装，不自己决策。 */
  mcpMeta?: Record<string, unknown>;
  /** 当前是否处于手动编辑模式下的 pending 状态。 */
  isPending: boolean;
}

/** ToolOutcomeRecorder 的副作用依赖：事件发送、消息写入、持久化都从 AgentSession 注入。 */
export interface ToolOutcomeRecorderDeps {
  /** 发前端事件（tool_call / tool_result）。 */
  send: (type: string, data: Record<string, unknown>) => void;
  /** 追加一条 tool 消息进历史。 */
  pushToolMessage: (msg: Record<string, unknown>) => void;
  /** 标记下一条 tool 消息为 transient（编辑工具软失败不落盘）。 */
  markNextAsTransient?: () => void;
}

/** 记录结果。 */
export interface ToolOutcomeRecordResult {
  mutated: boolean;
  diagnosed: boolean;
}

/**
 * ToolOutcomeRecorder —— 单次工具执行结果的事件发送 + 消息落盘协作者。
 *
 * 这是从 AgentSession.recordToolOutcome 抽出的第一版协作者，只做“搬家式重构”，
 * 不改变任何行为：
 * - 软失败工具延迟展示
 * - tool_result payload 拼装
 * - AI 上下文里的 commandWasEdited / noopEdit 提示注入
 * - 大结果截断入历史
 * - 编辑工具软失败标 transient
 *
 * 注意：mutated/diagnosed 的判断、meta.hidden/meta.fileDiff 等副作用仍由 agentSession 在调用前后维护；
 * 本类当前只承接“发什么 + 存什么”。
 */
export class ToolOutcomeRecorder {
  constructor(private readonly deps: ToolOutcomeRecorderDeps) {}

  record(input: ToolOutcomeRecordInput): ToolOutcomeRecordResult {
    const {
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
      mcpMeta,
      isPending,
    } = input;

    let mutated = false;
    let diagnosed = false;

    // 连续失败计数：失败累加，成功归零。str_replace 未匹配/参数非法等软失败不计入。
    const softFail = status === "error" && /(未找到匹配|参数为空|JSON|工具执行失败|调用被拦截|命令未执行|读取失败)/.test(result);
    guard.recordToolResult(status !== "error", softFail, { toolName, args: toolArgs });

    // 编辑工具失败：不展示卡片也不落盘。
    const isEditError = status === "error" && EDIT_PERSIST_TOOLS.has(toolName);
    if (isEditError) {
      meta.hidden = true;
      if (meta.userMessage) delete meta.userMessage;
      if (softFail) this.deps.markNextAsTransient?.();
    }

    if (meta.fileDiff || (meta.fileDiffs && meta.fileDiffs.length > 0)) mutated = true;
    if (toolName === "check_diagnostics") diagnosed = true;

    // 这里曾经为 SOFT_FAIL_TOOLS 补发一条 status=Success 的 tool_call（"延迟展示"：
    // 执行前不出卡，执行完确认没失败才补一张）。现已移除——toolCallExecutor 会在执行前
    // 就发出执行中卡片，卡片全程可见；失败时靠下面 tool_result 的 hidden 标记让前端撤卡。
    // 保留补发反而会与已存在的执行中卡片打架（前端对 status=success 的 tool_call 不建段，
    // 那条事件只会白跑一趟）。

    this.deps.send("tool_result", {
      id: toolCallId,
      name: toolName,
      args: toolArgs,
      result: result.slice(0, 500),
      status,
      fileDiff: meta.fileDiff,
      fileDiffs: meta.fileDiffs,
      noopEdit: meta.noopEdit,
      readRange: meta.readRange,
      diagnostics: meta.diagnostics,
      searchResults: (meta as any).searchResults,
      fetchResult: (meta as any).fetchResult,
      powerActivated: (meta as any).powerActivated,
      pending: isPending,
      userMessage: meta.userMessage,
      hidden: meta.hidden,
      resolvedPath: (meta as any).resolvedPath,
      ...(mcpMeta || {}),
    });

    const maxToolContent = toolContentLimit(toolName);
    const aiHint = commandWasEdited
      ? `[系统提示：用户在审批环节将你请求的命令手动改为 "${commandWasEdited}" 并执行。这是用户的正常操作（不是你的错误），以下输出来自实际执行的 "${commandWasEdited}"。请据此继续，不要重试、不要道歉。]\n`
      : meta.noopEdit
        ? "[系统提示：本次编辑工具调用已执行成功，但生成的新内容与当前文件内容完全一致，因此没有产生任何实际修改。请据此继续判断：如果你本来预期文件应被修改，说明这次编辑是 no-op，需要换参数、换工具或重新评估目标；不要把它当成已改成功。]\n"
        : "";
    const contentForAI = aiHint + result;
    const storedResult = contentForAI.length > maxToolContent
      ? contentForAI.slice(0, maxToolContent) + `\n\n[内容已截断，原始长度 ${result.length} 字符。如需更多内容，请用更大的行范围一次性读取，不要分多次零碎读取]`
      : contentForAI;

    this.deps.pushToolMessage({
      role: "tool",
      tool_call_id: toolCallId,
      _toolName: toolName,
      content: storedResult,
      displayContent: commandWasEdited ? result : undefined,
      displayCommand: commandWasEdited || undefined,
      status,
      fileDiff: meta.fileDiff,
      fileDiffs: meta.fileDiffs,
      readRange: meta.readRange,
      diagnostics: meta.diagnostics,
      searchResults: (meta as any).searchResults,
      fetchResult: (meta as any).fetchResult,
      powerActivated: (meta as any).powerActivated,
      pending: isPending,
      userMessage: meta.userMessage,
      hidden: meta.hidden,
      ...(mcpMeta || {}),
    });

    return { mutated, diagnosed };
  }
}
