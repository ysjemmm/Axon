import type { TurnPhase } from "./eventModel.js";

/**
 * 归一化后的回合结束原因（产品语义）。
 *
 * 说明：
 * - 这是 Axon 内部统一使用的“回合结束语义”，与具体协议字段解耦。
 * - complete：模型正常给出最终回复。
 * - tool_calls：本回合以工具调用收尾，request 需要继续下一轮 turn。
 * - truncated：输出被截断（如达到长度上限），需要续写而非当作正常完成。
 * - error：协议层/上游发生异常中断（如 Responses 的 failed）。
 * - cancelled：被用户或系统主动取消。
 */
export type NormalizedFinishReason = "complete" | "tool_calls" | "truncated" | "error" | "cancelled";

/**
 * 把底层策略（Chat Completions / Responses）产出的原始 finishReason
 * 归一化为 Axon 内部统一语义。
 *
 * 设计要点：
 * - 这是一个纯函数，不依赖任何运行时状态，便于单元测试与复用。
 * - 关键动机：修复历史上把 Responses 的 `failed` 误判为“正常结束”的问题——
 *   `error` 必须与 `complete` 严格区分，避免异常中断被当成正常收尾。
 * - 未知/缺失的原始值不静默当成 complete，而是显式归为 error，避免“假装正常完成”。
 *
 * 原始值映射：
 * - "stop"            -> "complete"
 * - "tool_calls"      -> "tool_calls"
 * - "length"          -> "truncated"
 * - "content_filter"  -> "error"
 * - "error"           -> "error"
 * - "cancelled"       -> "cancelled"
 * - null / 未知        -> "error"（保守：不冒充正常完成）
 */
export function normalizeFinishReason(raw: string | null | undefined): NormalizedFinishReason {
  switch (raw) {
    case "stop":
      return "complete";
    case "tool_calls":
      return "tool_calls";
    case "length":
      return "truncated";
    case "content_filter":
      return "error";
    case "error":
      return "error";
    case "cancelled":
      return "cancelled";
    default:
      // 空值或未知原因：保守归为 error，绝不当作正常完成。
      return "error";
  }
}

/**
 * 把 Responses API 的响应 status 映射为原始 finishReason 值。
 *
 * 设计要点：
 * - 抽成纯函数，专门锁死“failed 必须映射为 error、不能当作正常 stop”这一根因。
 * - 返回值刻意沿用 Chat Completions 的原始 finishReason 词表（stop / length / error），
 *   以便与 normalizeFinishReason 复用同一套归一化规则。
 *
 * status 映射：
 * - "completed"   -> "stop"    （正常完成）
 * - "incomplete"  -> "length"  （被截断，需续写）
 * - "failed"      -> "error"   （异常中断，绝不冒充正常完成）
 * - 其它/缺失      -> "error"   （保守：未知状态不当作正常完成）
 */
export function mapResponsesStatusToFinishReason(status: string | null | undefined): string {
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
      return "error";
    default:
      return "error";
  }
}

export function finishReasonToTurnPhase(reason: NormalizedFinishReason): TurnPhase {
  switch (reason) {
    case "complete":
    case "tool_calls":
      return "complete";
    case "truncated":
      return "truncated";
    case "error":
      return "error";
    case "cancelled":
      return "cancelled";
  }
}
