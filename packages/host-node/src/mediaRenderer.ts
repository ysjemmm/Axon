/**
 * NodeMediaRenderer —— HostMediaRenderer 的 Node 实现
 *
 * 流程：HTML → 离屏 Chromium 逐帧截图（PNG 序列）→ ffmpeg 编码成 GIF / MP4；
 * 有旁白时先用系统自带的语音合成出音轨，再混进 MP4。全程在本机，不调用任何第三方 API。
 *
 * ── 关键设计（改之前先读）──
 * 1. 确定性逐帧，不是录屏。录屏的帧间隔取决于机器当下的忙闲，截图慢一点动画就漏帧；
 *    这里把时间交给渲染器：第 i 帧固定对应 t = i / fps，慢只是慢，画面不会错。
 *    · CSS animation / transition / Web Animations：暂停后逐帧设置 currentTime
 *    · setTimeout / rAF / Date.now / performance.now：用 Playwright 的假时钟接管并手动推进
 *    · Canvas / JS 驱动：页面可定义 window.renderFrame(t)，每帧截图前以当前秒数调用
 * 2. 页面是模型刚写的、按不可信代码对待：拦截所有网络请求（只放行 data/blob/about），
 *    不挂任何本机能力，浏览器进程是一次性的、用完即关。被拦的请求会记下来提示模型，
 *    否则"引了 CDN 脚本所以整页空白"这类问题没人知道原因。
 * 3. 先出旁白再渲染：成片时长要由旁白长度决定，必须先知道它有多长。
 * 4. 旁白失败不拖垮整次渲染，降级成无声片并写进 warnings，由模型如实告诉用户——
 *    悄悄给个哑片，用户会以为是我们坏了。
 */

import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Browser } from "playwright-core";
import { MEDIA_LIMITS } from "@axon/core";
import type { HostMediaRenderer, MediaRenderEnv, MediaRenderRequest, MediaRenderResult } from "@axon/core";
import { ensureFfmpeg, findFfmpeg, pickAsset } from "./ffmpegProvision.js";

/**
 * 整次渲染的时间上限：兜住页面里死循环、浏览器卡死这类不会自己结束的情况。
 *
 * 15 分钟是给「60fps × 60 秒 = 3600 帧」留的余量：按每帧 150ms 的最坏情况算要 9 分钟，
 * 加上启动浏览器、音频合成、编码，仍有余地。再小就会把正常的长片误杀。
 */
const RENDER_WATCHDOG_MS = 15 * 60 * 1000;
/** 单次截图 / 页面操作的超时 */
const PAGE_OP_TIMEOUT_MS = 20_000;
/** 旁白合成超时 */
const TTS_TIMEOUT_MS = 60_000;
/** 第 0 帧前让假时钟先走的时长：一个 rAF 间隔（60Hz ≈ 16ms） */
const RAF_PRIME_MS = 16;
/** 旁白比画面多留的尾巴（秒），避免最后一个字被切掉 */
const NARRATION_TAIL_SEC = 0.5;

/**
 * 内置前端库目录（扩展的 media/vendor），由宿主在启动时注册。
 *
 * 渲染环境默认拦截一切外网请求（模型生成的页面按不可信代码对待）。但三维场景需要
 * Three.js 这类大库，让模型内联几百 KB 的库代码既不现实也不可靠，所以开这一个口子：
 * 页面用 `/vendor/<文件名>` 引用，路由直接读本地文件返回，仍然不出网。
 */
let mediaVendorDir: string | undefined;
export function setMediaVendorDir(dir: string | undefined): void {
  mediaVendorDir = dir;
}

// ── 子进程 ────────────────────────────────────────────────────────────────

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 输出只留末尾这么多字节：ffmpeg 的报错在末尾，前面全是横幅 */
const KEEP_OUTPUT_BYTES = 16 * 1024;

function runProcess(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        env: opts.env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        signal: opts.signal,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const keepTail = (s: string) => (s.length > KEEP_OUTPUT_BYTES ? s.slice(-KEEP_OUTPUT_BYTES) : s);
    child.stdout?.on("data", (d: Buffer) => { stdout = keepTail(stdout + d.toString("utf8")); });
    child.stderr?.on("data", (d: Buffer) => { stderr = keepTail(stderr + d.toString("utf8")); });

    const timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill(); }, opts.timeoutMs)
      : undefined;

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) reject(new Error(`进程超时（${Math.round((opts.timeoutMs ?? 0) / 1000)} 秒）`));
      else resolve({ code, stdout, stderr });
    });
  });
}

/** 取 stderr 最后几行作为报错摘要 */
function tailLines(text: string, n = 6): string {
  return text.trim().split(/\r?\n/).slice(-n).join(" | ");
}

// ── ffmpeg ────────────────────────────────────────────────────────────────

/**
 * 可用的 H.264 编码器。
 *
 * 不能写死 libx264：自动获取来的是 LGPL 构建，里面没有 x264（GPL），只有 libopenh264。
 * 而两者参数互不通用（openh264 不认 -crf / -preset，x264 不认识 -b:v 那套画质策略），
 * 所以必须先问 ffmpeg 自己有哪些编码器，再决定用哪套参数。
 *
 * macOS 上是第三种情况：LGPL 构建里既没有 x264 也没有 openh264（后者要额外链接），
 * 用的是系统框架 VideoToolbox（h264_videotoolbox）—— 许可干净且走硬件加速，比软件编码快得多。
 */
type VideoEncoder = "libx264" | "libopenh264" | "h264_videotoolbox";

const encoderCache = new Map<string, VideoEncoder>();

async function detectVideoEncoder(ffmpeg: string): Promise<VideoEncoder> {
  const cached = encoderCache.get(ffmpeg);
  if (cached) return cached;
  const r = await runProcess(ffmpeg, ["-hide_banner", "-encoders"], { timeoutMs: 15_000 });
  const text = `${r.stdout}\n${r.stderr}`;
  // 优先级：x264（用户系统里已有完整版时画质/体积最好）→ openh264（BtbN LGPL）
  // → VideoToolbox（macOS 自建构建，硬件加速）
  const picked: VideoEncoder | null = /\blibx264\b/.test(text)
    ? "libx264"
    : /\blibopenh264\b/.test(text)
      ? "libopenh264"
      : /\bh264_videotoolbox\b/.test(text)
        ? "h264_videotoolbox"
        : null;
  if (!picked) {
    throw new Error("这个 ffmpeg 没有 H.264 编码器（需要 libx264 / libopenh264 / h264_videotoolbox），无法生成 MP4。");
  }
  encoderCache.set(ffmpeg, picked);
  return picked;
}

/**
 * 成片后处理：把「网页截图」往「影像」推一档。
 *
 * 四步，从「成像」到「镜头」：
 * 1. 高光溢出（bloom）：把画面拆成两路，一路压掉暗部只留高光、高斯模糊后以 screen 模式
 *    叠回去。这是「数字画面」和「有镜头感的画面」最大的一处分水岭——光源和亮部边缘
 *    会有自然的光晕扩散，而不是硬边。只让高光参与叠加（0.35→0.05 的阈值曲线），
 *    暗部保持干净、不发灰。
 * 2. 电影调色：colorbalance 让暗部偏青、高光偏暖（teal & orange，商业片最通用的配色逻辑），
 *    再用 S 曲线压暗部提中间调，画面立刻「沉」下来、有胶片味。
 * 3. 暗角：把视线收到画面中心。
 * 4. 颗粒：极细噪点，消掉纯数字的塑料感。
 *
 * 只用于 mp4。GIF 帧数少、调色板只有 256 色，加光晕和颗粒会把体积和噪点一起放大。
 *
 * ⚠️ 不要换成 eq：Axon 自动获取的 ffmpeg 是精简构建，实测没有 eq 滤镜
 * （`No such filter: 'eq'`），写上会让所有渲染直接失败。eq 的能力 curves + colorbalance
 * 已完全覆盖且更专业。这条链已在真实 ffmpeg 上验证过能正常出片。
 *
 * 标签统一用 fx 前缀，避免和音频混流的 [a] 撞名。整段是一个自包含的 filtergraph 片段：
 * 可直接作为 -vf，也可拼进 filter_complex 后接输出标签。
 */
const POST_FX_FILTER = [
  "split[fxBase][fxGlow]",
  "[fxGlow]curves=all='0/0 0.35/0.05 1/1',gblur=sigma=18[fxBlur]",
  "[fxBase][fxBlur]blend=all_mode=screen:all_opacity=0.45[fxLit]",
  "[fxLit]colorbalance=rs=-0.05:bs=0.05:rh=0.04:bh=-0.04," +
    "curves=all='0/0 0.5/0.46 1/1',vignette=angle=PI/6,noise=alls=4:allf=t+u",
].join(",");

/**
 * 视频编码参数。
 *
 * openh264 没有 CRF 这类恒定量化参数，只能按目标码率走。
 */
function videoEncodeArgs(encoder: VideoEncoder, width: number, height: number, fps: number): string[] {
  if (encoder === "libx264") {
    // medium 比 veryfast 编码慢 2~3 倍，但对短视频（编码只占整体耗时的零头）换来的
    // 码率分配和边缘细节明显更好：文字边缘、细线、渐变过渡都不容易糊。
    return ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "20"];
  }
  // ⚠️ Axon 自动获取的 ffmpeg 不带 libx264（--disable-libx264），实际走的是 openh264
  // 的码率模式：画质完全由这里的 bitrate 决定，preset / crf 对它无效。
  // 0.15 bit/px 比原来的 0.1 高一档：720p30 约 4Mbps、1080p30 约 9Mbps，
  // 渐变过渡和细线不再出现色带。上限放到 20Mbps，宁可文件大一点（预览超限时
  // 用户可以在文件系统里用播放器打开），也不要在画质上妥协。
  const bitrate = Math.min(20_000_000, Math.max(1_000_000, Math.round(width * height * fps * 0.15)));
  if (encoder === "h264_videotoolbox") {
    return [
      "-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p",
      "-b:v", String(bitrate),
      // 没有硬件编码器时允许退回软件路径，否则在虚拟机 / 老机型上直接失败
      "-allow_sw", "1",
      "-g", String(Math.max(1, Math.round(fps * 2))),
    ];
  }
  return [
    "-c:v", "libopenh264", "-pix_fmt", "yuv420p",
    "-b:v", String(bitrate),
    // 关键帧间隔约 2 秒：全 I 帧会撑爆体积，太长则拖动定位不准
    "-g", String(Math.max(1, Math.round(fps * 2))),
    // 绝不允许为了凑码率丢帧——成片的时长和帧数必须和参数一致
    "-allow_skip_frames", "0",
  ];
}

async function runFfmpeg(bin: string, args: string[], signal?: AbortSignal): Promise<RunResult> {
  const r = await runProcess(bin, ["-y", "-hide_banner", "-nostdin", ...args], { signal });
  if (r.code !== 0) throw new Error(`ffmpeg 编码失败：${tailLines(r.stderr)}`);
  return r;
}

/** 用 ffmpeg 读出音频时长（秒）。不依赖 ffprobe——ffmpeg 自己会在 stderr 里报 Duration。 */
async function probeAudioSeconds(bin: string, file: string, signal?: AbortSignal): Promise<number> {
  const r = await runProcess(bin, ["-hide_banner", "-nostdin", "-i", file, "-f", "null", "-"], { signal });
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr);
  if (!m) throw new Error("无法读取旁白时长");
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// ── 旁白（系统自带语音合成）──────────────────────────────────────────────

const HAS_CJK = /[\u3400-\u9fff]/;

/**
 * Windows：System.Speech（SAPI）。
 * 文本走文件、路径走环境变量，脚本用 -EncodedCommand 传——避免把模型写的旁白拼进命令行
 * 引起引号转义问题（更别说注入）。
 * 旁白含中文而系统没装中文语音时必须失败：SAPI 用英文音色念汉字，出来的是一片静音或乱码。
 */
const WIN_TTS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$text = [System.IO.File]::ReadAllText($env:AXON_TTS_TEXT, [System.Text.Encoding]::UTF8)
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ([regex]::IsMatch($text, '[\u3400-\u9fff]')) {
  $v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1
  if (-not $v) { exit 3 }
  $s.SelectVoice($v.VoiceInfo.Name)
}
$s.SetOutputToWaveFile($env:AXON_TTS_OUT)
$s.Speak($text)
$s.Dispose()
`;

async function synthesizeNarration(text: string, dir: string, signal?: AbortSignal): Promise<string> {
  const textPath = join(dir, "narration.txt");
  await writeFile(textPath, text, "utf8");

  if (process.platform === "win32") {
    const out = join(dir, "narration.wav");
    const encoded = Buffer.from(WIN_TTS_SCRIPT, "utf16le").toString("base64");
    const r = await runProcess(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { env: { ...process.env, AXON_TTS_TEXT: textPath, AXON_TTS_OUT: out }, timeoutMs: TTS_TIMEOUT_MS, signal },
    );
    if (r.code === 3) throw new Error("系统没有安装中文语音包（设置 → 时间和语言 → 语音 中添加中文语音）");
    if (r.code !== 0) throw new Error(`系统语音合成失败：${tailLines(r.stderr, 3)}`);
    return out;
  }

  if (process.platform === "darwin") {
    const out = join(dir, "narration.aiff");
    const r = await runProcess("say", ["-o", out, "-f", textPath], { timeoutMs: TTS_TIMEOUT_MS, signal });
    if (r.code !== 0) throw new Error(`系统语音合成失败：${tailLines(r.stderr, 3)}`);
    return out;
  }

  // Linux：espeak-ng / espeak。音质一般，但至少是本机、无需网络
  const out = join(dir, "narration.wav");
  const voice = HAS_CJK.test(text) ? ["-v", "zh"] : [];
  for (const bin of ["espeak-ng", "espeak"]) {
    try {
      const r = await runProcess(bin, [...voice, "-f", textPath, "-w", out], { timeoutMs: TTS_TIMEOUT_MS, signal });
      if (r.code === 0) return out;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
  throw new Error("未找到语音合成引擎（请安装 espeak-ng）");
}

// ── 页面时间控制 ──────────────────────────────────────────────────────────

/**
 * 注入页面的时间定位脚本（每个文档最早执行）。
 *
 * 动画首次被看到的那一刻记为它的"逻辑起点"，之后 currentTime = 当前帧时刻 - 起点：
 * 页面加载时就存在的动画起点是 0，脚本中途创建的动画（如 renderFrame 里触发的 transition）
 * 起点是它出现的那一帧，两者都按预期推进。
 */
const PAGE_INIT_SCRIPT = String.raw`
(() => {
  const bases = new WeakMap();
  window.__axonSeek = (tMs) => {
    for (const a of document.getAnimations()) {
      if (!bases.has(a)) { bases.set(a, tMs); a.pause(); }
      a.currentTime = tMs - bases.get(a);
    }
    if (typeof window.renderFrame === "function") window.renderFrame(tMs / 1000);
  };
})();
`;

/**
 * 页面音效渲染脚本（每个文档最早执行）。
 *
 * 模型只需在 HTML 里定义 `window.renderAudio(ctx)`，ctx 是这里创建好的 OfflineAudioContext；
 * 它往 ctx.destination 上接振荡器/噪声/包络即可，不用自己 startRendering。
 *
 * 为什么用 OfflineAudioContext 而不是实时播放再录音：后者要真扬声器、时长按实时走、
 * 结果随机器忙闲漂移；前者按样本精确合成，几秒就能算完 60 秒音频，与「确定性逐帧」同一套思路。
 * 它也不受本页面假时钟影响（假时钟只接管 setTimeout / rAF，管不到音频图的采样渲染）。
 *
 * 返回 16bit PCM WAV 的 base64；页面没定义 renderAudio 时返回 null。
 */
const PAGE_AUDIO_SCRIPT = String.raw`
(() => {
  window.__axonHasAudio = () => typeof window.renderAudio === "function";
  window.__axonRenderAudio = async (sampleRate, durationSec) => {
    if (typeof window.renderAudio !== "function") return null;
    const frames = Math.max(1, Math.ceil(durationSec * sampleRate));
    const ctx = new OfflineAudioContext(2, frames, sampleRate);
    await window.renderAudio(ctx);
    const buffer = await ctx.startRendering();
    const channels = Math.min(2, buffer.numberOfChannels);
    const length = buffer.length;
    const bytes = new Uint8Array(44 + length * channels * 2);
    const view = new DataView(bytes.buffer);
    const putStr = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
    putStr(0, "RIFF");
    view.setUint32(4, 36 + length * channels * 2, true);
    putStr(8, "WAVE");
    putStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    putStr(36, "data");
    view.setUint32(40, length * channels * 2, true);
    const data = [];
    for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
    let offset = 44;
    for (let i = 0; i < length; i++) {
      for (let c = 0; c < channels; c++) {
        const v = Math.max(-1, Math.min(1, data[c][i]));
        view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        offset += 2;
      }
    }
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  };
})();
`;

/** 启动离屏浏览器：优先系统 Chrome → Edge → Playwright 自带 Chromium（与 PlaywrightBrowser 同一套回退） */
async function launchHeadless(): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const attempts: Array<{ channel?: string }> = [{ channel: "chrome" }, { channel: "msedge" }, {}];
  let lastErr: unknown;
  for (const opt of attempts) {
    try {
      return await chromium.launch({ headless: true, ...opt });
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `无法启动浏览器：未找到可用的 Chrome/Edge，Playwright 自带 Chromium 也未安装。` +
      `请安装 Chrome，或运行 \`npx playwright install chromium\`。原始错误：${(lastErr as Error)?.message || lastErr}`,
  );
}

const frameName = (i: number) => `frame_${String(i).padStart(6, "0")}.png`;

/**
 * 页面的"伪地址"。.invalid 是保留顶级域名，永远解析不了；请求由下面的路由直接应答，从不出网。
 *
 * 为什么不用 page.setContent：它不触发导航，只是往已有文档里 document.write——
 * 初始空白页早于 addInitScript 创建，注入的时间定位脚本根本没机会运行（实测 __axonSeek 为 undefined）。
 * 走一次真实导航，注入脚本与假时钟才都能赶在页面脚本之前就绪。
 */
const PAGE_URL = "http://axon-render.invalid/index.html";

/** 截帧参数 */
export interface CaptureOptions {
  html: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  /** 帧输出目录，文件名从 frame_000001.png 起 */
  dir: string;
  /**
   * 页面音效：提供了就尝试调用页面的 window.renderAudio，把结果写成 WAV。
   * 页面没定义这个函数时静默跳过（不是错误，多数片子本来就无声）。
   */
  audio?: { sampleRate: number; outPath: string; durationSec: number };
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * 离屏逐帧截图，返回需要告知用户的警告（被拦截的外部请求、页面脚本报错）。
 *
 * 单独导出是为了能脱离 ffmpeg 直接验证"确定性逐帧"这件最容易出错的事：
 * 第 i 帧必须稳定对应 t = i / fps，慢只是慢，画面不能错。浏览器的生命周期（含兜底超时、
 * 取消时强制关闭）全部收在这里，调用方不用再管。
 */
export async function captureFrames(opts: CaptureOptions): Promise<string[]> {
  const warnings: string[] = [];
  const throwIfAborted = () => {
    if (opts.signal?.aborted) throw new Error("渲染已取消");
  };
  throwIfAborted();

  const browser = await launchHeadless();
  const watchdog = setTimeout(() => { void browser.close().catch(() => {}); }, RENDER_WATCHDOG_MS);
  // 取消时直接关浏览器：正卡在截图 / 页面脚本里的调用会因此立刻失败，而不是干等超时
  const onAbort = () => { void browser.close().catch(() => {}); };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const context = await browser.newContext({
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: 1,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    const blocked: string[] = [];
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === PAGE_URL) {
        return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: opts.html });
      }
      if (/^(data|blob|about):/i.test(url)) return route.continue();
      // 内置库（如 Three.js）：页面用 /vendor/<文件名> 引用，这里直接读本地文件返回，仍然不出网。
      // 只允许单层文件名 —— 挡掉 ../ 和任何带路径分隔符的写法，避免拼出扩展目录之外的任意文件。
      if (mediaVendorDir) {
        try {
          const name = new URL(url).pathname.replace(/^\/vendor\//, "");
          if (name && !/[\\/]/.test(name) && !name.includes("..")) {
            const body = await readFile(join(mediaVendorDir, name));
            return route.fulfill({ status: 200, contentType: "application/javascript; charset=utf-8", body });
          }
        } catch {
          // 文件不存在 → 落回下面的外链拦截，让模型在 warnings 里看到原因
        }
      }
      blocked.push(url);
      return route.abort();
    });

    const page = await context.newPage();
    page.setDefaultTimeout(PAGE_OP_TIMEOUT_MS);
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => { if (pageErrors.length < 3) pageErrors.push(err.message); });

    await page.addInitScript(PAGE_INIT_SCRIPT);
    await page.addInitScript(PAGE_AUDIO_SCRIPT);
    // 假时钟必须在页面脚本运行前装好，并立刻暂停：
    // 否则 setContent 到第一帧之间真实时间在流逝，动画会在第 0 帧之前就已经走了一截。
    // 暂停点只能是 1ms 而不是更大的值：页面的 performance.now() / Date.now() 在第 0 帧读到的就是
    // 这个数，取大了会让所有依赖时间的 JS 动画整体提前。
    await page.clock.install({ time: 0 });
    await page.clock.pauseAt(1);
    await page.goto(PAGE_URL, { waitUntil: "load" });

    // 假时钟停在起点，requestAnimationFrame 的首批回调还没机会运行：不先推一个 rAF 间隔，
    // 靠 rAF 绘制首屏的页面（Canvas 动画几乎都是）第 0 帧截到的会是没画过的空白。
    // 真实浏览器在首次绘制前就会跑一轮 rAF，这里补上同样的一步。代价是依赖 performance.now 的
    // JS 动画整体比 CSS / renderFrame 晚 16ms（不到一帧），可以接受；CSS 与 renderFrame 是按 t 定位的，不受影响。
    await page.clock.runFor(RAF_PRIME_MS);

    let clockMs = 0;
    for (let i = 0; i < opts.frameCount; i++) {
      throwIfAborted();
      const targetMs = Math.round((i * 1000) / opts.fps);
      if (targetMs > clockMs) {
        await page.clock.runFor(targetMs - clockMs);
        clockMs = targetMs;
      }
      await page.evaluate(`window.__axonSeek(${targetMs})`);
      await page.screenshot({ path: join(opts.dir, frameName(i + 1)), type: "png", caret: "hide" });
      opts.onProgress?.(i + 1, opts.frameCount);
    }

    // 页面音效：截完帧再单独跑一次离线音频渲染。
    // 放在画面之后，是因为音频合成失败也不该影响已经截好的画面（降级成只有画面/旁白）。
    if (opts.audio) {
      throwIfAborted();
      try {
        const base64 = await page.evaluate(
          `window.__axonRenderAudio(${opts.audio.sampleRate}, ${opts.audio.durationSec})`,
        );
        if (typeof base64 === "string" && base64.length > 0) {
          await writeFile(opts.audio.outPath, Buffer.from(base64, "base64"));
        }
      } catch (err) {
        warnings.push(`音效合成失败（${(err as Error).message}），这段声音在成片里没有`);
      }
    }

    if (blocked.length) {
      warnings.push(
        `页面请求了外部资源，已被拦截（${blocked.slice(0, 3).join("、")}${blocked.length > 3 ? ` 等 ${blocked.length} 个` : ""}），` +
          `这些内容在成片里会缺失；渲染环境不联网，需要的东西请内联`,
      );
    }
    if (pageErrors.length) {
      warnings.push(`页面脚本报错：${pageErrors.join(" | ")}，画面可能不完整`);
    }
    return warnings;
  } catch (err) {
    // 取消时是我们主动关的浏览器，此时浏览器侧报的是"已关闭"，对调用方没有意义，统一成取消
    if (opts.signal?.aborted) throw new Error("渲染已取消");
    throw err;
  } finally {
    clearTimeout(watchdog);
    opts.signal?.removeEventListener("abort", onAbort);
    await browser.close().catch(() => {});
  }
}

// ── 渲染器 ────────────────────────────────────────────────────────────────

export class NodeMediaRenderer implements HostMediaRenderer {
  async checkEnv(): Promise<MediaRenderEnv> {
    // 本地已有 → 立即可用；本地没有但能自动获取 → 也算可用（首次渲染时下载，见 render）
    // 只有"本机没有、这个平台又拿不到"才算不可用
    if (await findFfmpeg()) return { ok: true };
    if (pickAsset(process.platform, process.arch)) return { ok: true };
    return {
      ok: false,
      problem:
        `当前系统（${process.platform}-${process.arch}）没有可自动获取的渲染组件。` +
        `请安装 ffmpeg 并加入 PATH，或用环境变量 AXON_FFMPEG_PATH 指定 ffmpeg 可执行文件路径。`,
    };
  }

  async render(req: MediaRenderRequest): Promise<MediaRenderResult> {
    // 首次渲染会在这里自动下载 ffmpeg（约 100~170MB，只下一次，之后走缓存）
    const ffmpeg = (
      await ensureFfmpeg({
        signal: req.signal,
        onProgress: ({ phase, doneBytes, totalBytes }) => {
          if (phase === "download") req.onProgress?.({ phase: "provision", done: doneBytes, total: totalBytes });
          else req.onProgress?.({ phase: "provision", done: 0, total: 0 });
        },
      })
    ).bin;

    const tmp = await mkdtemp(join(tmpdir(), "axon-media-"));
    const warnings: string[] = [];

    const throwIfAborted = () => {
      if (req.signal?.aborted) throw new Error("渲染已取消");
    };

    try {
      // 1) 旁白：先于画面，因为成片时长要由它决定
      let audioPath: string | undefined;
      let audioSec = 0;
      if (req.narration && req.format === "mp4") {
        req.onProgress?.({ phase: "narration", done: 0, total: 1 });
        try {
          audioPath = await synthesizeNarration(req.narration, tmp, req.signal);
          audioSec = await probeAudioSeconds(ffmpeg, audioPath, req.signal);
        } catch (err) {
          throwIfAborted();
          audioPath = undefined;
          warnings.push(`旁白合成失败（${(err as Error).message}），成片没有声音`);
        }
        req.onProgress?.({ phase: "narration", done: 1, total: 1 });
      }

      // 2) 定时长与帧数
      let durationSec = req.durationSec;
      if (audioPath) {
        const needed = audioSec + NARRATION_TAIL_SEC;
        if (needed > MEDIA_LIMITS.maxDurationSec) {
          durationSec = MEDIA_LIMITS.maxDurationSec;
          warnings.push(`旁白约 ${audioSec.toFixed(0)} 秒，超过成片上限 ${MEDIA_LIMITS.maxDurationSec} 秒，结尾的旁白被截断`);
        } else if (needed > durationSec) {
          warnings.push(
            `旁白约 ${audioSec.toFixed(1)} 秒，比设定的 ${durationSec} 秒长，成片已延长到 ${Math.ceil(needed * 10) / 10} 秒；` +
              `画面动画只设计了 ${durationSec} 秒，之后会停在最后一帧`,
          );
          durationSec = Math.ceil(needed * 10) / 10;
        }
      }
      let fps = req.fps;
      if (durationSec * fps > MEDIA_LIMITS.maxFrames) fps = Math.max(1, Math.floor(MEDIA_LIMITS.maxFrames / durationSec));
      const frameCount = Math.max(1, Math.round(durationSec * fps));

      // 3) 逐帧截图（浏览器生命周期、取消、兜底超时都在 captureFrames 里）
      // 音效与画面共用同一次浏览器会话：页面里的 OfflineAudioContext 不依赖假时钟，截完帧再算音频即可。
      const sfxPath = req.format === "mp4" ? join(tmp, "soundtrack.wav") : undefined;
      const captureWarnings = await captureFrames({
        html: req.html,
        width: req.width,
        height: req.height,
        fps,
        frameCount,
        dir: tmp,
        audio: sfxPath
          ? { sampleRate: MEDIA_LIMITS.audioSampleRate, outPath: sfxPath, durationSec: frameCount / fps }
          : undefined,
        signal: req.signal,
        onProgress: (done, total) => req.onProgress?.({ phase: "frames", done, total }),
      });
      warnings.push(...captureWarnings);
      // 4) 编码
      throwIfAborted();
      req.onProgress?.({ phase: "encoding", done: 0, total: 1 });
      const encoded = join(tmp, req.format === "gif" ? "out.gif" : "out.mp4");
      const input = ["-framerate", String(fps), "-i", join(tmp, "frame_%06d.png")];
      // 音效只有页面真的定义了 window.renderAudio 才会写出文件，没写出就代表这条片子只有旁白/无声
      const hasSfx = sfxPath ? !!(await stat(sfxPath).catch(() => null)) : false;
      let hasNarration = false;

      if (req.format === "gif") {
        await runFfmpeg(
          ffmpeg,
          [
            ...input,
            "-vf", "split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
            "-loop", "0",
            encoded,
          ],
          req.signal,
        );
      } else {
        // 只有 mp4 才需要 H.264 编码器。探测放在这个分支里而不是开头：
        // 否则一份没有 H.264 的 ffmpeg 会让本来能出的 GIF 也一起失败。
        const encoder = await detectVideoEncoder(ffmpeg);
        const audioInputs = [audioPath, hasSfx ? sfxPath : undefined].filter((p): p is string => !!p);
        hasNarration = !!audioPath;
        // 视频后处理要拆两路做 bloom，和音频混流一起走 filter_complex：
        // 保证视频/音频各自只有一个输出映射，避免 -vf 与 -filter_complex 抢同一个输出流。
        const extraInputs = audioInputs.flatMap((p) => ["-i", p]);
        let graph: string;
        let streamMaps: string[];
        if (audioInputs.length === 2) {
          // 旁白 + 音效：normalize=0 保持各自音量，否则 amix 默认把两路各压一半，旁白会变得很小声
          graph = `[0:v]${POST_FX_FILTER}[v];[1:a][2:a]amix=inputs=2:duration=longest:normalize=0,apad[a]`;
          streamMaps = ["-map", "[v]", "-map", "[a]", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-shortest"];
        } else if (audioInputs.length === 1) {
          // apad 把音频补成无限长、-shortest 再按画面截断：声音比画面短时尾部补静音，而不是把画面截短
          graph = `[0:v]${POST_FX_FILTER}[v];[1:a]apad[a]`;
          streamMaps = ["-map", "[v]", "-map", "[a]", "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-shortest"];
        } else {
          graph = `[0:v]${POST_FX_FILTER}[v]`;
          streamMaps = ["-map", "[v]"];
        }
        await runFfmpeg(
          ffmpeg,
          [
            ...input,
            ...extraInputs,
            "-filter_complex", graph,
            ...streamMaps,
            ...videoEncodeArgs(encoder, req.width, req.height, fps),
            "-movflags", "+faststart",
            encoded,
          ],
          req.signal,
        );
      }
      req.onProgress?.({ phase: "encoding", done: 1, total: 1 });

      // 5) 编码成功后才落到目标位置：失败时产物目录里不会留下半截文件
      await mkdir(dirname(req.outputPath), { recursive: true });
      await copyFile(encoded, req.outputPath);
      const size = (await stat(req.outputPath)).size;

      return {
        outputPath: req.outputPath,
        durationSec: frameCount / fps,
        hasAudio: hasNarration || hasSfx,
        hasSoundtrack: hasSfx,
        frameCount,
        size,
        warnings,
      };
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
}
