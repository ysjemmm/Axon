/**
 * Axon 品牌 Logo 组件 - 支持静态/动画两种状态
 * 
 * animate=true 时：中心呼吸发光 + 信号点沿轴突流动
 * animate=false 时：静态展示
 * 
 * 小尺寸（≤36px）自动切换为简化版（只有核心 + 脉冲环），避免细节糊掉
 */

interface AxonLogoProps {
  size?: number;       // px，默认 32
  animate?: boolean;   // 是否播放动画
  className?: string;
}

export function AxonLogo({ size = 32, animate = false, className = "" }: AxonLogoProps) {
  // 小尺寸用简化版
  if (size <= 36) {
    return <AxonLogoCompact size={size} animate={animate} className={className} />;
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      fill="none"
      width={size}
      height={size}
      className={`rounded-full shrink-0 ${className}`}
    >
      {/* 背景 */}
      <circle cx="256" cy="256" r="256" fill="#0f172a" />

      {/* 核心发光 */}
      <circle cx="256" cy="256" r="56" fill="url(#axon-core-glow)">
        {animate && (
          <animate attributeName="r" values="56;64;56" dur="2s" repeatCount="indefinite" />
        )}
      </circle>
      <circle cx="256" cy="256" r="32" fill="url(#axon-core-inner)">
        {animate && (
          <animate attributeName="opacity" values="1;0.7;1" dur="2s" repeatCount="indefinite" />
        )}
      </circle>

      {/* 分支 */}
      <path d="M296 216 L350 162 L388 138" stroke="url(#axon-branch-r)" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="388" cy="138" r="14" fill="#38bdf8" />
      <path d="M312 256 L374 252 L412 236" stroke="url(#axon-branch-r)" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="412" cy="236" r="12" fill="#38bdf8" opacity="0.85" />
      <path d="M296 296 L348 348 L380 380" stroke="url(#axon-branch-r)" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="380" cy="380" r="14" fill="#38bdf8" />
      <path d="M216 216 L162 162 L128 136" stroke="url(#axon-branch-l)" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="128" cy="136" r="13" fill="#a78bfa" />
      <path d="M200 256 L138 260 L100 276" stroke="url(#axon-branch-l)" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="100" cy="276" r="12" fill="#a78bfa" opacity="0.85" />
      <path d="M216 296 L164 348 L134 376" stroke="url(#axon-branch-l)" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="134" cy="376" r="13" fill="#a78bfa" />
      <path d="M256 200 L260 140 L272 100" stroke="url(#axon-branch-r)" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="272" cy="100" r="11" fill="#38bdf8" opacity="0.8" />
      <path d="M256 312 L252 372 L240 412" stroke="url(#axon-branch-l)" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="240" cy="412" r="11" fill="#a78bfa" opacity="0.8" />

      {/* 信号脉冲 */}
      {animate ? (
        <>
          <circle r="6" fill="#ffffff" opacity="0.9">
            <animateMotion dur="1.5s" repeatCount="indefinite" path="M296 216 L350 162 L388 138" />
          </circle>
          <circle r="5.5" fill="#ffffff" opacity="0.85">
            <animateMotion dur="1.8s" repeatCount="indefinite" path="M312 256 L374 252 L412 236" />
          </circle>
          <circle r="6" fill="#ffffff" opacity="0.8">
            <animateMotion dur="2s" repeatCount="indefinite" path="M296 296 L348 348 L380 380" />
          </circle>
          <circle r="5.5" fill="#ffffff" opacity="0.85">
            <animateMotion dur="1.6s" repeatCount="indefinite" path="M216 216 L162 162 L128 136" />
          </circle>
          <circle r="5" fill="#ffffff" opacity="0.8">
            <animateMotion dur="1.9s" repeatCount="indefinite" path="M200 256 L138 260 L100 276" />
          </circle>
          <circle r="5.5" fill="#ffffff" opacity="0.85">
            <animateMotion dur="2.1s" repeatCount="indefinite" path="M216 296 L164 348 L134 376" />
          </circle>
        </>
      ) : (
        <>
          <circle cx="330" cy="182" r="6" fill="#ffffff" opacity="0.9" />
          <circle cx="374" cy="252" r="5" fill="#ffffff" opacity="0.7" />
          <circle cx="162" cy="162" r="5.5" fill="#ffffff" opacity="0.8" />
          <circle cx="330" cy="348" r="5" fill="#ffffff" opacity="0.75" />
          <circle cx="164" cy="348" r="5" fill="#ffffff" opacity="0.7" />
        </>
      )}

      <defs>
        <radialGradient id="axon-core-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="70%" stopColor="#4f46e5" stopOpacity="0.6" />
          <stop offset="100%" stopColor="#4f46e5" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="axon-core-inner" cx="40%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="50%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#6366f1" />
        </radialGradient>
        <linearGradient id="axon-branch-r" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#38bdf8" />
        </linearGradient>
        <linearGradient id="axon-branch-l" x1="100%" y1="0%" x2="0%" y2="0%">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** 小尺寸简化版：白底圆形 + 渐变描边 + 极简核心标记，清晰轻盈 */
function AxonLogoCompact({ size, animate, className }: { size: number; animate: boolean; className: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      fill="none"
      width={size}
      height={size}
      className={`shrink-0 ${className}`}
    >
      {/* 外圈渐变描边 */}
      <circle cx="50" cy="50" r="46" stroke="url(#axon-c-ring)" strokeWidth="4" fill="white">
        {animate && (
          <animate attributeName="stroke-width" values="4;6;4" dur="1.8s" repeatCount="indefinite" />
        )}
      </circle>

      {/* 核心圆点 */}
      <circle cx="50" cy="50" r="12" fill="url(#axon-c-core)">
        {animate && (
          <animate attributeName="r" values="12;14;12" dur="1.5s" repeatCount="indefinite" />
        )}
      </circle>

      {/* 三条轴突线（120° 间隔，简洁的分支感） */}
      <line x1="50" y1="38" x2="50" y2="18" stroke="#6366f1" strokeWidth="3" strokeLinecap="round" opacity="0.8" />
      <line x1="60" y1="56" x2="76" y2="72" stroke="#38bdf8" strokeWidth="3" strokeLinecap="round" opacity="0.8" />
      <line x1="40" y1="56" x2="24" y2="72" stroke="#a78bfa" strokeWidth="3" strokeLinecap="round" opacity="0.8" />

      {/* 末端小圆 */}
      <circle cx="50" cy="16" r="4" fill="#6366f1" />
      <circle cx="78" cy="74" r="3.5" fill="#38bdf8" />
      <circle cx="22" cy="74" r="3.5" fill="#a78bfa" />

      <defs>
        <linearGradient id="axon-c-ring" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="50%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#a78bfa" />
        </linearGradient>
        <radialGradient id="axon-c-core" cx="40%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#4f46e5" />
        </radialGradient>
      </defs>
    </svg>
  );
}
