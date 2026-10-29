/**
 * AxonSpark —— AI 活动指示器（无外框的放射状"神经星芒"）。
 *
 * · animate=true （AI 进行中）：按状态播放不同动作（见下方 SparkMode）
 * · animate=false（终态/空闲）：静止的八角星芒，不跑任何动画
 *
 * 与 AxonLogo 的分工：
 * · AxonLogo  = 品牌标识（带圆形底/描边），用于应用身份位（空态大图、tab 图标）
 * · AxonSpark = 活动指示器（无框），用于 assistant 回复头部
 *
 * ── 一套连续的动作，而不是五段各自独立的动画 ──
 * 早先每个状态是一组独立的 CSS 关键帧，切换时旧动画被掐断、新动画从第 0 帧开始，
 * 再用一次「缩一下弹回来」把跳变盖住——看得出是两段动画硬接在一起。
 *
 * 现在所有状态共用同一台时钟和同一个辐条公式，状态只是一组参数（波纹速度、转速、波形、幅度、收缩）：
 *   · 时钟（相位、整体角度）只累加、从不归零 → 切换时没有任何一根辐条跳位
 *   · 参数按指数缓动滑向新状态 → 动作是「变形」过去的：转得慢下来、波纹变宽、亮点散开成呼吸
 *   · 结束时同样滑向静止：转动减速并停在最近的 45° 上，辐条舒展到全长
 *
 * ── 仍然遵守的约束 ──
 *  · 只动辐条长度（沿描边轴向缩放）和不透明度，绝不动 stroke-width：20px 下描边宽度落进次像素区间会抖
 *  · 每帧直接改 SVG 属性，不触发 React 渲染；静止下来就停掉 requestAnimationFrame
 *  · 系统开了「减少动态效果」时不跑动画，只显示静止星芒
 */

import { createContext, useContext, useEffect, useRef } from "react";

/**
 * 活动中的几种状态：
 * · think   思考：整颗慢转，一道宽波纹绕圈推进——「在琢磨」
 * · write   输出正文：相邻辐条此起彼伏，节奏轻快——「在落笔」
 * · tool    执行工具：一个亮点带着拖尾绕圈追逐，转得更快——「在干活」
 * · wait    等用户（确认 / 作答）：停转，所有辐条同步慢呼吸——「停下来等你」
 * · compact 压缩上下文：整颗向中心收拢再舒展——「在挤压」
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

/**
 * 一个状态 = 一组参数。所有参数都是连续量，状态之间逐帧插值。
 * 波形由三种成分按权重混合（权重同样插值，切换时一种波形淡出、另一种淡入）：
 *   travel 绕圈推进的亮区（sharp 越大亮区越窄，像追逐的光点）
 *   ripple 相邻辐条交替（四个波峰，此起彼伏）
 *   pulse  所有辐条同步（呼吸）
 */
interface Params {
  /** 波纹速度（圈 / 秒） */
  speed: number;
  /** 整体转速（度 / 秒） */
  spin: number;
  travel: number;
  ripple: number;
  pulse: number;
  /** travel 亮区的锐度 */
  sharp: number;
  /** 辐条随波形缩短 / 变淡的幅度（0 = 不动） */
  amp: number;
  /** 整颗随 pulse 向中心收拢的幅度 */
  squeeze: number;
  /** 辐条最暗 / 最亮时的不透明度（静止时两者相等，星芒均匀地略淡） */
  floor: number;
  peak: number;
}

const MODES: Record<SparkMode | "idle", Params> = {
  think: { speed: 0.62, spin: 38, travel: 1, ripple: 0, pulse: 0, sharp: 1.6, amp: 0.58, squeeze: 0, floor: 0.32, peak: 1 },
  write: { speed: 1.05, spin: 16, travel: 0, ripple: 1, pulse: 0, sharp: 1.6, amp: 0.5, squeeze: 0, floor: 0.38, peak: 1 },
  tool: { speed: 1.05, spin: 70, travel: 1, ripple: 0, pulse: 0, sharp: 5, amp: 0.42, squeeze: 0, floor: 0.2, peak: 1 },
  wait: { speed: 0.42, spin: 0, travel: 0, ripple: 0, pulse: 1, sharp: 1.6, amp: 0.3, squeeze: 0, floor: 0.5, peak: 1 },
  compact: { speed: 0.7, spin: 0, travel: 0, ripple: 0, pulse: 1, sharp: 1.6, amp: 0.16, squeeze: 0.36, floor: 0.6, peak: 1 },
  idle: { speed: 0, spin: 0, travel: 0, ripple: 0, pulse: 0, sharp: 1.6, amp: 0, squeeze: 0, floor: 0.6, peak: 0.6 },
};

const KEYS = Object.keys(MODES.idle) as (keyof Params)[];

/** 参数缓动的时间常数（秒）：约 0.35 秒内完成过渡的大部分 */
const EASE_TAU = 0.16;

const TAU = Math.PI * 2;

/** 辐条内端（靠中心那头）：长度缩放的原点，所以是从中心朝外生长 */
const RAY_ORIGIN_Y = 7.5;

function reducedMotion(): boolean {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

export function AxonSpark({ size = 20, animate = false, mode, className = "" }: AxonSparkProps) {
  const liveMode = useContext(LiveSparkModeContext);
  const target: SparkMode | "idle" = animate ? (mode ?? liveMode) : "idle";

  const bodyRef = useRef<SVGGElement>(null);
  const rayRefs = useRef<(SVGLineElement | null)[]>([]);
  /** 动画状态跨渲染保留：时钟只累加，参数只缓动 */
  const sim = useRef({ cur: { ...MODES.idle }, phase: 0, angle: 0, raf: 0, last: 0 });
  const targetRef = useRef(target);

  useEffect(() => {
    targetRef.current = target;
    const s = sim.current;
    if (s.raf || (target === "idle" && s.cur.amp < 0.001 && s.cur.squeeze < 0.001)) return;
    if (reducedMotion()) return;

    const frame = (now: number) => {
      const dt = s.last ? Math.min(0.05, (now - s.last) / 1000) : 1 / 60;
      s.last = now;
      const goal = MODES[targetRef.current];
      const k = 1 - Math.exp(-dt / EASE_TAU);
      for (const key of KEYS) s.cur[key] += (goal[key] - s.cur[key]) * k;
      const p = s.cur;

      s.phase = (s.phase + TAU * p.speed * dt) % (TAU * 1000);
      s.angle = (s.angle + p.spin * dt) % 360;
      // 停转时滑到最近的 45°：静止的星芒总是端正的
      if (targetRef.current === "idle" || goal.spin === 0) {
        const snap = Math.round(s.angle / 45) * 45;
        s.angle += (snap - s.angle) * k;
      }

      const pulseWave = (1 + Math.cos(s.phase)) / 2;
      const weightSum = p.travel + p.ripple + p.pulse || 1;
      SPOKE_ANGLES.forEach((deg, i) => {
        const theta = (deg * Math.PI) / 180;
        const travel = Math.pow((1 + Math.cos(s.phase - theta)) / 2, p.sharp);
        const ripple = (1 + Math.cos(s.phase * 1.5 - 4 * theta)) / 2;
        const b = (p.travel * travel + p.ripple * ripple + p.pulse * pulseWave) / weightSum;
        const len = 1 - p.amp * (1 - b);
        const opacity = p.floor + (p.peak - p.floor) * b;
        const ray = rayRefs.current[i];
        if (ray) {
          ray.setAttribute("transform", `translate(0 ${RAY_ORIGIN_Y}) scale(1 ${len.toFixed(4)}) translate(0 ${-RAY_ORIGIN_Y})`);
          ray.setAttribute("stroke-opacity", opacity.toFixed(3));
        }
      });
      const scale = 1 - p.squeeze * pulseWave;
      bodyRef.current?.setAttribute("transform", `rotate(${s.angle.toFixed(3)} 12 12) translate(12 12) scale(${scale.toFixed(4)}) translate(-12 -12)`);

      // 回到静止且参数已经落定：停帧，DOM 上留下静止星芒
      const settled = targetRef.current === "idle" && p.amp < 0.002 && p.squeeze < 0.002 && Math.abs(p.peak - p.floor) < 0.002 && Math.abs(Math.round(s.angle / 45) * 45 - s.angle) < 0.05;
      if (settled) {
        s.raf = 0;
        s.last = 0;
        return;
      }
      s.raf = requestAnimationFrame(frame);
    };
    s.raf = requestAnimationFrame(frame);
  }, [target]);

  // 卸载时停帧
  useEffect(() => () => { if (sim.current.raf) cancelAnimationFrame(sim.current.raf); }, []);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      width={size}
      height={size}
      className={`shrink-0 axon-spark ${className}`}
      role="img"
      aria-label={animate ? "Axon 正在处理" : "Axon"}
    >
      <g ref={bodyRef}>
        {SPOKE_ANGLES.map((angle, i) => (
          // 旋转放在外层 <g>，长度缩放放在 <line> 自己的 transform 上（以辐条内端为原点）
          <g key={angle} transform={`rotate(${angle} 12 12)`}>
            <line
              ref={(el) => { rayRefs.current[i] = el; }}
              x1="12"
              y1="7.5"
              x2="12"
              y2="1.9"
              stroke="url(#axon-spark-grad)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeOpacity={0.6}
            />
          </g>
        ))}
      </g>

      <defs>
        {/* 对角渐变：userSpace 渐变稳定铺在固定方位上，不会随辐条游走 */}
        <linearGradient id="axon-spark-grad" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="50%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
    </svg>
  );
}
