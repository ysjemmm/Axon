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
  // Wiki 页面保存：本质是写文件（写 .axon/wiki/*.md），归到 edit。
  // 它不产生 fileDiff，因此不会进「代码改动」那套呈现（改动面板/待确认卡片）。
  [ToolName.WikiSavePage]: "edit",
  // 规划只登记清单、不落盘，归到 other（不是编辑、也不是读取仓库内容）
  [ToolName.WikiPlanPages]: "other",
  // 编排类
  [ToolName.DelegateTask]: "orchestration",
  [ToolName.RelayCreate]: "orchestration",
  [ToolName.RelaySaveDoc]: "orchestration",
  [ToolName.RelayAdvance]: "orchestration",
  [ToolName.RelayUpdateTask]: "orchestration",
  [ToolName.RelayReviewTask]: "orchestration",
  // 选项问答：向用户抛选择。归到 other——它不是读写/命令/联网任何一类，
  // 也不想被 orchestration 那套（子 Agent 分组）呈现逻辑带走。
  [ToolName.AskUser]: "other",
  // 声明式表单：同样不读不写磁盘，只把"需要用户填的内容"呈现出来，归 other
  [ToolName.AskForm]: "other",
  // 产出登记：不读不写磁盘，只是把"已经做好的文件"告诉前端，归 other
  [ToolName.ReportOutputs]: "other",
  // 产物：本质是写文件（落到产物目录），归 edit。与 wiki_save_page 同理——
  // 它不产生 fileDiff，所以不会进「代码改动」那套审阅呈现；渲染成产物卡片由前端单独接管。
  [ToolName.CreateArtifact]: "edit",
  // 媒体渲染：同样是往产物目录写一个文件（只是内容由后端渲染得到），不产生 fileDiff，归 edit，
  // 卡片同样由前端的产物卡片接管。
  [ToolName.RenderMedia]: "edit",
  // 会话记忆：不读不写磁盘，只改会话自己的一个字段，同样归 other
  [ToolName.UpdateMemory]: "other",
  [ToolName.UpdateTasks]: "other",
  // 产物的局部修改同 create_artifact 归 edit（不产生 fileDiff，卡片由产物卡片接管）；两个读取归 read
  [ToolName.EditArtifact]: "edit",
  [ToolName.ReadArtifact]: "read",
  [ToolName.ReadSkillFile]: "read",
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
