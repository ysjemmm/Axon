/**
 * AI 思考过程展示区块（可折叠，不持久化）。
 * 折叠态：极简一行标签，几乎不占空间；展开态：内部滚动展示完整内容。
 */

import { useState, useRef, useEffect, useMemo } from "react";
import { Brain } from "lucide-react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";

export function ReasoningBlock({ content, streaming }: { content: string; streaming?: boolean }) {
  // streaming=true 时展开（正在进行），streaming=false/undefined 时默认折叠（已完结）
  const [expanded, setExpanded] = useState(!!streaming);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cleanedContent = useMemo(() => content.replace(/<!--[\s\S]*?-->/g, ""), [content]);

  // 思考完成（streaming 从 true 变为 false）时自动折叠
  useEffect(() => {
    if (streaming) {
      setExpanded(true);
    } else {
      setExpanded(false);
    }
  }, [streaming]);

  // 内部滚动区是否"贴底"：用户往上翻过就不再自动跟随，否则流式期间每来一段内容
  // 都会把视口拽回底部，滚动条根本没法滚。
  const stickRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [expanded]); // 滚动区仅在展开态存在，展开/折叠会重建它，故按 expanded 重挂监听

  // 流式更新时自动滚动到内部底部（仅当用户本来就在底部）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !expanded) return;
    if (!stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [cleanedContent, expanded]);

  // ── 只渲染【一棵树】，折叠靠高度过渡，而不是切换两套结构 ──
  //
  // ⚠️ 这里曾经是 `if (!expanded) return <button/>` + 另一个分支返回"标签+内容"的两棵树。
  // React 对"同 key 换结构"是卸载+重挂载，于是上面的 effect 把 expanded 置 false 的那一刻，
  // 整个内容区**在一帧内被卸载**：大片高度瞬间消失，下方内容整体上移、腾出来的位置露出页面底色。
  // 这就是用户反复报、并且被误当成"重渲染问题"去修的「回复完白屏刷一下」——
  // 它与渲染路径无关，是纯粹的高度跳变；而且每逢思考块收尾必现，与回复内容无关。
  //
  // 现在内容常驻挂载（也因此不再有挂载/卸载带来的重解析与 re-hydrate），只让容器高度动画：
  // grid-template-rows 1fr ↔ 0fr 是可过渡的，且**不需要预先知道内容高度** ——
  // reasoning 长度差异极大，用 max-height 写死上限会让动画时长严重失真（短内容几乎不动、长内容半途跳完）。
  //
  // 折叠态外观与旧版一致（一行标签、视觉极轻）；差别仅是内容仍在 DOM 里但高度为 0。
  return (
    <div
      className={`text-xs transition-[margin] duration-200 ease-out motion-reduce:transition-none ${
        expanded ? "mb-2" : "mb-0"
      }`}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className={`flex items-center gap-1.5 py-0.5 text-[11px] hover:text-muted-foreground transition-colors cursor-pointer ${
          expanded ? "text-muted-foreground/70" : "text-muted-foreground/60"
        }`}
      >
        <Brain className="w-3.5 h-3.5 shrink-0" />
        <span>思考过程</span>
      </button>
      <div
        className="grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr", opacity: expanded ? 1 : 0 }}
        aria-hidden={!expanded}
      >
        {/* min-h-0 是必须的：grid 子项默认 min-height:auto，高度不会被压到 0 */}
        <div className="min-h-0 overflow-hidden">
          {/* 这里把正文压到 text-xs；正文里的行内代码 / 引用块 / 表格用的是 em 字号，会跟着一起缩。
              若把它们改回 px，就会在这个更小的上下文里比正文还大（曾出现「思考过程里代码字体特别大」）。 */}
          <div
            ref={scrollRef}
            className="pl-4 border-l-2 border-muted-foreground/15 max-h-52 overflow-y-auto [&_.prose]:text-muted-foreground/70 [&_.prose]:text-xs [&_.prose]:leading-snug [&_.prose_p]:my-0.5 [&_.prose_ul]:my-0.5 [&_.prose_ol]:my-0.5"
          >
            <MarkdownRenderer content={cleanedContent} streaming={streaming} />
          </div>
        </div>
      </div>
    </div>
  );
}
