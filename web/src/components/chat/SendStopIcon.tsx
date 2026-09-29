interface SendStopIconProps {
  stopping: boolean;
}

/**
 * 发送 / 停止共用图标。
 *
 * 两种状态始终保留在同一张 SVG 中，通过 transform、opacity 和描边进度交叉过渡，
 * 避免切换生成状态时卸载节点造成跳帧。
 */
export function SendStopIcon({ stopping }: SendStopIconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`axon-send-stop-icon size-4 ${stopping ? "is-stopping" : "is-ready"}`}
      aria-hidden="true"
    >
      <g className="axon-send-stop-icon__plane">
        <path
          d="M4.15 11.13 18.9 4.72c.66-.29 1.34.35 1.09 1.03l-5.54 15.02c-.24.66-1.17.7-1.47.07l-2.5-5.28-5.3-2.97c-.62-.35-.52-1.18.17-1.48Z"
          fill="currentColor"
        />
        <path
          d="m10.48 15.56 4.48-5.08"
          fill="none"
          stroke="var(--primary)"
          strokeLinecap="round"
          strokeWidth="1.55"
        />
      </g>

      <path
        className="axon-send-stop-icon__trail axon-send-stop-icon__trail--top"
        d="M3.5 7.4h4.1"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
      <path
        className="axon-send-stop-icon__trail axon-send-stop-icon__trail--bottom"
        d="M2.8 16.7h4.8"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />

      <rect
        className="axon-send-stop-icon__stop"
        x="6"
        y="6"
        width="12"
        height="12"
        rx="3"
        fill="currentColor"
      />
    </svg>
  );
}
