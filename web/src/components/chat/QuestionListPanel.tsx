/**
 * 问题列表面板 —— 展示会话中所有用户提问，支持搜索、点击跳转。
 * 嵌在 Popover 内部使用。
 */

import { useState } from "react";
import { ImageIcon, Paperclip, Search } from "lucide-react";

/** 格式化时间戳为短时间（今天: HH:mm，昨天: 昨天 HH:mm，更早: MM/DD HH:mm） */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return hhmm;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hhmm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
}

export interface QuestionItem {
  id: string;
  text: string;
  timestamp?: number;
  hasImage?: boolean;
  files?: string[];
}

interface QuestionListPanelProps {
  questions: QuestionItem[];
  onSelect: (id: string) => void;
}

export function QuestionListPanel({ questions, onSelect }: QuestionListPanelProps) {
  const [search, setSearch] = useState("");

  const filtered = search.trim()
    ? questions.filter((q) => q.text.toLowerCase().includes(search.toLowerCase()))
    : questions;

  return (
    <>
      {/* 搜索栏 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60">
        <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <input
          type="text"
          placeholder="搜索提问..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground/60"
          autoFocus
        />
      </div>
      {/* 列表 */}
      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="text-center text-xs text-muted-foreground py-6">
            {search ? "无匹配结果" : "暂无提问"}
          </div>
        )}
        {filtered.map((q) => (
          <button
            key={q.id}
            onClick={() => onSelect(q.id)}
            className="w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors border-b border-border/30 last:border-b-0"
          >
            <div className="flex items-center gap-2">
              <p className="flex-1 min-w-0 text-xs text-foreground truncate">{q.text || "(无文本)"}</p>
              {q.timestamp && (
                <span className="shrink-0 text-[10px] text-muted-foreground/70 font-mono tabular-nums bg-muted/50 px-1.5 py-0.5 rounded">
                  {formatTime(q.timestamp)}
                </span>
              )}
            </div>
            {/* 附件指示 */}
            {(q.hasImage || (q.files && q.files.length > 0)) && (
              <div className="flex items-center gap-2 mt-0.5">
                {q.hasImage && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
                    <ImageIcon className="w-3 h-3" />
                    图片
                  </span>
                )}
                {q.files && q.files.length > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground truncate">
                    <Paperclip className="w-3 h-3 shrink-0" />
                    {q.files.length === 1 ? q.files[0] : `${q.files.length} 个文件`}
                  </span>
                )}
              </div>
            )}
          </button>
        ))}
      </div>
    </>
  );
}
