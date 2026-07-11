/**
 * ReasoningEventBuilder —— 把 reasoning 增量转成统一内部事件（纯逻辑，可测试）
 *
 * 背景：
 * - ReasoningAssembler 负责“把分段增量拼成完整文本”，解决的是展示态拼装。
 * - 但新 pipeline 需要的是把每一条 reasoning 增量转成标准 ReasoningDeltaEvent，
 *   最终收尾时再产出一条 ReasoningCommitEvent，供 trace / 前端消费。
 * - 这个构建器就是这两者之间的桥：输入 reasoning 增量 + 归属信息，输出标准事件。
 *
 * 设计要点：
 * - 纯函数：不依赖运行时状态、不发事件、不碰 DOM，便于单元测试与复用。
 * - source / stage 由事件模型固定（reasoning 恒为 source=llm；delta=runtime，commit=committed），
 *   构建器不重复决策，避免语义分散。
 */

import type { ReasoningDeltaEvent, ReasoningCommitEvent, ReasoningKind, RequestId, TurnId } from "./eventModel.js";
import type { ReasoningDeltaInput } from "./reasoningAssembler.js";

/** 事件归属信息（一次 request/turn 内共享）。 */
export interface ReasoningEventContext {
  requestId: RequestId;
  turnId?: TurnId;
  /** 可选的时间戳来源（便于测试注入固定时间）；默认取当前时间。 */
  now?: () => string;
}

function nowIso(ctx: ReasoningEventContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

/** 把一条 reasoning 增量转成标准 ReasoningDeltaEvent。 */
export function buildReasoningDeltaEvent(
  ctx: ReasoningEventContext,
  input: ReasoningDeltaInput,
  kind?: ReasoningKind,
): ReasoningDeltaEvent {
  return {
    type: "reasoning.delta",
    ts: nowIso(ctx),
    requestId: ctx.requestId,
    turnId: ctx.turnId,
    source: "llm",
    stage: "runtime",
    text: input.text,
    kind,
    partIndex: input.partIndex,
    itemId: input.itemId,
  };
}

/**
 * 把整段拼装好的 reasoning 文本转成一条 ReasoningCommitEvent。
 *
 * 说明：
 * - 通常在一个 turn 的 reasoning 结束时调用一次，产出最终定型的思考内容。
 * - partIndex / itemId 在“整段提交”语义下可省略（表示这是本轮汇总后的完整 reasoning）。
 */
export function buildReasoningCommitEvent(
  ctx: ReasoningEventContext,
  text: string,
  kind?: ReasoningKind,
): ReasoningCommitEvent {
  return {
    type: "reasoning.commit",
    ts: nowIso(ctx),
    requestId: ctx.requestId,
    turnId: ctx.turnId,
    source: "llm",
    stage: "committed",
    text,
    kind,
  };
}
