/**
 * RetryBlock —— 接口重试状态展示组件（类 Codex 风格）。
 * 重试中：WiFi 图标 + "正在重新连接 N/M" + 可折叠错误详情
 * 重试失败：警告图标 + 最终错误信息
 */

import { useState } from "react";
import { Wifi, ChevronDown, CircleAlert } from "lucide-react";

interface RetryBlockProps {
  attempt: number;
  maxRetries: number;
  error: string;
  status: "retrying" | "failed";
}

export function RetryBlock({ attempt, maxRetries, error, status }: RetryBlockProps) {
  const [expanded, setExpanded] = useState(false);

  if (status === "failed") {
    return (
      <div className="flex flex-col gap-1 py-1.5 text-xs text-destructive">
        <div className="flex items-center gap-2">
          <CircleAlert className="w-4 h-4 shrink-0" />
          <span className="font-medium">重试次数已用尽</span>
        </div>
        <div className="ml-6 max-h-24 overflow-y-auto rounded-md bg-destructive/10 px-2 py-1.5 text-destructive/90 break-words">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 py-1.5 text-xs text-muted-foreground">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 hover:text-foreground transition-colors cursor-pointer"
      >
        <Wifi className="w-4 h-4 shrink-0 animate-pulse" />
        <span className="font-medium">正在重新连接 {attempt}/{maxRetries}</span>
        <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && (
        <div className="ml-6 max-h-24 overflow-y-auto rounded-md bg-muted/40 px-2 py-1.5 text-muted-foreground/70 break-words">
          {error}
        </div>
      )}
    </div>
  );
}
