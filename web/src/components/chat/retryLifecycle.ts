/**
 * retry 段（接口重试提示）的生命周期判定。
 *
 * 背景：后端只在「正在重试」和「重试次数已用尽」时发 retry 事件，**成功时不发任何
 * "恢复"信号**。所以前端必须自己判断"什么时候该把重试提示收掉"。
 *
 * 判据只看 status：
 * · "retrying" —— 进行中。一旦有了后续产出（正文/工具/思考），说明已恢复，应收掉。
 * · "failed"   —— 「重试次数已用尽」，是终态记录，必须保留给人看。
 *
 * 抽成纯函数是为了能脱离 React 单独验证（见修复时的验证脚本）。
 */

import type { Segment } from "./types";

/** 是否是「正在重试」段（进行中）。failed 是终态，不算。 */
export function isPendingRetry(seg: Segment): boolean {
  return seg.type === "retry" && seg.status === "retrying";
}

/**
 * 移除所有「正在重试」段。
 * @returns 新的 segments 数组；若本来就没有待移除的段，返回 null，
 *          调用方据此跳过状态更新（避免每次 delta 都触发一次无意义的重渲染）。
 */
export function stripPendingRetry(segments: Segment[]): Segment[] | null {
  if (!segments.some(isPendingRetry)) return null;
  return segments.filter((s) => !isPendingRetry(s));
}
