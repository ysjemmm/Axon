/**
 * AxonSpark —— AI 活动指示器：一颗渐变圆点，外加一道细细的环形弧线。
 *
 * · animate=true （AI 进行中）：圆点轻轻呼吸，弧线绕着它转（各状态的快慢、弧长不同）
 * · animate=false（终态/空闲）：只剩一颗静止的圆点
 *
 * 动作只有两个元素、三种变化（圆点大小、圆点亮度、弧线转动），状态之间不换动画，
 * 只把这几个量逐帧缓动到新值：转得快一点 / 慢一点、弧线变长 / 变短、呼吸变快 / 变慢。
 * 时钟（呼吸相位、弧线角度）只累加不归零，所以任何时刻切换状态都不会跳。
 *
 * 每帧直接改 SVG 属性，不触发 React 渲染；静止下来就停掉 requestAnimationFrame。
 * 系统开了「减少动态效果」时不跑动画。
 */

import { createContext, useContext, useEffect, useId, useRef } from "react";

/**
 * 活动中的几种状态：
 * · think   思考：弧线慢转，圆点缓慢呼吸
 * · write   输出正文：弧线收短、匀速转，圆点呼吸稍快
 * · tool    执行工具：弧线变长、转得快
 * · wait    等用户（确认 / 作答）：弧线淡出，圆点慢呼吸——停下来等你
 * · compact 压缩上下文：圆点收小，弧线贴近转动
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

interface Params {
  /** 圆点半径（viewBox 24 内） */
  core: number;
  /** 呼吸幅度（半径的比例）与速度（次 / 秒） */
  breath: number;
  breathSpeed: number;
  /** 弧线不透明度、转速（度 / 秒）、弧长（占整圈的比例）、半径 */
  ring: number;
  spin: number;
  arc: number;
  ringR: number;
}

const MODES: Record<SparkMode | "idle", Params> = {
  think: { core: 5.6, breath: 0.12, breathSpeed: 0.7, ring: 0.9, spin: 200, arc: 0.28, ringR: 10 },
  write: { core: 5.6, breath: 0.08, breathSpeed: 1.2, ring: 0.9, spin: 300, arc: 0.18, ringR: 10 },
  tool: { core: 5.2, breath: 0.06, breathSpeed: 1, ring: 1, spin: 420, arc: 0.42, ringR: 10 },
  wait: { core: 5.8, breath: 0.16, breathSpeed: 0.45, ring: 0, spin: 60, arc: 0.28, ringR: 10 },
  compact: { core: 4, breath: 0.1, breathSpeed: 0.9, ring: 0.8, spin: 260, arc: 0.3, ringR: 7.5 },
  idle: { core: 6.2, breath: 0, breathSpeed: 0, ring: 0, spin: 0, arc: 0.28, ringR: 10 },
};

const KEYS = Object.keys(MODES.idle) as (keyof Params)[];

/** 参数缓动的时间常数（秒）：约 0.4 秒内完成过渡 */
const EASE_TAU = 0.14;

function reducedMotion(): boolean {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

export function AxonSpark({ size = 20, animate = false, mode, className = "" }: AxonSparkProps) {
  const liveMode = useContext(LiveSparkModeContext);
  const target: SparkMode | "idle" = animate ? (mode ?? liveMode) : "idle";
  const gradId = `axon-spark-${useId().replace(/:/g, "")}`;

  const coreRef = useRef<SVGCircleElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);
  /** 动画状态跨渲染保留：时钟只累加，参数只缓动 */
  const sim = useRef({ cur: { ...MODES.idle }, phase: 0, angle: -90, raf: 0, last: 0 });
  const targetRef = useRef(target);

  useEffect(() => {
    targetRef.current = target;
    const s = sim.current;
    if (s.raf || (target === "idle" && s.cur.ring < 0.002 && Math.abs(s.cur.core - MODES.idle.core) < 0.01)) return;
    if (reducedMotion()) return;

    const frame = (now: number) => {
      const dt = s.last ? Math.min(0.05, (now - s.last) / 1000) : 1 / 60;
      s.last = now;
      const goal = MODES[targetRef.current];
      const k = 1 - Math.exp(-dt / EASE_TAU);
      for (const key of KEYS) s.cur[key] += (goal[key] - s.cur[key]) * k;
      const p = s.cur;

      s.phase = (s.phase + Math.PI * 2 * p.breathSpeed * dt) % (Math.PI * 2000);
      s.angle = (s.angle + p.spin * dt) % 360;

      const breath = (1 - Math.cos(s.phase)) / 2; // 0 → 1 → 0，从静止大小起步，不会一开始就跳
      const r = p.core * (1 - p.breath * breath);
      coreRef.current?.setAttribute("r", r.toFixed(3));
      coreRef.current?.setAttribute("opacity", (1 - 0.25 * (p.breath / 0.16) * breath).toFixed(3));

      const ring = ringRef.current;
      if (ring) {
        const circumference = 2 * Math.PI * p.ringR;
        ring.setAttribute("r", p.ringR.toFixed(3));
        ring.setAttribute("stroke-dasharray", `${(circumference * p.arc).toFixed(2)} ${circumference.toFixed(2)}`);
        ring.setAttribute("opacity", p.ring.toFixed(3));
        ring.setAttribute("transform", `rotate(${s.angle.toFixed(2)} 12 12)`);
      }

      const settled = targetRef.current === "idle" && p.ring < 0.002 && Math.abs(p.core - MODES.idle.core) < 0.01 && p.breath < 0.001;
      if (settled) {
        coreRef.current?.setAttribute("r", String(MODES.idle.core));
        coreRef.current?.setAttribute("opacity", "1");
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
      className={`shrink-0 ${className}`}
      role="img"
      aria-label={animate ? "Axon 正在处理" : "Axon"}
    >
      <defs>
        <linearGradient id={gradId} x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="55%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      <circle
        ref={ringRef}
        cx="12"
        cy="12"
        r={MODES.idle.ringR}
        stroke={`url(#${gradId})`}
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity={0}
      />
      <circle ref={coreRef} cx="12" cy="12" r={MODES.idle.core} fill={`url(#${gradId})`} />
    </svg>
  );
}
