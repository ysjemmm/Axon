/**
 * 工具目录（单一事实来源）—— 集中定义每个工具的"名称 + 状态文案 + 行为标记"。
 *
 * 此前这些信息以魔法字符串散落在多处：definitions（只读白名单/内容上限）、agentSession
 * （状态文案 / 软失败集 / 编辑落盘集 / 必填参数集 / 分发 switch）、promptBuilder（瞬态工具集）、
 * snapshot（快照工具集）。任何增删工具都要改一圈、极易漏改。
 *
 * 现在统一收敛到这里：
 *   · ToolName        —— 工具名枚举，杜绝魔法字符串，全仓库引用 ToolName.X
 *   · TOOL_CATALOG    —— 每个工具的元数据（状态文案 + 行为标记 + 内容上限）
 *   · 派生集合/谓词   —— READ_ONLY_TOOLS / isSnapshotTool / isSoftFailProne 等，从目录派生
 *
 * 工具的【描述与参数 schema】仍在 definitions.ts 的 getToolDefinitions（那本就是集中的、且要逐字
 * 喂给 LLM）；本目录补齐"描述之外的行为面"，两者按 ToolName 对齐。
 */

/** 内置工具名枚举（含主 Agent 专属的编排类工具）。MCP 工具是动态前缀，不在此枚举。 */
export enum ToolName {
  // 文件
  ReadFile = "read_file",
  CreateFile = "create_file",
  StrReplace = "str_replace",
  ApplyPatch = "apply_patch",
  // 命令 / 进程
  ExecuteCommand = "execute_command",
  StartProcess = "start_process",
  GetProcessOutput = "get_process_output",
  StopProcess = "stop_process",
  ListProcesses = "list_processes",
  // 浏览器
  OpenBrowser = "open_browser",
  GetBrowserLogs = "get_browser_logs",
  ScreenshotPage = "screenshot_page",
  CloseBrowser = "close_browser",
  BrowserClick = "browser_click",
  BrowserType = "browser_type",
  BrowserPress = "browser_press",
  BrowserSelect = "browser_select",
  BrowserScroll = "browser_scroll",
  BrowserReload = "browser_reload",
  GetBrowserNetwork = "get_browser_network",
  GetBrowserStorage = "get_browser_storage",
  BrowserEval = "browser_eval",
  BrowserHover = "browser_hover",
  BrowserWait = "browser_wait",
  BrowserGetHtml = "browser_get_html",
  BrowserSetViewport = "browser_set_viewport",
  BrowserBack = "browser_back",
  BrowserForward = "browser_forward",
  // 搜索 / 诊断 / 联网
  Search = "search",
  ListDir = "list_dir",
  CheckDiagnostics = "check_diagnostics",
  WebSearch = "web_search",
  WebFetch = "web_fetch",
  // 技能 / 能力包
  UseSkill = "use_skill",
  ActivatePower = "activate_power",
  // Wiki 页面保存：生成流程专用，不在默认工具列表里（见 definitions.getWikiToolDefinitions）
  WikiSavePage = "wiki_save_page",
  // Wiki 页面规划：生成流程专用，仅在规划阶段注入
  WikiPlanPages = "wiki_plan_pages",
  // 主 Agent 编排类（不在通用 tools.ts，子 Agent 拿不到）
  DelegateTask = "delegate_task",
  RelayCreate = "relay_create",
  RelaySaveDoc = "relay_save_doc",
  RelayAdvance = "relay_advance",
  RelayUpdateTask = "relay_update_task",
  RelayReviewTask = "relay_review_task",
  // 选项问答：主 Agent 向用户抛问题 + 选项，用户单选/多选作答。
  // 子 Agent 拿不到用户（会死等），故只在 ToolDefBuilder 里注入给主 Agent。
  AskUser = "ask_user",
  // 产出登记（Cowork 专用）：Agent 自己把最终交付的文件告诉前端，渲染成可预览卡片。
  // 只在办公面板注入 —— 比我们去扫目录猜哪些文件是产出可靠得多。
  ReportOutputs = "report_outputs",
  // 声明式表单：主 Agent 把「需要用户填一套参数」交付成一张可填写的表单/控件面板。
  // 与 ask_user 同源（都需要用户在场），子 Agent 拿不到，故只在 ToolDefBuilder 里注入。
  AskForm = "ask_form",
  // 会话记忆：主 Agent 把本次会话值得跨会话带走的结论浓缩成一份 md 写回会话。
  // 记忆是会话级的，子 Agent 独立跑完就丢，故同样只在 ToolDefBuilder 里注入。
  UpdateMemory = "update_memory",
  // Chat 产物：模型把一份独立成品（HTML 页面 / SVG / 文档 / 代码）交付给用户。
  // 与 create_file 的区别：create_file 是「改项目源码」，产物是「交付物」，统一落到产物目录、
  // 渲染成可预览的卡片。后端直接写盘，所以不带文件工具的问答模式也能用。
  // 面向用户交互，子 Agent 不需要，故只在 ToolDefBuilder 里注入给主 Agent。
  CreateArtifact = "create_artifact",
  // 媒体渲染：把模型写的 HTML 动画在后端离屏渲染成 GIF / MP4（可选本机语音旁白）。
  // 与 create_artifact 的区别：产物是后端渲染出的二进制文件，模型只给 HTML 和参数。
  // 不碰仓库、不给模型任何命令权限，所以 Quest 模式也可以用；仅在宿主提供 mediaRenderer 时注入。
  RenderMedia = "render_media",
}

/**
 * 工具调用卡片的状态机（前后端共享的协议值）。
 * 经 JSON 跨进程传输，后端 agentSession 产出、前端按此渲染：
 *   Queued（还没开始执行：排队等待，或参数仍在流式生成）→ Executing（正在执行）
 *   → Success / Error / Cancelled（终态）
 * 前端对应类型是 web/src/components/ToolCallItem.tsx 的 ToolStatus，两侧字符串值必须一致。
 * 注意两边词表并不完全相同：本枚举的 Executing 对应前端的 "pending"（前端用 pending 表示
 * "正在执行"），而两边的 "queued" 含义一致。前端不存在 Pending 这个协议值。
 *
 * Queued 与 Executing 必须是两个值：本轮工具由 DefaultToolDispatchHandler **串行**执行
 * （for + await，一个跑完才轮到下一个），但流式阶段 onToolCallDetected 会为每个工具提前发卡
 * 以消除等待感。此时一个都还没开始跑，若与 Executing 共用一个值，前端只能把"排队"画成
 * "执行中"——多工具轮里几张卡一起转圈、都写着"执行命令中..."，而实际只有第一个在跑。
 *
 * Pending 保留但不再用于 tool_call 事件（执行前卡片一律 Executing，提前卡一律 Queued）。
 */
export enum ToolCallStatus {
  Queued = "queued",
  Pending = "pending",
  Executing = "executing",
  Success = "success",
  Error = "error",
  Cancelled = "cancelled",
}

/** 单个工具的行为/呈现元数据（描述与参数 schema 在 definitions.ts，不在此处重复）。 */
export interface ToolSpec {
  /** 执行时推送给前端的状态文案 + 阶段（缺省回退到“正在执行 X...”/executing） */
  status?: { content: string; phase: string };
  /** 只读：不改文件/不跑命令，可被并行只读子 Agent 安全调用 */
  readOnly?: boolean;
  /** 必须带至少一个参数（空参数对象视为调用失败，提前拦截） */
  requiresArgs?: boolean;
  /** 易“软失败”的工具（前几次失败隐藏卡片，错误回传 AI 重试即可） */
  softFailProne?: boolean;
  /** 写文件类：执行前建快照，可被一键回滚 */
  snapshot?: boolean;
  /** 编辑类：硬失败时前几次不落盘（_transient 标记控制） */
  editPersist?: boolean;
  /** 瞬态：结果只在当轮有意义，跨轮从历史里裁掉 */
  transient?: boolean;
  /** 仅对慢模型（DeepSeek 等）额外纳入瞬态裁剪 */
  transientAggressive?: boolean;
  /** 存入对话历史的内容上限（字符）。缺省 3000 */
  contentLimit?: number;
}

/**
 * “不截断”哨兵值：给那些结果一旦被砍就补不回来的工具用。
 * 内容上限设为无穷大，使各处 `len > limit` 的判定恒为 false。
 */
export const NO_CONTENT_LIMIT = Number.POSITIVE_INFINITY;

/**
 * 不截断工具：结果必须原样保留，任何环节都不得裁剪。只含结论型——
 *   · 结论型（delegate_task）：子 Agent 的最终交付物，
 *     不像 read_file 那样能“换个范围再读一次”，砍掉即永久丢失。
 *
 * ⚠️ 终端类（execute_command / get_process_output）曾经也在本集合里，现已移出，见 TERMINAL_OUTPUT_TOOLS。
 * 原因是实测事故：它们“重跑有代价”所以不该随便裁，但**没有上限**会出事——某会话因一条跨仓库
 * 递归搜索的命令输出（1168 万字符）把上下文顶到 327 万 token，是 1M 窗口的 3 倍多，界面直接 100% 卡死。
 * 现在改为：单次结果有硬上限（TERMINAL_OUTPUT_CAP，超出保留头尾），旧轮次允许被裁剪。
 *
 * 覆盖的裁剪环节：
 *   · 存入对话历史：toolOutcomeRecorder / SubAgentRunner 读 contentLimit
 *   · 旧轮次裁剪：compactor.pruneOldToolResults
 *   · 请求组装的历史摘要：promptBuilder
 *   · 发往前端的实时事件：见 FULL_RESULT_TOOLS（结论型仍走完整结果）
 *
 * 注意：host 层的 MAX_BUFFER_CHARS 是采集侧的内存保护（进程输出缓冲自动滚出旧内容），
 * 不属于“对结果的裁剪”，不在此列。
 */
export const NO_TRUNCATE_TOOLS: Set<string> = new Set([
  ToolName.DelegateTask,
]);

/**
 * 终端类工具：输出体量由外部命令决定，我们控制不了。
 *
 * 与结论型的处理策略刻意不同：
 *   · 结论型——任何环节都不裁（永久保留，不可复得）
 *   · 终端类——单次结果有硬上限（TERMINAL_OUTPUT_CAP）；旧轮次允许被裁剪
 *     （把“重跑一次”当作可接受的代价，换取上下文不再被历史输出长期占用）
 *
 * 为什么旧轮次可以裁：这类输出几十 KB 起步，信息早已被模型提炼进回复，
 * 留在历史里对后续判断几乎零价值，却要每一轮请求都重发一遍。
 */
export const TERMINAL_OUTPUT_TOOLS: Set<string> = new Set([
  ToolName.ExecuteCommand,
  ToolName.GetProcessOutput,
]);

/**
 * 单次终端输出写入历史的最大字符数（超出保留头 40% + 尾 60%）。
 *
 * ⚠️ 这是终端输出唯一的一道裁剪：写入历史时一次裁到位，之后不再改写
 * （回合收尾的旧结果裁剪已移除——它改写历史中间的消息，每轮都断一次前缀缓存）。
 * 所以上限要按「长期留在历史里」来定，而不是按「只在当轮有用」来定。
 *
 * 取 20_000 的依据（实测 33 个会话、1084 次 execute_command）：p90 = 3053、p99 = 5945、
 * 最大 18561 —— 正常输出全部原样保留；病态输出（递归全盘搜索、无过滤的巨型 JSON）
 * 被挡在约 5 千 token 以内。原值 100_000 是事故修复时的"防顶爆"口径，不适合长期驻留。
 */
export const TERMINAL_OUTPUT_CAP = 20_000;

/**
 * 发往前端实时事件时保留完整结果（不降为 500 字符预览）的工具。
 * = 结论型 ∪ 终端类：终端输出正是用户在卡片上要看的主体内容。
 *
 * 注意它只决定“发多少给前端”，不决定“旧轮次是否允许被裁剪”——后者看 NO_TRUNCATE_TOOLS。
 * 这两件事过去共用一个集合，所以“要不要在历史里保留”和“要不要发给前端看”被绑死了。
 */
export const FULL_RESULT_TOOLS: Set<string> = new Set([
  ...NO_TRUNCATE_TOOLS,
  ...TERMINAL_OUTPUT_TOOLS,
]);

/**
 * 探索类工具：read_file / search / list_dir —— 三者结果都属于「换个更精确的调用就能重新拿到」。
 *
 * 这是它们与结论型工具（delegate_task：砍掉即永久丢失、不可复得）的根本区别，
 * 也正是能对它们做「单轮累计限流」的前提：超了可以让模型换个方式再取，结论型超了只能认。
 */
export const EXPLORATION_TOOLS: Set<string> = new Set([
  ToolName.ReadFile,
  ToolName.Search,
  ToolName.ListDir,
]);

/**
 * 单轮探索结果的累计上限（字符）。
 *
 * ── 为什么单次上限不够 ──
 * 它管不住总量。实测：一次「了解某项目结构」的任务里，模型连读十几份文件，单次都在各自
 * 上限内，一轮累计却到 10 万字符量级；后端 + 前端两次叠起来接近 20 万。
 * 逐个工具收紧单次上限只是把每次切得更碎（总量不变），所以必须有一道【按轮累计】的闸。
 *
 * ── 为什么只覆盖探索类 ──
 * 只有探索类能「换方式重取」：读被截了可以读更小的行范围，搜被截了可以缩窄 query。
 * 结论型（子 Agent 交付物）砍掉就补不回来，终端类另有自己的硬上限，都不该进这套预算。
 *
 * ── 取值依据 ──
 * 实测正常轮次多在 2~5 万字符，失控轮次 9~15 万。6 万足以放行正常探索，
 * 又能把失控轮次压到一半以下。
 */
/**
 * ⚠️ 已停用（按用户要求移除该约束）。
 *
 * 原值 60_000：把「一轮内累计读入的探索类结果」限制在 6 万字符，用尽后后续每次
 * read_file / search / list_dir 都只返回 TURN_BUDGET_EXHAUSTED_PREVIEW 个字符的预览。
 * 它带来的实际摩擦是：同一个文件想分几次读完会被中途掐断，只能靠"换一轮"重置额度，
 * 而换轮本身要重发、重推理、重烧额度——反而更贵。
 *
 * 置为 Infinity 后，capByTurnBudget 里的 `content.length <= remaining` 恒成立，直接原样返回，
 * 该上限从此不再生效：读文件只受「单次上限」（capToolContent / 各工具 contentLimit）约束。
 * 需要恢复时把本常量改回 60_000 即可——函数与整条调用链都原样保留。
 */
export const TURN_EXPLORATION_BUDGET = Number.POSITIVE_INFINITY;

/**
 * 预算用尽后，单条探索结果还能保留的字符数。
 * 取 1500 是为了够模型判断「这份内容里有没有我要的东西」——只留几十字符等于什么都没给。
 */
export const TURN_BUDGET_EXHAUSTED_PREVIEW = 1_500;

const S = (content: string, phase: string) => ({ content, phase });

/**
 * 工具元数据目录。新增/调整工具的行为或状态文案，只改这一处。
 */
export const TOOL_CATALOG: Record<ToolName, ToolSpec> = {
  [ToolName.ReadFile]: { status: S("正在读取文件...", "reading"), requiresArgs: true, readOnly: true, softFailProne: true, transient: true, contentLimit: 12_000 },
  [ToolName.CreateFile]: { status: S("正在创建文件...", "editing"), requiresArgs: true, snapshot: true, editPersist: true },
  [ToolName.StrReplace]: { status: S("正在修改文件...", "editing"), requiresArgs: true, snapshot: true, editPersist: true, softFailProne: true },
  [ToolName.ApplyPatch]: { requiresArgs: true, snapshot: true, editPersist: true, softFailProne: true },
  [ToolName.ExecuteCommand]: { status: S("正在执行命令...", "running"), requiresArgs: true, contentLimit: TERMINAL_OUTPUT_CAP },
  [ToolName.StartProcess]: { status: S("正在启动后台进程...", "running"), requiresArgs: true },
  [ToolName.GetProcessOutput]: { status: S("正在读取进程输出...", "running"), requiresArgs: true, contentLimit: TERMINAL_OUTPUT_CAP },
  [ToolName.StopProcess]: { status: S("正在停止后台进程...", "running"), requiresArgs: true },
  [ToolName.ListProcesses]: { status: S("正在列出后台进程...", "running") },
  [ToolName.OpenBrowser]: { status: S("正在打开浏览器...", "running"), requiresArgs: true },
  [ToolName.GetBrowserLogs]: { status: S("正在读取控制台/报错...", "checking"), requiresArgs: true },
  [ToolName.ScreenshotPage]: { status: S("正在截图页面...", "running") },
  [ToolName.CloseBrowser]: { status: S("正在关闭浏览器...", "running") },
  [ToolName.BrowserClick]: { status: S("正在点击页面元素...", "running"), requiresArgs: true },
  [ToolName.BrowserType]: { status: S("正在输入文本...", "running"), requiresArgs: true },
  [ToolName.BrowserPress]: { status: S("正在按键...", "running"), requiresArgs: true },
  [ToolName.BrowserSelect]: { status: S("正在选择...", "running"), requiresArgs: true },
  [ToolName.BrowserScroll]: { status: S("正在滚动页面...", "running"), requiresArgs: true },
  [ToolName.BrowserReload]: { status: S("正在刷新页面...", "running") },
  [ToolName.GetBrowserNetwork]: { status: S("正在读取网络请求...", "checking"), requiresArgs: true },
  [ToolName.GetBrowserStorage]: { status: S("正在读取存储数据...", "checking"), requiresArgs: true },
  [ToolName.BrowserEval]: { status: S("正在执行 JS...", "running"), requiresArgs: true },
  [ToolName.BrowserHover]: { status: S("正在悬停...", "running"), requiresArgs: true },
  [ToolName.BrowserWait]: { status: S("正在等待...", "running"), requiresArgs: true },
  [ToolName.BrowserGetHtml]: { status: S("正在读取 HTML...", "checking"), requiresArgs: true },
  [ToolName.BrowserSetViewport]: { status: S("正在设置视口...", "running"), requiresArgs: true },
  [ToolName.BrowserBack]: { status: S("正在后退...", "running") },
  [ToolName.BrowserForward]: { status: S("正在前进...", "running") },
  [ToolName.Search]: { status: S("正在搜索...", "searching"), requiresArgs: true, readOnly: true, transient: true, contentLimit: 2_500 },
  [ToolName.ListDir]: { status: S("正在浏览目录...", "searching"), readOnly: true, transient: true, contentLimit: 3_000 },
  [ToolName.CheckDiagnostics]: { status: S("正在检查语法...", "checking"), requiresArgs: true, transientAggressive: true, contentLimit: 8_000 },
  [ToolName.WebSearch]: { status: S("正在搜索网络...", "searching"), requiresArgs: true, readOnly: true, transient: true },
  [ToolName.WebFetch]: { status: S("正在获取网页...", "searching"), requiresArgs: true, readOnly: true, transient: true, contentLimit: 10_000 },
  [ToolName.UseSkill]: { status: S("正在加载 Skill...", "thinking"), requiresArgs: true, readOnly: true },
  [ToolName.ActivatePower]: { requiresArgs: true, readOnly: true },
  // 写操作（不标 readOnly：只读子 Agent 不可用）。也不进快照体系 ——
  // 快照回滚是给用户代码准备的，Wiki 页面有 git 托管，不需要另一套撤销。
  [ToolName.WikiSavePage]: { status: S("正在保存 Wiki 页面...", "editing"), requiresArgs: true },
  // 规划不写文件、只登记清单，故标 readOnly（只读子 Agent 也能用）
  [ToolName.WikiPlanPages]: { status: S("正在规划 Wiki 页面...", "planning"), requiresArgs: true, readOnly: true },
  [ToolName.DelegateTask]: { status: S("正在委托子 Agent...", "delegating"), requiresArgs: true, contentLimit: NO_CONTENT_LIMIT },
  [ToolName.RelayCreate]: { status: S("正在创建工作流...", "planning"), requiresArgs: true },
  [ToolName.RelaySaveDoc]: { requiresArgs: true },
  [ToolName.RelayAdvance]: { requiresArgs: true },
  [ToolName.RelayUpdateTask]: { requiresArgs: true },
  [ToolName.RelayReviewTask]: { requiresArgs: true },
  // 选项问答：结果（用户的选择）要留在历史里供后续轮次参考，故不标 transient。
  [ToolName.AskUser]: { status: S("正在等待你的选择...", "thinking"), requiresArgs: true, contentLimit: NO_CONTENT_LIMIT },
  // 声明式表单：用户填的内容是后续轮次的依据，同样要留在历史里，故不标 transient。
  [ToolName.AskForm]: { status: S("正在等待你填写...", "thinking"), requiresArgs: true, contentLimit: NO_CONTENT_LIMIT },
  // 产出登记：结果只是"登记成功/哪些路径不存在"的短回执。
  // 标 transient —— 这条回执对后续轮次没有参考价值，留在历史里纯占上下文。
  [ToolName.ReportOutputs]: { status: S("正在整理产出文件...", "editing"), requiresArgs: true, transient: true },
  // 会话记忆：入参是整份 md（可能不短），标 transient 让工具的【结果】跨轮被裁掉。
  // 调用本身仍留在历史的 assistant 消息里，故只在值得记的时候调用。
  // 记忆的正式落点是 SessionData.memory，随后由 PromptBuilder 作为按轮注入。
  [ToolName.UpdateMemory]: { status: S("正在更新会话记忆...", "thinking"), requiresArgs: true, transient: true },
  // 产物：入参 content 就是整份成品（可能很大），调用本身会留在 assistant 消息里；
  // 标 transient 让工具【结果】那条短回执跨轮被裁掉，不占上下文。
  [ToolName.CreateArtifact]: { status: S("正在生成产物...", "editing"), requiresArgs: true, transient: true },
  // 媒体渲染：入参 html 可能很大，调用本身会留在 assistant 消息里；
  // 标 transient 让工具【结果】那条回执跨轮被裁掉。渲染耗时较长，进度由执行过程中的 status 事件细化。
  [ToolName.RenderMedia]: { status: S("正在渲染动画...", "running"), requiresArgs: true, transient: true },
};

const DEFAULT_CONTENT_LIMIT = 3_000;

/** 取某 flag 为 true 的工具名集合（用于一次性派生 Set） */
function namesWith(flag: keyof ToolSpec): Set<string> {
  return new Set(
    (Object.keys(TOOL_CATALOG) as ToolName[]).filter((n) => TOOL_CATALOG[n][flag] === true),
  );
}

/** 只读工具白名单（可并行只读子 Agent 调用） */
export const READ_ONLY_TOOLS: Set<string> = namesWith("readOnly");
/** 写文件类：执行前建快照 */
export const SNAPSHOT_TOOLS: Set<string> = namesWith("snapshot");
/** 易软失败工具（隐藏前几次失败卡片） */
export const SOFT_FAIL_TOOLS: Set<string> = namesWith("softFailProne");
/** 编辑类：硬失败前几次不落盘 */
export const EDIT_PERSIST_TOOLS: Set<string> = namesWith("editPersist");
/**
 * 瞬态工具（标记"结果只在当轮有用"）。
 *
 * ⚠️ 请求组装已不再据此在新一轮开头移除旧结果：那会让上一轮已发出的历史在新一轮变样，
 * 前缀缓存从中间断开、每次发问的首个请求按全价计费（见 promptBuilder.buildRequestMessages）。
 * 旧结果的体积现由写入时的单次上限（capToolContent）与滚动压缩控制。
 * 这两个集合目前没有消费方，保留是为了不丢失工具目录里的这层语义。
 */
export const TRANSIENT_TOOLS: Set<string> = namesWith("transient");
/** 慢模型下额外纳入瞬态的工具（含基础瞬态集 + transientAggressive 集） */
export const TRANSIENT_TOOLS_AGGRESSIVE: Set<string> = new Set([
  ...TRANSIENT_TOOLS,
  ...namesWith("transientAggressive"),
]);
/** 必须带参数的工具 */
export const REQUIRED_ARGS_TOOLS: Set<string> = namesWith("requiresArgs");

/** 工具执行时推送给前端的状态文案（未配置回退到“正在执行 X...”/executing） */
export function statusForTool(toolName: string): { content: string; phase: string } {
  return TOOL_CATALOG[toolName as ToolName]?.status ?? { content: `正在执行 ${toolName}...`, phase: "executing" };
}

/** 存入对话历史的内容上限（字符）。 */
export function contentLimitForTool(toolName: string): number {
  return TOOL_CATALOG[toolName as ToolName]?.contentLimit ?? DEFAULT_CONTENT_LIMIT;
}

/**
 * 按工具的内容上限裁剪结果（存入对话历史 / 发往前端共用同一份实现）。
 *
 * - 未超限：原样返回（结论型上限是 Infinity，自然走这一支）
 * - 超限且是终端类：保留**头 + 尾**，中间省略。终端输出的尾部通常是报错与最终结论，
 *   比开头更重要（与 compactor.shouldKeepTail 的判断一致），只留开头会把最该看的部分丢掉。
 * - 超限且非终端类：保留开头。
 *
 * 裁剪后附一句可执行的提示，让模型知道该换什么方式取（而不是反复重试同一条命令）。
 */
export function capToolContent(toolName: string, content: string, limit = contentLimitForTool(toolName)): string {
  if (content.length <= limit) return content;
  if (TERMINAL_OUTPUT_TOOLS.has(toolName)) {
    const head = Math.floor(limit * 0.4);
    const tail = limit - head;
    return (
      content.slice(0, head) +
      `\n\n[⋯ 已省略中间 ${content.length - limit} 字符（原始 ${content.length} 字符，超出单次上限 ${limit}）⋯]\n` +
      `[提示：输出过长。后续请改用管道过滤（如 | Select-Object -First 50）或更精确的命令分次获取，不要重复执行整条命令]\n\n` +
      content.slice(-tail)
    );
  }
  return content.slice(0, limit) + `\n\n[内容已截断，原始长度 ${content.length} 字符。如需更多内容，请用更大的行范围一次性读取，不要分多次零碎读取]`;
}

/**
 * 按【单轮累计预算】裁剪探索类结果。
 *
 * 与 capToolContent 的分工：后者管「单次」上限（各工具自己的口径），本函数管「一轮内累计」——
 * 同一轮里第 N 次调用，可用额度是预算减去前 N-1 次的用量。两级都会生效：
 * 调用方先过 capToolContent，再把结果交给这里。
 *
 * ── 为什么用尽的文案要说「不是这一次被截」 ──
 * 若只说「已截断」，模型会以为换个范围重读就能拿到，于是反复重试、白烧轮次。
 * 必须讲明是【本轮累计到顶】，并把出路指明（缩小参数范围 / 先基于已有内容推进）。
 *
 * @param used 本轮此前已写入上下文的探索结果字符数（由调用方跨调用维护）
 * @returns content 为实际保留的文本；counted 为本次应计入预算的字符数
 *          （非探索类恒为 0 —— 它们不占用这套预算）
 */
export function capByTurnBudget(
  toolName: string,
  content: string,
  used: number,
): { content: string; counted: number } {
  // 非探索类不参与：结论型砍了不可复得，终端类另有自己的硬上限
  if (!EXPLORATION_TOOLS.has(toolName)) return { content, counted: 0 };

  const remaining = TURN_EXPLORATION_BUDGET - used;

  // 额度已用尽：只留开头一小段。counted 记 0 —— 再计下去会把额度推成负数，
  // 后续每一次都会走这一支，文案里出现的「剩余」也就跟着失真
  if (remaining <= 0) {
    return {
      content:
        content.slice(0, TURN_BUDGET_EXHAUSTED_PREVIEW) +
        `\n\n[本轮探索额度已用尽（上限 ${TURN_EXPLORATION_BUDGET} 字符），本结果仅保留开头 ${TURN_BUDGET_EXHAUSTED_PREVIEW} 字符。` +
        `\n注意：这不是单独某次调用被截，而是本轮累计读入已达上限。请先基于已获得的内容推进；` +
        `确实还需要别的信息时，用更精确的参数（更小的行范围 / 更窄的 query / includePattern）重新调用，只取真正需要的那部分。]`,
      counted: 0,
    };
  }

  if (content.length <= remaining) return { content, counted: content.length };

  return {
    content:
      content.slice(0, remaining) +
      `\n\n[本轮探索额度仅剩 ${remaining} 字符，本结果已截断（原始 ${content.length} 字符）。` +
      `请勿重试同一次调用；需要更多内容时请缩小参数范围，只取必要部分。]`,
    counted: remaining,
  };
}
