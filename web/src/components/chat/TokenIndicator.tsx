/**
 * 上下文使用率圆环 —— 同时承担「手动压缩」入口。
 *
 * 早先工具栏里是两个相邻控件：只读的圆环 + 一个单独的压缩按钮（Minimize2）。
 * 两者说的是同一件事（上下文满了多少 / 要不要压），分开放既占宽度，
 * 又让用户去猜那个小箭头图标是什么意思。现在合成一个：
 *   · 常态：圆环显示用量，hover 看明细；可压缩时点击即压缩
 *   · 压缩中（手动 / 自动都算）：圆环播放流转动画，禁止点击
 *   · 不可压缩（用量不足 35% / 已超限走顶部横幅）：只读，tooltip 说明原因
 */

import { Activity, Minimize2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatTokenCount } from "./format";

/** 手动压缩门槛：用量未达窗口的这个比例时没有可压的东西（与后端 compactionController 一致） */
const MANUAL_COMPACT_MIN_RATIO = 0.35;

interface TokenIndicatorProps {
  used: number;
  max: number;
  cumulative?: number;
  /** 正在压缩（手动或自动触发）：播放动画并禁止点击 */
  compacting?: boolean;
  /** 压缩中的进度文案（后端下发） */
  compactingMessage?: string | null;
  /** 上下文已超限：此时压缩入口在顶部横幅，这里只读 */
  overflow?: boolean;
  /** 点击压缩。不传则圆环只读 */
  onCompact?: () => void;
}

export function TokenIndicator({ used, max, compacting = false, compactingMessage, overflow = false, onCompact }: TokenIndicatorProps) {
  const hasMax = max > 0;
  const ratio = hasMax ? Math.min(used / max, 1) : 0;
  const percent = ratio * 100;

  // 能不能手动压缩：由用量决定，而不是消息条数（理由见 ChatPanel 旧注释：一个 agent 回合在 UI 上只占 2 条）
  const belowThreshold = hasMax && ratio < MANUAL_COMPACT_MIN_RATIO;
  const canCompact = !!onCompact && !compacting && !overflow && !belowThreshold;

  // 颜色：绿 → 黄 → 红
  const strokeColor = percent < 50 ? "#22c55e" : percent < 80 ? "#eab308" : "#ef4444";

  // SVG 圆环参数。
  // 圆环画 20px、线宽 2，外面套 28px 的点击区（与工具栏其他控件同高）。
  // 早先直接画 28px + 2.5px 线宽：空心大圆在一排 12px 文字里最"重"，视觉上压过了发送按钮。
  const size = 20;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - ratio * circumference;
  // 压缩中的流转弧：固定 1/4 圈，绕圆心匀速旋转
  const arc = circumference * 0.25;

  const compactStatus = compacting
    ? (compactingMessage || "正在压缩上下文…")
    : overflow
      ? "上下文已超限，请使用上方横幅中的压缩按钮"
      : belowThreshold
        ? `用量未达 ${MANUAL_COMPACT_MIN_RATIO * 100}%，暂无需压缩`
        : onCompact
          ? "点击压缩上下文"
          : null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => { if (canCompact) onCompact?.(); }}
            // 用 aria-disabled 而不是 disabled：disabled 的按钮不触发 hover，tooltip（用量明细）就看不到了
            aria-disabled={!canCompact}
            aria-busy={compacting}
            aria-label={compacting ? "正在压缩上下文" : `上下文已用 ${Math.ceil(percent)}%${canCompact ? "，点击压缩" : ""}`}
            className={`group relative inline-flex items-center justify-center h-7 w-7 shrink-0 rounded-md transition-colors ${canCompact ? "cursor-pointer hover:bg-muted/60" : "cursor-default"}`}
          >
            <svg width={size} height={size} className="rotate-[-90deg]" aria-hidden>
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
              {compacting ? (
                /* 压缩中：一段蓝色弧绕圈流转（与用量无关，表达"正在处理"）。
                   不用 primary：本项目的 primary 是近黑/近白，和绿黄红的用量色放在一起像"没加载出来"。 */
                <circle
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  stroke="#3b82f6"
                  strokeWidth={strokeWidth}
                  strokeDasharray={`${arc} ${circumference - arc}`}
                  strokeLinecap="round"
                  className="origin-center animate-spin [animation-duration:1.1s]"
                />
              ) : (
                /* 常态：用量进度 */
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
              )}
            </svg>
            {/* 中心图标：可压缩时 hover 换成压缩图标，提示"这里能点" */}
            {/* 中心图标 10px：圆环内径只有 16px，图标再大就顶到环上 */}
            <Activity
              className={`w-2.5 h-2.5 absolute transition-opacity ${compacting ? "text-blue-500 animate-pulse" : "text-muted-foreground"} ${canCompact ? "group-hover:opacity-0" : ""}`}
            />
            {canCompact && (
              <Minimize2 className="w-2.5 h-2.5 absolute text-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" align="end" className="p-0 border-zinc-700 bg-zinc-900 text-white shadow-xl">
          <div className="w-56 text-xs">
            <div className="px-3 pt-2.5 pb-1.5 font-medium text-sm text-white">Context usage</div>
            <div className="px-3 py-1.5 flex justify-between font-medium text-zinc-200">
              <span>已用</span>
              <span>{hasMax ? `${Math.ceil(percent)}%（${formatTokenCount(used)} / ${formatTokenCount(max)}）` : formatTokenCount(used)}</span>
            </div>
            {compactStatus && (
              <div className={`px-3 pt-1.5 pb-2.5 border-t border-zinc-700/70 ${canCompact ? "text-white" : "text-zinc-400"}`}>
                {compactStatus}
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
