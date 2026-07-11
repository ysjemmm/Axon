/**
 * ToolKindResolver —— 把现网工具名映射到统一事件模型的 ToolKind（纯逻辑，可测试）
 *
 * 背景：
 * - 新事件模型用 toolKind 做“能力大类”分组（前端图标、状态提示、trace 聚合都优先看它）。
 * - 现网工具以 ToolName 枚举维护。接现网时需要一座桥：把每个真实工具归到某个 toolKind。
 *
 * 设计要点：
 * - 用穷举 Record<ToolName, ToolKind>：一旦新增工具却忘了归类，TypeScript 在编译期即报错。
 * - resolveToolKind 对未知工具名（如 MCP 动态工具）回退到 "other"，不抛错。
 * - 纯逻辑：不依赖运行时状态，便于单测与跨端复用。
 */

import { ToolName } from "../tools/catalog.js";
import type { ToolKind } from "./toolEventModel.js";

/** 每个内置工具的能力大类归属（穷举，缺项编译期报错）。 */
const TOOL_KIND_MAP: Record<ToolName, ToolKind> = {
  // 文件读取
  [ToolName.ReadFile]: "read",
  // 文件编辑
  [ToolName.CreateFile]: "edit",
  [ToolName.StrReplace]: "edit",
  [ToolName.ApplyPatch]: "edit",
  // 命令 / 进程
  [ToolName.ExecuteCommand]: "command",
  [ToolName.StartProcess]: "command",
  [ToolName.GetProcessOutput]: "command",
  [ToolName.StopProcess]: "command",
  [ToolName.ListProcesses]: "command",
  // 浏览器
  [ToolName.OpenBrowser]: "browser",
  [ToolName.GetBrowserLogs]: "browser",
  [ToolName.ScreenshotPage]: "browser",
  [ToolName.CloseBrowser]: "browser",
  [ToolName.BrowserClick]: "browser",
  [ToolName.BrowserType]: "browser",
  [ToolName.BrowserPress]: "browser",
  [ToolName.BrowserSelect]: "browser",
  [ToolName.BrowserScroll]: "browser",
  [ToolName.BrowserReload]: "browser",
  [ToolName.GetBrowserNetwork]: "browser",
  [ToolName.GetBrowserStorage]: "browser",
  [ToolName.BrowserEval]: "browser",
  [ToolName.BrowserHover]: "browser",
  [ToolName.BrowserWait]: "browser",
  [ToolName.BrowserGetHtml]: "browser",
  [ToolName.BrowserSetViewport]: "browser",
  [ToolName.BrowserBack]: "browser",
  [ToolName.BrowserForward]: "browser",
  // 搜索 / 目录 / 诊断
  [ToolName.Search]: "search",
  [ToolName.ListDir]: "read",
  [ToolName.CheckDiagnostics]: "diagnostics",
  // 联网
  [ToolName.WebSearch]: "network",
  [ToolName.WebFetch]: "network",
  // 技能 / 能力包
  [ToolName.UseSkill]: "other",
  [ToolName.ActivatePower]: "other",
  // 编排类
  [ToolName.DelegateTask]: "orchestration",
  [ToolName.RelayCreate]: "orchestration",
  [ToolName.RelaySaveDoc]: "orchestration",
  [ToolName.RelayAdvance]: "orchestration",
  [ToolName.RelayUpdateTask]: "orchestration",
  [ToolName.RelayReviewTask]: "orchestration",
  [ToolName.ParallelResearch]: "orchestration",
  [ToolName.ParallelExecute]: "orchestration",
};

/**
 * 把工具名解析为 ToolKind。
 *
 * 说明：
 * - 已知内置工具按穷举表返回精确大类。
 * - 未知工具名（如 MCP 动态工具、未来新增但尚未归类的名字）回退到 "other"，不抛错。
 */
export function resolveToolKind(toolName: string): ToolKind {
  return TOOL_KIND_MAP[toolName as ToolName] ?? "other";
}
