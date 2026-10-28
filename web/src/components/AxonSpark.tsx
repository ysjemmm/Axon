/**
 * AxonSpark —— AI 活动指示器（无外框的放射状"神经星芒"）。
 *
 * · animate=true （AI 进行中）：按状态播放不同动作（见下方 SparkMode）
 * · animate=false（终态/空闲）：静止的八角星芒，一条循环动画都不跑
 *
 * 与 AxonLogo 的分工：
 * · AxonLogo  = 品牌标识（带圆形底/描边），用于应用身份位（空态大图、tab 图标）
 * · AxonSpark = 活动指示器（无框），用于 assistant 回复头部
 *
 * ── 为什么另起一个组件，而不是改 AxonLogo ──
 * 旧的 AxonLogoCompact 在 22px 下有肉眼可见的周期性闪烁，成因是三条独立动画叠加：
 *   · 外圈 stroke-width 4→6→4    dur=1.8s
 *   · 核心 r 12→14→12            dur=1.5s
 *   · 头部状态文字 animate-pulse  dur=2s（Tailwind）
 * 两个独立问题：
 *  ① stroke-width 动画在小尺寸下落进**次像素**区间。viewBox 100 单位、显示 22px，缩放比 0.22，
 *    stroke 4→6 实际只有 0.88px→1.32px。描边边缘的抗锯齿覆盖率在相邻像素间反复跳档，
 *    表现为"抖/闪"而非平滑呼吸——这是真闪烁，不是观感问题。
 *  ② 1.5s / 1.8s / 2s 三个互质周期叠加产生**节拍**（beat）：要到 9s 才重新对齐，
 *    中途持续错相，于是"隔一段时间闪一下"，正是用户描述的现象。
 *
 * ── 本组件如何避免重蹈覆辙 ──
 *  · 只动 scaleY + opacity，**绝不动 stroke-width**（①的成因）
 *  · 同一状态下八根辐条共用**同一个 duration**，只靠负 animation-delay 错相（②的成因）。
 *    同周期 + 相位差 = 波纹推进；不同周期才会产生节拍。这条是本组件的硬约束，别改成各自不同的 dur。
 *  · 终态彻底不挂动画类，DOM 上没有任何 animation 在跑
 */

import { createContext, useContext, useEffect, useRef, useState } from "react";

/**
 * 活动中的几种状态，各有一套动作（关键帧见 index.css 的 .axon-spark--*）：
 * · think   思考：整颗星芒慢转，辐条上一道波纹绕圈推进——「在琢磨」
 * · write   输出正文：奇偶辐条交替闪烁，节奏轻快——「在落笔」
 * · tool    执行工具：一根亮辐条带着拖尾绕圈追逐——「在干活」
 * · wait    等用户（确认 / 作答）：所有辐条同步慢呼吸——「停下来等你」
 * · compact 压缩上下文：辐条整体向中心收拢再舒展——「在挤压」
 * 状态切换时整颗星芒做一次回弹形变（axon-spark-morph），把两套动作的相位差盖住，
 * 看起来是有意的变身，而不是动画突然跳帧。动画结束（animate=false）时同样回弹一次再静止。
 */
export type SparkMode = "think" | "write" | "tool" | "wait" | "compact";

/** 当前这一轮的状态（ChatPanel 提供）：只有流式中的那条回复头部会读它，免得把它层层透传过消息列表 */
export const LiveSparkModeContext = createContext<SparkMode>("think");

interface AxonSparkProps {
  /** px，默认 20（assistant 头部用尺寸） */
  size?: number;
  /** 是否播放动画（AI 活动中） */
  animate?: boolean;
  /** 活动中的状态；不传时读 LiveSparkModeContext */
  mode?: SparkMode;
  className?: string;
}

/** 八根辐条的角度，均匀 45°。颜色统一走渐变，不逐根指定——20px 下八种颜色会显脏。 */
const SPOKE_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];

export function AxonSpark({ size = 20, animate = false, mode, className = "" }: AxonSparkProps) {
  const liveMode = useContext(LiveSparkModeContext);
  const state = animate ? (mode ?? liveMode) : "idle";

  // 只在挂载后状态真的变了才回弹：历史消息一挂载就是 idle，不该每条都弹一下
  const [morphKey, setMorphKey] = useState(0);
  const prevState = useRef(state);
  useEffect(() => {
    if (prevState.current === state) return;
    prevState.current = state;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 状态变化触发一次性过场
    setMorphKey((k) => k + 1);
  }, [state]);

  return (
    <svg
      key={morphKey}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width={size}
      height={size}
      className={`shrink-0 axon-spark axon-spark--${state} ${morphKey > 0 ? "axon-spark-morph" : ""} ${className}`}
      role="img"
      aria-label={animate ? "Axon 正在处理" : "Axon"}
    >
      <g className="axon-spark-body">
        {SPOKE_ANGLES.map((angle, i) => (
          // 旋转放在外层 <g> 的 SVG transform 属性上，伸缩放在内层 <line> 的 CSS transform 上。
          // 必须分两层：CSS transform 会整体覆盖同元素的 SVG transform 属性，写一层会把旋转丢掉。
          <g key={angle} transform={`rotate(${angle} 12 12)`}>
            <line
              x1="12"
              y1="7.5"
              x2="12"
              y2="1.9"
              stroke="url(#axon-spark-grad)"
              strokeWidth="2.5"
              strokeLinecap="round"
              className="axon-spark-ray"
              // 相位按序号错开：各状态的 CSS 用 --i 算负 delay（同一状态内所有辐条同周期，不产生节拍）
              style={{ ["--i" as string]: i }}
            />
          </g>
        ))}
      </g>

      <defs>
        {/* 对角渐变：辐条不旋转，userSpace 渐变因此稳定铺在固定方位上，不会随动画游走 */}
        <linearGradient id="axon-spark-grad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="50%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
    </svg>
  );
}
