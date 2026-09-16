/**
 * WebviewStallWatchdog —— 从扩展宿主侧监视 Axon webview 是否失去响应。
 *
 * 要解决的故障：AI 回复过程中界面整片变灰、点击无反应，但后端仍在继续输出。
 *
 * 为什么必须在扩展宿主里做：webview 的界面一旦被主线程占满，页面内的 JS 就已无法执行，
 * 任何"卡住时打日志"的方案都不成立。而扩展宿主是另一个进程，它照常运行——
 * 于是让它来当外部观察者：webview 定期发心跳，心跳停了就说明界面卡了，
 * 此刻由宿主记下时间点与最后状态（正在跑什么操作、DOM 规模、是否正在流式）。
 *
 * 只在面板可见时判定：面板不可见时 Chromium 会节流定时器，心跳变慢属正常现象，
 * 不能算作卡死（否则切走标签就会误报）。
 */

import * as vscode from "vscode";

/** 心跳超时：webview 每 2s 一次心跳，超过该时长未收到即判定失去响应 */
const STALL_MS = 7000;
/** 巡检间隔 */
const CHECK_INTERVAL_MS = 2000;

/** webview 上报的心跳载荷 */
export interface DiagHeartbeat {
  /** 增量诊断记录（长任务、帧间隔、慢操作等） */
  records?: Array<{ kind: string; ms: number; at: number; detail?: string }>;
  /** 当时正在进行的重操作（如 markdown-parse / mermaid-render） */
  span?: string;
  /** 现场信息（DOM 节点数、是否存在全屏弹窗遮罩） */
  dom?: string;
  /** 前端自报状态 */
  state?: { streaming?: boolean };
  /** 上次运行残留的"卡死"标记（仅首次心跳携带） */
  stuck?: { name: string; detail?: string; seconds: number } | null;
}

let channel: vscode.OutputChannel | null = null;

/** 诊断输出通道（用户可在「输出」面板选择 “Axon 诊断” 查看） */
function out(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel("Axon 诊断");
  return channel;
}

/** 打开诊断输出面板 */
export function showDiagLog(): void {
  out().show(true);
}

function log(message: string): void {
  out().appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

export class WebviewStallWatchdog {
  /** 最后一次收到心跳的时间戳（0 = 尚未收到过） */
  private lastBeatAt = 0;
  private lastPayload: DiagHeartbeat | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** 是否已就当前这次卡死报过警，避免重复刷屏 */
  private reported = false;
  private beatCount = 0;
  /** 累计检测到的卡死次数，便于判断是偶发还是高频 */
  private stallCount = 0;

  /** @param isVisible 面板当前是否可见（不可见时不判定，规避浏览器节流造成的误报） */
  constructor(private readonly isVisible: () => boolean) {}

  start(): void {
    log("观察器启动：等待 webview 心跳（每 3s 一次，超过 7s 未收到即记录为失去响应）");
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
  }

  /** 收到一次心跳：刷新存活时间，并把新增的诊断记录写入持久日志 */
  noteHeartbeat(payload: DiagHeartbeat): void {
    this.lastBeatAt = Date.now();
    this.lastPayload = payload;
    this.beatCount++;

    if (this.reported) {
      log("webview 已恢复响应");
      this.reported = false;
    }

    // 上次运行遗留的卡死标记：这是判断根因最直接的证据，优先呈现
    if (payload.stuck) {
      log(
        `⚠️ 上次运行疑似在「${payload.stuck.name}」期间卡死：该操作已持续 ${payload.stuck.seconds.toFixed(1)}s 未结束` +
        `${payload.stuck.detail ? `（${payload.stuck.detail}）` : ""}`,
      );
    }

    for (const r of payload.records ?? []) {
      log(`  · ${r.kind} ${r.ms}ms${r.detail ? ` · ${r.detail}` : ""}`);
    }
  }

  /** 巡检：心跳是否已停 */
  private check(): void {
    if (!this.isVisible()) return;
    if (!this.lastBeatAt) return; // 还没收到首次心跳，不判定
    const silentMs = Date.now() - this.lastBeatAt;
    if (silentMs < STALL_MS || this.reported) return;

    this.reported = true;
    this.stallCount++;
    const p = this.lastPayload;
    const streaming = p?.state?.streaming;
    log(
      `⚠️ webview 已 ${(silentMs / 1000).toFixed(1)}s 无心跳 —— 界面此刻失去响应（用户看到的"卡灰"应发生在此期间）。` +
      ` 现场：正在执行=${p?.span || "无"} | DOM=${p?.dom || "-"} | AI在输出=${streaming === undefined ? "未知" : streaming ? "是" : "否"}` +
      ` | 累计心跳=${this.beatCount} | 累计卡死=${this.stallCount}`,
    );
    void vscode.window.showWarningMessage(
      "Axon 界面似乎失去响应，已记录诊断信息（详见「输出 → Axon 诊断」）",
    );
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    log("观察器停止");
  }
}
