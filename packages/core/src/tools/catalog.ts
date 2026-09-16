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
  // 主 Agent 编排类（不在通用 tools.ts，子 Agent 拿不到）
  DelegateTask = "delegate_task",
  RelayCreate = "relay_create",
  RelaySaveDoc = "relay_save_doc",
  RelayAdvance = "relay_advance",
  RelayUpdateTask = "relay_update_task",
  RelayReviewTask = "relay_review_task",
  ParallelResearch = "parallel_research",
  ParallelExecute = "parallel_execute",
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
 *   · 结论型（delegate_task / parallel_research / parallel_execute）：子 Agent 的最终交付物，
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
  ToolName.ParallelResearch,
  ToolName.ParallelExecute,
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
 * 单次终端输出保留的最大字符数（≈2.8 万 token，约 1M 窗口的 2.8%）。
 *
 * 取这个量级的理由：正常构建日志/搜索结果远达不到，不会误伤；
 * 而病态输出（递归全盘搜索、无过滤的巨型 JSON）被挡在这里，
 * 不至于一条命令就把上下文顶爆。
 */
export const TERMINAL_OUTPUT_CAP = 100_000;

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
  [ToolName.Search]: { status: S("正在搜索...", "searching"), requiresArgs: true, readOnly: true, transient: true, contentLimit: 4_000 },
  [ToolName.ListDir]: { status: S("正在浏览目录...", "searching"), readOnly: true, transient: true, contentLimit: 4_000 },
  [ToolName.CheckDiagnostics]: { status: S("正在检查语法...", "checking"), requiresArgs: true, transientAggressive: true, contentLimit: 8_000 },
  [ToolName.WebSearch]: { status: S("正在搜索网络...", "searching"), requiresArgs: true, readOnly: true, transient: true },
  [ToolName.WebFetch]: { status: S("正在获取网页...", "searching"), requiresArgs: true, readOnly: true, transient: true, contentLimit: 10_000 },
  [ToolName.UseSkill]: { status: S("正在加载 Skill...", "thinking"), requiresArgs: true, readOnly: true },
  [ToolName.ActivatePower]: { requiresArgs: true, readOnly: true },
  [ToolName.DelegateTask]: { status: S("正在委托子 Agent...", "delegating"), requiresArgs: true, contentLimit: NO_CONTENT_LIMIT },
  [ToolName.RelayCreate]: { status: S("正在创建工作流...", "planning"), requiresArgs: true },
  [ToolName.RelaySaveDoc]: { requiresArgs: true },
  [ToolName.RelayAdvance]: { requiresArgs: true },
  [ToolName.RelayUpdateTask]: { requiresArgs: true },
  [ToolName.RelayReviewTask]: { requiresArgs: true },
  [ToolName.ParallelResearch]: { status: S("正在并行调研...", "delegating"), requiresArgs: true, contentLimit: NO_CONTENT_LIMIT },
  [ToolName.ParallelExecute]: { status: S("正在并行执行...", "delegating"), requiresArgs: true, contentLimit: NO_CONTENT_LIMIT },
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
/** 瞬态工具（跨轮裁掉结果） */
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
