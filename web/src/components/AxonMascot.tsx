/**
 * AxonMascot —— 趴在输入框上沿的品牌吉祥物「Axo」。
 *
 * 造型刻意长在既有品牌语言上，而不是另贴一只卡通角色：
 * 身体 = AxonLogo 的「发光核心」，头顶三根触须 = logo 的轴突分支（同样的 indigo/cyan/violet
 * 三色与角度），所以它和 logo、AxonSpark 是同一个世界观里的东西。
 *
 * ── 表情由 mood 驱动 ──
 *   idle      空闲：轻轻上下浮动 + 偶尔眨眼
 *   focused   输入框获得焦点：坐直凑近（微微放大），嘴张成小圆
 *   typing    正在打字：触须快速摆动，瞳孔下移看着文字
 *   deleting  正在删除：眯眼后仰躲一下
 *   thinking  AI 正在干活：触须末端依次点亮（信号流动），眼睛向上想事情
 *   sleeping  长时间无操作：闭眼、呼吸变慢，飘出一个 Z
 *
 * ── 动画纪律（这些约束是踩过坑之后定下的，别放宽）──
 *  · 绝不 animate stroke-width：小尺寸下它落进次像素区间，描边抗锯齿覆盖率在相邻像素间
 *    跳档，看起来是"抖/闪"而不是平滑变化。
 *  · 同一组里的多个元素若要错相，必须**共用同一个 duration**、只用 animation-delay 错开
 *    （见三根触须的依次点亮）。周期不同才会叠出节拍（beat），表现为"隔一段时间一起闪一下"。
 *  · 每个 mood 下同时运行的动画尽量作用在不同元素、不同属性上（浮动是整体 translate，
 *    眨眼是眼睛 scaleY），避免同一小块区域出现多重明暗振荡。
 */

export type MascotMood = "idle" | "focused" | "typing" | "deleting" | "thinking" | "sleeping";

interface MoodLook {
  /** 整体（身体 + 触须 + 五官）的姿态动画类 */
  bodyClass: string;
  /** 触须组的动画类 */
  antennaClass: string;
  /** 眼睛组的动画类 */
  eyeClass: string;
  /** 瞳孔偏移：>0 向下看（看输入的文字），<0 向上看（想事情） */
  pupilDx: number;
  pupilDy: number;
  /** 闭眼（睡觉时画眼皮弧线而不是眼珠） */
  eyesShut: boolean;
  /** 触须末端依次点亮（"信号流动"，只在 thinking 用） */
  sparkle: boolean;
  mouth: "smile" | "flat" | "o";
}

const LOOKS: Record<MascotMood, MoodLook> = {
  idle: {
    bodyClass: "axon-mascot-bob", antennaClass: "", eyeClass: "axon-mascot-blink",
    pupilDx: 0, pupilDy: 0, eyesShut: false, sparkle: false, mouth: "smile",
  },
  focused: {
    bodyClass: "axon-mascot-perk", antennaClass: "", eyeClass: "axon-mascot-blink",
    pupilDx: 0, pupilDy: 0.5, eyesShut: false, sparkle: false, mouth: "o",
  },
  typing: {
    bodyClass: "", antennaClass: "axon-mascot-wiggle", eyeClass: "",
    pupilDx: 0, pupilDy: 1.1, eyesShut: false, sparkle: false, mouth: "smile",
  },
  deleting: {
    bodyClass: "axon-mascot-lean", antennaClass: "", eyeClass: "axon-mascot-squint",
    pupilDx: -0.8, pupilDy: 0.6, eyesShut: false, sparkle: false, mouth: "flat",
  },
  thinking: {
    bodyClass: "axon-mascot-bob", antennaClass: "", eyeClass: "",
    pupilDx: 0, pupilDy: -0.7, eyesShut: false, sparkle: true, mouth: "o",
  },
  sleeping: {
    bodyClass: "axon-mascot-sleep", antennaClass: "", eyeClass: "",
    pupilDx: 0, pupilDy: 0, eyesShut: true, sparkle: false, mouth: "flat",
  },
};

/**
 * 三根触须：角度与配色照搬 AxonLogo 的分支（左 violet / 上 cyan / 右 indigo）。
 * delay 为负值，让 thinking 时三点在 t=0 就已分布在各自相位上，不会先排队再开始。
 */
const ANTENNAE = [
  { x: 13, y: 6, color: "#a78bfa", delay: "-0.70s" },
  { x: 20, y: 3.5, color: "#38bdf8", delay: "-0.35s" },
  { x: 27, y: 6, color: "#6366f1", delay: "0s" },
];

/** 眼睛中心（供 CSS transform-origin 对齐，改这里也要同步 index.css 里的 20px 23px） */
const EYE_Y = 23;

interface AxonMascotProps {
  mood: MascotMood;
  /** px，默认 26 */
  size?: number;
  className?: string;
}

export function AxonMascot({ mood, size = 26, className = "" }: AxonMascotProps) {
  const look = LOOKS[mood];

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 40 40"
      width={size}
      height={size}
      fill="none"
      className={`overflow-visible ${className}`}
      // 纯装饰元素：不进无障碍树，也不吃鼠标事件（它悬在输入框上沿，不能挡住点击）
      aria-hidden="true"
      focusable="false"
    >
      <g className={look.bodyClass}>
        <g className={look.antennaClass}>
          {ANTENNAE.map((a) => (
            <g key={a.x} className={look.sparkle ? "axon-mascot-spark" : undefined} style={look.sparkle ? { animationDelay: a.delay } : undefined}>
              <line x1="20" y1="14" x2={a.x} y2={a.y} stroke={a.color} strokeWidth="1.7" strokeLinecap="round" opacity="0.85" />
              <circle cx={a.x} cy={a.y} r="2.1" fill={a.color} />
            </g>
          ))}
        </g>

        {/* 身体：与 logo 同一套核心渐变 */}
        <circle cx="20" cy="25" r="12" fill="url(#axon-mascot-body)" />

        <g className={look.eyeClass}>
          {look.eyesShut ? (
            <>
              <path d="M12.6 23.2 Q15.6 25.6 18.6 23.2" stroke="#eef2ff" strokeWidth="1.5" strokeLinecap="round" fill="none" />
              <path d="M21.4 23.2 Q24.4 25.6 27.4 23.2" stroke="#eef2ff" strokeWidth="1.5" strokeLinecap="round" fill="none" />
            </>
          ) : (
            <>
              <circle cx="15.6" cy={EYE_Y} r="3.3" fill="#f8fafc" />
              <circle cx="24.4" cy={EYE_Y} r="3.3" fill="#f8fafc" />
              <circle cx={15.6 + look.pupilDx} cy={EYE_Y + look.pupilDy} r="1.65" fill="#1e1b4b" />
              <circle cx={24.4 + look.pupilDx} cy={EYE_Y + look.pupilDy} r="1.65" fill="#1e1b4b" />
              {/* 高光小点：让眼睛显得湿润有神，位置固定不随瞳孔走 */}
              <circle cx="16.5" cy={EYE_Y - 1.1} r="0.6" fill="#ffffff" opacity="0.9" />
              <circle cx="25.3" cy={EYE_Y - 1.1} r="0.6" fill="#ffffff" opacity="0.9" />
            </>
          )}
        </g>

        {look.mouth === "smile" && (
          <path d="M17 29.2 Q20 31.4 23 29.2" stroke="#e0e7ff" strokeWidth="1.3" strokeLinecap="round" fill="none" opacity="0.95" />
        )}
        {look.mouth === "flat" && (
          <path d="M17.7 29.8 H22.3" stroke="#e0e7ff" strokeWidth="1.3" strokeLinecap="round" opacity="0.8" />
        )}
        {look.mouth === "o" && (
          <circle cx="20" cy="29.6" r="1.35" fill="#1e1b4b" opacity="0.55" />
        )}
      </g>

      {mood === "sleeping" && (
        <text
          x="29"
          y="12"
          className="axon-mascot-zzz"
          fill="#6366f1"
          fontSize="9"
          fontWeight="700"
          fontFamily="inherit"
        >
          z
        </text>
      )}

      <defs>
        <radialGradient id="axon-mascot-body" cx="38%" cy="32%" r="72%">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="55%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#4f46e5" />
        </radialGradient>
      </defs>
    </svg>
  );
}
