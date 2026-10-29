/**
 * 翻牌式文字切换：旧的一行向上翻走，新的从下面翻到中间。
 * animateKey 变了才翻；同一 key 下文字变化直接替换（比如进行中实时刷新的当前动作，不该每步都翻）。
 */

import { useState } from "react";

export function FlipText({ text, animateKey, className = "" }: { text: string; animateKey: string; className?: string }) {
  // 渲染期调整状态（React 推荐的「随 props 变化重置」写法）：记住上一条，用来做翻走的那一半
  const [state, setState] = useState({ key: animateKey, text, prev: null as string | null, n: 0 });
  if (state.key !== animateKey) setState({ key: animateKey, text, prev: state.text, n: state.n + 1 });
  else if (state.text !== text) setState({ ...state, text });

  return (
    <span className={`relative inline-grid min-w-0 overflow-hidden ${className}`}>
      {state.prev !== null && (
        <span key={`out-${state.n}`} aria-hidden className="col-start-1 row-start-1 min-w-0 truncate animate-flip-out">
          {state.prev}
        </span>
      )}
      <span key={`in-${state.n}`} className={`col-start-1 row-start-1 min-w-0 truncate ${state.n > 0 ? "animate-flip-in" : ""}`}>
        {state.text}
      </span>
    </span>
  );
}
