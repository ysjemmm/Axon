/**
 * HostMediaRenderer —— 把一段 HTML 动画渲染成 GIF / MP4 文件（执行端 ① 的一部分）
 *
 * ── 为什么放在 host，而不是让模型自己 execute_command ──
 * Quest（问答）模式刻意没有命令执行能力。出片需要「无头浏览器截帧 + ffmpeg 编码 + 本机语音合成」，
 * 这几步都是固定流程，把它封成一个受控能力：模型只能给 HTML 和几个参数，
 * 拿不到 shell，也就不会因为"要出视频"而被迫放开命令权限。
 *
 * ── 与 HostWebBrowser 的区别 ──
 * webBrowser 是给 Agent 调试前端用的、用户可见的有头浏览器；这里是一次性的离屏渲染，
 * 自己起一个无头浏览器、用完即关，互不干扰。
 *
 * 不支持的形态为 undefined（AgentHost.mediaRenderer 可选）。
 */

/** 输出格式。GIF 容器本身没有音轨，带旁白时必须是 mp4。 */
export type MediaFormat = "gif" | "mp4";

/**
 * 渲染限额。参数校验（core）与渲染实现（host）共用同一份，避免两边口径漂移。
 *
 * maxFrames 是时间预算：每帧要截一次图（实测约 80~150ms），1200 帧约 2~3 分钟，
 * 再长就该让用户拆成多段，而不是让一次工具调用挂着不动。
 */
export const MEDIA_LIMITS = {
  /** mp4 最长时长（秒） */
  maxDurationSec: 60,
  /** gif 最长时长（秒）：GIF 体积随帧数线性膨胀，超过这个长度基本发不出去 */
  maxGifDurationSec: 15,
  maxFps: 30,
  maxGifFps: 15,
  maxFrames: 1200,
  minSize: 160,
  maxWidth: 1920,
  maxHeight: 1080,
  maxGifWidth: 960,
  maxGifHeight: 540,
  maxNarrationChars: 2000,
} as const;

/** 各格式的默认参数 */
export const MEDIA_DEFAULTS = {
  mp4: { width: 1280, height: 720, fps: 24, durationSec: 5 },
  gif: { width: 640, height: 360, fps: 12, durationSec: 3 },
} as const;

/** 渲染进度阶段 */
export type MediaRenderPhase =
  /** 准备渲染组件（首次使用需自动下载 ffmpeg，可能要几分钟） */
  | "provision"
  | "narration"
  | "frames"
  | "encoding";

/** 一次渲染请求 */
export interface MediaRenderRequest {
  /** 完整的单文件 HTML（样式与脚本内联，不得依赖网络资源） */
  html: string;
  format: MediaFormat;
  /** 成片时长（秒）。有旁白且旁白更长时，实现会自动延长到能容纳旁白 */
  durationSec: number;
  fps: number;
  /** 画面尺寸（像素，已是偶数） */
  width: number;
  height: number;
  /** 旁白文本（本机语音合成）。仅 mp4 有效；缺省表示无声 */
  narration?: string;
  /** 输出文件绝对路径（父目录由实现负责创建） */
  outputPath: string;
  /** 用户取消时中断渲染 */
  signal?: AbortSignal;
  /** 进度回调：done/total 的单位随阶段而定（frames 阶段为帧数） */
  onProgress?: (info: { phase: MediaRenderPhase; done: number; total: number }) => void;
}

/** 渲染结果 */
export interface MediaRenderResult {
  outputPath: string;
  /** 实际成片时长（秒） */
  durationSec: number;
  /** 成片是否带音轨 */
  hasAudio: boolean;
  frameCount: number;
  /** 文件字节数 */
  size: number;
  /**
   * 不致命但用户该知道的情况（如旁白合成失败而降级成无声片）。
   * 给模型看，由模型决定怎么如实告诉用户。
   */
  warnings: string[];
}

/** 渲染环境自检结果 */
export interface MediaRenderEnv {
  ok: boolean;
  /** 不可用时的原因与解决办法（给模型看，也会转述给用户） */
  problem?: string;
}

export interface HostMediaRenderer {
  /**
   * 检查渲染依赖是否齐备（ffmpeg 等）。便宜、不启动浏览器。
   * 浏览器是否可用要真正启动才知道，由 render 抛出的错误说明。
   */
  checkEnv(): Promise<MediaRenderEnv>;

  /**
   * 渲染并写出文件。失败抛错，错误信息要说清原因，模型会据此决定是否重试。
   */
  render(req: MediaRenderRequest): Promise<MediaRenderResult>;
}
