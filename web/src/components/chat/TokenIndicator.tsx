/**
 * 上下文使用率圆环 + 悬停明细面板（ContextUsagePanel）。
 *
 *   · 圆环只负责显示用量；悬停弹出明细面板，手动压缩的唯一入口是面板里的「压缩会话」按钮
 *     （早先点圆环就直接压缩，面板里有了按钮后两个入口并存，点一下圆环看明细却触发了压缩）
 *   · 压缩中（手动 / 自动都算）：圆环播放流转动画，按钮禁用
 *   · 不可压缩（用量不足 35% / 已超限走顶部横幅 / AI 正在回复中）：按钮禁用，面板里写明原因
 */

import { Activity } from "lucide-react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { Tooltip, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextUsagePanel } from "./ContextUsagePanel";
import type { ContextBreakdown } from "./types";

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
  /** AI 正在回复中：此时禁止手动压缩（后端会挡，压缩会破坏正在跑的回合） */
  replying?: boolean;
  /** 点击压缩。不传则圆环只读 */
  onCompact?: () => void;
  /** 占用按来源拆分（悬停面板的明细） */
  breakdown?: ContextBreakdown;
}

export function TokenIndicator({ used, max, compacting = false, compactingMessage, overflow = false, replying = false, onCompact, breakdown }: TokenIndicatorProps) {
  const hasMax = max > 0;
  const ratio = hasMax ? Math.min(used / max, 1) : 0;
  const percent = ratio * 100;

  // 能不能手动压缩：由用量决定，而不是消息条数（理由见 ChatPanel 旧注释：一个 agent 回合在 UI 上只占 2 条）
  const belowThreshold = hasMax && ratio < MANUAL_COMPACT_MIN_RATIO;
  const canCompact = !!onCompact && !compacting && !overflow && !belowThreshold && !replying;

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
        : replying
          ? "AI 正在回复中，回复结束后可压缩上下文"
          : null;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-busy={compacting}
            aria-label={compacting ? "正在压缩上下文" : `上下文已用 ${Math.ceil(percent)}%，悬停查看明细`}
            // Radix tooltip 默认点一下触发器就收起：圆环不再承担点击动作，点它时保持面板打开
            onClick={(e) => e.preventDefault()}
            className="relative inline-flex items-center justify-center h-7 w-7 shrink-0 rounded-md cursor-default transition-colors hover:bg-muted/60"
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
            {/* 中心图标 10px：圆环内径只有 16px，图标再大就顶到环上 */}
            <Activity className={`w-2.5 h-2.5 absolute ${compacting ? "text-blue-500 animate-pulse" : "text-muted-foreground"}`} />
          </button>
        </TooltipTrigger>
        {/* 明细面板：悬停圆环弹出。不用封装好的 TooltipContent：它带深色底和小箭头，
            这里要的是与正文同色系的卡片；面板里有可点的按钮和可展开的列表，Radix 的
            tooltip 默认允许鼠标移进内容区，移进去不会关。 */}
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side="top"
            align="end"
            sideOffset={8}
            collisionPadding={8}
            className="z-50 rounded-xl border border-border bg-popover px-4 py-3.5 text-popover-foreground shadow-lg data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
          >
            <ContextUsagePanel
              used={used}
              max={max}
              breakdown={breakdown}
              canCompact={canCompact}
              compacting={compacting}
              compactStatus={compactStatus}
              onCompact={() => { if (canCompact) onCompact?.(); }}
            />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </Tooltip>
    </TooltipProvider>
  );
}
