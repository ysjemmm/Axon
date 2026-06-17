/**
 * AgentEvent —— 出站事件（Agent → UI），呈现端 ② 的一半
 *
 * 把现在散落在 agentSession.ts 里的 30+ 处 this.send(type, data) 收敛成有类型的联合体。
 * 载荷字段严格对齐现有 WS 协议字段名，保证 web 端无需改动即可继续消费（WsAdapter 直接
 * JSON.stringify 透传）。新增形态（VS Code webview）也消费同一套事件。
 *
 * 注意：这里只定义“事件形状”，不定义传输方式。传输由 AgentChannel 的具体实现决定。
 */

import type { CreditDetail } from "../credits.js";

/** relay/skill 等复杂载荷暂以宽松类型占位，阶段 1 迁移 relay 模块时替换为精确类型 */
type Json = Record<string, unknown>;

/**
 * 多会话路由标签（出站事件统一携带）：
 * - sessionId：事件所属会话。便于消费方区分来源。
 * - clientId：事件应送达的前端面板（ChatPanel）标识。前端事件总线按 clientId 路由，
 *   使后台并发会话的流式事件精确送达对应面板，切走不中断、切回无缝衔接。
 *
 * 两者均可选：无标签的事件（如工作区文件夹变化广播）由前端总线广播给所有面板。
 */
export interface AgentEventRouting {
  sessionId?: string;
  clientId?: string;
}

/** 事件载荷联合体（不含路由标签）。对外暴露的 {@link AgentEvent} 在此基础上叠加路由标签。 */
export type AgentEventPayload =
  // ── 流式文本 ──
  | { type: "stream_start" }
  | { type: "stream_delta"; content: string }
  | { type: "stream_pause" }
  | { type: "stream_end"; elapsed: number; tokens: number; model?: string; credits?: number; creditDetail?: CreditDetail }
  | { type: "turn_cancelled"; elapsed: number; tokens: number; model?: string; credits?: number; creditDetail?: CreditDetail }
  | { type: "reasoning_delta"; content: string }
  | { type: "status"; content: string }
  | { type: "compacted"; message: string }
  | { type: "compacting_start" }
  | { type: "compacting_end"; success: boolean; message: string }
  | { type: "error"; content: string }

  // ── 工具调用 ──
  | {
      type: "tool_call";
      id: string;
      name: string;
      args: Json;
      cwd: string;
      status: "pending" | "executing";
      /** MCP 工具专用：真实 server 名 / 工具名（前端卡片展示用） */
      mcpServer?: string;
      mcpTool?: string;
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      args: Json;
      result: string;
      status: "success" | "error";
      fileDiff?: { path: string; oldContent: string; newContent: string; editId?: string };
      fileDiffs?: { path: string; absPath?: string; oldContent: string; newContent: string; editId?: string }[];
      readRange?: { startLine: number; endLine: number };
      diagnostics?: unknown;
      searchResults?: unknown;
      fetchResult?: unknown;
      pending?: boolean;
      /** 给用户看的简短失败文案（失败时；不含内部工具名）。前端失败卡片优先展示 */
      userMessage?: string;
      /** 该工具调用卡片是否对用户隐藏（中性结果，如文件不存在/已存在被拦） */
      hidden?: boolean;
      /** MCP 工具专用：真实 server 名 / 工具名 */
      mcpServer?: string;
      mcpTool?: string;
    }

  // ── token 用量 ──
  | { type: "token_usage"; used: number; max: number; cumulative?: number }

  // ── 命令信任（execute_command 白名单 / 人工授权） ──
  | {
      type: "confirm_command_request";
      requestId: string;
      command: string;
      /** 三档信任建议（exact/prefix/all），前端据此渲染按钮 */
      options: { choice: "exact" | "prefix" | "all"; pattern: string; label: string }[];
      /** 触发该命令的工具调用 id：前端据此把审批按钮内联到对应命令卡片（无感模式） */
      id?: string;
      /** 发起方：主 Agent 或某个子 Agent（用于 UI 标注来源） */
      delegateId?: string;
    }
  | { type: "command_blocked"; command: string; reason: string }

  // ── 工具确认门（relay_create 创建确认 / MCP 工具调用审批） ──
  | {
      type: "confirm_tool_request";
      /** 待确认的工具标识（relay_create，或 MCP 的 "serverName · toolName"） */
      toolName: string;
      /** 工具参数（展示用） */
      args: Json;
      /** 确认类型：relay 工作流创建 / MCP 工具调用。前端据此渲染不同文案 */
      kind?: "relay" | "mcp";
      /** 展示标签（MCP 为 "serverName · toolName"；relay 为工作流标题） */
      label?: string;
    }

  // ── 编辑模式 / 待确认改动 ──
  | { type: "edit_mode_set"; mode: "auto" | "manual" }
  | {
      type: "edits_updated";
      pending: string[];
      diffs: { path: string; oldContent: string; newContent: string }[];
      rejected: string[];
      /** 已接受、可撤销的相对路径列表（LIFO）。前端据此在已接受卡片显示「撤销」图标 */
      undoable?: string[];
      /** 待确认的编辑单元 id 列表（${toolCallId}::${path}），供前端逐次卡片精确匹配 */
      pendingEditIds?: string[];
      /** 已接受、可撤销的编辑单元 id 列表，供前端逐次卡片精确匹配 */
      undoableEditIds?: string[];
    }
  | {
      /** 撤销结果通知：ok=true 该文件已恢复到接受前；ok=false 时 reason 为轻提示文案 */
      type: "edit_undo_result";
      path: string;
      ok: boolean;
      reason?: string;
    }

  // ── 会话生命周期 ──
  | { type: "session_created"; sessionId: string; workspace: string; workspaces?: string[] }
  | { type: "session_loaded"; sessionId: string; [k: string]: unknown }
  | { type: "session_title_updated"; title: string }

  // ── 工作区 ──
  | { type: "workspace_set"; workspace: string; workspaces: string[]; groupId?: string; groupName?: string }
  | { type: "workspace_error"; message: string }

  // ── 子 Agent / 并行调研 ──
  | { type: "sub_agent_start"; delegateId: string; toolCallId: string; intent: string; skill: string | null; prompt: string }
  | { type: "sub_agent_event"; delegateId: string; event: Json }
  | { type: "sub_agent_end"; delegateId: string; result: string }
  | { type: "parallel_research_start"; batchId: string; toolCallId: string; [k: string]: unknown }
  | { type: "parallel_research_end"; batchId: string; results: { delegateId: string; ok: boolean }[] }

  // ── Relay 长任务工作流 ──
  | { type: "relay_updated"; relay: Json }
  | { type: "relay_deleted"; relayId: string }
  | { type: "relay_review_start"; batchId: string; relayId: string; taskId: string }
  | { type: "relay_review_end"; batchId: string; relayId: string; taskId: string; passed: boolean };

/**
 * AgentEvent —— 出站事件（含多会话路由标签）。
 *
 * 在事件载荷基础上叠加可选的 {@link AgentEventRouting}（sessionId / clientId）。
 * 因 `(A | B) & C === (A & C) | (B & C)`，判别字段 `type` 保持完好，
 * 既有 `{ type: "stream_end", ... }` 字面量仍可直接赋值（路由标签可选）。
 */
export type AgentEvent = AgentEventPayload & AgentEventRouting;

/** 事件 type 字面量集合，便于运行时校验/转发 */
export type AgentEventType = AgentEventPayload["type"];
