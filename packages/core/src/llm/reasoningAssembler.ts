/**
 * ReasoningAssembler —— reasoning 分段拼装（纯逻辑，可测试、前后端可共享）
 *
 * 背景：
 * - GPT Responses 的 reasoning summary 会以 (itemId, partIndex) 分段流式到达，
 *   同一个 part 的多个增量需要按 key 累加，不同 part 之间需要按到达顺序拼接。
 * - 旧实现把这套“按 key 累加 + 顺序 join”的逻辑散落在前端 handleReasoningDelta 里，
 *   既不可单测，也无法被新 pipeline 复用。
 *
 * 设计要点：
 * - 纯逻辑：不依赖任何运行时状态、不发事件、不碰 DOM，便于单元测试与跨端复用。
 * - 保持插入顺序：Map 的迭代顺序即 part 首次出现顺序，保证拼接顺序稳定。
 * - 兼容无分段场景：未提供 partIndex 时归到单一顺序缓冲，行为与旧实现一致。
 */

/** 单条 reasoning 增量输入。 */
export interface ReasoningDeltaInput {
  /** 本次增量文本。 */
  text: string;
  /** 分段序号（provider 提供时）。 */
  partIndex?: number;
  /** 分段所属 item 标识（provider 提供时）。 */
  itemId?: string;
}

/**
 * reasoning 分段拼装器。
 *
 * 用法：
 * - 每收到一条 reasoning 增量就调用 push()。
 * - 需要展示时调用 text() 拿到按 part 顺序拼接后的完整文本。
 */
export class ReasoningAssembler {
  /** key -> 该分段累计文本；用普通对象无法保证顺序，这里依赖 Map 的插入顺序。 */
  private readonly parts = new Map<string, string>();
  /** 无分段信息时的顺序缓冲 key。 */
  private static readonly SEQUENTIAL_KEY = "__sequential__";

  /** 累加一条 reasoning 增量。空文本直接忽略。 */
  push(input: ReasoningDeltaInput): void {
    const text = input.text || "";
    if (!text) return;
    const key = typeof input.partIndex === "number"
      ? `${input.itemId ?? ""}:${input.partIndex}`
      : ReasoningAssembler.SEQUENTIAL_KEY;
    this.parts.set(key, (this.parts.get(key) ?? "") + text);
  }

  /** 按 part 首次出现顺序拼接出完整 reasoning 文本。 */
  text(separator = "\n\n"): string {
    return Array.from(this.parts.values()).filter(Boolean).join(separator);
  }

  /** 是否已累计到任何内容。 */
  isEmpty(): boolean {
    return this.parts.size === 0;
  }

  /** 清空累计状态（新一轮 reasoning 开始时调用）。 */
  reset(): void {
    this.parts.clear();
  }
}
