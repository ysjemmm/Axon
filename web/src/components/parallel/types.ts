/**
 * 多 Agent 并行工作流 - 类型定义
 *
 * 数据模型设计：
 * - ParallelBatch：一次并行执行批次（用户发起一个需求，AI 拆分成多个并行子任务）
 * - ParallelAgent：批次中的一路 Agent（有独立的进度、事件流、文件作用域）
 * - 前端事件协议复用 sub_agent_event 机制（delegateId 路由到各路 Agent 卡片）
 */

import type { Segment } from "../chat/types";

/** 单路 Agent 的执行状态 */
export type AgentStatus = "pending" | "running" | "done" | "failed";

/** 单路并行 Agent */
export interface ParallelAgent {
  /** 与后端 delegateId 对应（事件路由 key） */
  delegateId: string;
  /** 一句话任务描述 */
  intent: string;
  /** 允许写入的文件/目录 glob 列表（文件分区隔离） */
  fileScope: string[];
  /** 执行状态 */
  status: AgentStatus;
  /** 内部事件段（实时流式，复用 Segment 渲染体系） */
  inner: Segment[];
  /** 是否正在流式输出 */
  innerStreaming?: boolean;
  /** 最终结论文本 */
  conclusion?: string;
  /** 耗时（毫秒） */
  elapsed?: number;
  /** 消耗 token */
  tokens?: number;
}

/** 一次并行执行批次 */
export interface ParallelBatch {
  /** 批次唯一 id */
  batchId: string;
  /** 整体目标描述 */
  intent: string;
  /** 创建时间 */
  createdAt: number;
  /** 批次状态（所有子 Agent 都完成则 done） */
  status: "running" | "done" | "partial_failed";
  /** 各路并行 Agent */
  agents: ParallelAgent[];
  /** 关联的 Relay ID（从 Relay executing 阶段触发时有值，可点击跳转） */
  relayId?: string;
  /** 整体耗时（完成时填入） */
  elapsed?: number;
  /** 总 token 消耗 */
  totalTokens?: number;
}

/** 并行面板的全局状态 */
export interface ParallelState {
  /** 所有批次（按时间倒序） */
  batches: ParallelBatch[];
  /** 当前查看的批次 id（null = 最新的正在运行的批次 / 列表页） */
  activeBatchId: string | null;
}
