/**
 * AI 思考过程展示区块（可折叠，不持久化）。
 * 折叠态：极简一行标签，几乎不占空间；展开态：内部滚动展示完整内容。
 */

import { useState, useRef, useEffect, useMemo } from "react";
import { ChevronRight } from "lucide-react";
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

  // 流式更新时自动滚动到内部底部
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !expanded) return;
    el.scrollTop = el.scrollHeight;
  }, [cleanedContent, expanded]);

  // 折叠态：极简一行，不用 border/背景，视觉极轻
  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="flex items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-pointer"
      >
        <ChevronRight className="w-3 h-3 shrink-0" />
        <span>思考过程</span>
      </button>
    );
  }

  // 展开态：轻量容器 + 内容
  return (
    <div className="mb-2 text-xs">
      <button
        onClick={() => setExpanded(false)}
        className="flex items-center gap-1.5 py-0.5 mb-1 text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors cursor-pointer"
      >
        <ChevronRight className="w-3 h-3 shrink-0 rotate-90 transition-transform" />
        <span>思考过程</span>
      </button>
      <div
        ref={scrollRef}
        className="pl-4 border-l-2 border-muted-foreground/15 max-h-52 overflow-y-auto [&_.prose]:text-muted-foreground/70 [&_.prose]:text-xs [&_.prose]:leading-snug [&_.prose_p]:my-0.5 [&_.prose_ul]:my-0.5 [&_.prose_ol]:my-0.5"
      >
        <MarkdownRenderer content={cleanedContent} />
      </div>
    </div>
  );
}
