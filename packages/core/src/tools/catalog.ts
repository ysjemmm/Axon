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
 *   Pending（准备/等待执行）→ Executing（执行中）→ Success / Error / Cancelled（终态）
 * 前端有对应的镜像常量（web/src/.../toolStatus.ts），两侧字符串值必须一致。
 */
export enum ToolCallStatus {
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

const S = (content: string, phase: string) => ({ content, phase });

/**
 * 工具元数据目录。新增/调整工具的行为或状态文案，只改这一处。
 */
export const TOOL_CATALOG: Record<ToolName, ToolSpec> = {
  [ToolName.ReadFile]: { status: S("正在读取文件...", "reading"), requiresArgs: true, readOnly: true, softFailProne: true, transient: true, contentLimit: 12_000 },
  [ToolName.CreateFile]: { status: S("正在创建文件...", "editing"), requiresArgs: true, snapshot: true, editPersist: true },
  [ToolName.StrReplace]: { status: S("正在修改文件...", "editing"), requiresArgs: true, snapshot: true, editPersist: true, softFailProne: true },
  [ToolName.ApplyPatch]: { requiresArgs: true, snapshot: true, editPersist: true, softFailProne: true },
  [ToolName.ExecuteCommand]: { status: S("正在执行命令...", "running"), requiresArgs: true, transientAggressive: true },
  [ToolName.StartProcess]: { status: S("正在启动后台进程...", "running"), requiresArgs: true },
  [ToolName.GetProcessOutput]: { status: S("正在读取进程输出...", "running"), requiresArgs: true },
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
  [ToolName.DelegateTask]: { status: S("正在委托子 Agent...", "delegating"), requiresArgs: true },
  [ToolName.RelayCreate]: { status: S("正在创建工作流...", "planning"), requiresArgs: true },
  [ToolName.RelaySaveDoc]: { requiresArgs: true },
  [ToolName.RelayAdvance]: { requiresArgs: true },
  [ToolName.RelayUpdateTask]: { requiresArgs: true },
  [ToolName.RelayReviewTask]: { requiresArgs: true },
  [ToolName.ParallelResearch]: { requiresArgs: true },
  [ToolName.ParallelExecute]: { status: S("正在并行执行...", "delegating"), requiresArgs: true },
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
