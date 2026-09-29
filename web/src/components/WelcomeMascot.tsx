/**
 * WelcomeMascot —— 空会话（新对话）欢迎页的大图吉祥物。
 *
 * ── 为什么另起一个组件，而不是改 AxonLogo ──
 * AxonLogo 是**共享的品牌标识**：除了这里的空态大图，`App.tsx` 的头部（size=14）也在用，
 * AxonSpark.tsx 的注释还把它定义为"应用身份位（空态大图、tab 图标）"。
 * 为了一个页面的观感去改它，会把头部一并改掉。所以这里单开一个只服务空态的组件。
 *
 * ── 造型与"手绘感" ──
 * 图形刻意**不规整**：外圈是两道几乎重叠的抖动描边（手绘的"描两遍"），
 * 八根放射线的角度与长度各自带偏移，笔触粗细分三档、全部圆头笔帽。
 * 这些都靠人眼可辨的"不精确"来传达手绘，而不是靠滤镜。
 *
 * ── 颜色 ──
 * 主线用 `currentColor`，层次靠 opacity（0.9 / 0.55 / 0.3）拉开；
 * 因此**颜色由外层 class 决定**（例如 `text-blue-500 dark:text-blue-400`），
 * 深浅主题都不需要在这里写第二套颜色，也避免了硬编码深色在深色主题下糊掉。
 *
 * ── 动画 ──
 * 纯 CSS keyframes，四个动作都挂在同一个根节点上，互不抢属性：
 *   · 描线   stroke-dashoffset 画入（挂载时一次）
 *   · 浮动   translateY 缓慢起伏（循环）
 *   · 呼吸   整体轻微缩放（循环）
 *   · 闪烁   三个节点错相位明暗（循环）
 * `prefers-reduced-motion: reduce` 时全部关闭，只保留静态成品形态。
 */

interface WelcomeMascotProps {
  /** 渲染边长（px），默认 76 */
  size?: number;
  className?: string;
}

export function WelcomeMascot({ size = 76, className = "" }: WelcomeMascotProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      className={`welcome-mascot ${className}`}
      role="img"
      aria-label="Axon"
    >
      <style>{`
        .welcome-mascot {
          /* 位移/缩放分开写：两个动画共用 transform 会互相覆盖 */
          animation: welcome-float 6s ease-in-out infinite;
          transform-origin: 60px 60px;
        }
        .welcome-mascot .wm-core {
          animation: welcome-breathe 4.5s ease-in-out infinite;
          transform-origin: 60px 60px;
        }
        /* 描线：dasharray 取大于周长值，offset 从满到零 */
        .welcome-mascot .wm-ink {
          stroke-dasharray: 240;
          animation: welcome-draw 0.95s cubic-bezier(0.22, 0.61, 0.36, 1) both;
        }
        .welcome-mascot .wm-ink-2 { animation-delay: 0.12s; }
        .welcome-mascot .wm-ray { animation: welcome-draw 0.7s ease-out both; }
        .welcome-mascot .wm-ray:nth-of-type(2) { animation-delay: 0.06s; }
        .welcome-mascot .wm-ray:nth-of-type(3) { animation-delay: 0.12s; }
        .welcome-mascot .wm-ray:nth-of-type(4) { animation-delay: 0.18s; }
        .welcome-mascot .wm-ray:nth-of-type(5) { animation-delay: 0.24s; }
        .welcome-mascot .wm-ray:nth-of-type(6) { animation-delay: 0.3s; }
        .welcome-mascot .wm-ray:nth-of-type(7) { animation-delay: 0.36s; }
        .welcome-mascot .wm-ray:nth-of-type(8) { animation-delay: 0.42s; }
        .welcome-mascot .wm-node {
          animation: welcome-twinkle 2.6s ease-in-out infinite;
          transform-origin: 60px 60px;
        }
        .welcome-mascot .wm-node-2 { animation-delay: 0.9s; }
        .welcome-mascot .wm-node-3 { animation-delay: 1.7s; }

        @keyframes welcome-float {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-3px); }
        }
        @keyframes welcome-breathe {
          0%, 100% { transform: scale(1); }
          50%      { transform: scale(1.035); }
        }
        @keyframes welcome-draw {
          from { stroke-dashoffset: 240; }
          to   { stroke-dashoffset: 0; }
        }
        @keyframes welcome-twinkle {
          0%, 100% { opacity: 0.28; }
          50%      { opacity: 1; }
        }

        @media (prefers-reduced-motion: reduce) {
          .welcome-mascot,
          .welcome-mascot .wm-core,
          .welcome-mascot .wm-ink,
          .welcome-mascot .wm-ray,
          .welcome-mascot .wm-node {
            animation: none;
          }
          /* 关掉动画后 dashoffset 会停在初始态（线是空的）——必须显式归位 */
          .welcome-mascot .wm-ink,
          .welcome-mascot .wm-ray { stroke-dashoffset: 0; }
          .welcome-mascot .wm-node { opacity: 0.7; }
        }
      `}</style>

      {/* ── 外圈：两道几乎重叠的抖动描边（手绘"描两遍"的痕迹）── */}
      <g className="wm-core" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path
          className="wm-ink"
          d="M60 24.5 C77.5 25.8 95.6 40.9 95.2 60.4 C95 78.8 79.1 95.4 59.6 95.1 C41.7 94.9 24.4 78.6 25.1 59.2 C25.7 42.1 41.3 25.1 60 24.5"
          strokeWidth={2.1}
          opacity={0.9}
        />
        <path
          className="wm-ink wm-ink-2"
          d="M60.6 25.4 C77 26.9 94.5 41.7 94.1 60 C93.9 77.5 78.6 94.2 60.3 93.9 C43.2 93.7 26.1 78.2 26.7 59.9 C27.2 43.4 42.5 25.9 60.6 25.4"
          strokeWidth={1.3}
          opacity={0.3}
        />
      </g>

      {/* ── 八根放射线：角度/长度各自带偏移，粗细分三档 ── */}
      <g stroke="currentColor" strokeLinecap="round" fill="none">
        <path className="wm-ray" d="M60 17.5 L59.2 7.8"  strokeWidth={2.3} opacity={0.85} />
        <path className="wm-ray" d="M85.8 34.6 L93.4 27.4" strokeWidth={1.6} opacity={0.45} />
        <path className="wm-ray" d="M102 60.7 L111.6 61.5" strokeWidth={2.1} opacity={0.75} />
        <path className="wm-ray" d="M85.2 85.5 L92.4 93.2" strokeWidth={1.5} opacity={0.4} />
        <path className="wm-ray" d="M59.4 102.4 L60.2 111.7" strokeWidth={2.2} opacity={0.8} />
        <path className="wm-ray" d="M34.1 85.9 L27.2 93.1"  strokeWidth={1.6} opacity={0.45} />
        <path className="wm-ray" d="M17.9 59.6 L8.6 58.9"   strokeWidth={2}   opacity={0.7} />
        <path className="wm-ray" d="M34.8 34.2 L27.9 27.1"  strokeWidth={1.5} opacity={0.4} />
      </g>

      {/* ── 中心：实心核 + 一圈留白（手绘的"点一下"）── */}
      <g className="wm-core">
        <circle cx="60" cy="60" r="11.5" fill="currentColor" opacity={0.16} />
        <circle cx="60" cy="60" r="5.4"  fill="currentColor" opacity={0.92} />
        {/* 核上偏一点的小高光，让实心块不像机械圆 */}
        <circle cx="58.2" cy="58.1" r="1.5" fill="currentColor" opacity={0.5} />
      </g>

      {/* ── 三个节点：错相位明暗 ── */}
      <g fill="currentColor">
        <circle className="wm-node" cx="60" cy="8.6" r="2.9" opacity={0.9} />
        <circle className="wm-node wm-node-2" cx="111" cy="61.1" r="2.3" opacity={0.9} />
        <circle className="wm-node wm-node-3" cx="27.5" cy="92.6" r="2" opacity={0.9} />
      </g>
    </svg>
  );
}
