/**
 * 回复底部的时间：近的说「刚刚 / 几分钟前」，远的给具体时间。
 *   < 1 分钟 → 刚刚；< 1 小时 → N 分钟前；今天 → 14:32；昨天 → 昨天 14:32；今年 → 3月5日 14:32；更早 → 2024/3/5 14:32
 */
const pad = (n: number) => String(n).padStart(2, "0");

export function formatMessageTime(at: number, now = Date.now()): string {
  const diff = now - at;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const d = new Date(at);
  const today = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= startOfToday) return hm;
  if (at >= startOfToday - 86_400_000) return `昨天 ${hm}`;
  if (d.getFullYear() === today.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 悬停时显示的完整时间 */
export function fullMessageTime(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
