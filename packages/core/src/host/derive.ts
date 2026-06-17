/**
 * 子 Agent host 派生（执行端纯逻辑）
 *
 * 子 Agent（delegate_task / parallel_research / relay_review）独占执行、改动直接落盘，
 * 必须用【独立 auto 模式】的 EditPresenter——否则它的落盘会写进主 Agent 的 manual 暂存区，
 * 污染待确认列表。但 fs / commands / diagnostics / browser / ideContext 都是无状态或只读的，
 * 可与父 host 安全共享。
 *
 * 本函数在 core 内完成派生，不依赖任何具体 host 实现：通过 EditPresenter.fork("auto")
 * 让父的 edits 自行 new 一个同类型的干净 auto 实例。
 */

import type { AgentHost } from "./index.js";

/** 由父 host 派生一个供子 Agent 使用的 host：共享 fs/commands/diagnostics/browser，edits 换独立 auto 实例。 */
export function deriveSubAgentHost(parent: AgentHost): AgentHost {
  return {
    fs: parent.fs,
    commands: parent.commands,
    diagnostics: parent.diagnostics,
    browser: parent.browser,
    edits: parent.edits.fork("auto"),
    ideContext: parent.ideContext,
  };
}
