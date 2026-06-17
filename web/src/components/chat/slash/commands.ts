/**
 * 默认斜杠命令注册表
 *
 * 扩展方式：在数组里加一条 {@link SlashCommand} 即可，菜单与交互 hook 自动支持。
 * 业界参考（Cursor / GitHub Copilot / Windsurf / Kiro）：
 *  - 当前文件 / 选区        → 把活动编辑器内容作为上下文
 *  - 文件 / 文件夹 / 工作区  → 搜索并挑选资源加入上下文
 *  - 问题（诊断）           → 把当前文件的报错/警告作为上下文
 * 其余能力（Git 变更、终端输出、代码符号、Web 文档等）后续按同样方式追加。
 */

import { FileCode2, FileText, Folder, AlertCircle } from "lucide-react";
import type { SlashCommand } from "./types";

export const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "current-file",
    label: "当前文件",
    description: "把当前编辑器打开的文件加入上下文",
    icon: FileCode2,
    keywords: ["current", "file", "active", "当前", "文件", "活动", "打开"],
    kind: "action",
    run: (host) => host.addActiveFileContext(),
  },
  {
    id: "files",
    label: "文件",
    description: "搜索工作区文件并加入上下文",
    icon: FileText,
    keywords: ["file", "files", "文件", "搜索", "工作区"],
    kind: "search",
    scope: "file",
  },
  {
    id: "folders",
    label: "文件夹",
    description: "搜索工作区文件夹并加入上下文",
    icon: Folder,
    keywords: ["folder", "folders", "dir", "directory", "目录", "文件夹"],
    kind: "search",
    scope: "folder",
  },
  {
    id: "problems",
    label: "问题",
    description: "把当前文件的问题 / 诊断加入上下文",
    icon: AlertCircle,
    keywords: ["problem", "problems", "diagnostic", "error", "warning", "问题", "诊断", "错误", "警告"],
    kind: "action",
    run: (host) => host.addDiagnosticsContext(),
  },
];
