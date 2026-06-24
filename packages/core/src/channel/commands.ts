/**
 * ControlCommand —— 入站控制指令（UI → Agent），呈现端 ② 的另一半
 *
 * 把现在 index.ts 里 ws.on("message") 那一大坨 if (msg.type === ...) 分支收敛成有类型的联合体。
 * 字段严格对齐现有 WS 入站协议，保证 web 端发送的消息无需改动。
 *
 * 这些指令由各形态的适配器解析后交给 SessionHub.dispatch 统一处理，
 * 使会话生命周期管理与具体传输（WS / webview.postMessage / stdio）解耦。
 */

/** 用户发送一条消息（可带图片、附件、模型/provider 选择、回复风格等） */
export interface UserMessageCommand {
  type: "user_message";
  content?: string;
  images?: unknown[];
  model?: string;
  provider?: string;
  workspace?: string;
  workspaces?: string[];
  displayText?: string;
  attachedFiles?: unknown[];
  /** 用户消息的内联片段（文本 + tag），用于富文本气泡的持久化与恢复 */
  userSegments?: unknown[];
  replyStyle?: string;
  /** 会话模式：agent（默认）、quest（纯问答）或 parallel（多 Agent 并行） */
  mode?: "agent" | "quest" | "parallel";
  /** Quest 模式选项 */
  quest?: { think?: boolean; webSearch?: boolean };
}

/**
 * 多会话路由标签（入站指令统一携带）：
 * - clientId：发出指令的前端面板（ChatPanel）标识。SessionHub 以此维护
 *   「面板 → 会话」映射（clientSessions），取代全局单一 currentSessionId，
 *   使多个面板并发各自操作自己的会话而不串台。
 * - sessionId：指令显式指向的会话（如 load_session）。
 *
 * 两者均可选：缺省时退化为「广播 / 默认会话」语义（如工作区文件夹变化时
 * 由扩展宿主下发、不含 clientId 的 set_workspace）。
 */
export interface ControlCommandRouting {
  clientId?: string;
  sessionId?: string;
}

/** 指令载荷联合体（不含路由标签）。对外暴露的 {@link ControlCommand} 在此基础上叠加路由标签。 */
export type ControlCommandPayload =
  | UserMessageCommand
  // 会话切换/管理
  | { type: "load_session"; sessionId: string }
  | { type: "new_session"; workspace?: string; model?: string; provider?: string; mode?: "agent" | "quest" | "parallel" }
  | { type: "reset_session" }
  // 工作区
  | { type: "set_workspace"; workspace: string; workspaces?: string[] }
  | { type: "set_workspace_group"; groupId: string }
  // 执行控制
  | { type: "cancel" }
  // 上下文压缩
  | { type: "compact_session" }
  | { type: "compaction_choice"; choice: "continue" | "new_session" }
  // 浏览器：把 open_browser 打开的页面带到前台（前端点击卡片输出触发）
  | { type: "focus_browser" }
  // 编辑模式 / 待确认改动
  | { type: "set_edit_mode"; mode: "auto" | "manual" }
  | { type: "accept_edits"; path?: string }
  | { type: "reject_edits"; path?: string }
  | { type: "undo_edits"; path: string }
  | { type: "undo_parallel_file"; path: string }
  // 闪电回滚
  | { type: "list_snapshots" }
  | { type: "restore_snapshot"; snapshotId: string }
  // Relay
  | { type: "delete_relay"; relayId: string; workspace?: string }
  // 工具确认（用户确认/拒绝创建 Relay 等需要确认的操作）
  | { type: "confirm_tool"; confirmed: boolean }
  // 命令信任授权（用户对未信任命令的三档决策）
  | {
      type: "confirm_command";
      requestId: string;
      choice: "exact" | "prefix" | "all" | "once" | "reject";
      pattern?: string;
      /** 写入作用域：user=全局 / workspace=仅当前项目。默认 workspace */
      target?: "user" | "workspace";
      /** 用户手动编辑后的命令（有值时后端用此替代原命令执行） */
      editedCommand?: string;
    };

/**
 * ControlCommand —— 入站控制指令（含多会话路由标签）。
 *
 * 在指令载荷基础上叠加可选的 {@link ControlCommandRouting}（clientId / sessionId）。
 * 判别字段 `type` 保持完好，既有发送方无需为旧字段做适配。
 */
export type ControlCommand = ControlCommandPayload & ControlCommandRouting;

export type ControlCommandType = ControlCommandPayload["type"];
