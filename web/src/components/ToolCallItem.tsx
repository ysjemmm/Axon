/**
 * 工具调用展示 - 简洁一行式（参考 Kiro）
 *
 * 样式：[状态图标] 简短描述
 * - pending: 旋转 loading
 * - success: 绿色 ✓ + 结果描述
 * - error: 红色 ✗ + 错误描述
 *
 * execute_command 特殊样式：显示命令内容
 */

import { useState, useContext } from "react";
import { CheckCircle2, Loader2, Terminal, Eye, EyeOff, FileX, Search, GitCompare, Bug, ChevronRight, Check, X, Globe, ShieldCheck, Pencil, Plug, Undo2, Server, ScrollText, Power, ExternalLink, FolderTree } from "lucide-react";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCommandApproval, CommandApprovalContext, type CommandTrustOption, type CommandDecision } from "@/components/chat/commandApprovalContext";

/**
 * 单行文本：超长截断为省略号，hover 显示完整内容（shadcn tooltip）。
 * 仅当文本可能超长时才包 tooltip，短文本直接渲染避免无谓的 DOM。
 */
function TruncatedText({ text, className = "" }: { text: string; className?: string }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`truncate min-w-0 ${className}`}>{text}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-md whitespace-pre-wrap break-words">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** 可点击的文件名标签：点击通过 postMessage 通知扩展打开对应文件（可选带行号跳转选中） */
export function ClickableFileName({ fileName, absPath, startLine, endLine, className = "" }: { fileName: string; absPath?: string; startLine?: number; endLine?: number; className?: string }) {
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const filePath = absPath || fileName;
    if (!filePath) return;
    const vscode = (window as any).__axonVSCode;
    if (vscode) {
      vscode.postMessage({ type: "open_file", path: filePath, startLine, endLine });
    }
  };

  return (
    <span
      onClick={handleClick}
      className={`cursor-pointer hover:underline hover:text-blue-600 dark:hover:text-blue-400 transition-colors ${className}`}
      title={absPath || fileName}
    >
      {fileName}
    </span>
  );
}

export type ToolStatus = "pending" | "success" | "error";

/** check_diagnostics 单文件结果 */
export interface DiagnosticFileResult {
  path: string;
  ok: boolean;
  errorCount: number;
  /** 结果作用域：'project' 表示整个项目的汇总结果（非单个文件）。缺省为文件级。 */
  scope?: 'project';
}

export interface ToolCallData {
  id: string;
  name: string;
  status: ToolStatus;
  description: string;
  command?: string; // execute_command 专用：命令内容
  cwd?: string;     // execute_command 专用：工作目录
  output?: string;  // execute_command 专用：执行结果
  query?: string;   // search 专用：搜索关键词
  args?: Record<string, unknown>; // 原始工具参数，用于失败态仍能展示路径等关键信息
  diff?: { path: string; absPath?: string; oldContent: string; newContent: string }; // str_replace/create_file 专用：本次修改的完整文件前后快照
  diffs?: { path: string; absPath?: string; oldContent: string; newContent: string }[]; // apply_patch 专用：一次改多个文件，逐文件的前后快照
  diagnostics?: DiagnosticFileResult[]; // check_diagnostics 专用：按文件的诊断结果
  searchResults?: { query: string; source: string; results: { title: string; url: string; snippet: string; domain: string; date?: string }[] }; // web_search 专用
  fetchResult?: { url: string; title: string; byteSize: number; success: boolean; error?: string }; // web_fetch 专用
  powerActivated?: { name: string; displayName: string; mcpServerCount: number; skillCount: number; keywords: string[] }; // activate_power 专用
  pending?: boolean; // str_replace/create_file 专用：手动模式下是否待确认（未落盘）
  rejected?: boolean; // 该改动已被用户拒绝
  undoable?: boolean; // 该改动已被接受、可撤销（右侧显示撤销图标）
  reverted?: boolean; // 该改动已被用户撤销（恢复到接受前）
  /** 编辑单元 id（${toolCallId}::${path}）：接受/拒绝/撤销按此精确定位某一次改动 */
  editId?: string;
  displayName?: string; // 可选：消歧后的展示文件名（同名文件补路径），覆盖默认 basename 展示
  /** 该工具调用卡片是否对用户隐藏（中性结果：试探性调用被执行层拦住） */
  hidden?: boolean;
  /** MCP 工具专用：真实 server 名 / 工具名（后端透传，免去从编码工具名反推） */
  mcpServer?: string;
  mcpTool?: string;
}

/** 根据工具名和结果/参数生成描述 */
export function formatToolDescription(name: string, result?: string, args?: Record<string, unknown>): string {
  // MCP 工具（mcp__serverId__toolName）：提取友好名并显示结果
  if (name.startsWith("mcp__")) {
    const { serverName, toolName } = parseMcpToolName(name);
    if (!result) return `${toolName}...`;
    // 取结果的前 80 字符作为描述
    const short = result.length > 80 ? result.slice(0, 80) + "…" : result;
    return `${serverName} · ${toolName}: ${short}`;
  }

  const fileName = args?.path as string || "";
  const shortName = fileName ? fileName.split("/").pop()?.split("\\").pop() || fileName : "";
  const intent = (args?.intent as string) || "";
  // read_file 行号后缀，无指定时为空
  const lineSuffix = (name === "read_file") ? formatLineSuffix(args?.startLine, args?.endLine) : "";
  const fileWithLines = shortName + (lineSuffix ? ` ${lineSuffix}` : "");

  if (!result) {
    switch (name) {
      case "read_file": return shortName ? `读取 ${fileWithLines}` : "读取文件中...";
      case "create_file": {
        if (!result) return shortName ? `${args?.overwrite === true ? "覆盖" : "创建"} ${shortName}` : "创建文件中...";
        // 被防覆盖拦住时 result 以"文件 xxx 已存在"开头，显示为"文件已存在"而非"已创建"
        if (result.includes("已存在")) return shortName ? `${shortName} 已存在` : "文件已存在";
        return shortName ? `${result.startsWith("已覆盖") ? "已覆盖" : "已创建"} ${shortName}` : result;
      }
      case "str_replace": return shortName ? `编辑 ${shortName}` : "修改文件中...";
      case "apply_patch": return "应用补丁中...";
      case "execute_command": return "执行命令中...";
      case "search": return intent || fallbackIntent("search");
      case "list_dir": return intent || fallbackIntent("list_dir");
      case "check_diagnostics": return "检查中...";
      default: return `${name}...`;
    }
  }

  // 有结果时的描述
  switch (name) {
    case "read_file": return shortName ? `已读取 ${fileWithLines}` : result;
    case "create_file": {
      if (result.includes("已存在")) return shortName ? `${shortName} 已存在` : "文件已存在";
      return shortName ? `${result.startsWith("已覆盖") ? "已覆盖" : "已创建"} ${shortName}` : result;
    }
    case "str_replace": return shortName ? `已编辑 ${shortName}` : result;
    case "apply_patch": return "已应用补丁";
    case "execute_command": return "命令已执行";
    case "search": return intent || fallbackIntent("search");
    case "list_dir": return intent || fallbackIntent("list_dir");
    case "check_diagnostics": return result.includes("无错误") ? "无错误" : "发现错误";
    default: return result;
  }
}

/**
 * 把 startLine/endLine 格式化为行号后缀（对齐 Kiro：1-10 / 2-EOF / 空）
 * - 都为空：返回 ""
 * - 仅 endLine 缺：返回 "{start}-EOF"
 * - 仅 startLine 缺：返回 "1-{end}"
 * - 都有：返回 "{start}-{end}"
 */
/** 把可能为 number/string 的行号值规整为合法的正整数行号，非法则返回 undefined */
export function toLineNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n >= 1 ? n : undefined;
}

export function formatLineSuffix(startLine: unknown, endLine: unknown): string {
  let s = typeof startLine === "number" ? startLine : parseInt(String(startLine ?? ""), 10);
  let e = typeof endLine === "number" ? endLine : parseInt(String(endLine ?? ""), 10);
  const hasS = Number.isFinite(s) && s >= 1;
  const hasE = Number.isFinite(e) && e >= 1;
  if (!hasS && !hasE) return "";
  if (hasS && !hasE) return `${s}-EOF`;
  if (!hasS && hasE) return `1-${e}`;
  // 确保小行号在前
  if (s > e) [s, e] = [e, s];
  return `${s}-${e}`;
}

/**
 * 解析 MCP 编码工具名（mcp__serverId__toolName），提取 server 名与工具名供 UI 展示。
 * 编码时 serverId 里的非 [a-zA-Z0-9] 被替换为 _，因此这里做"尽力还原"：下划线分割取最后段为工具名、前段为 server。
 */
export function parseMcpToolName(encoded: string): { serverName: string; toolName: string } {
  // 去掉 mcp__ 前缀后按 __ 分割（双下划线是分段符，单下划线是字符替换）
  const inner = encoded.slice(5); // "mcp__" = 5 字符
  const sep = inner.lastIndexOf("__");
  if (sep > 0) {
    return { serverName: inner.slice(0, sep).replace(/_/g, " ").trim(), toolName: inner.slice(sep + 2) };
  }
  return { serverName: "MCP", toolName: inner };
}

/** intent 缺失时按工具类型回退成通用文案，避免展示出原始 query（如 "*"）等难看内容 */
export function fallbackIntent(name: string): string {
  switch (name) {
    case "list_dir": return "浏览目录";
    case "search": return "搜索代码";
    default: return "搜索工作区";
  }
}

/**
 * 消歧式文件名展示（对齐 Kiro）：默认只显示文件名；当一组里出现同名文件时，
 * 给冲突的文件补上能区分彼此的最短尾部路径（逐级向上加目录，直到唯一）。
 * @param paths 各文件的完整路径（"/" 或 "\\" 分隔）
 * @returns 与输入等长的展示名数组
 */
export function disambiguatePaths(paths: string[]): string[] {
  const segs = paths.map((p) => (p || "").replace(/\\/g, "/").split("/").filter(Boolean));
  return segs.map((parts, idx) => {
    if (parts.length === 0) return paths[idx] || "文件";
    const self = parts.join("/");
    const base = parts[parts.length - 1];
    // 仅当存在「同名但完整路径不同」的文件时才需要消歧；
    // 完整路径完全相同的视为同一文件（如同一文件的不同行段），不参与消歧，直接显示文件名。
    const sameName = segs.filter((o, j) => j !== idx && o[o.length - 1] === base && o.join("/") !== self);
    if (sameName.length === 0) return base; // 唯一（或与自身同一文件） → 只显示文件名
    for (let take = 2; take <= parts.length; take++) {
      const tail = parts.slice(parts.length - take).join("/");
      const collides = sameName.some((o) => o.slice(Math.max(0, o.length - take)).join("/") === tail);
      if (!collides) return tail;
    }
    return self; // 兜底：完整路径
  });
}

interface ToolCallItemProps {
  tool: ToolCallData;
  /** 手动模式待确认改动的接受/拒绝回调（按文件路径） */
  onAcceptEdit?: (path: string) => void;
  onRejectEdit?: (path: string) => void;
  /** 已接受改动的撤销回调（按文件路径） */
  onUndoEdit?: (path: string) => void;
}

/** 输出结果区（带内部滚动），execute_command 使用 */
function OutputBlock({ output }: { output: string }) {
  return (
    <div className="border-t border-border/60 bg-foreground/[0.02] px-4 py-2 max-h-32 overflow-y-overlay [&]:overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent [&::-webkit-scrollbar-track]:bg-transparent [&:hover::-webkit-scrollbar-thumb]:bg-muted-foreground/30">
      <pre className="text-[10px] font-mono text-muted-foreground/70 whitespace-pre-wrap break-all leading-relaxed">{output}</pre>
    </div>
  );
}

/**
 * 命令卡片内联审批条（无感模式）：命令未信任时挂在 execute_command 卡片底部。
 * 默认一行 [拒绝] [信任] [运行]；点「信任」展开三档信任范围（仅这条 / 前缀 / 全部）。
 * - 运行(once)：本次执行，不入白名单
 * - 信任：选档后写入白名单，以后这类命令自动执行
 * - 拒绝：不执行，反馈给 AI
 */
function InlineCommandApproval({ options, onApprove }: { options: CommandTrustOption[]; onApprove: (d: CommandDecision) => void }) {
  const [showTrust, setShowTrust] = useState(false);
  const [target, setTarget] = useState<"workspace" | "user">("workspace");

  if (showTrust) {
    return (
      <div className="border-t border-amber-300/50 bg-amber-50/60 dark:bg-amber-950/20 px-2.5 py-2 space-y-1.5">
        <div className="text-[11px] text-muted-foreground leading-relaxed">
          加入信任白名单后，以后这类命令将<strong className="text-foreground font-medium">自动执行、不再询问</strong>。选择信任范围：
        </div>
        {options.filter((o) => o.choice !== "all").map((opt) => (
          <button
            key={opt.choice}
            onClick={() => onApprove({ choice: opt.choice, pattern: opt.pattern, target })}
            className="block w-full text-left px-2.5 py-1.5 rounded-md text-[11px] border border-border hover:bg-muted/60 transition-colors"
          >
            {opt.label}
          </button>
        ))}
        {/* 作用域选择（单选）——仅对 exact/prefix 有意义，all 仅本会话不持久化 */}
        <div className="flex items-center gap-3 pt-1 border-t border-border/40 mt-1.5">
          <label className="inline-flex items-center gap-1.5 cursor-pointer text-[11px] text-muted-foreground">
            <input
              type="radio"
              name="trust-target"
              checked={target === "workspace"}
              onChange={() => setTarget("workspace")}
              className="w-3 h-3 accent-primary"
            />
            仅当前项目
          </label>
          <label className="inline-flex items-center gap-1.5 cursor-pointer text-[11px] text-muted-foreground">
            <input
              type="radio"
              name="trust-target"
              checked={target === "user"}
              onChange={() => setTarget("user")}
              className="w-3 h-3 accent-primary"
            />
            所有项目生效
          </label>
        </div>
        {/* 分隔线 + all 选项独立放在最后，与上方作用域选择无关 */}
        {options.filter((o) => o.choice === "all").map((opt) => (
          <button
            key={opt.choice}
            onClick={() => onApprove({ choice: "all", pattern: "*" })}
            className="block w-full text-left px-2.5 py-1.5 rounded-md text-[11px] border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors"
          >
            允许所有命令（仅当前会话有效，关闭后失效）
          </button>
        ))}
        <button
          onClick={() => setShowTrust(false)}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors px-1"
        >
          ← 返回
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2 border-t border-amber-300/50 bg-amber-50/60 dark:bg-amber-950/20 px-2.5 py-1.5">
      <span className="text-[11px] text-muted-foreground">等待你的确认</span>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onApprove({ choice: "reject" })}
          className="px-2.5 py-1 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        >
          拒绝
        </button>
        <button
          onClick={() => setShowTrust(true)}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] border border-border hover:bg-muted/60 transition-colors"
        >
          <ShieldCheck className="w-3 h-3" />
          信任
        </button>
        <button
          onClick={() => onApprove({ choice: "once" })}
          className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          运行
        </button>
      </div>
    </div>
  );
}

/**
 * execute_command 卡片（含编辑能力）：
 * - 标题栏右侧有编辑按钮（铅笔图标），点击后命令区变成可编辑 textarea
 * - 编辑模式下"运行"按钮用编辑后的命令，信任也基于编辑后的内容
 */
function CommandCardItem({ tool, approval }: { tool: ToolCallData; approval: ReturnType<typeof useCommandApproval> }) {
  const [editing, setEditing] = useState(false);
  const [editedCmd, setEditedCmd] = useState(tool.command || "");

  // 检查是否正在等待用户输入
  const { waitingInputIds } = useContext(CommandApprovalContext);
  const isWaitingInput = waitingInputIds.has(tool.id);

  const startEditing = () => { setEditedCmd(tool.command || ""); setEditing(true); };

  // 包装 approval.approve：如果用户编辑了命令，附带 editedCommand
  const handleApprove = (d: CommandDecision) => {
    const edited = editing && editedCmd.trim() && editedCmd.trim() !== (tool.command || "").trim() ? editedCmd.trim() : undefined;
    approval!.approve({ ...d, editedCommand: edited });
  };

  // 是否处于可编辑态：必须有待审批 + 用户主动点了编辑
  const isEditing = !!approval && editing;

  return (
    <div className={`my-2 rounded-lg border bg-popover overflow-hidden ${approval ? "border-amber-400/70" : (isWaitingInput && tool.status === "pending") ? "border-primary/50 animate-pulse" : "border-border"}`}>
      {/* 标题栏 */}
      <div className="flex items-center gap-2 py-1.5 px-2.5 text-xs border-b border-border/60 bg-foreground/[0.04]">
        {tool.status === "pending" && isWaitingInput && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-primary" />}
        {tool.status === "pending" && !isWaitingInput && <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-muted-foreground" />}
        {tool.status === "success" && <Terminal className="w-3.5 h-3.5 text-green-600 shrink-0" />}
        {tool.status === "error" && <Terminal className="w-3.5 h-3.5 text-red-500 shrink-0" />}
        <span className="text-muted-foreground flex-1">Command</span>
        {isWaitingInput && tool.status === "pending" && (
          <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary border border-primary/30 animate-pulse">
            等待用户输入
          </span>
        )}
        {tool.cwd && <span className="text-xs text-muted-foreground/70 font-mono">{tool.cwd}</span>}
        {/* 聚焦终端按钮 */}
        <button
          onClick={(e) => { e.stopPropagation(); const vscode = (window as any).__axonVSCode; if (vscode) vscode.postMessage({ type: "focus_terminal" }); }}
          title="在终端中查看"
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
        {/* 编辑按钮：仅在待审批时显示 */}
        {approval && (
          <button
            onClick={() => isEditing ? setEditing(false) : startEditing()}
            title={isEditing ? "取消编辑" : "编辑命令"}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {/* 命令内容：有审批且正在编辑时用 textarea，否则用只读 code */}
      {isEditing ? (
        <div className="px-2.5 py-1.5">
          <textarea
            value={editedCmd}
            onChange={(e) => setEditedCmd(e.target.value)}
            className="w-full text-[11px] font-mono font-semibold text-foreground bg-muted/30 border border-border/60 rounded-md px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-primary/40"
            rows={Math.min(editedCmd.split("\n").length + 1, 6)}
            spellCheck={false}
          />
        </div>
      ) : (
        <div className="px-2.5 py-1.5">
          <code className="text-[11px] font-mono font-semibold text-foreground break-all bg-transparent p-0">{tool.command}</code>
        </div>
      )}
      {/* 内联审批条 */}
      {approval && <InlineCommandApproval options={approval.options} onApprove={handleApprove} />}
      {/* 执行结果 */}
      {tool.output && <OutputBlock output={tool.output} />}
    </div>
  );
}

/** 浏览器相关工具名集合（用于分组收集） */
export const BROWSER_TOOL_NAMES = new Set([
  "open_browser", "get_browser_logs", "get_browser_network", "get_browser_storage", "screenshot_page", "close_browser",
  "browser_click", "browser_type", "browser_press", "browser_select", "browser_scroll", "browser_reload",
  "browser_eval", "browser_hover", "browser_wait", "browser_get_html", "browser_set_viewport", "browser_back", "browser_forward",
]);

/** 浏览器会话分组数据 */
export interface BrowserSessionData {
  id: string;
  url?: string;
  steps: ToolCallData[];
  closed: boolean;
  hasError: boolean;
  pending: boolean;
}

/** 浏览器会话大卡片：把连续的浏览器操作折叠合并 */
export function BrowserSessionGroup({ group }: { group: BrowserSessionData }) {
  const [expanded, setExpanded] = useState(false);
  // 默认折叠时只显示最近 3 条
  const visibleSteps = expanded ? group.steps : group.steps.slice(-3);
  const hasMore = group.steps.length > 3;

  return (
    <div className={`my-2 rounded-lg border overflow-hidden ${group.hasError ? "border-red-300/60" : group.pending ? "border-amber-300/60" : "border-border"} bg-popover`}>
      {/* 标题栏 */}
      <div
        className="flex items-center gap-2 py-1.5 px-2.5 text-xs bg-foreground/[0.04] cursor-pointer hover:bg-foreground/[0.06] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {group.pending
          ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-muted-foreground" />
          : group.closed
            ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />
            : <Globe className="w-3.5 h-3.5 text-blue-500 shrink-0" />}
        <span className="font-medium text-foreground">Browser Session</span>
        {group.url && <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[180px]">{group.url}</span>}
        <span className="ml-auto text-[10px] text-muted-foreground">{group.steps.length} 步</span>
        <ChevronRight className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
      </div>
      {/* 步骤列表 */}
      <div className="divide-y divide-border/40">
        {!expanded && hasMore && (
          <div className="px-2.5 py-1 text-[10px] text-muted-foreground text-center cursor-pointer hover:text-foreground" onClick={() => setExpanded(true)}>
            ↑ 还有 {group.steps.length - 3} 步…
          </div>
        )}
        {visibleSteps.map((step) => (
          <BrowserStepRow key={step.id} step={step} />
        ))}
      </div>
    </div>
  );
}

/** 浏览器分组内的单步行（精简一行） */
function BrowserStepRow({ step }: { step: ToolCallData }) {
  const [showOutput, setShowOutput] = useState(false);
  const icon = step.status === "pending"
    ? <Loader2 className="w-3 h-3 animate-spin text-muted-foreground shrink-0" />
    : step.status === "error"
      ? <X className="w-3 h-3 text-red-500 shrink-0" />
      : <Check className="w-3 h-3 text-green-600 shrink-0" />;

  const label = browserStepLabel(step);
  const hasOutput = !!step.output && step.output.length > 0;

  return (
    <div className="px-2.5 py-1">
      <div className="flex items-center gap-1.5 text-[11px]">
        {icon}
        <span className="text-muted-foreground truncate">{label}</span>
        {hasOutput && (
          <button onClick={() => setShowOutput(!showOutput)} className="ml-auto text-[10px] text-blue-600 dark:text-blue-400 hover:underline shrink-0">
            {showOutput ? "收起" : "输出"}
          </button>
        )}
      </div>
      {showOutput && step.output && (
        <pre className="mt-1 text-[9px] font-mono text-muted-foreground/70 whitespace-pre-wrap break-all max-h-24 overflow-y-auto leading-relaxed bg-muted/30 rounded px-2 py-1">{step.output}</pre>
      )}
    </div>
  );
}

/** 浏览器步骤的精简描述 */
function browserStepLabel(step: ToolCallData): string {
  switch (step.name) {
    case "open_browser": return `打开 ${(step.args?.url as string) || "页面"}`;
    case "close_browser": return "关闭浏览器";
    case "browser_click": return `点击 ${(step.args?.selector as string) || "元素"}`;
    case "browser_type": return `输入 → ${(step.args?.selector as string) || ""}`;
    case "browser_press": return `按键 ${(step.args?.key as string) || ""}`;
    case "browser_select": return `选择 ${(step.args?.value as string) || ""}`;
    case "browser_scroll": return `滚动 ${(step.args?.direction as string) || ""}`;
    case "browser_reload": return "刷新页面";
    case "screenshot_page": return "截图";
    case "get_browser_logs": return "读取控制台";
    case "get_browser_network": return "读取网络请求";
    case "get_browser_storage": return `读取 ${(step.args?.type as string) || "存储"}`;
    case "browser_eval": return "执行 JS";
    case "browser_hover": return `悬停 ${(step.args?.selector as string) || ""}`;
    case "browser_wait": return "等待";
    case "browser_get_html": return "读取 HTML";
    case "browser_set_viewport": return `视口 ${step.args?.width}×${step.args?.height}`;
    case "browser_back": return "后退";
    case "browser_forward": return "前进";
    default: return step.name;
  }
}

/** 卡片状态图标（统一 pending/success/error 三态） */
function CardStatusIcon({ status, Icon }: { status: ToolStatus; Icon: typeof Server }) {
  if (status === "pending") return <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-muted-foreground" />;
  if (status === "error") return <Icon className="w-3.5 h-3.5 text-red-500 shrink-0" />;
  return <Icon className="w-3.5 h-3.5 text-green-600 shrink-0" />;
}

/** 卡片标题栏（工具个人信息层） */
function CardHeader({ status, Icon, label, right }: { status: ToolStatus; Icon: typeof Server; label: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-1.5 px-2.5 text-xs border-b border-border/60 bg-foreground/[0.04]">
      <CardStatusIcon status={status} Icon={Icon} />
      <span className="text-muted-foreground flex-1">{label}</span>
      {right}
    </div>
  );
}

/**
 * start_process 卡片（三层）：① 工具信息 ② 执行的命令 ③ terminalId。
 * 未信任命令时复用内联审批条；启动信息作为底部输出。
 */
function ProcessStartCard({ tool, approval }: { tool: ToolCallData; approval: ReturnType<typeof useCommandApproval> }) {
  const handleApprove = (d: CommandDecision) => approval!.approve(d);
  const startedId = tool.output?.match(/terminalId:\s*(\S+)/)?.[1] || tool.output?.match(/terminalId=(\S+)/)?.[1];
  return (
    <div className={`my-2 rounded-lg border bg-popover overflow-hidden ${approval ? "border-amber-400/70" : "border-border"}`}>
      <CardHeader status={tool.status} Icon={Server} label="启动后台进程" right={
        <div className="flex items-center gap-1">
          {tool.cwd && <span className="text-[10px] text-muted-foreground/70 font-mono truncate max-w-[160px]">{tool.cwd}</span>}
          <button
            onClick={() => { const vscode = (window as any).__axonVSCode; if (vscode) vscode.postMessage({ type: "focus_terminal" }); }}
            title="在终端中查看"
            className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <ExternalLink className="w-3 h-3" />
          </button>
        </div>
      } />
      {/* ② 命令 */}
      <div className="px-2.5 py-1.5 border-b border-border/40">
        <code className="text-[11px] font-mono font-semibold text-foreground break-all">{tool.command}</code>
      </div>
      {/* ③ terminalId */}
      {startedId && (
        <div className="px-2.5 py-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="px-1.5 py-0.5 rounded bg-muted font-mono">{startedId}</span>
          <span>后台运行中</span>
        </div>
      )}
      {approval && <InlineCommandApproval options={approval.options} onApprove={handleApprove} />}
      {tool.output && <OutputBlock output={tool.output} />}
    </div>
  );
}

/** get_process_output 卡片（两层）：① 工具信息 + terminalId ② 读取到的输出 */
function ProcessOutputCard({ tool }: { tool: ToolCallData }) {
  const tid = typeof tool.args?.terminalId === "string" ? (tool.args.terminalId as string) : undefined;
  return (
    <div className="my-2 rounded-lg border border-border bg-popover overflow-hidden">
      <CardHeader
        status={tool.status}
        Icon={ScrollText}
        label="读取进程输出"
        right={
          <div className="flex items-center gap-1">
            {tid && <span className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono text-muted-foreground">{tid}</span>}
            <button
              onClick={() => { const vscode = (window as any).__axonVSCode; if (vscode) vscode.postMessage({ type: "focus_terminal" }); }}
              title="在终端中查看"
              className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
            </button>
          </div>
        }
      />
      {tool.output && <OutputBlock output={tool.output} />}
    </div>
  );
}

/** stop_process 卡片（一层）：工具信息 */
function ProcessStopCard({ tool }: { tool: ToolCallData }) {
  const tid = typeof tool.args?.terminalId === "string" ? (tool.args.terminalId as string) : undefined;
  return (
    <div className="flex items-center gap-2 py-1.5 px-2.5 my-2 rounded-lg border border-border bg-muted/20 text-xs">
      <CardStatusIcon status={tool.status} Icon={Power} />
      <span className="text-muted-foreground">停止后台进程</span>
      {tid && <span className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-mono text-muted-foreground">{tid}</span>}
    </div>
  );
}

/**
 * open_browser 卡片（两层）：① 工具信息 ② 输出。点击输出区把已打开的网页带到前台。
 */
function BrowserOpenCard({ tool }: { tool: ToolCallData }) {
  const url = typeof tool.args?.url === "string" ? (tool.args.url as string) : undefined;
  const focusPage = () => {
    const vscode = (window as any).__axonVSCode;
    if (vscode) vscode.postMessage({ type: "focus_browser" });
  };
  return (
    <div className="my-2 rounded-lg border border-border bg-popover overflow-hidden">
      <CardHeader
        status={tool.status}
        Icon={Globe}
        label="打开浏览器"
        right={url ? <span className="text-[10px] text-blue-600 dark:text-blue-400 font-mono truncate max-w-[200px]">{url}</span> : undefined}
      />
      {tool.output && (
        <div
          onClick={focusPage}
          title="点击聚焦到已打开的网页"
          className="cursor-pointer group border-t border-border/60 bg-foreground/[0.02] px-4 py-2 max-h-32 overflow-y-auto hover:bg-foreground/[0.04] transition-colors"
        >
          <div className="flex items-center gap-1 text-[10px] text-blue-600 dark:text-blue-400 mb-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <ExternalLink className="w-3 h-3" /> 点击聚焦网页
          </div>
          <pre className="text-[10px] font-mono text-muted-foreground/70 whitespace-pre-wrap break-all leading-relaxed">{tool.output}</pre>
        </div>
      )}
    </div>
  );
}

/** get_browser_logs 卡片（两层）：① 工具信息 ② 控制台/报错/网络输出 */
function BrowserLogsCard({ tool }: { tool: ToolCallData }) {
  return (
    <div className="my-2 rounded-lg border border-border bg-popover overflow-hidden">
      <CardHeader status={tool.status} Icon={Bug} label="浏览器控制台 / 报错" />
      {tool.output && <OutputBlock output={tool.output} />}
    </div>
  );
}

/** close_browser 卡片（一层）：工具信息 */
function BrowserCloseCard({ tool }: { tool: ToolCallData }) {
  return (
    <div className="flex items-center gap-2 py-1.5 px-2.5 my-2 rounded-lg border border-border bg-muted/20 text-xs">
      <CardStatusIcon status={tool.status} Icon={X} />
      <span className="text-muted-foreground">关闭浏览器</span>
    </div>
  );
}

export function ToolCallItem({ tool, onAcceptEdit, onRejectEdit, onUndoEdit }: ToolCallItemProps) {
  // 命令内联审批：该工具调用若有未决审批（未信任命令），在卡片底部展示 拒绝/信任/运行
  const approval = useCommandApproval(tool.id);

  // 中性结果隐藏：执行层标记 hidden 的工具调用不展示卡片，
  // 让 AI 的文字回复直接面对用户，显得更自然。
  // 双重判断：hidden 字段 OR description 含"已存在"/"文件不存在"（兜底 hidden 未传到的情况）
  if (tool.hidden || (tool.status === "success" && !tool.diff && tool.name === "create_file" && tool.description?.includes("已存在"))) {
    return null;
  }

  // execute_command 特殊渲染：命令卡片（含未信任命令的内联审批）
  if (tool.name === "execute_command" && tool.command) {
    return <CommandCardItem tool={tool} approval={approval} />;
  }

  // 后台进程工具卡片
  if (tool.name === "start_process") return <ProcessStartCard tool={tool} approval={approval} />;
  if (tool.name === "get_process_output") return <ProcessOutputCard tool={tool} />;
  if (tool.name === "stop_process") return <ProcessStopCard tool={tool} />;
  // 浏览器工具卡片
  if (tool.name === "open_browser") return <BrowserOpenCard tool={tool} />;
  if (tool.name === "get_browser_logs") return <BrowserLogsCard tool={tool} />;
  if (tool.name === "close_browser") return <BrowserCloseCard tool={tool} />;

  // search / list_dir 用 SearchGroupItem 单独渲染（连续探索会合并），这里不处理

  // check_diagnostics 特殊渲染：可折叠卡片，标题一行 + 展开后按文件列结果
  if (tool.name === "check_diagnostics") {
    return <DiagnosticsItem tool={tool} />;
  }

  // web_search 特殊渲染：Kiro 风格可折叠搜索结果卡片
  if (tool.name === "web_search") {
    return <WebSearchItem tool={tool} />;
  }

  // web_fetch 特殊渲染：单行卡片显示 URL + 字节数
  if (tool.name === "web_fetch") {
    return <WebFetchItem tool={tool} />;
  }

  // activate_power 特殊渲染：Power 激活卡片
  if (tool.name === "activate_power") {
    return <PowerActivatedItem tool={tool} />;
  }

  // 通用渲染：文件操作
  // 去掉描述中的引号（错误信息可能带路径引号）
  const cleanDesc = tool.description.replace(/['"]/g, "");
  // 文件名 + 可选的行号区间（如 read_file 的 "ChatPanel.tsx 1-10" / "2-EOF"）
  const parts = cleanDesc.match(/^(.+?)\s+(\S+\.\S+)(?:\s+(\d+-(?:\d+|EOF)))?$/);
  const action = parts ? parts[1] : cleanDesc;
  const fileName = parts ? parts[2] : null;
  const lineRange = parts && parts[3] ? parts[3] : null;
  // 是否有可展示的本次修改 diff
  const hasDiff = !!tool.diff && tool.status === "success" && (tool.name === "str_replace" || tool.name === "create_file" || tool.name === "apply_patch");

  // 根据工具类型和状态选择图标
  const renderIcon = () => {
    if (tool.status === "pending") {
      return <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-muted-foreground" />;
    }
    if (tool.status === "error") {
      if (tool.name === "read_file") {
        return <EyeOff className="w-3.5 h-3.5 text-red-500 shrink-0" />;
      }
      // MCP 工具错误：红色插头（与成功态蓝色插头呼应，一眼看出是 MCP）
      if (tool.name.startsWith("mcp__")) {
        return <Plug className="w-3.5 h-3.5 text-red-500 shrink-0" />;
      }
      return <FileX className="w-3.5 h-3.5 text-red-500 shrink-0" />;
    }
    // MCP 工具：插头图标 + 蓝色（区别于内置的绿色 ✓）
    if (tool.name.startsWith("mcp__")) {
      return <Plug className="w-3.5 h-3.5 text-blue-500 shrink-0" />;
    }
    if (tool.name === "read_file") {
      return <Eye className="w-3.5 h-3.5 text-green-600 shrink-0" />;
    }
    return <CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />;
  };

  // 有 diff 时用可展开卡片，否则用单行（displayName 优先：同名文件补了路径）
  if (hasDiff) {
    // apply_patch 的描述里没有文件名，从 diff.path 兜底取 basename
    const diffBase = tool.diff?.path ? tool.diff.path.split("/").pop()?.split("\\").pop() || null : null;
    return <FileEditItem tool={tool} action={action} fileName={tool.displayName || fileName || diffBase} icon={renderIcon()} onAcceptEdit={onAcceptEdit} onRejectEdit={onRejectEdit} onUndoEdit={onUndoEdit} />;
  }

  // 根据状态决定边框样式（pending/rejected/error）
  let borderClass = "border-border bg-muted/20";
  if (tool.status === "pending") {
    borderClass = "border-amber-300/60 bg-amber-50 dark:bg-amber-950/20";
  } else if (tool.rejected) {
    borderClass = "border-red-300/60 bg-red-50 dark:bg-red-950/20";
  } else if (tool.status === "error") {
    borderClass = "border-red-300/60 bg-red-50 dark:bg-red-950/20";
  }

  return (
    <div className={`flex items-center gap-2 py-1.5 px-2.5 my-2 rounded-lg border text-xs ${borderClass}`}>
      {renderIcon()}
      {/* MCP 工具：badge 显示 server 名 + 描述显示"调用 工具名" */}
      {tool.mcpServer && (
        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${
          tool.status === "error"
            ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
            : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
        }`}>{tool.mcpServer}</span>
      )}
      {tool.name === "read_file" && typeof tool.args?.path === "string" && tool.args.path.trim()
        ? <ClickableFileName fileName={String(tool.args.path)} absPath={String(tool.args.path)} startLine={toLineNumber(tool.args?.startLine)} endLine={toLineNumber(tool.args?.endLine)} className={`font-mono truncate min-w-0 ${tool.status === "error" ? "text-red-600" : "text-foreground"}`} />
        : (tool.mcpTool && tool.status === "success")
          ? <span className="text-muted-foreground truncate min-w-0">调用 <span className="font-medium text-foreground">{tool.mcpTool}</span></span>
          : <TruncatedText text={action} className="text-muted-foreground" />}
      {fileName && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-muted/40 text-xs font-mono shrink-0" title={String(tool.diff?.absPath || tool.diff?.path || tool.args?.path || fileName)}>
          <FileTypeIcon fileName={fileName} />
          <ClickableFileName fileName={fileName} absPath={String(tool.diff?.absPath || tool.diff?.path || tool.args?.path || "")} className="text-foreground" />
          {lineRange && <span className="text-muted-foreground/70">{lineRange}</span>}
        </span>
      )}
    </div>
  );
}

/** 带 diff 查看按钮的文件编辑项 */
function FileEditItem({
  tool, action, fileName, icon, onAcceptEdit, onRejectEdit, onUndoEdit,
}: {
  tool: ToolCallData; action: string; fileName: string | null; icon: React.ReactNode;
  onAcceptEdit?: (path: string) => void; onRejectEdit?: (path: string) => void; onUndoEdit?: (path: string) => void;
}) {
  const diff = tool.diff!;
  const editPath = diff.path || fileName || "";
  const actionTarget = tool.editId || editPath; // 优先用 editId 精确定位某一次改动
  const isPending = !!tool.pending;
  const isRejected = !!tool.rejected;
  const isReverted = !!tool.reverted;
  const isUndoable = !!tool.undoable && !isPending && !isRejected && !isReverted;

  /** 打开 VS Code 原生 diff（通过 postMessage 通知扩展） */
  const openNativeDiff = () => {
    const vscode = (window as any).__axonVSCode;
    if (vscode) {
      vscode.postMessage({ type: "open_diff", path: diff.absPath || diff.path, oldContent: diff.oldContent, newContent: diff.newContent });
    } else {
      console.log("[axon] open diff:", diff.path);
    }
  };

  // 样式：pending=琥珀色; rejected=红色浅底+删除线; reverted=灰色浅底+删除线; 正常=灰色
  const struck = isRejected || isReverted;
  const borderClass = isRejected
    ? "border-red-300/60 bg-red-50 dark:bg-red-950/20"
    : isReverted
      ? "border-border bg-muted/30"
      : isPending
        ? "border-amber-300/60 bg-amber-50 dark:bg-amber-950/20"
        : "border-border bg-muted/20";

  return (
    <>
      <div className={`flex items-center gap-2 py-1.5 px-2.5 my-2 rounded-lg border text-xs ${borderClass}`}>
        {icon}
        <span className={`text-muted-foreground ${struck ? "line-through" : ""}`}>{isReverted ? "已撤销" : action}</span>
        {fileName && (
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded bg-muted/40 text-xs font-mono ${struck ? "text-muted-foreground line-through" : "text-foreground"}`} title={diff.absPath || editPath}>
            <FileTypeIcon fileName={fileName} />
            <ClickableFileName fileName={fileName} absPath={diff.absPath || editPath} className={struck ? "text-muted-foreground line-through" : ""} />
          </span>
        )}
        {/* 右侧操作区 */}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={openNativeDiff}
            title="查看本次修改"
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <GitCompare className="w-3.5 h-3.5" />
          </button>
          {isPending && onAcceptEdit && (
            <button
              onClick={() => onAcceptEdit(actionTarget)}
              title="接受此改动"
              className="p-1 rounded text-green-600 hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
          )}
          {isPending && onRejectEdit && (
            <button
              onClick={() => onRejectEdit(actionTarget)}
              title="拒绝此改动"
              className="p-1 rounded text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {isUndoable && onUndoEdit && (
            <button
              onClick={() => onUndoEdit(actionTarget)}
              title="撤销此改动（恢复到接受前）"
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * check_diagnostics 渲染：一张可折叠卡片（一次调用 = 一张卡片，N 个文件不重复 N 次）。
 * 诊断卡片：一行式，左边虫子图标 + "Checked diagnostics"，右边平铺被诊断的文件名 tag。
 * tag 颜色区分：无错误=普通灰，有错误=红色描边。文件多时自动换行。
 */
function DiagnosticsItem({ tool }: { tool: ToolCallData }) {
  const files = tool.diagnostics || [];
  const pending = tool.status === "pending";
  const hasErrors = files.some((f) => !f.ok);
  // 消歧展示：同名文件补最短区分路径
  const displayNames = disambiguatePaths(files.map((f) => f.path));

  return (
    <div className="flex items-center gap-2 py-1.5 px-2.5 my-2 rounded-lg border border-border bg-muted/20 text-xs flex-wrap">
      {pending
        ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-muted-foreground" />
        : <Bug className={`w-3.5 h-3.5 shrink-0 ${hasErrors ? "text-red-500" : "text-green-600"}`} />}
      <span className="text-muted-foreground shrink-0">语法诊断</span>
      {/* 右边：文件名 tag */}
      {files.map((f, i) => {
        // 整个项目的汇总结果：用 scope 字段判断（结构化标记）。
        if (f.scope === "project") {
          return (
            <span
              key={i}
              title="对整个项目做了类型检查"
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${f.ok ? "bg-muted text-foreground" : "bg-red-100 dark:bg-red-950/40 text-red-600 dark:text-red-400"}`}
            >
              <FolderTree className="w-3.5 h-3.5 shrink-0" />
              <span>整个项目</span>
            </span>
          );
        }
        return (
          <span
            key={i}
            onClick={() => {
              const vscode = (window as any).__axonVSCode;
              if (vscode) vscode.postMessage({ type: "open_file", path: f.path });
            }}
            title={f.path}
            className={`inline-flex items-start gap-1 px-2 py-0.5 rounded text-xs font-mono cursor-pointer hover:underline break-all min-w-0 max-w-full ${f.ok ? "bg-muted text-foreground" : "bg-red-100 dark:bg-red-950/40 text-red-600 dark:text-red-400"}`}
          >
            <FileTypeIcon fileName={f.path} />
            <span className="break-all">{displayNames[i]}</span>
          </span>
        );
      })}
    </div>
  );
}

/** 一组对同一文件的连续编辑数据 */
export interface EditGroupData {
  id: string;          // 用第一个编辑的 id
  fileName: string;    // 短文件名（单文件分组用作标题；多文件分组用作回退）
  pending: boolean;    // 组内是否有待确认
  edits: ToolCallData[]; // 组内各次编辑的完整数据（多文件时每项 displayName 为各自文件名）
  /** true=一次调用改了多个不同文件（如 apply_patch）；false/缺省=同一文件的多次编辑 */
  multiFile?: boolean;
  /** 组内是否已被接受、可撤销（右侧显示撤销图标） */
  undoable?: boolean;
  /** 组内是否已被撤销 */
  reverted?: boolean;
}

/**
 * 文件改动分组卡（统一服务 edit_tool 同文件多次编辑 与 apply_patch 一次改多文件）
 * 可展开查看每个文件/每次编辑的 diff，支持逐项接受/拒绝。
 */
export function EditGroupItem({
  group, onAcceptEdit, onRejectEdit, onUndoEdit,
}: {
  group: EditGroupData;
  onAcceptEdit?: (path: string) => void;
  onRejectEdit?: (path: string) => void;
  onUndoEdit?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const editPath = group.edits[0]?.diff?.path || group.fileName;

  // 组内是否有正在执行中的编辑（status 还是 pending）
  const hasExecuting = group.edits.some((e) => e.status === "pending");
  // 总 diff（仅单文件分组有意义）：第一次编辑前 → 最后一次编辑后
  const firstDiff = group.edits[0]?.diff;
  const lastDiff = group.edits[group.edits.length - 1]?.diff;
  const canShowTotalDiff = !group.multiFile && !!firstDiff && !!lastDiff && !hasExecuting;

  // 批量操作：作用于「对应状态」的子单元，按各自 editId 精确下发。
  // 撤销/拒绝按「从新到旧」逆序逐个下发，符合反向引擎的安全顺序（后改的先撤）。
  const orderedEdits = group.edits;
  const reversedEdits = [...group.edits].reverse();
  const doAcceptAll = () => orderedEdits.forEach((e) => { if (e.pending) onAcceptEdit?.(e.editId || e.diff?.path || ""); });
  const doRejectAll = () => reversedEdits.forEach((e) => { if (e.pending) onRejectEdit?.(e.editId || e.diff?.path || ""); });
  // 整文件撤销：按文件 path 下发（后端恢复到 AI 改动前的原始快照，永远安全）；多文件分组逐文件下发
  const distinctPaths = [...new Set(group.edits.map((e) => e.diff?.path).filter((p): p is string => !!p))];
  const doUndoAllFiles = () => distinctPaths.forEach((p) => onUndoEdit?.(p));

  // 撤销态：已接受可撤销（非 pending）
  const isUndoable = !!group.undoable && !group.pending;
  const isReverted = !!group.reverted;

  return (
    <div className={`my-2 rounded-lg border overflow-hidden ${group.pending ? "border-amber-300/60 bg-amber-50 dark:bg-amber-950/20" : "border-border bg-muted/20"} ${isReverted ? "opacity-60" : ""}`}>
      {/* 标题行 */}
      <div className="flex items-center gap-2 py-1.5 px-2.5 text-xs">
        {isReverted && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">已撤销</span>}        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 flex-1 text-left min-w-0"
        >
          <ChevronRight className={`w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
          {group.multiFile ? (
            <span className="text-muted-foreground">已修改 <span className="text-foreground font-medium">{group.edits.length}</span> 个文件</span>
          ) : (
            <>
              <span className="text-muted-foreground">已编辑</span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-muted/40 text-xs font-mono text-foreground min-w-0">
                <FileTypeIcon fileName={group.fileName} />
                <ClickableFileName fileName={group.fileName} absPath={group.edits[0]?.diff?.absPath || group.edits[0]?.diff?.path || ""} className="truncate" />
              </span>
              {group.edits.length > 1 && <span className="text-muted-foreground/70 shrink-0">· {group.edits.length} 次</span>}
            </>
          )}
        </button>
        {/* 右侧操作按钮 */}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {!group.multiFile && (
            <button
              onClick={() => {
                if (!canShowTotalDiff || !firstDiff || !lastDiff) return;
                const vscode = (window as any).__axonVSCode;
                if (vscode) {
                  vscode.postMessage({ type: "open_diff", path: firstDiff.path, oldContent: firstDiff.oldContent, newContent: lastDiff.newContent });
                }
              }}
              disabled={!canShowTotalDiff}
              title={hasExecuting ? "编辑进行中，完成后可查看总 diff" : "查看所有改动的合并 diff"}
              className={`p-1 rounded transition-colors ${canShowTotalDiff ? "text-muted-foreground hover:text-foreground hover:bg-muted/50" : "text-muted-foreground/30 cursor-not-allowed"}`}
            >
              <GitCompare className="w-3.5 h-3.5" />
            </button>
          )}
          {group.pending && onAcceptEdit && (
            <button
              onClick={() => (group.multiFile ? doAcceptAll() : onAcceptEdit(editPath))}
              title={group.multiFile ? "接受全部文件改动" : "接受此文件的所有改动"}
              className="p-1 rounded text-green-600 hover:bg-green-100 dark:hover:bg-green-900/30 transition-colors"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
          )}
          {group.pending && onRejectEdit && (
            <button
              onClick={() => (group.multiFile ? doRejectAll() : onRejectEdit(editPath))}
              title={group.multiFile ? "拒绝全部文件改动" : "拒绝此文件的所有改动"}
              className="p-1 rounded text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {isUndoable && onUndoEdit && (
            <button
              onClick={() => doUndoAllFiles()}
              title="撤销该文件全部改动（恢复到 AI 改动前）"
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      {/* 展开区：逐个文件/编辑 */}
      {expanded && (
        <div className="border-t border-border/50 px-2 py-1.5 space-y-1">
          {group.edits.map((edit) => (
            <FileEditItem
              key={edit.id}
              tool={edit}
              action={edit.name === "create_file" ? (edit.diff && edit.diff.oldContent ? "已覆盖" : "已创建") : "已编辑"}
              fileName={edit.displayName || group.fileName}
              icon={<CheckCircle2 className="w-3.5 h-3.5 text-green-600 shrink-0" />}
              onAcceptEdit={onAcceptEdit}
              onRejectEdit={onRejectEdit}
              onUndoEdit={onUndoEdit}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 一组连续探索（search / list_dir）的数据 */
export interface SearchGroupData {
  id: string;          // 用第一个调用的 id
  pending: boolean;    // 组内是否还有进行中的调用
  queries: string[];   // 每次调用展示的意图文案（intent）
}

/**
 * 工作区探索分组展示（search + list_dir 共用统一卡片，对齐 Kiro 的 "Searched workspace"）
 * - 单条：第二层平铺一条（无项目符号）
 * - 多条连续：第二层用 · 列表逐条展示
 */
export function SearchGroupItem({ group }: { group: SearchGroupData }) {
  const isMulti = group.queries.length > 1;
  return (
    <div className="my-2 rounded-lg border border-border bg-popover overflow-hidden">
      {/* 第一层：图标 + 标题（前景色叠加 + 底分隔线，跨主题与下层分明） */}
      <div className="flex items-center gap-2 py-1.5 px-3 text-xs border-b border-border/60 bg-foreground/[0.04]">
        {group.pending
          ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-muted-foreground" />
          : <Search className="w-3.5 h-3.5 text-green-600 shrink-0" />}
        <span className="text-muted-foreground">搜索工作区</span>
      </div>
      {/* 第二层：意图文案（卡片底面） */}
      <div className="px-3 py-1.5">
        {isMulti ? (
          <ul className="space-y-1">
            {group.queries.map((q, i) => (
              <li key={i} className="flex items-start gap-2 text-xs font-mono text-foreground/80">
                <span className="text-muted-foreground/60 select-none">·</span>
                <span className="break-all">{q}</span>
              </li>
            ))}
          </ul>
        ) : (
          <code className="text-xs font-mono text-foreground/80 break-all">{group.queries[0]}</code>
        )}
      </div>
    </div>
  );
}

/** 一组连续 read_file 的数据 */
export interface ReadFileGroupData {
  id: string;          // 用第一个 read_file 的 id
  pending: boolean;    // 组内是否还有进行中的读取
  hasError: boolean;   // 组内是否有失败
  /** 每个文件：文件名 + 可选行号区间（如 "1-10" / "2-EOF"）+ 完整路径（点击打开用）+ 起止行号（点击跳转选中用） */
  files: { name: string; range?: string; path?: string; startLine?: number; endLine?: number }[];
}

/**
 * 连续 read_file 合并展示（对齐 Kiro 的 "Read file(s)" 紧凑卡片）
 * 两层结构：第一层 [图标] 已读取，第二层标签列表自动换行
 * 标签内：文件名 + 灰色小字行号（如有）
 */
export function ReadFileGroupItem({ group }: { group: ReadFileGroupData }) {
  return (
    <div className="my-2 rounded-lg border border-border bg-muted/20 overflow-hidden min-w-0 w-full">
      {/* 单行：状态图标 + 标题 + 文件名标签（同一行，文件多时自动换行） */}
      <div className="flex items-center gap-2 py-1.5 px-2.5 text-xs flex-wrap">
        {group.pending
          ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-muted-foreground" />
          : group.hasError
            ? <EyeOff className="w-3.5 h-3.5 text-red-500 shrink-0" />
            : <Eye className="w-3.5 h-3.5 text-green-600 shrink-0" />}
        <span className="text-muted-foreground shrink-0">
          {group.pending ? "读取中" : "已读取"}
        </span>
        {group.files.map((f, i) => (
          <span
            key={i}
            onClick={() => {
              if (!f.path) return;
              const vscode = (window as any).__axonVSCode;
              if (vscode) vscode.postMessage({ type: "open_file", path: f.path, startLine: f.startLine, endLine: f.endLine });
            }}
            className={`inline-flex items-start gap-1 px-2 py-0.5 rounded bg-muted/40 text-xs font-mono break-all min-w-0 max-w-full ${f.path ? "cursor-pointer hover:bg-muted/60 transition-colors" : ""}`}
            title={f.path || f.name}
          >
            <FileTypeIcon fileName={f.name} />
            <span className="text-foreground break-all">{f.name}</span>
            {f.range && <span className="text-muted-foreground/70 whitespace-nowrap shrink-0">{f.range}</span>}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * 网站 Favicon：用 Google favicon 服务获取，加载失败则显示默认多巴胺线条图标。
 * 16x16 尺寸，与文字行内对齐。
 */
function SiteFavicon({ domain }: { domain: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !domain) {
    // 默认多巴胺线条图标（抽象的圆+线条）
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0 opacity-60">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M5 8.5c.5-2 2-3 3.5-2.5s2 2.5 1.5 4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        <circle cx="6" cy="6" r="1" fill="currentColor" />
      </svg>
    );
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=16`}
      alt=""
      width={14}
      height={14}
      className="shrink-0 rounded-sm"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * Web 搜索结果展示（Kiro 风格）：可折叠卡片
 * 标题行：🌐 Web search: {query}  N results
 * 展开后：每条结果一行（域名、标题、日期）
 */
function WebSearchItem({ tool }: { tool: ToolCallData }) {
  const [expanded, setExpanded] = useState(false);
  const sr = tool.searchResults;
  const pending = tool.status === "pending";
  const resultCount = sr?.results?.length || 0;

  return (
    <div className="my-2 rounded-lg border border-border bg-muted/20 overflow-hidden">
      {/* 标题行 */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full py-1.5 px-2.5 text-xs text-left hover:bg-muted/30 transition-colors"
      >
        <ChevronRight className={`w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`} />
        {pending
          ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-muted-foreground" />
          : <Globe className="w-3.5 h-3.5 shrink-0 text-blue-500" />}
        <span className="text-muted-foreground">Web search:</span>
        <span className="text-foreground font-medium truncate flex-1">{sr?.query || tool.description}</span>
        {!pending && (
          <span className="text-xs text-muted-foreground shrink-0">{resultCount} results</span>
        )}
      </button>
      {/* 展开区：搜索结果列表 */}
      {expanded && sr && sr.results.length > 0 && (
        <div className="border-t border-border/50 px-4 py-2 space-y-2">
          {sr.results.map((r, i) => (
            <div key={i} className="space-y-0.5">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <SiteFavicon domain={r.domain} />
                <span>{r.domain}</span>
                {r.date && <span>{r.date}</span>}
              </div>
              <a
                href={r.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline block truncate"
              >
                {r.title}
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Web Fetch 结果展示（Kiro 风格）：
 * 成功：🌐 Fetched: {url 蓝色链接}  {字节数}
 * 失败：⚠ Web fetch failed + 红色错误信息
 */
function WebFetchItem({ tool }: { tool: ToolCallData }) {
  const fr = tool.fetchResult;
  const pending = tool.status === "pending";
  const failed = tool.status === "error" || (fr && !fr.success);

  if (failed && fr?.error) {
    return (
      <div className="my-2 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50/50 dark:bg-red-950/20 overflow-hidden">
        <div className="flex items-center gap-2 py-1.5 px-2.5 text-xs">
          <span className="text-amber-500 shrink-0">⚠</span>
          <span className="text-foreground font-medium">Web fetch failed</span>
        </div>
        <div className="px-4 pb-2.5">
          <code className="text-xs font-mono text-red-600 dark:text-red-400">{fr.error}</code>
        </div>
      </div>
    );
  }

  const displayUrl = fr?.url || (tool.description || "").replace(/^抓取\s*/, "").split(" ")[0] || "";
  const byteLabel = fr ? formatBytes(fr.byteSize) : "";

  return (
    <div className="my-2 rounded-lg border border-border bg-muted/20 overflow-hidden">
      <div className="flex items-center gap-2 py-1.5 px-2.5 text-xs">
        {pending
          ? <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0 text-muted-foreground" />
          : <Globe className="w-3.5 h-3.5 shrink-0 text-blue-500" />}
        <span className="text-muted-foreground shrink-0">Fetched:</span>
        <a
          href={displayUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 dark:text-blue-400 hover:underline truncate flex-1 font-mono text-xs"
        >
          {displayUrl}
        </a>
        {byteLabel && (
          <span className="text-xs text-muted-foreground shrink-0">{byteLabel}</span>
        )}
      </div>
    </div>
  );
}

/**
 * Power 激活卡片（对齐 Claude/Kiro 的 "Activated power" 展示）
 * 紫色/闪电风格：⚡ Activated power   power-name   N MCP · N Skills
 * 点击名称打开 PowerStudio Tab
 */
function PowerActivatedItem({ tool }: { tool: ToolCallData }) {
  const pending = tool.status === "pending";
  const pa = tool.powerActivated;
  const name = pa?.displayName || pa?.name || (tool.args?.name as string) || "power";

  /** 点击名称 → 通知 Extension Host 打开 Power Tab */
  const handleClickName = () => {
    const powerName = pa?.name || (tool.args?.name as string) || "";
    if (!powerName) return;
    const vs = (window as any).__axonVSCode;
    if (vs) {
      vs.postMessage({ type: "open_power_tab", powerName });
    }
  };

  return (
    <div className="my-2 rounded-lg border border-violet-200 dark:border-violet-900/50 bg-violet-50/50 dark:bg-violet-950/20 overflow-hidden">
      <div className="flex items-center gap-2 py-2 px-3 text-xs">
        {pending
          ? <Loader2 className="w-4 h-4 animate-spin shrink-0 text-violet-500" />
          : <span className="text-violet-500 shrink-0 text-base">⚡</span>}
        <span className="text-muted-foreground font-medium">Activated power</span>
        <span
          onClick={handleClickName}
          className="font-semibold text-foreground cursor-pointer hover:text-violet-600 dark:hover:text-violet-400 hover:underline transition-colors"
        >
          {name}
        </span>
        {pa && (
          <span className="ml-auto text-[11px] text-muted-foreground">
            {pa.mcpServerCount > 0 && `${pa.mcpServerCount} MCP`}
            {pa.mcpServerCount > 0 && pa.skillCount > 0 && " · "}
            {pa.skillCount > 0 && `${pa.skillCount} Skills`}
          </span>
        )}
      </div>
    </div>
  );
}

/** 格式化字节数 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
