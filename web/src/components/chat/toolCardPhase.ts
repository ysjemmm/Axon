/**
 * 工具卡片前置态（queued）的成因判定。
 *
 * ── 要区分什么 ──
 * 后端在**流式阶段**（onToolCallDetected：工具名刚认出来、参数还在逐 chunk 累加）就为每个
 * 工具提前发卡，以消除等待期的空白。于是同一个 `queued` 状态下混着两种成因完全不同的等待：
 *
 * · 生成中：模型正在流式产出这次调用的参数。create_file 的 content 就是整个文件正文，
 *           str_replace 的 new_str 同理——这一段常常是本轮最长的等待，而且**确实有事在发生**。
 * · 排队中：参数已经齐了，纯粹在等前面的工具跑完（后端严格串行，一个跑完才轮到下一个）。
 *           此刻这个工具自己什么都没干。
 *
 * 不分开的后果不是"少个细节"，而是**等待时间的归因整个错了**：卡片长时间停在「排队中」、
 * 然后「创建中」一闪而过，看起来像计时坏了；真实情况是模型在逐字写文件内容。
 *
 * ── 为什么能纯前端推出来，不需要后端加协议字段 ──
 * ① 工具调用在流里是**按序**产出的（chat 协议按 index 累积：T1 的 args 收完才出现 T2 的 name；
 *    Anthropic 的 content block 同样逐块推进）。所以在流式阶段，**最后一个**被检测到的工具
 *    才是参数仍在累加的那个，它之前的工具参数都已完整、只是在等流结束。
 * ② 后端串行执行，同一时刻最多一个工具处于执行中。只要看到有工具在执行，就说明流已经结束、
 *    没有谁还在生成参数，剩下的 queued 一律是在排队等。
 *
 * 换成事件驱动（后端显式广播状态切换）反而更差：tool_call 在前端卡片队列里带 80ms 入场间隔，
 * 为 N 个工具各补一发就是 N×80ms 的额外延迟，会把第一张执行中卡片往后推——正好抵消提前出卡
 * 想换来的那点即时感。
 *
 * ── 与上一版的区别（这是个真 bug 的修复，不是优化）──
 * 上一版的判定是"扫描段列表，只要**已经有**工具离开 queued，后面的 queued 就算在排队"。
 * 那个标志一旦置起就永不复位，而 agent loop 每一轮的工具段都累积在同一条 assistant 消息里：
 * 第 1 轮工具一旦跑完，第 2 轮起所有正在生成参数的卡片都会被误判成「排队中」。
 * 多轮恰恰是常态，等于那版判定基本没生效。
 *
 * 本版只看**当下的 in-flight 状态**，不看历史，因此与轮次无关。
 */

import type { Segment } from "./types";

/**
 * 找出哪些 `queued` 工具是**真的在排队等**（而非参数仍在生成）。
 *
 * @param segments 一条 assistant 消息内的段列表（含多轮累积的工具段）
 * @returns 处于"排队等待"的工具段 id 集合；不在集合里的 queued 段即"参数生成中"
 */
export function resolveQueuedWaitingIds(segments: readonly Segment[]): Set<string> {
  const waiting = new Set<string>();

  const queuedIds: string[] = [];
  let anyExecuting = false;
  for (const s of segments) {
    if (s.type !== "tool") continue;
    if (s.status === "queued") queuedIds.push(s.id);
    // pending = 宿主正在真正执行这一个（前端词表里 pending 表示执行中）
    else if (s.status === "pending") anyExecuting = true;
  }
  if (queuedIds.length === 0) return waiting;

  // 有工具在执行 → 流已结束，没有谁在生成参数；否则最后一个被检测到的才是在生成参数的那个。
  const streamingId = anyExecuting ? null : queuedIds[queuedIds.length - 1];
  for (const id of queuedIds) {
    if (id !== streamingId) waiting.add(id);
  }
  return waiting;
}
