/**
 * 会话标题的显示与编辑。
 *
 * 自动标题截断后加的是省略号「…」（老会话里存的是三个英文句点 "..."）。
 * 显示时统一成「…」；双击重命名时把它去掉，让用户编辑的是干净的文字，
 * 而不是在输入框里看到一串 "..."。
 */

const TRAILING_ELLIPSIS = /(?:\.{3}|…)$/;

/** 显示用：老标题末尾的 "..." 换成「…」 */
export function displaySessionTitle(title: string | undefined | null): string {
  return (title || "").replace(/\.{3}$/, "…");
}

/** 重命名输入框里的初始值：去掉自动截断留下的省略号 */
export function editableSessionTitle(title: string | undefined | null): string {
  return (title || "").replace(TRAILING_ELLIPSIS, "").trimEnd();
}
