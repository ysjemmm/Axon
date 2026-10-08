/**
 * CoworkScene —— Cowork 空态的手绘风格场景动画
 *
 * 画的是"桌面上的文档工作台"：一叠纸、一张表格、一支笔、几片浮起的数据碎片。
 * 用手绘笔触（不规则路径 + 略微抖动的描边）而不是几何图形，是为了压住"工具软件"的
 * 冷硬感 —— Cowork 的用户是会计、做报表的人，这一屏该像一张便签速写，不像仪表盘。
 *
 * ── 动画约束（与 AxonSpark / AxonBloom 同源的经验）──
 * · 只动 transform 与 opacity，绝不动 stroke-width：后者在小尺寸下落进次像素区间，
 *   描边边缘的抗锯齿覆盖率在相邻像素间跳档，表现为真实的抖动而非呼吸。
 * · 同一组元素共用一个 duration，靠负 animation-delay 错相。不同周期叠加会产生节拍
 *   （两个互质周期要很久才重新对齐，中途持续错相，看起来就是"隔一会儿闪一下"）。
 * · 所有动画在 prefers-reduced-motion 下停在展开态（见 index.css 的对应分支）。
 *
 * 配色走品牌渐变（靛蓝 → 天蓝 → 紫），与 AxonSpark / AxonLogo 同一套色值。
 */

/** 浮起的数据碎片：相对画布的位置 + 尺寸，错相由索引决定 */
const MOTES = [
  { x: 128, y: 40, r: 2.6 },
  { x: 150, y: 62, r: 1.8 },
  { x: 40, y: 52, r: 2.2 },
  { x: 22, y: 78, r: 1.6 },
  { x: 142, y: 96, r: 2.0 },
];

/** 表格里逐行浮现的数据条：x 起点、y、宽度 */
const ROWS = [
  { x: 74, y: 108, w: 26 },
  { x: 106, y: 108, w: 14 },
  { x: 74, y: 118, w: 18 },
  { x: 98, y: 118, w: 22 },
  { x: 74, y: 128, w: 30 },
  { x: 110, y: 128, w: 10 },
];

interface CoworkSceneProps {
  /** px，默认 190（空态主视觉尺寸） */
  size?: number;
}

export function CoworkScene({ size = 190 }: CoworkSceneProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 190 170"
      fill="none"
      width={size}
      height={size * (170 / 190)}
      /* mx-auto 不能省：Tailwind preflight 把 svg 设成 display:block，
         固定宽度的块级元素不受父级 text-align:center 影响，会贴在左边缘。 */
      className="cowork-scene mx-auto shrink-0"
      role="img"
      aria-label="文档工作台"
    >
      <defs>
        {/* 品牌渐变。userSpace 让渐变稳定铺在固定方位，元素做 transform 时颜色不跟着游走 */}
        <linearGradient id="cowork-grad" x1="0" y1="0" x2="190" y2="170" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="52%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#a78bfa" />
        </linearGradient>
        {/* 纸张的淡填充：极低透明度，只为把纸面从背景里"托"起来一点 */}
        <linearGradient id="cowork-paper" x1="0" y1="0" x2="0" y2="170" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#a78bfa" stopOpacity="0.06" />
        </linearGradient>
      </defs>

      {/* ── 底层：两张错位的纸（手绘感来自四角不对齐的路径） ── */}
      <g className="cowork-scene__paper-back">
        <path
          d="M44 30 L120 26 Q126 26 126 32 L129 128 Q129 134 123 134 L49 137 Q43 137 43 131 Z"
          fill="url(#cowork-paper)"
          stroke="url(#cowork-grad)"
          strokeOpacity="0.45"
          strokeWidth="1.9"
          strokeLinejoin="round"
        />
      </g>

      {/* ── 主体：表格纸 ── */}
      <g className="cowork-scene__paper-main">
        <path
          d="M58 42 L136 38 Q143 38 143 45 L146 142 Q146 149 139 149 L63 152 Q56 152 56 145 Z"
          fill="url(#cowork-paper)"
          stroke="url(#cowork-grad)"
          strokeOpacity="0.85"
          strokeWidth="2.1"
          strokeLinejoin="round"
        />

        {/* 表头：一条略粗的横线 + 两个格子分隔 */}
        <path d="M68 62 L133 59" stroke="url(#cowork-grad)" strokeOpacity="1" strokeWidth="2.6" strokeLinecap="round" />
        <path d="M68 74 L133 71" stroke="url(#cowork-grad)" strokeOpacity="0.55" strokeWidth="1.5" strokeLinecap="round" />

        {/* 竖向分栏（手绘：两端略微偏移，不是标准垂直线） */}
        <path d="M101 60 L102 145" stroke="url(#cowork-grad)" strokeOpacity="0.35" strokeWidth="1.3" strokeLinecap="round" />

        {/* 逐行浮现的数据条 */}
        {ROWS.map((row, i) => (
          <rect
            key={`${row.x}-${row.y}`}
            x={row.x}
            y={row.y}
            width={row.w}
            height="3.4"
            rx="1.7"
            fill="url(#cowork-grad)"
            className="cowork-scene__row"
            // 负延迟让各行在 t=0 就已分布在不同相位，没有"启动时先排队"的观感
            style={{ animationDelay: `${-(i * 2.8) / ROWS.length}s` }}
          />
        ))}
      </g>

      {/* ── 笔：斜搭在纸右侧，轻微摆动（像刚放下） ── */}
      <g className="cowork-scene__pen">
        <path
          d="M150 58 L169 39 Q172 36 175 39 Q178 42 175 45 L156 64 L148 67 Z"
          fill="url(#cowork-paper)"
          stroke="url(#cowork-grad)"
          strokeOpacity="0.9"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        {/* 笔尖那一小截深色 */}
        <path d="M150 58 L156 64 L148 67 Z" fill="url(#cowork-grad)" fillOpacity="0.8" />
      </g>

      {/* ── 浮起的数据碎片：缓慢上浮 + 明暗呼吸 ── */}
      {MOTES.map((mote, i) => (
        <circle
          key={`${mote.x}-${mote.y}`}
          cx={mote.x}
          cy={mote.y}
          r={mote.r}
          fill="url(#cowork-grad)"
          className="cowork-scene__mote"
          style={{ animationDelay: `${-(i * 4.2) / MOTES.length}s` }}
        />
      ))}

      {/* ── 右下角的对勾：处理完成的隐喻，最后一个浮现 ── */}
      <path
        d="M116 128 L124 136 L140 118"
        stroke="url(#cowork-grad)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="cowork-scene__check"
      />
    </svg>
  );
}
