/**
 * AI 思考过程展示区块（可折叠，不持久化）。展开时内部滚动，始终展示完整内容。
 * 从原 ChatPanel.tsx 拆出。
 */

import { useState, useRef, useEffect } from "react";
import { Activity, ChevronDown } from "lucide-react";

export function ReasoningBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(true);
  const scrollRef = useRef<HTMLPreElement>(null);

  // 流式更新时自动滚动到内部底部（让用户看到最新思考）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !expanded) return;
    el.scrollTop = el.scrollHeight;
  }, [content, expanded]);

  return (
    <div className="mb-3 rounded-md border border-border/50 bg-muted/30 text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        <Activity className="w-3.5 h-3.5 shrink-0 text-primary/60" />
        <span className="font-medium">思考过程</span>
        <ChevronDown className={`w-3.5 h-3.5 ml-auto transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && (
        <pre
          ref={scrollRef}
          className="px-3 pb-2 whitespace-pre-wrap break-words text-muted-foreground/80 max-h-64 overflow-y-auto leading-snug font-sans my-0"
        >
          {content}
        </pre>
      )}
    </div>
  );
}
