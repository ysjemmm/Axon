/**
 * ToolGateDecider —— 工具执行前的门控决策抽象（方案 B：门控逻辑下沉进 pipeline）
 *
 * 背景：
 * - 现网的工具门控（命令三档授权、灾难命令硬拦、MCP 审批、重复调用拦截等）目前散落在
 *   agentSession.dispatchToolCall 里，与主循环强耦合，无法在新架构 handler 层复用与单测。
 * - 方案 B 的目标是把「execute 之前要不要放行」这个决策抽象成独立可注入组件，
 *   由 DefaultToolDispatchHandler 在 plan 之后、execute 之前统一调用。
 *
 * 设计要点：
 * - 纯决策：只回答「放行 / 拦截 / 改写参数」，不真正执行工具、不发前端事件（那是执行器与事件桥的职责）。
 * - 未注入决策器时，handler 默认全部放行，行为与方案 A 完全一致（零回退）。
 * - 决策可携带 editedArgs（如命令被用户编辑后的替代参数），执行器据此用实际参数执行。
 */

import type { ToolKind } from "./toolEventModel.js";

/** 一次门控决策请求（由工具草案归一化而来，与 ToolExecuteRequest 对齐）。 */
export interface ToolGateRequest {
  callId: string;
  toolName: string;
  toolKind: ToolKind;
  parsedArgs?: Record<string, unknown>;
  rawArgsText?: string;
}

/**
 * 门控决策结果。
 *
 * - allow：放行，可继续 execute；可选 editedArgs 表示用改写后的参数执行（如用户编辑过的命令）。
 * - block：拦截，工具不执行，收敛为 cancelled 终态；reason 作为给 AI 的可恢复错误文案。
 */
export interface ToolGateDecision {
  action: "allow" | "block";
  /** block 时给 AI 的清晰、可恢复错误文案。 */
  reason?: string;
  /** 给用户看的简短文案（前端卡片用，区别于给 AI 的 reason）。 */
  userMessage?: string;
  /** allow 时可选的改写参数（如命令被用户编辑后的替代版本）。 */
  editedArgs?: Record<string, unknown>;
}

/**
 * 工具门控决策器：在工具执行前决定放行 / 拦截 / 改写参数。
 *
 * 说明：
 * - 具体实现（接命令信任门 gateCommand、MCP 审批、重复调用拦截等）由上层注入，本层不感知细节。
 * - 只做决策，不执行、不发事件；DefaultToolDispatchHandler 据此驱动状态机（execute / block）。
 */
export interface ToolGateDecider {
  decide(req: ToolGateRequest): Promise<ToolGateDecision>;
}
