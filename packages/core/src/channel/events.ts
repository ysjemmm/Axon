/**
 * AgentEvent —— 出站事件（Agent → UI），呈现端 ② 的一半
 *
 * 把现在散落在 agentSession.ts 里的 30+ 处 this.send(type, data) 收敛成有类型的联合体。
 * 载荷字段严格对齐现有 WS 协议字段名，保证 web 端无需改动即可继续消费（WsAdapter 直接
 * JSON.stringify 透传）。新增形态（VS Code webview）也消费同一套事件。
 *
 * 注意：这里只定义“事件形状”，不定义传输方式。传输由 AgentChannel 的具体实现决定。
 */

import type { CoworkCheck } from "../cowork/checks.js";
import type { BackgroundTaskInfo } from "../session/backgroundTasks.js";
import type { ConnectorTemplateInfo } from "../connectors/catalog.js";
import type { ConnectorView } from "../connectors/store.js";
import type { CoworkFlow, CoworkFlowInputDraft } from "../cowork/flows.js";
import type { CreditDetail } from "../credits.js";
import type { BillingMode, TurnCost, TurnUsage } from "../billing.js";
import type { WikiGenerationEvent } from "../wiki/wikiController.js";
import type { WorkspaceAxonStatus } from "../session/workspaceConfig.js";

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
  | { type: "stream_end"; elapsed: number; tokens: number; model?: string; modelName?: string; providerName?: string; effort?: string; credits?: number; creditDetail?: CreditDetail; billing?: BillingMode; usage?: TurnUsage; cost?: TurnCost }
  /**
   * 本轮非正常结束。reason 区分"用户主动取消"与"provider/网关异常"——
   * 两者都走这个事件，但对用户的含义完全不同（"我停的" vs "它挂了"）。
   * 可选是为了向后兼容：缺省时呈现端按 cancelled 处理，行为与该字段引入前一致。
   */
  | { type: "turn_cancelled"; elapsed: number; tokens: number; model?: string; modelName?: string; providerName?: string; effort?: string; credits?: number; creditDetail?: CreditDetail; billing?: BillingMode; usage?: TurnUsage; cost?: TurnCost; reason?: "cancelled" | "error" }
  | { type: "reasoning_delta"; content: string; partIndex?: number; itemId?: string }
  /**
   * 状态文案。
   *
   * humanized=true 表示这是模型为当前任务即时生成的办公化文案（Cowork），
   * 不是后端按规则给的通用文案。前端据此决定「能否覆盖已有文案」——
   * 生成的文案信息量更高，不该被随后到达的规则文案盖回去。
   */
  | { type: "status"; content: string; phase?: string; humanized?: boolean }
  | { type: "retry"; attempt: number; maxRetries: number; error: string; status: "retrying" | "failed" }
  | { type: "context_overflow" }
  | { type: "compacted"; message: string }
  /** inline：回答进行中的自动压缩（两轮工具调用之间），前端不插分隔线、不打断当前回复 */
  | { type: "compacting_start"; inline?: boolean }
  | { type: "compacting_end"; success: boolean; message: string; inline?: boolean }
  | { type: "compaction_needed"; currentTokens: number; maxTokens: number; percent: number }
  | { type: "compaction_migrated"; newSessionId?: string; parentSessionId?: string; migratedToNewSession?: boolean }
  // Wiki 生成进度（规划完成 / 逐页落盘 / 收尾）。
  // 子 Agent 的内部过程刻意不在此转发 —— 那会让聊天界面被十几张卡片灌满，
  // 且这些过程对用户没有决策价值。这里只给「共几页、完成几页、结果如何」。
  | { type: "wiki_generation"; event: WikiGenerationEvent }
  /**
   * 记忆召回：本轮把哪些 Wiki 页面注入了上下文。
   *
   * 只在召回集合【发生变化】时发出（首次 / 页面增删 / 某页转陈旧），稳定期静默 ——
   * 它表达的是「记忆变了，值得看一眼」，不是「本轮又注入了一次」。每轮都发会把
   * 真正的变化淹没在一串重复卡片里。
   */
  | { type: "wiki_recall"; total: number; pages: { title: string; stale: boolean }[] }
  | { type: "error"; content: string }

  // ── Credits 预算门（成本护栏：本轮花费达到硬暂停阈值，等待用户选择继续/停止） ──
  | { type: "credit_budget_paused"; spent: number; threshold: number; model?: string; usage?: string }

  // ── 工具调用 ──
  | {
      type: "tool_call";
      id: string;
      name: string;
      args: Json;
      cwd: string;
      /** queued=已规划排队（流式阶段提前出卡）；executing=宿主正在真正执行这一个 */
      status: "queued" | "pending" | "executing";
      /** 当前调用开始前必须完成的工具；仅 queued 更新事件携带。 */
      waitingFor?: { id: string; name: string }[];
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

  /**
   * 本轮产出的文件（Cowork）。
   *
   * 由 AI 主动登记并经文件存在性校验。paths 保持旧版兼容；
   * files 带每个文件的创建/编辑类型，前端据此显示对应颜色。
   */
  | { type: "cowork_outputs"; paths: string[]; files?: { path: string; kind?: "created" | "edited"; snapshotDir?: string }[] }
  // ── Cowork 核对与流程 ──
  | { type: "cowork_checks"; checks: CoworkCheck[] }
  // ── 连接器 ──
  | { type: "connectors"; catalog: ConnectorTemplateInfo[]; connectors: ConnectorView[] }
  | { type: "connector_saved"; requestId?: string; connector?: ConnectorView; error?: string }
  | { type: "connector_test_result"; requestId?: string; ok: boolean; tools?: { name: string; description?: string }[]; error?: string }
  // ── 插话 ──
  /** 这些插话已经插进对话（模型下一次请求就能看到） */
  | { type: "steer_absorbed"; clientMessageIds: string[] }
  /** 这一轮没来得及插入，系统拿这些插话开了新一轮 */
  | { type: "steer_turn"; clientMessageIds: string[] }
  | { type: "steer_cancelled"; clientMessageId: string; ok: boolean }
  // ── 后台任务 ──
  | { type: "background_tasks"; tasks: (BackgroundTaskInfo & { sessionId: string; sessionTitle?: string })[] }
  | { type: "background_task_output"; requestId?: string; sessionId: string; terminalId: string; output: string; status: string; exitCode: number | null }
  /** 后台任务结束，系统替 Agent 发起了一轮：前端据此插入一行通知并进入「回复中」 */
  | { type: "background_turn"; clientMessageId: string; label: string; notice: Record<string, unknown> }
  | { type: "cowork_flows"; flows: CoworkFlow[] }
  | { type: "cowork_flow_saved"; requestId?: string; flow?: CoworkFlow; error?: string }
  | { type: "cowork_flow_draft"; requestId?: string; draft?: Omit<CoworkFlowInputDraft, "id">; error?: string }

  // ── token 用量 ──
  | { type: "token_usage"; used: number; max: number; cumulative?: number;
      /** 占用按来源拆分（上下文面板明细），见 TokenAccountant.buildContextBreakdown */
      breakdown?: {
        categories: Array<{ key: string; tokens: number }>;
        mcpTools: Array<{ name: string; server: string; tool: string; tokens: number }>;
        autoCompactAt: number;
        manualCompactAt: number;
      } }

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
  /**
   * 命令风险提醒：已信任的命令命中风险模式（如递归删除）时**照常执行**，
   * 只把原因推给前端做可见提示——无需用户应答，因此没有 requestId。
   */
  | { type: "command_risk_notice"; command: string; reason: string; id?: string }

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
  | {
      type: "tool_confirm_timeout";
      /** 超时未应答而被自动关闭的确认门对应工具标识 */
      toolName: string;
    }

  // ── 选项问答（ask_user 工具：Agent 一次抛 1~N 个问题 + 选项，用户逐题单选/多选作答） ──
  | {
      type: "ask_user_request";
      /** 关联的工具调用 id */
      toolCallId: string;
      /** 问题列表（1~N 个；前端用「第 n / N 题」步进器逐题作答） */
      questions: {
        question: string;
        /** 选项列表（id 回传用、label 展示、description 为可选说明） */
        options: { id: string; label: string; description?: string }[];
        /** true=多选（checkbox），false=单选（radio） */
        multi: boolean;
        /** 是否允许用户自己输入「其他」答案 */
        allowOther: boolean;
      }[];
    }

  // ── 声明式表单（ask_form 工具：Agent 交付一张表单/控件面板，用户填写提交后结果回传） ──
  | {
      type: "form_request";
      /** 关联的 ask_form 工具调用 id（前端提交时原样回传，用于校验归属） */
      toolCallId: string;
      /** 表单声明（结构见 core 的 FormSpec；前端按字段 type 渲染对应控件） */
      form: Record<string, unknown>;
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
  /** 会话分叉完成：sessionId 为新会话，sourceId 为被分叉的源会话 */
  | { type: "session_forked"; sessionId: string; sourceId: string }
  /** get_diff_content 的应答。found=false 表示已找不到该次改动的正文（例如会话被压缩过） */
  | { type: "diff_content"; requestId: string; found: boolean; oldContent?: string; newContent?: string }
  | { type: "session_title_updated"; title: string }

  // ── 工作区 ──
  | { type: "workspace_set"; workspace: string; workspaces: string[]; groupId?: string; groupName?: string }
  | { type: "workspace_error"; message: string }
  | { type: "workspace_axon_initialized"; workspace: string; created: string[]; existing: string[] }
  | { type: "workspace_axon_proposal"; workspace: string; content: string }
  | { type: "workspace_axon_status"; workspaces: WorkspaceAxonStatus[] }

  // ── 命令信任与安全 ──
  | { type: "confirm_command_request"; requestId: string; command: string; options: { choice: string; pattern: string; label: string }[]; id?: string }

  // ── 子 Agent ──
  | { type: "sub_agent_start"; delegateId: string; toolCallId: string; intent: string; skill: string | null; prompt: string }
  | { type: "sub_agent_event"; delegateId: string; event: Json }
  | { type: "sub_agent_end"; delegateId: string; result: string }

  // ── Relay 长任务工作流 ──
  | { type: "relay_updated"; relay: Json }
  | { type: "relay_deleted"; relayId: string }
  | { type: "relay_review_start"; batchId: string; relayId: string; taskId: string }
  | { type: "relay_review_end"; batchId: string; relayId: string; taskId: string; passed: boolean }

  // ── 闪电回滚 ──
  | { type: "snapshots_listed"; snapshots: Array<{ id: string; createdAt: number; label: string; files: string[] }> }
  /** 会话记忆的最新内容：模型调用 update_memory 或用户导入 .md 之后推送 */
  | { type: "session_memory"; memory: string; historyCount?: number }
  /** 记忆的历史版本（新的在前）；content 为该版本被替换前的完整内容 */
  | { type: "memory_history"; versions: Array<{ at: number; source: string; content: string }> }
  | { type: "snapshot_restored"; snapshotId: string; ok: boolean }
  // ── 模型历史格式不兼容（deepseek 输出 DSML 退化）──
  | { type: "tool_history_mismatch"; model: string }
  // ── 连续工具调用分组的一句话摘要（前端大折叠行的标题；toolCallId = 组内第一个工具调用）──
  | { type: "tool_group_summary"; toolCallId: string; summary: string };

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
