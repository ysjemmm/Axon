/**
 * ReasoningStreamProcessor —— reasoning 增量流的处理闭环（纯逻辑，可测试）
 *
 * 背景：
 * - ReasoningAssembler 负责“把分段增量拼成完整文本”（展示态）。
 * - ReasoningEventBuilder 负责“把增量/整段转成标准内部事件”。
 * - 本处理器把两者串成一个闭环：喂入一条条 reasoning 增量，实时产出
 *   ReasoningDeltaEvent，收尾时基于已拼好的完整文本产出一条 ReasoningCommitEvent。
 *
 * 设计要点：
 * - 纯逻辑：不发事件、不碰 DOM、不依赖运行时状态，返回值即产物，便于单元测试与复用。
 * - 归属信息（requestId/turnId/now）在构造时注入一次，push/commit 复用，避免逐次重复传参。
 * - commit 只有在累计到内容时才产出事件；空 reasoning 不产生噪声 commit。
 */

import { ReasoningAssembler, type ReasoningDeltaInput } from "./reasoningAssembler.js";
import {
  buildReasoningDeltaEvent,
  buildReasoningCommitEvent,
  type ReasoningEventContext,
} from "./reasoningEventBuilder.js";
import type { ReasoningDeltaEvent, ReasoningCommitEvent, ReasoningKind } from "./eventModel.js";

export class ReasoningStreamProcessor {
  private readonly assembler = new ReasoningAssembler();

  constructor(private readonly ctx: ReasoningEventContext) {}

  /**
   * 处理一条 reasoning 增量：累加到拼装器，并返回对应的 reasoning.delta 事件。
   * 空文本增量被忽略（不累加、返回 null），与 ReasoningAssembler 行为一致。
   */
  push(input: ReasoningDeltaInput, kind?: ReasoningKind): ReasoningDeltaEvent | null {
    if (!input.text) return null;
    this.assembler.push(input);
    return buildReasoningDeltaEvent(this.ctx, input, kind);
  }

  /**
   * 收尾：基于已拼好的完整文本产出一条 reasoning.commit 事件。
   * 若本轮未累计到任何 reasoning 内容，返回 null（不产生空 commit）。
   */
  commit(kind?: ReasoningKind): ReasoningCommitEvent | null {
    if (this.assembler.isEmpty()) return null;
    return buildReasoningCommitEvent(this.ctx, this.assembler.text(), kind);
  }

  /** 当前已拼装的完整 reasoning 文本（展示态）。 */
  text(separator?: string): string {
    return this.assembler.text(separator);
  }

  /** 是否尚未累计到任何 reasoning 内容。 */
  isEmpty(): boolean {
    return this.assembler.isEmpty();
  }

  /** 重置累计状态（新一轮 reasoning 开始时调用）。 */
  reset(): void {
    this.assembler.reset();
  }
}
