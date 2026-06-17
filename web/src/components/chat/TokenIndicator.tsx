/**
 * Token 用量圆环指示器（hover 展示上下文使用明细）
 * 从原 ChatPanel.tsx 拆出。
 */

import { Activity } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatTokenCount } from "./format";

export function TokenIndicator({ used, max }: { used: number; max: number; cumulative?: number }) {
  const hasMax = max > 0;
  const percent = hasMax ? Math.min((used / max) * 100, 100) : 0;

  // 颜色：绿 → 黄 → 红
  const strokeColor = percent < 50 ? "#22c55e" : percent < 80 ? "#eab308" : "#ef4444";

  // SVG 圆环参数
  const size = 28;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percent / 100) * circumference;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="relative flex items-center justify-center shrink-0 cursor-pointer hover:opacity-80 transition-opacity">
            {/* 圆环进度条 */}
            <svg width={size} height={size} className="rotate-[-90deg]">
              {/* 背景圆环 */}
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth={strokeWidth}
                className="text-muted"
              />
              {/* 进度圆环 */}
              <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={strokeColor}
                strokeWidth={strokeWidth}
                strokeDasharray={circumference}
                strokeDashoffset={offset}
                strokeLinecap="round"
                className="transition-all duration-300"
              />
            </svg>
            {/* 中心图标 */}
            <Activity className="w-3 h-3 text-muted-foreground absolute" />
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" align="end" className="p-0">
          <div className="w-56 text-xs">
            <div className="px-3 pt-2.5 pb-1.5 font-medium text-sm">Context usage</div>
            <div className="px-3 py-1.5 flex justify-between font-medium">
              <span>已用</span>
              <span>{hasMax ? `${Math.ceil(percent)}%（${formatTokenCount(used)} / ${formatTokenCount(max)}）` : formatTokenCount(used)}</span>
            </div>
            {/* 累计发送数据对用户无意义且容易造成困惑（与当前上下文差异巨大），不再展示 */}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
