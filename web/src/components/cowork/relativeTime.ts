/** 相对时间：办公用户关心的是「多久以前」，不是精确时间戳。接受毫秒时间戳或 ISO 字符串 */
export function relativeTime(value: number | string): string {
  const then = typeof value === "number" ? value : new Date(value).getTime();
  if (!Number.isFinite(then)) return "";
  const min = Math.floor((Date.now() - then) / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(then).toLocaleDateString("zh-CN");
}
