/**
 * 全局常量 —— 消除魔法值，统一管理所有散落的字符串/数字
 *
 * 分类：
 * - STORAGE:  localStorage / sessionStorage key（统一短横线命名）
 * - IPC:  postMessage channel / 协议字段
 * - AGENT_EVENT:  Agent 事件 type 枚举
 * - CONTROL_CMD:  前端 → 后端控制指令 type
 * - TIMEOUT:  超时 / 重试 / 间隔数值（毫秒）
 * - API:  REST / WebSocket 路径与默认值
 * - MIME:  Content-Type / 下载 MIME
 */

// ═══════════════════════════════════════════════════════════════════
// localStorage / sessionStorage Keys
// ═══════════════════════════════════════════════════════════════════

export const STORAGE = {
  MODE: "axon-mode",
  TABS: "axon-tabs",
  ACTIVE_KEYS: "axon-active-keys",
  LAST_MODEL: "axon-last-model",
  EDIT_MODE: "axon-edit-mode",
  /**
   * 思考开关（agent / quest 通用）。用新 key 而不是沿用旧的 axon-quest-think：
   * 旧 key 存的是"要不要展示思考过程"（默认关），新语义是"要不要请求思考"（默认开），
   * 沿用会把老用户的"不展示"误读成"不要思考"。
   */
  THINK: "axon-think",
  QUEST_WEBSEARCH: "axon-quest-websearch",
  PARALLEL_MODEL: "axon-parallel-model",
  PARALLEL_PROVIDER: "axon-parallel-provider",
  PARALLEL_BATCHES: "axon-parallel-batches",
  PROVIDER_EXPAND: "axon-provider-expand",
  LAST_PROVIDER: "axon-last-provider",
} as const;

// ═══════════════════════════════════════════════════════════════════
// postMessage / IPC 协议
// ═══════════════════════════════════════════════════════════════════

export const IPC = {
  /** REST 请求包裹标记 */
  REQ: "__axonReq",
  /** REST 应答包裹标记 */
  RES: "__axonRes",
} as const;

// ═══════════════════════════════════════════════════════════════════
// Agent 事件类型（后端 → 前端）
// ═══════════════════════════════════════════════════════════════════

export const AGENT_EVENT = {
  // ── 流式文本 ──
  STREAM_START: "stream_start",
  STREAM_DELTA: "stream_delta",
  STREAM_PAUSE: "stream_pause",
  STREAM_END: "stream_end",
  // ── 推理 ──
  REASONING_DELTA: "reasoning_delta",
  // ── 工具调用 ──
  TOOL_CALL: "tool_call",
  TOOL_RESULT: "tool_result",
  TOOL_WAITING_INPUT: "tool_waiting_input",
  // ── 轮次 ──
  TURN_CANCELLED: "turn_cancelled",
  // ── 会话生命周期 ──
  SESSION_CREATED: "session_created",
  SESSION_LOADED: "session_loaded",
  SESSION_ERROR: "session_error",
  // ── 压缩 ──
  COMPACTING_START: "compacting_start",
  COMPACTION_NEEDED: "compaction_needed",
  COMPACTION_MIGRATED: "compaction_migrated",
  COMPACTING_END: "compacting_end",
  // ── Credits 预算门 ──
  CREDIT_BUDGET_PAUSED: "credit_budget_paused",
  // ── 状态 ──
  STATUS: "status",
  RETRY: "retry",
  CONTEXT_OVERFLOW: "context_overflow",
  TOKEN_USAGE: "token_usage",
  EDITS_UPDATED: "edits_updated",
  EDIT_UNDO_RESULT: "edit_undo_result",
  WORKSPACE_SET: "workspace_set",
  EDIT_MODE_SET: "edit_mode_set",
  WORKSPACE_ERROR: "workspace_error",
  // ── 确认门 ──
  CONFIRM_TOOL_REQUEST: "confirm_tool_request",
  TOOL_CONFIRM_TIMEOUT: "tool_confirm_timeout",
  CONFIRM_COMMAND_REQUEST: "confirm_command_request",
  COMMAND_BLOCKED: "command_blocked",
  // ── Relay ──
  FOCUS_RELAY: "focus_relay",
  RELAY_UPDATED: "relay_updated",
  RELAY_DELETED: "relay_deleted",
  // ── 子 Agent ──
  SUB_AGENT_START: "sub_agent_start",
  SUB_AGENT_EVENT: "sub_agent_event",
  SUB_AGENT_END: "sub_agent_end",
  // ── 并行 ──
  PARALLEL_EXECUTE_START: "parallel_execute_start",
  PARALLEL_EXECUTE_END: "parallel_execute_end",
  PARALLEL_RESEARCH_START: "parallel_research_start",
  PARALLEL_RESEARCH_END: "parallel_research_end",
  // ── 错误 ──
  ERROR: "error",
  // ── 模型历史格式不兼容 ──
  TOOL_HISTORY_MISMATCH: "tool_history_mismatch",
} as const;

// ═══════════════════════════════════════════════════════════════════
// 控制指令（前端 → 后端）
// ═══════════════════════════════════════════════════════════════════

export const CONTROL_CMD = {
  CANCEL: "cancel",
  SET_EDIT_MODE: "set_edit_mode",
  USER_MESSAGE: "user_message",
  ADD_CONTEXT: "add_context",
  NAVIGATE_PARALLEL: "navigate_parallel",
  FLATTEN_TOOL_HISTORY: "flatten_tool_history",
} as const;

// ═══════════════════════════════════════════════════════════════════
// 工具名称（前端判断逻辑依赖）
// ═══════════════════════════════════════════════════════════════════

export const TOOL = {
  READ_FILE: "read_file",
  CREATE_FILE: "create_file",
  STR_REPLACE: "str_replace",
  APPLY_PATCH: "apply_patch",
  EXECUTE_COMMAND: "execute_command",
  START_PROCESS: "start_process",
  SEARCH: "search",
  LIST_DIR: "list_dir",
  CHECK_DIAGNOSTICS: "check_diagnostics",
  DELEGATE_TASK: "delegate_task",
} as const;

// ═══════════════════════════════════════════════════════════════════
// 超时 / 间隔 / 限制（毫秒）
// ═══════════════════════════════════════════════════════════════════

export const TIMEOUT = {
  /** REST postMessage 请求超时 */
  API_REQUEST: 30_000,
  /** WebSocket 断线重连延迟 */
  WS_RECONNECT: 3_000,
  /** 会话标题同步轮询间隔 */
  SESSION_SYNC: 5_000,
  /** 工具结果完成后恢复"思考中"延迟 */
  TOOL_RESULT_RESET: 300,
  /** requestIdleCallback 降级 setTimeout 延迟 */
  IDLE_CALLBACK_FALLBACK: 100,
  /** 终端输出更新节流阈值（秒） */
  TERMINAL_THROTTLE: 10,
  /** 默认模型上下文窗口 */
  DEFAULT_CONTEXT_WINDOW: 128_000,
} as const;

// ═══════════════════════════════════════════════════════════════════
// API / WebSocket
// ═══════════════════════════════════════════════════════════════════

export const API = {
  DEFAULT_PORT: "3001",
  WS_PATH: "/ws",
} as const;

// ═══════════════════════════════════════════════════════════════════
// MIME / 下载
// ═══════════════════════════════════════════════════════════════════

export const MIME = {
  JSON: "application/json",
  TEXT: "text/plain",
  MARKDOWN: "text/markdown",
  OCTET_STREAM: "application/octet-stream",
} as const;

// ═══════════════════════════════════════════════════════════════════
// 并行面板
// ═══════════════════════════════════════════════════════════════════

export const PARALLEL = {
  CLIENT_ID: "parallel-panel",
  MAX_PERSIST_BATCHES: 20,
} as const;

// ═══════════════════════════════════════════════════════════════════
// UI / 视图模式
// ═══════════════════════════════════════════════════════════════════

export const VIEW_MODE = {
  CHAT: "chat",
  SKILLS: "skills",
  RELAY: "relay",
  POWERS: "powers",
  MCP: "mcp",
  PROVIDERS: "providers",
} as const;
