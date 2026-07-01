/**
 * AgentHost —— 执行端抽象（两层抽象之 ①）
 *
 * Agent 的“手”：决定“谁来动文件、跑命令、做诊断、呈现改动、感知 IDE”。
 * @axon/core 只面向这个聚合接口编程，绝不直接 import node:fs / child_process / vscode。
 *
 * 两种实现：
 *   · @axon/host-node    —— NodeAgentHost（web / cli / server 形态）
 *   · @axon/host-vscode  —— VSCodeAgentHost（Code OSS 内置扩展形态，进程内）
 */

export * from "./fs.js";
export * from "./commands.js";
export * from "./processes.js";
export * from "./webBrowser.js";
export * from "./diagnostics.js";
export * from "./edits.js";
export * from "./browser.js";
export * from "./search.js";
export * from "./ideContext.js";
export * from "./derive.js";
export * from "./scopedHost.js";

import type { HostFileSystem } from "./fs.js";
import type { HostCommandRunner } from "./commands.js";
import type { HostProcessManager } from "./processes.js";
import type { HostWebBrowser } from "./webBrowser.js";
import type { HostDiagnostics } from "./diagnostics.js";
import type { EditPresenter } from "./edits.js";
import type { DirectoryBrowser } from "./browser.js";
import type { HostSearch } from "./search.js";
import type { IdeContextProvider } from "./ideContext.js";

/**
 * 执行端聚合：Agent 触碰外部世界的唯一入口。
 *
 * 必选能力（所有形态都有）：fs / commands / diagnostics / browser / edits
 * 可选能力（仅进程内 IDE 形态）：ideContext
 */
export interface AgentHost {
  /** 文件读写 */
  readonly fs: HostFileSystem;
  /** 命令执行 */
  readonly commands: HostCommandRunner;
  /** 后台常驻进程管理（开发服务器/watch/交互式命令）；不支持的形态为 undefined */
  readonly processes?: HostProcessManager;
  /** 网页浏览器（CDP/Playwright）：读控制台/报错/网络 + 截图；不支持的形态为 undefined */
  readonly webBrowser?: HostWebBrowser;
  /** 类型/编译诊断 */
  readonly diagnostics: HostDiagnostics;
  /** 目录浏览（目录选择器逐层下钻） */
  readonly browser: DirectoryBrowser;
  /** 高效全文/文件名搜索（execFile 调 ripgrep）；不提供的形态为 undefined，core 退化为纯 fs 遍历 */
  readonly search?: HostSearch;
  /** 改动呈现/落盘（auto 直接写盘 / manual 暂存 / 原生 diff） */
  readonly edits: EditPresenter;
  /** IDE 上下文感知（活动文件/选区/git diff）；非 IDE 形态为 undefined */
  readonly ideContext?: IdeContextProvider;
}
