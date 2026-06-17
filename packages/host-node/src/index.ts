/**
 * @axon/host-node —— NodeAgentHost
 *
 * 基于 Node 运行时实现 AgentHost 各能力域，服务 web / cli / server 形态：
 *   · fs          → NodeFileSystem（node:fs/promises）
 *   · commands    → NodeCommandRunner（child_process + PowerShell UTF-8 包装）
 *   · diagnostics → NodeDiagnostics（tsc --noEmit）
 *   · browser     → NodeDirectoryBrowser（列盘符 / 列子目录）
 *   · edits       → NodeEditPresenter（auto 写盘 / manual 内存暂存待确认）
 *   · ideContext  → 不提供（web/cli 无编辑器概念）
 *
 * 实现逻辑迁移自 server/src 的 tools.ts / fsBrowser.ts，语义保持一致。
 */

import type { AgentHost } from "@axon/core";
import { NodeFileSystem } from "./fs.js";
import { NodeCommandRunner } from "./commands.js";
import { NodeProcessManager } from "./processes.js";
import { PlaywrightBrowser } from "./webBrowser.js";
import { NodeDiagnostics } from "./diagnostics.js";
import { NodeDirectoryBrowser } from "./browser.js";
import { NodeEditPresenter } from "./edits.js";

export { NodeFileSystem } from "./fs.js";
export { NodeCommandRunner } from "./commands.js";
export { NodeProcessManager } from "./processes.js";
export { PlaywrightBrowser } from "./webBrowser.js";
export { NodeDiagnostics } from "./diagnostics.js";
export { NodeDirectoryBrowser } from "./browser.js";
export { NodeEditPresenter } from "./edits.js";
export { JsonFileStorage } from "./jsonFileStorage.js";
export { FileCommandTrustStore } from "./commandTrustStore.js";
export { NodeMcpCapability, createNodeMcpCapability } from "./mcpClient.js";

/**
 * 构造一个 NodeAgentHost。
 * edits 是有状态的（持有暂存区），因此每个 AgentSession 应独占一个 host 实例。
 */
export function createNodeAgentHost(): AgentHost {
  return {
    fs: new NodeFileSystem(),
    commands: new NodeCommandRunner(),
    processes: new NodeProcessManager(),
    webBrowser: new PlaywrightBrowser(),
    diagnostics: new NodeDiagnostics(),
    browser: new NodeDirectoryBrowser(),
    edits: new NodeEditPresenter(),
    // ideContext 留空：Node 形态无编辑器上下文
  };
}
