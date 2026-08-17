/**
 * 子 Agent host 派生（执行端纯逻辑）
 *
 * 子 Agent（delegate_task / parallel_research / relay_review）独占执行、改动直接落盘，
 * 必须用【独立 auto 模式】的 EditPresenter——否则它的落盘会写进主 Agent 的 manual 暂存区，
 * 污染待确认列表。同理，命令执行器也必须 fork 独立实例：多个子 Agent 若共用父 Agent 的
 * 终端，命令会挤进同一个终端串行排队、互相干扰。fs / diagnostics / browser / ideContext
 * 都是无状态或只读的，可与父 host 安全共享。
 *
 * 本函数在 core 内完成派生，不依赖任何具体 host 实现：通过 EditPresenter.fork("auto")
 * 让父的 edits 自行 new 一个同类型的干净 auto 实例；通过 HostCommandRunner.fork() 让父的
 * commands 自行 new 一个绑定独立终端的实例。
 */

import type { AgentHost } from "./index.js";

/** 由父 host 派生一个供子 Agent 使用的 host：共享 fs/diagnostics/browser，commands 与 edits 各自独立实例。 */
export function deriveSubAgentHost(parent: AgentHost): AgentHost {
  return {
    fs: parent.fs,
    commands: parent.commands.fork(),
    diagnostics: parent.diagnostics,
    browser: parent.browser,
    edits: parent.edits.fork("auto"),
    ideContext: parent.ideContext,
  };
}
