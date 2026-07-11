/**
 * ToolExecutor —— 工具执行能力的最小抽象（供新 pipeline 的 ToolDispatchHandler 注入）
 *
 * 背景：
 * - ToolDispatchHandler 只负责“驱动工具调用的状态流转 + 产出统一事件”，
 *   不应该自己耦合宿主如何真正执行工具（读文件/跑命令/联网等）。
 * - 因此把“真正执行一个工具”抽象成 ToolExecutor 接口，由外部注入。
 *
 * 设计要点：
 * - 纯接口，不含任何实现；第一阶段仅用于把执行能力与分发编排解耦。
 * - 返回结构化结果（ok + result/error），与 ToolCallStateMachine 的 complete/fail 语义对齐。
 */

/** 一次工具执行请求（由工具调用草案归一化而来）。 */
export interface ToolExecuteRequest {
  callId: string;
  toolName: string;
  parsedArgs?: Record<string, unknown>;
  rawArgsText?: string;
}

/** 一次工具执行结果（结构化，明确区分成功与失败）。 */
export interface ToolExecuteResult {
  ok: boolean;
  /** 成功时的结果文本。 */
  result?: string;
  /** 失败时的错误文本。 */
  error?: string;
}

/**
 * 工具执行器：把一次工具调用请求真正执行并返回结构化结果。
 *
 * 说明：
 * - 具体实现（接宿主 executeToolCall、命令门控等）由上层注入，本层不感知细节。
 * - 抛出异常与返回 ok=false 都视为失败；ToolDispatchHandler 会统一收敛为 fail 事件。
 */
export interface ToolExecutor {
  execute(req: ToolExecuteRequest): Promise<ToolExecuteResult>;
}
