/**
 * AxonSpark —— AI 活动指示器：三个或四个小圆点。
 *
 * 四个圆点槽位，每个状态是几种「成分」的组合，全部是连续量：
 *   · 数量 count：3 ~ 4。第 4 个点从第 3 个点的位置长出来 / 缩回去，其余点同时重新排开
 *   · 排布 ring ：0 = 一字排开，1 = 围成一圈（3 个是三角、4 个是方形），中间是从直线弯成圆的过渡
 *   · 动作：bounce 依次跳起、seq 依次亮起放大、sync 一起呼吸、spin 整圈转动、squeeze 圈向中心收拢
 * 切换状态就是把这些量逐帧缓动到新值；时钟（相位、转角）只累加不归零，所以任何组合之间都能平滑过渡，
 * 比如三点跳动 → 长出第四个点、弯成一圈、转起来。
 *
 * 每帧直接改 SVG 属性，不触发 React 渲染；静止下来就停掉 requestAnimationFrame。
 * 系统开了「减少动态效果」时不跑动画。
 */

import { createContext, useContext, useEffect, useId, useRef } from "react";

/**
 * 活动中的几种状态（括号里是成分组合）：
 * · think   思考（三点一排，依次亮起）
 * · write   输出正文（三点一排，依次跳起）
 * · tool    执行工具（四点围成一圈转动）
 * · wait    等用户确认 / 作答（三点一排，一起慢呼吸）
 * · compact 压缩上下文（四点一圈，向中心收拢再舒展）
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
  count: number;
  ring: number;
  /** 节奏（次 / 秒） */
  speed: number;
  bounce: number;
  seq: number;
  sync: number;
  /** 转速（度 / 秒） */
  spin: number;
  squeeze: number;
  /** 整体不透明度（静止时略淡） */
  alpha: number;
}

const MODES: Record<SparkMode | "idle", Params> = {
  think: { count: 3, ring: 0, speed: 1.1, bounce: 0, seq: 1, sync: 0, spin: 0, squeeze: 0, alpha: 1 },
  write: { count: 3, ring: 0, speed: 1.5, bounce: 1, seq: 0.35, sync: 0, spin: 0, squeeze: 0, alpha: 1 },
  tool: { count: 4, ring: 1, speed: 1.2, bounce: 0, seq: 0.6, sync: 0, spin: 220, squeeze: 0, alpha: 1 },
  wait: { count: 3, ring: 0, speed: 0.5, bounce: 0, seq: 0, sync: 1, spin: 0, squeeze: 0, alpha: 1 },
  compact: { count: 4, ring: 1, speed: 0.8, bounce: 0, seq: 0, sync: 0.4, spin: 90, squeeze: 1, alpha: 1 },
  idle: { count: 3, ring: 0, speed: 0, bounce: 0, seq: 0, sync: 0, spin: 0, squeeze: 0, alpha: 0.55 },
};

const KEYS = Object.keys(MODES.idle) as (keyof Params)[];

/** 参数缓动的时间常数（秒）：约 0.45 秒内完成过渡 */
const EASE_TAU = 0.15;

const SLOTS = [0, 1, 2, 3];
const DOT_R = 2.4;
const RING_R = 6.2;

function reducedMotion(): boolean {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 第 i 个槽位在「n 个点」时的一字排布 x 坐标；多出来的槽位叠在最后一个点上（大小为 0） */
function rowX(i: number, n: number): number {
  const gap = n === 3 ? 7 : 5.6;
  const idx = Math.min(i, n - 1);
  return 12 + (idx - (n - 1) / 2) * gap;
}

/**
 * 第 i 个槽位在「n 个点」时的环形排布角度（度，屏幕坐标 y 朝下）。
 * 顺序与一字排开时一致：左 → 上 → 右（→ 下），这样直线弯成圈时每个点就近移动，不会交叉穿过。
 */
function ringAngle(i: number, n: number): number {
  return n === 3 ? 150 + 120 * Math.min(i, 2) : 180 + 90 * i;
}

export function AxonSpark({ size = 20, animate = false, mode, className = "" }: AxonSparkProps) {
  const liveMode = useContext(LiveSparkModeContext);
  const target: SparkMode | "idle" = animate ? (mode ?? liveMode) : "idle";
  const gradId = `axon-dots-${useId().replace(/:/g, "")}`;

  const dotRefs = useRef<(SVGCircleElement | null)[]>([]);
  /** 动画状态跨渲染保留：时钟只累加，参数只缓动 */
  const sim = useRef({ cur: { ...MODES.idle }, phase: 0, angle: 0, raf: 0, last: 0 });
  const targetRef = useRef(target);

  useEffect(() => {
    targetRef.current = target;
    const s = sim.current;
    const atRest = () => KEYS.every((k) => Math.abs(s.cur[k] - MODES.idle[k]) < 0.002) && Math.abs(Math.round(s.angle / 360) * 360 - s.angle) < 0.05;
    if (s.raf || (target === "idle" && atRest())) return;
    if (reducedMotion()) return;

    const frame = (now: number) => {
      const dt = s.last ? Math.min(0.05, (now - s.last) / 1000) : 1 / 60;
      s.last = now;
      const goal = MODES[targetRef.current];
      const k = 1 - Math.exp(-dt / EASE_TAU);
      for (const key of KEYS) s.cur[key] += (goal[key] - s.cur[key]) * k;
      const p = s.cur;

      s.phase = (s.phase + Math.PI * 2 * p.speed * dt) % (Math.PI * 2000);
      s.angle = (s.angle + p.spin * dt) % 360;
      // 不转的状态：转角滑回端正的位置——还是一圈就对齐到相邻点的间隔，要排成一行就整圈回正
      if (goal.spin === 0) {
        const period = goal.ring > 0.5 ? 360 / Math.round(goal.count) : 360;
        s.angle += (Math.round(s.angle / period) * period - s.angle) * k;
      }

      const n4 = Math.min(1, Math.max(0, p.count - 3)); // 0 = 三个点，1 = 四个点
      const breath = (1 - Math.cos(s.phase)) / 2;
      const radius = RING_R * (1 - 0.45 * p.squeeze * breath);

      SLOTS.forEach((i) => {
        // 位置：三点 / 四点两种排布按 n4 插值，再在一字排开与围成一圈之间按 ring 插值
        const x3 = rowX(i, 3), x4 = rowX(i, 4);
        const rowXi = lerp(x3, x4, n4);
        // 转动只加在环形位置上：一字排开的那一半不受影响，弯成圈 / 拉直的过程中不会整排歪掉
        const a = ((lerp(ringAngle(i, 3), ringAngle(i, 4), n4) + s.angle) * Math.PI) / 180;
        const ringXi = 12 + radius * Math.cos(a);
        const ringYi = 12 + radius * Math.sin(a);
        const wave = Math.max(0, Math.sin(s.phase - i * 0.9));
        const x = lerp(rowXi, ringXi, p.ring);
        const y = lerp(12 - 3.2 * p.bounce * wave, ringYi, p.ring);

        // 大小与亮度：依次亮起（seq）+ 一起呼吸（sync）
        const lit = (1 + Math.cos(s.phase - i * 1.1)) / 2;
        const presence = i < 3 ? 1 : n4;
        const scale = presence * (1 - 0.38 * p.seq * (1 - lit)) * (1 - 0.3 * p.sync * (1 - breath));
        const opacity = p.alpha * (1 - 0.55 * p.seq * (1 - lit) - 0.4 * p.sync * (1 - breath));

        const dot = dotRefs.current[i];
        if (dot) {
          dot.setAttribute("cx", x.toFixed(3));
          dot.setAttribute("cy", y.toFixed(3));
          dot.setAttribute("r", Math.max(0, DOT_R * scale).toFixed(3));
          dot.setAttribute("opacity", Math.max(0, opacity).toFixed(3));
        }
      });

      if (targetRef.current === "idle" && atRest()) {
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
        <linearGradient id={gradId} x1="3" y1="6" x2="21" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="55%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      <g>
        {SLOTS.map((i) => (
          <circle
            key={i}
            ref={(el) => { dotRefs.current[i] = el; }}
            cx={rowX(i, 3)}
            cy={12}
            r={i < 3 ? DOT_R : 0}
            opacity={MODES.idle.alpha}
            fill={`url(#${gradId})`}
          />
        ))}
      </g>
    </svg>
  );
}
