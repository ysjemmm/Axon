/**
 * AxonSpark —— AI 活动指示器（无外框的放射状"神经星芒"）。
 *
 * 两个状态：
 * · animate=true （AI 进行中）：八根辐条依次伸缩，形成绕圈推进的呼吸波
 * · animate=false（终态/空闲）：完全静止的八角星芒，一条动画都不跑
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
 *  · 八根辐条共用**同一个 duration**，只靠负 animation-delay 错相（②的成因）。
 *    同周期 + 相位差 = 波纹推进；不同周期才会产生节拍。这条是本组件的硬约束，别改成各自不同的 dur。
 *  · 终态彻底不挂动画类，DOM 上没有任何 animation 在跑
 */

interface AxonSparkProps {
  /** px，默认 20（assistant 头部用尺寸） */
  size?: number;
  /** 是否播放伸缩动画（AI 活动中） */
  animate?: boolean;
  className?: string;
}

/** 八根辐条的角度，均匀 45°。颜色统一走渐变，不逐根指定——20px 下八种颜色会显脏。 */
const SPOKE_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];

/** 一轮波纹走完的时长（秒）。与 CSS 里的 duration 必须一致，否则相位分布不均。 */
const CYCLE_SECONDS = 1.2;

export function AxonSpark({ size = 20, animate = false, className = "" }: AxonSparkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width={size}
      height={size}
      className={`shrink-0 ${className}`}
      role="img"
      aria-label={animate ? "Axon 正在处理" : "Axon"}
    >
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
            className={animate ? "axon-spark-spoke" : undefined}
            strokeOpacity={animate ? undefined : 0.6}
            // 负延迟让八根辐条在 t=0 就已均匀分布在各自相位上，没有"启动时先排队"的观感
            style={animate ? { animationDelay: `${-(i * CYCLE_SECONDS) / SPOKE_ANGLES.length}s` } : undefined}
          />
        </g>
      ))}

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
