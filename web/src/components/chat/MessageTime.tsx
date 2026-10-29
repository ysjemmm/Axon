/**
 * 回复完成时间（「刚刚」「5 分钟前」「昨天 14:32」），悬停看完整时间。
 * 所有实例共用一个每分钟走一次的时钟，几百条消息也只有一个定时器。
 */

import { useSyncExternalStore } from "react";
import { formatMessageTime, fullMessageTime } from "@/lib/messageTime";

let minute = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    // 之前没人在看时钟就停着，重新开始前先对一下时间
    minute = Date.now();
    timer = setInterval(() => {
      minute = Date.now();
      listeners.forEach((l) => l());
    }, 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) { clearInterval(timer); timer = null; }
  };
}

export function MessageTime({ at }: { at: number }) {
  const now = useSyncExternalStore(subscribe, () => minute);
  return <span title={fullMessageTime(at)}>{formatMessageTime(at, Math.max(now, at))}</span>;
}
