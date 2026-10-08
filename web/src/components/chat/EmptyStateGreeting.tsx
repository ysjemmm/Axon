/**
 * EmptyStateGreeting —— 新会话空态的问候语 + 快捷提示词
 *
 * 取代原先那句固定的「Axon / 读写代码、执行命令…」自我介绍：对天天用的人来说，
 * 每开一个新会话都被介绍一遍产品是什么，纯属噪音。换成按时段问候 + 一行可点的
 * 提示词入口，空态从「说明书」变成「起点」。
 *
 * 两块内容：
 * · 问候行：星芒动画 + 「上午好/下午好/晚上好」。星芒是本文件内的 AxonBloom（为大尺寸
 *   重排几何的版本，见其注释），配色走品牌渐变，是这一屏唯一的动态元素。
 * · 提示词块：仅 quest（Chat）模式出现。点击把预置文案填进输入框，不直接发送——
 *   用户几乎总要在模板上补一句自己的上下文，直接发出去反而多一轮废话。
 */

import { Code2, GraduationCap, Palette, PenLine, Coffee, FolderPlus } from "lucide-react";

/**
 * 空态星芒的辐条角度：10 根、每 36°。
 * 根数刻意不多：12 根以上在 32px 下相邻辐条的端点几乎相接，放射状会糊成一个圆环。
 */
const BLOOM_ANGLES = Array.from({ length: 10 }, (_, i) => i * 36);

/** 一轮呼吸的时长（秒）。与 CSS 的 .axon-bloom-ray duration 必须一致，否则相位分布不均。 */
const BLOOM_CYCLE_SECONDS = 3.4;

/**
 * 空态专用的舒展星芒。
 *
 * 为什么不直接放大 AxonSpark：那个组件的辐条只占 viewBox 的 y=1.9~7.5，是为 20px
 * 图标位设计的紧凑比例——中心留白小、辐条短。等比放大到 30px 只会得到一团糊在一起的
 * 短线，看不出放射状。这里重新排布几何：中心留一个小空洞，辐条更长更细，12 根。
 *
 * 动画约束与 AxonSpark 一致（那套约束是踩过闪烁坑换来的，见其文件头）：
 * 只动 scaleY + opacity，绝不动 stroke-width；所有辐条共用同一个 duration，
 * 靠负 delay 错相形成绕圈推进的波纹。
 */
function AxonBloom({ size = 30 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 40 40"
      fill="none"
      width={size}
      height={size}
      className="shrink-0"
      role="img"
      aria-label="Axon"
    >
      {BLOOM_ANGLES.map((angle, i) => (
        // 旋转在外层 <g> 的 SVG transform，伸缩在内层 <line> 的 CSS transform。
        // 分两层是必须的：CSS transform 会覆盖同元素的 SVG transform 属性。
        <g key={angle} transform={`rotate(${angle} 20 20)`}>
          {/* 辐条占半径的绝大部分（y 6→19，中心只留 1 单位空洞），细描边。
              这个比例才是"放射星芒"；辐条短、空洞大会看成一个带毛边的圆环。 */}
          <line
            x1="20"
            y1="19"
            x2="20"
            y2="6"
            stroke="url(#axon-bloom-grad)"
            strokeWidth="1.7"
            strokeLinecap="round"
            className="axon-bloom-ray"
            style={{ animationDelay: `${-(i * BLOOM_CYCLE_SECONDS) / BLOOM_ANGLES.length}s` }}
          />
        </g>
      ))}

      <defs>
        {/* 品牌渐变：靛蓝 → 天蓝 → 紫，与 AxonSpark / AxonLogo 同一套色值。
            userSpace 渐变稳定铺在固定方位上，辐条做 scaleY 时不会让颜色跟着游走。 */}
        <linearGradient id="axon-bloom-grad" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="50%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** 快捷提示词：图标 + 标签 + 点击后填入输入框的文案 */
interface PromptChip {
  id: string;
  label: string;
  icon: typeof Code2;
  /** 填进输入框的起手文案。刻意留白让用户接着写，不做成完整问题。 */
  prompt: string;
}

/**
 * Chat（quest）模式的提示词分类。
 * 对齐 Claude 的五类（Code/Learn/Create/Write/Life stuff），但文案按 Axon 的定位
 * 调整——Axon 的 Chat 模式是「不碰代码的答疑」，所以 Code 类问的是分析与方案，
 * 不是「帮我写」。
 */
const QUEST_CHIPS: PromptChip[] = [
  { id: "code", label: "代码", icon: Code2, prompt: "帮我分析这段代码的实现思路：\n" },
  { id: "learn", label: "学习", icon: GraduationCap, prompt: "用通俗的方式讲清楚这个概念：" },
  { id: "create", label: "构思", icon: Palette, prompt: "我想做一个这样的东西，帮我理一下方案：" },
  { id: "write", label: "写作", icon: PenLine, prompt: "帮我把这段内容写得更清楚：\n" },
  { id: "life", label: "随便聊", icon: Coffee, prompt: "" },
];

/** Agent（code）模式的提示词。Agent 能动文件跑命令，入口按「任务」组织。 */
const AGENT_CHIPS: PromptChip[] = [
  { id: "explain", label: "读懂项目", icon: FolderPlus, prompt: "先熟悉一下这个项目的结构和技术栈，给我一个概览" },
  { id: "bug", label: "修 bug", icon: Code2, prompt: "这里有个问题需要排查：\n" },
  { id: "feature", label: "加功能", icon: PenLine, prompt: "帮我实现这个功能：\n" },
];

/** 按本地时间返回问候语。分段沿用中文日常习惯，不做「凌晨」这类过细切分。 */
function greetingFor(hour: number): string {
  if (hour < 6) return "夜深了";
  if (hour < 12) return "上午好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

interface EmptyStateGreetingProps {
  mode: "agent" | "quest";
  /** 点击提示词块：把文案填进输入框（不发送） */
  onPickPrompt: (prompt: string) => void;
}

export function EmptyStateGreeting({ mode, onPickPrompt }: EmptyStateGreetingProps) {
  const chips = mode === "quest" ? QUEST_CHIPS : AGENT_CHIPS;

  return (
    <div className="px-3 pb-6">
      {/* 问候行：星芒与文字同基线，星芒略大于字号，视觉重量才压得住 */}
      <div className="flex items-center justify-center gap-2">
        <AxonBloom size={32} />
        <h1 className="text-[27px] leading-tight font-normal tracking-tight text-foreground">
          {greetingFor(new Date().getHours())}
        </h1>
      </div>

      {/* 提示词块：横向排布、自动换行，窄面板下会自然折成多行 */}
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {chips.map((chip) => {
          const Icon = chip.icon;
          return (
            <button
              key={chip.id}
              onClick={() => onPickPrompt(chip.prompt)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border/80 hover:bg-muted/50 hover:text-foreground"
            >
              <Icon className="w-3.5 h-3.5" />
              {chip.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
