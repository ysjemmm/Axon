/**
 * ControlCommand —— 入站控制指令（UI → Agent），呈现端 ② 的另一半
 *
 * 把现在 index.ts 里 ws.on("message") 那一大坨 if (msg.type === ...) 分支收敛成有类型的联合体。
 * 字段严格对齐现有 WS 入站协议，保证 web 端发送的消息无需改动。
 *
 * 这些指令由各形态的适配器解析后交给 SessionHub.dispatch 统一处理，
 * 使会话生命周期管理与具体传输（WS / webview.postMessage / stdio）解耦。
 */

/** 用户发送一条消息（可带图片、附件、模型/provider 选择等） */
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
  /** 前端生成的用户消息 id，用于后续编辑历史消息时精确定位 */
  clientMessageId?: string;
  /** 用户消息的内联片段（文本 + tag），用于富文本气泡的持久化与恢复 */
  userSegments?: unknown[];
  /**
   * 会话模式：agent（默认）/ quest（纯问答）/ cowork（办公文档工作面）。
   * cowork 的运行时行为与 agent 相同，差别只在历史列表里单独归类。
   */
  mode?: "agent" | "quest" | "cowork";
  /** Cowork：本轮是在运行哪个流程（记一次运行，历史列表据此标出来源） */
  flowId?: string;
  /** 由后台任务结束通知发起的一轮（后端内部生成，前端不会发） */
  backgroundNotice?: Record<string, unknown>;
  /**
   * 是否启用思考（缺省视为开启）。
   *
   * 顶层字段而非 quest 子对象：它对 agent / quest 两种模式都生效。
   * 早先只有 Quest 有个同名开关，且仅控制 reasoning 要不要转发给前端——
   * 模型照样思考、照样计费，关掉省不下任何东西。现在它同时决定"是否向模型请求思考"。
   */
  think?: boolean;
  /** 当前模型 Provider 配置中选中的实际思考强度值（如 high / xhigh）；关闭时不传 */
  effort?: string;
  /** Quest 模式专属选项（联网搜索；思考开关见顶层 think） */
  quest?: { webSearch?: boolean };
  /**
   * 产出目录绝对路径（Cowork）。
   *
   * 虽然这个路径也写在消息正文里给模型看，但后端必须单独拿到一份 ——
   * 轮次收尾时要扫这个目录，diff 出本轮实际产出了哪些文件。
   * 不能靠收集 create_file 的参数来替代：办公任务的产物基本都是 Python 脚本写出来的，
   * 那条路径后端根本看不见（见 outputScanner 的说明）。
   */
  outputDir?: string;
  /**
   * Chat 产物目录（绝对路径）。
   *
   * 与上面的 outputDir 刻意分开：outputDir 是 Cowork 的，且每轮缺省即清空；
   * 这个字段属于 Chat 的「产物」功能，缺省/空串表示「用默认位置」
   * （~/.axon/artifacts/<会话id>/），由 AgentSession.getArtifactDir() 兜底解析。
   */
  artifactDir?: string;
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
  /** model / provider：前端当前选中的模型，供恢复的会话在发消息前就按正确的窗口计算占用 */
  | { type: "load_session"; sessionId: string; model?: string; provider?: string }
  | { type: "new_session"; workspace?: string; model?: string; provider?: string; mode?: "agent" | "quest" | "cowork" }
  /**
   * 会话分叉：从 sessionId 指向的已有会话派生出一个新会话。
   *
   * 两种入口，共用这一条指令：
   * · 不带截断参数（会话列表 / 顶栏「分叉」）—— 新会话只继承源会话的「记忆」
   *   （SessionData.memory），不复制对话消息历史。用户要带走的是结论而不是过程。
   *   记忆会随每轮请求作为按轮注入发出（见 PromptBuilder.buildInjections），
   *   因此分叉后模型立刻就知道此前沉淀下的结论。源会话保持不变。
   * · 带截断参数（某条 AI 回复上的「从这里分叉」）—— 额外把截至那一轮为止的历史
   *   一并复制进新会话，见下面两个字段。此时记忆同样会复制。
   */
  | {
      type: "fork_session";
      sessionId: string;
      /**
       * 历史截断锚点：「回合起点」用户消息的 clientMessageId。
       *
       * ⚠️ 这里传的不是被点的那条 assistant 消息 —— 落盘的 assistant 消息**没有 id**
       * （ChatCompletionMessageParam 里只有 user 带 clientMessageId、tool 带 tool_call_id），
       * 后端无法按 assistant 消息的 id 定位。而前端一条 assistant 气泡实际覆盖后端一串消息
       * （assistant + tool_calls + n 条 tool 结果 + 收尾正文），于是用「包住这条回复的那一轮
       * 是从哪条用户消息开始的」来锚定：后端把这个 id 对应的用户消息及其后的整轮
       * （直到下一条真实用户消息之前）一起带走，语义恰好等于前端那一条气泡。
       *
       * 缺省 = 不复制历史（只有记忆）。
       */
      upToMessageId?: string;
      /**
       * 兜底锚点：锚点用户消息在历史里的序号（从 0 开始，只数真实用户消息，跳过截图注入）。
       *
       * 存在的理由：老会话（clientMessageId 落盘之前）与压缩生成的摘要用户消息都没有
       * clientMessageId，前端只能给出序号。口径与 edit_user_message 的 userIndex 完全一致。
       * 两者都传时优先按 id 匹配，id 匹配不上再用序号。
       */
      upToUserIndex?: number;
    }
  | { type: "reset_session" }
  // Cowork 流程：存在 ~/.axon/cowork/flows.json，扩展和独立 server 走同一套指令
  | { type: "cowork_list_flows" }
  | { type: "cowork_save_flow"; flow: unknown; requestId?: string }
  | { type: "cowork_delete_flow"; id: string }
  /** 把一个已完成的 Cowork 会话提炼成流程草稿（不保存，等用户确认） */
  /** 起草流程：给 sessionId 就从做完的任务提炼；给 description 就按描述设计（此时用 model / provider） */
  | { type: "cowork_draft_flow"; sessionId?: string; description?: string; model?: string; provider?: string; requestId?: string }
  // 连接器（~/.axon/settings/connectors.json，密钥单独存放）
  | { type: "connectors_list" }
  | { type: "connector_save"; connector: unknown; requestId?: string }
  | { type: "connector_set_enabled"; id: string; enabled: boolean }
  | { type: "connector_delete"; id: string }
  /** 试连：草稿（未保存）或已保存的连接器，列出它提供的工具 */
  | { type: "connector_test"; connector: unknown; requestId?: string }
  /** 一键连接：OAuth 连接器去浏览器授权；GitHub 走设备码登录。connector 是要保存的草稿（新建时没有 id） */
  | { type: "connector_connect"; connector: unknown; requestId?: string }
  /** 取消正在进行的授权 / 登录 */
  | { type: "connector_connect_cancel"; requestId?: string }
  /** 断开授权（删掉 OAuth 凭据，连接器保留） */
  | { type: "connector_sign_out"; id: string }
  /** 连接器全局设置：GitHub OAuth App 的 Client ID */
  | { type: "connector_app_settings"; githubClientId?: string }
  // 插话：回复进行中追加消息（字段同 user_message）；会话空闲时等同于发一条普通消息
  | (Omit<UserMessageCommand, "type"> & { type: "steer_message" })
  | { type: "steer_cancel"; clientMessageId: string }
  // 后台任务（start_process 启动的进程），跨所有活跃会话
  | { type: "list_background_tasks" }
  | { type: "get_background_task_output"; sessionId: string; terminalId: string; requestId?: string }
  | { type: "stop_background_task"; sessionId: string; terminalId: string }
  // 工作区
  | { type: "set_workspace"; workspace: string; workspaces?: string[] }
  | { type: "set_workspace_group"; groupId: string }
  /** 用户明确确认后初始化指定工作区的 .axon 文件；普通切换工作区不会创建文件。 */
  | { type: "initialize_workspace"; workspace: string; axonContent?: string }
  /** 只读分析工作区，生成 AXON.md 草案；不会写入文件。 */
  | { type: "propose_workspace_axon"; workspace: string }
  /** 只读探测当前会话全部工作区的 .axon 状态；不会创建目录或文件。 */
  | { type: "inspect_workspace_axon" }
  /** 前端模型选择切换时同步当前 Provider，供 IDE 状态栏展示对应额度。 */
  | { type: "set_active_provider"; provider?: string }
  // 执行控制
  | { type: "cancel" }
  | { type: "edit_user_message"; messageId: string; content: string; displayText?: string; userIndex?: number; images?: string[]; attachedFiles?: unknown[] }
  // 上下文压缩。model/provider 可选：前端切换了模型选择器但尚未发送消息时，
  // 会话内部的 model/provider 仍是上一条消息用的值，需要带上前端当前选中值同步。
  | { type: "compact_session"; model?: string; provider?: string }
  | { type: "force_compact_session"; model?: string; provider?: string }
  | { type: "compaction_choice"; choice: "continue" | "new_session" }
  // 生成 / 续跑项目 Wiki。workspace 由 UI 显式指定 —— 生成是写操作，
  // 多工作区下不能由后端推定（写错仓库会污染不相干项目，且那些文件还会被提交）。
  // model / provider / maxPages 来自 VS Code 设置（axon.wiki.*），由呈现端读出后透传：
  // 读设置是形态相关的事，而「哪个 provider 提供这个模型」的解析留在 core。
  | { type: "wiki_generate"; workspace: string; provider?: string; model?: string; maxPages?: number }
  // Credits 预算门：硬暂停触发时用户的继续/停止决策
  | { type: "credit_budget_choice"; choice: "continue" | "stop" }
  // 浏览器：把 open_browser 打开的页面带到前台（前端点击卡片输出触发）
  | { type: "focus_browser" }
  // 编辑模式 / 待确认改动
  | { type: "set_edit_mode"; mode: "auto" | "manual" }
  /** 权限模式：safe 安全（默认）/ auto 自动（不审批）/ full 完全访问（自动 + 可写工作区外） */
  | { type: "set_permission_mode"; mode: "safe" | "auto" | "full" }
  /** 后台 Agent 任务：交给 AI 在后台独立完成（新会话，自动权限） */
  | { type: "agent_task_start"; content: string; displayText?: string; model: string; provider: string; effort?: string; workspace?: string; workspaces?: string[] }
  | { type: "agent_tasks_list" }
  | { type: "agent_task_stop"; taskId: string }
  | { type: "agent_task_remove"; taskId: string }
  /** 用户看过了（清掉未读标记） */
  | { type: "agent_task_seen"; taskId: string }
  | { type: "accept_edits"; path?: string }
  | { type: "reject_edits"; path?: string }
  | { type: "undo_edits"; path: string }
  // 闪电回滚
  | { type: "list_snapshots" }
  /**
   * 保存 / 导入会话记忆。
   * mode=merge：导入（.md、别的会话），合并进当前记忆；mode=replace（默认）：编辑后保存，
   * base 是开始编辑时的记忆，后台期间改过记忆时据此三方合并。
   */
  | { type: "set_memory"; memory: string; base?: string; mode?: "replace" | "merge" }
  /** 取记忆的历史版本（回 memory_history 事件） */
  | { type: "get_memory_history" }
  /** 恢复记忆到某个历史版本（at 为版本时间戳） */
  | { type: "restore_memory_version"; at: number }
  | { type: "restore_snapshot"; snapshotId: string }
  // 按需取某次改动的前后全文（会话快照里只下发路径与 editId，打开 diff 时再取正文）。
  // requestId 原样回带在 diff_content 事件上，前端据此配对请求。
  | { type: "get_diff_content"; requestId: string; editId?: string; path?: string }
  // Relay
  | { type: "delete_relay"; relayId: string; workspace?: string }
  // 工具确认（用户确认/拒绝创建 Relay 等需要确认的操作）
  | { type: "confirm_tool"; confirmed: boolean; mode?: "strict" | "auto" }
  // 表单提交（ask_form 工具 / 内联表单块）：当前全部字段值 + 触发的动作
  | {
      type: "submit_form";
      /** 阻塞式表单对应 ask_form 的工具调用 id */
      toolCallId?: string;
      /** 动作标识："submit" | 自定义按钮 id | row:<表格名>:<行下标>:<动作 id> */
      action: string;
      /** 当前全部字段值 */
      values: Record<string, unknown>;
      /** 表格名 → 被勾选的行下标 */
      selectedRows?: Record<string, string[]>;
    }
  // 选项问答（ask_user 工具）的用户作答：answers 与请求里的 questions 一一对应
  | {
      type: "answer_user_question";
      /** 对应 ask_user 的工具调用 id */
      toolCallId: string;
      answers: {
        /** 选中的选项 id 列表（单选时最多一个；skipped 时为空） */
        selected: string[];
        /** 用户自己填写的「其他」答案（allowOther 且有填写时） */
        other?: string;
        /** 用户选择「跳过，让你自己决定」 */
        skipped?: boolean;
      }[];
    }
  // 压平历史里的结构化工具调用（用户点击"压缩不兼容记忆"后触发）
  | { type: "flatten_tool_history" }
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
