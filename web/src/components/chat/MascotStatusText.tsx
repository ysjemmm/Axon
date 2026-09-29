/**
 * MascotStatusText —— 吉祥物右侧的「正在执行」状态文字。
 *
 * 为什么需要它：Axo 本体只表达心情（waiting / thinking），表达不了「进行到哪一步」；
 * 而 AI 回复头部的状态文字会随消息流滚出视野。把 statusText 固定在始终可见的输入框上方，
 * 用户抬眼就能确认「它还在干活」，不必去消息流里找。
 *
 * 动画是三色流光（见 index.css 的 .axon-mascot-status）。渐变按位置循环、与文字内容无关，
 * 因此状态频繁切换（思考中→正在读取文件…）时不会跳变，也不改变宽度、不顶动布局。
 *
 * 切换过场：文案变化时整个 span 重挂载（key=文案），重放淡入上滑动画 —— 见下方 key 处说明。
 */

import { memo } from "react";

export const MascotStatusText = memo(function MascotStatusText({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <span
      // key=文案：文案一变就重挂载这个 span，从而重放 axon-mascot-status-in 的淡入上滑过场。
      // 不挂 key 时 React 只改文本节点，切换是硬替换、观感生硬。
      // 重挂载会顺带让底色流光从相位起点重来，但新文案本来就是从透明淡入的，
      // 相位重置正好被这段淡入盖住，看不出跳变。
      key={text}
      // 位置：这一行外壳是 h-[26px] -mb-[5px]（底部 5px 压在输入框边框上），
      // 文字若纯居中，底部离输入框只剩 ~2px，看着像贴在边框上。故上移 2px 拉开距离。
      // 用 relative+top 而不是 -translate-y：axon-mascot-status 的入场动画动的是 transform，
      // animation-fill-mode: both 会让动画结束后仍占着 transform，盖掉 translate 类。
      // 字号 11px（比 text-xs 小一档）+ 显式行高：arbitrary 字号不带行高，若继承 text-xs 的
      // 16px，字形会在行盒里偏下，等于抵消了一部分上移。
      className="axon-mascot-status relative -top-[2px] text-[11px] leading-[14px] font-medium max-w-[260px] truncate"
      // 纯装饰：状态每轮都在刷新，不该每次都进无障碍树打断屏幕阅读器
      aria-hidden="true"
    >
      {text}
    </span>
  );
});
