/**
 * @axon/host-vscode —— VSCodeAgentHost
 *
 * 基于 vscode API 实现 AgentHost，服务 Code OSS 内置扩展形态（进程内，跑在 Extension Host）：
 *   · fs          → vscode.workspace.fs（支持虚拟/远程文件系统）
 *   · commands    → child_process（扩展宿主即 Node 环境，复用 PowerShell UTF-8 链路）
 *   · diagnostics → vscode.languages.getDiagnostics（实时、全语言、零子进程）
 *   · browser     → vscode.workspace.fs 目录浏览
 *   · edits       → 阶段 2 基础版（auto 写盘 / manual 暂存）；阶段 3 升级为原生 diff + SCM
 *   · ideContext  → window.activeTextEditor / tabGroups / git diff
 */

import type { AgentHost } from "@axon/core";
import { PlaywrightBrowser } from "@axon/host-node";
import { VSCodeFileSystem } from "./fs.js";
import { VSCodeCommandRunner } from "./commands.js";
import { VSCodeProcessManager } from "./processes.js";
import { VSCodeDiagnostics } from "./diagnostics.js";
import { VSCodeDirectoryBrowser } from "./browser.js";
import { VSCodeEditPresenter } from "./edits.js";
import { VSCodeIdeContext } from "./ideContext.js";

export { VSCodeFileSystem } from "./fs.js";
export { VSCodeCommandRunner } from "./commands.js";
export { VSCodeProcessManager } from "./processes.js";
export { VSCodeDiagnostics } from "./diagnostics.js";
export { VSCodeDirectoryBrowser } from "./browser.js";
export { VSCodeEditPresenter } from "./edits.js";
export { VSCodeIdeContext } from "./ideContext.js";
export { VSCodeCommandTrustStore } from "./commandTrustStore.js";
export { PendingDiffPresenter, PENDING_SCHEME, pendingUri } from "./pendingDiff.js";
export { focusTerminal } from "./terminalDisplay.js";

/**
 * 构造一个 VSCodeAgentHost。
 * edits 有状态（持暂存区），每个 AgentSession 应独占一个 host 实例。
 */
export function createVSCodeAgentHost(): AgentHost {
  return {
    fs: new VSCodeFileSystem(),
    commands: new VSCodeCommandRunner(),
    processes: new VSCodeProcessManager(),
    webBrowser: new PlaywrightBrowser(),
    diagnostics: new VSCodeDiagnostics(),
    browser: new VSCodeDirectoryBrowser(),
    edits: new VSCodeEditPresenter(),
    ideContext: new VSCodeIdeContext(),
  };
}
