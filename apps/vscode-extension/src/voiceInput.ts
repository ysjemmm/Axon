/**
 * 语音输入：在扩展进程里录音，录完交给语音识别服务转成文字，填回输入框。
 *
 * ── 为什么不在界面里录 ──
 * VS Code 的 webview 拿不到麦克风：主进程的权限处理只给 webview 放行剪贴板，
 * getUserMedia 一律被拒，iframe 也没有 allow="microphone"。所以录音只能放在扩展进程，
 * 由系统自带的录音能力或 ffmpeg 来做。
 *
 * ── 录音后端（按平台挑，挑不到给出明确的安装建议）──
 *   · Windows：PowerShell 调系统自带的 winmm（MCI），零依赖；录音电平也由它报
 *   · macOS：ffmpeg（avfoundation）→ sox 的 rec
 *   · Linux：arecord（ALSA 自带）→ ffmpeg（pulse / alsa）
 * 除 Windows 外都让录音程序把 16kHz 单声道 PCM 写到标准输出，这边边收边算音量（界面画波形），
 * 停止时自己拼成 WAV。
 *
 * ── 识别 ──
 * 走 OpenAI 兼容的 /audio/transcriptions（OpenAI、硅基流动、Groq 等都支持），
 * 复用已配置的 Provider 的地址和 Key，用户只需选 Provider 和模型。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findFfmpeg } from "@axon/host-node";
import { getResolvedProviders, resolveProviderName } from "@axon/core";

/** 语音输入配置（用户级 providers.json 的 voiceInput 字段） */
export interface VoiceInputConfig {
  /** 用哪个 Provider 的地址和 Key；"builtin" 表示内置的硅基流动 */
  provider: string;
  /** 识别模型，如 whisper-1 / gpt-4o-mini-transcribe / FunAudioLLM/SenseVoiceSmall */
  model: string;
  /** 语言（ISO-639-1，如 zh / en）；留空让服务自动判断 */
  language?: string;
}

/**
 * 内置识别服务：硅基流动的 SenseVoiceSmall（免费，中文效果好）。
 * Key 在打包时由 esbuild 注入（见 esbuild.mjs 的 define），源码和 git 里没有；
 * 开发时也可以用同名环境变量。用户在设置里选了自己的 Provider 就不再用内置的。
 */
declare const __AXON_BUILTIN_VOICE_KEY__: string;
export const BUILTIN_VOICE = {
  label: "硅基流动（内置）",
  baseUrl: "https://api.siliconflow.cn/v1",
  model: "FunAudioLLM/SenseVoiceSmall",
};
/** 设置里「用内置服务」存成这个 provider 名 */
export const BUILTIN_VOICE_PROVIDER = "builtin";

function builtinVoiceKey(): string {
  const injected = typeof __AXON_BUILTIN_VOICE_KEY__ === "string" ? __AXON_BUILTIN_VOICE_KEY__ : "";
  return (injected || process.env.AXON_BUILTIN_VOICE_KEY || "").trim();
}

export function builtinVoiceAvailable(): boolean {
  return !!builtinVoiceKey();
}

/** 识别请求实际要用的地址 / Key / 模型 */
interface VoiceEndpoint {
  label: string;
  baseUrl: string;
  apiKey: string;
  apiKeyHeader?: string;
  model: string;
  language?: string;
}

/**
 * 解析出这次要用的识别服务：用户选了自己的 Provider 就用它；
 * 没配置或选了「内置」就用内置的硅基流动。都用不了返回 null（界面引导去设置）。
 */
export function resolveVoiceEndpoint(cfg: VoiceInputConfig | undefined): VoiceEndpoint | null {
  if (cfg && cfg.provider !== BUILTIN_VOICE_PROVIDER) {
    const name = resolveProviderName(cfg.provider) ?? cfg.provider;
    const p = getResolvedProviders().find((x) => x.name === name);
    if (!p || !p.apiKey) return null;
    return { label: p.label || p.name, baseUrl: p.baseUrl, apiKey: p.apiKey, apiKeyHeader: p.apiKeyHeader, model: cfg.model, language: cfg.language };
  }
  const key = builtinVoiceKey();
  if (!key) return null;
  return { label: BUILTIN_VOICE.label, baseUrl: BUILTIN_VOICE.baseUrl, apiKey: key, model: BUILTIN_VOICE.model, language: cfg?.language };
}

const SAMPLE_RATE = 16_000;
/** 单次录音上限：16kHz 单声道 16bit 每分钟约 1.9MB，10 分钟远低于识别接口常见的 25MB 上限 */
const MAX_SECONDS = 600;

interface Recording {
  proc: ChildProcess;
  backend: string;
  startedAt: number;
  /** stdout PCM 后端：收到的音频 */
  chunks: Buffer[];
  /** 自上次取电平以来的音量（0~1），界面据此画波形 */
  levels: number[];
  /** Windows MCI：停止标记文件与输出 WAV */
  stopFlag?: string;
  wavPath?: string;
  tmpDir?: string;
  stderr: string;
  exited: Promise<number | null>;
  timer: ReturnType<typeof setTimeout>;
}

let current: Recording | null = null;

/** 16bit 小端 PCM 的均方根音量，映射到 0~1（对数刻度，说话声能明显动起来） */
function pcmLevel(buf: Buffer): number {
  const n = Math.floor(buf.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  const db = 20 * Math.log10(rms + 1e-9);
  return Math.max(0, Math.min(1, (db + 55) / 50));
}

function wavFromPcm(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function onPath(bin: string): boolean {
  const dirs = (process.env.PATH || "").split(process.platform === "win32" ? ";" : ":");
  return dirs.some((d) => d && existsSync(join(d, bin)));
}

/**
 * Windows：PowerShell + winmm MCI。每 80ms 输出一行「L <电平>」；停止标记文件出现后保存 WAV 并退出。
 * MCI 的 status level 在录音时返回当前采样幅度（16bit 时 0~32767）。
 */
function mciScript(wavPath: string, stopFlag: string): string {
  const esc = (p: string) => p.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -Namespace AxonVoice -Name Mci -MemberDefinition @'
[DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern int mciSendString(string cmd, System.Text.StringBuilder ret, int len, IntPtr hwnd);
[DllImport("winmm.dll", CharSet = CharSet.Unicode)] public static extern bool mciGetErrorString(int err, System.Text.StringBuilder buf, int len);
'@
function Mci([string]$c) {
  $sb = New-Object System.Text.StringBuilder 256
  $r = [AxonVoice.Mci]::mciSendString($c, $sb, 256, [IntPtr]::Zero)
  if ($r -ne 0) {
    $e = New-Object System.Text.StringBuilder 256
    [void][AxonVoice.Mci]::mciGetErrorString($r, $e, 256)
    [Console]::Error.WriteLine("MCI 错误 $r（$c）：$($e.ToString())")
    exit 2
  }
  return $sb.ToString()
}
Mci 'open new type waveaudio alias axonrec' | Out-Null
Mci 'set axonrec format tag pcm bitspersample 16 channels 1 samplespersec ${SAMPLE_RATE} bytespersec ${SAMPLE_RATE * 2} alignment 2' | Out-Null
Mci 'record axonrec' | Out-Null
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
while (-not (Test-Path -LiteralPath '${esc(stopFlag)}')) {
  $sb = New-Object System.Text.StringBuilder 64
  $lv = if ([AxonVoice.Mci]::mciSendString('status axonrec level', $sb, 64, [IntPtr]::Zero) -eq 0) { $sb.ToString() } else { '0' }
  [Console]::Out.WriteLine("L $lv"); [Console]::Out.Flush()
  Start-Sleep -Milliseconds 80
}
Mci 'stop axonrec' | Out-Null
Mci 'save axonrec "${esc(wavPath.replace(/"/g, ""))}"' | Out-Null
Mci 'close axonrec' | Out-Null
[Console]::Out.WriteLine('SAVED'); [Console]::Out.Flush()
`;
}

/** 拼出当前平台可用的 PCM 录音命令（stdout 输出 s16le / 16kHz / 单声道）；都没有返回 null */
async function pcmRecorderCommand(): Promise<{ bin: string; args: string[]; backend: string } | null> {
  const pcmOut = ["-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"];
  if (process.platform === "linux" && onPath("arecord")) {
    return { bin: "arecord", args: ["-q", "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw"], backend: "arecord" };
  }
  const ff = await findFfmpeg().catch(() => null);
  if (ff) {
    const input = process.platform === "darwin"
      ? ["-f", "avfoundation", "-i", ":default"]
      : process.platform === "linux"
        ? ["-f", onPath("pactl") || onPath("pipewire") ? "pulse" : "alsa", "-i", "default"]
        : null;
    if (input) return { bin: ff.bin, args: ["-hide_banner", "-loglevel", "error", "-nostdin", ...input, ...pcmOut], backend: "ffmpeg" };
  }
  if (process.platform === "darwin" && onPath("rec")) {
    return { bin: "rec", args: ["-q", "-t", "raw", "-b", "16", "-e", "signed-integer", "-c", "1", "-r", String(SAMPLE_RATE), "-"], backend: "sox" };
  }
  return null;
}

function missingRecorderHint(): string {
  if (process.platform === "darwin") return "没有找到可用的录音程序。请安装 ffmpeg（brew install ffmpeg）或 sox（brew install sox）后重试。";
  if (process.platform === "linux") return "没有找到可用的录音程序。请安装 alsa-utils（提供 arecord）或 ffmpeg 后重试。";
  return "当前系统不支持录音。";
}

export function isRecording(): boolean {
  return !!current;
}

/** 开始录音。已在录就直接返回 */
export async function startRecording(): Promise<void> {
  if (current) return;
  let rec: Recording;
  if (process.platform === "win32") {
    const dir = await mkdtemp(join(tmpdir(), "axon-voice-"));
    const wavPath = join(dir, "voice.wav");
    const stopFlag = join(dir, "stop");
    const encoded = Buffer.from(mciScript(wavPath, stopFlag), "utf16le").toString("base64");
    const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true });
    rec = makeRecording(proc, "mci", { stopFlag, wavPath, tmpDir: dir });
    // MCI 报的是 16bit 采样幅度：换算成和 PCM 后端同一套 0~1 刻度
    let buf = "";
    proc.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const m = /^L\s+(\d+)/.exec(line);
        if (m) {
          const amp = Math.min(32767, Number(m[1])) / 32768;
          const db = 20 * Math.log10(amp + 1e-9);
          rec.levels.push(Math.max(0, Math.min(1, (db + 55) / 50)));
        }
      }
    });
    await waitReady(rec, (resolveReady) => {
      const onData = (d: Buffer) => { if (d.toString().includes("READY")) { proc.stdout!.off("data", onData); resolveReady(); } };
      proc.stdout!.on("data", onData);
    });
  } else {
    const cmd = await pcmRecorderCommand();
    if (!cmd) throw new Error(missingRecorderHint());
    const proc = spawn(cmd.bin, cmd.args, { stdio: ["ignore", "pipe", "pipe"] });
    rec = makeRecording(proc, cmd.backend, {});
    let pending = Buffer.alloc(0);
    const frame = SAMPLE_RATE * 2 * 0.08; // 80ms 一个电平点
    proc.stdout!.on("data", (d: Buffer) => {
      rec.chunks.push(d);
      pending = Buffer.concat([pending, d]);
      while (pending.length >= frame) {
        rec.levels.push(pcmLevel(pending.subarray(0, frame)));
        pending = pending.subarray(frame);
      }
    });
    await waitReady(rec, (resolveReady) => {
      // 收到第一段音频才算真正开录（权限弹窗、设备打开失败都会在这之前暴露）
      proc.stdout!.once("data", () => resolveReady());
    });
  }
  current = rec;
}

function makeRecording(proc: ChildProcess, backend: string, extra: Partial<Recording>): Recording {
  const rec: Recording = {
    proc,
    backend,
    startedAt: Date.now(),
    chunks: [],
    levels: [],
    stderr: "",
    exited: new Promise((resolve) => {
      proc.on("exit", (code) => resolve(code));
      proc.on("error", (err) => { rec.stderr += String(err.message); resolve(-1); });
    }),
    // 忘了停：到上限自动停下，免得麦克风一直开着
    timer: setTimeout(() => { if (current === rec) void stopRecording().catch(() => undefined); }, MAX_SECONDS * 1000),
    ...extra,
  };
  proc.stderr?.on("data", (d: Buffer) => { if (rec.stderr.length < 4000) rec.stderr += d.toString(); });
  return rec;
}

/** 等录音程序真正开始；先退出或超时没动静就报错（带上它的错误输出） */
async function waitReady(rec: Recording, hook: (resolve: () => void) => void): Promise<void> {
  const ready = new Promise<void>((resolve) => hook(resolve));
  const result = await Promise.race([
    ready.then(() => "ready" as const),
    rec.exited.then(() => "exited" as const),
    // Windows 首次要编译一段 C# 声明（Add-Type），杀毒软件扫描时会慢一些
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), rec.backend === "mci" ? 15_000 : 8000)),
  ]);
  if (result === "ready") return;
  clearTimeout(rec.timer);
  rec.proc.kill();
  if (rec.tmpDir) void rm(rec.tmpDir, { recursive: true, force: true });
  const detail = rec.stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300);
  throw new Error(`麦克风没有打开${result === "timeout" ? "（等待超时）" : ""}。请确认麦克风已连接、系统允许 VS Code 使用麦克风。${detail ? `\n${detail}` : ""}`);
}

/** 取走自上次以来的电平点与已录时长 */
export function takeLevels(): { recording: boolean; levels: number[]; seconds: number } {
  if (!current) return { recording: false, levels: [], seconds: 0 };
  const levels = current.levels;
  current.levels = [];
  return { recording: true, levels, seconds: Math.floor((Date.now() - current.startedAt) / 1000) };
}

/** 停止录音，返回 WAV；cancel 时丢弃录音返回 null */
export async function stopRecording(cancel = false): Promise<Buffer | null> {
  const rec = current;
  if (!rec) return null;
  current = null;
  clearTimeout(rec.timer);
  try {
    if (rec.backend === "mci") {
      if (cancel) { rec.proc.kill(); return null; }
      await writeFile(rec.stopFlag!, "");
      const code = await Promise.race([rec.exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000))]);
      if (code === "timeout") rec.proc.kill();
      if (!existsSync(rec.wavPath!)) throw new Error(`录音没有保存下来。${rec.stderr.trim().slice(0, 300)}`);
      return await readFile(rec.wavPath!);
    }
    // PCM 后端：让程序正常结束（ffmpeg 收到 SIGINT 会刷完缓冲），没反应再强杀
    rec.proc.kill("SIGINT");
    const code = await Promise.race([rec.exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000))]);
    if (code === "timeout") rec.proc.kill("SIGKILL");
    if (cancel) return null;
    const pcm = Buffer.concat(rec.chunks);
    if (pcm.length < SAMPLE_RATE * 2 * 0.3) throw new Error("录音太短了，按住说完再停。");
    return wavFromPcm(pcm);
  } finally {
    if (rec.tmpDir) void rm(rec.tmpDir, { recursive: true, force: true });
  }
}

/** 中文提示词：让 Whisper 一类模型输出简体中文并带标点（不加时它常给出无标点或繁体的结果） */
const ZH_PROMPT = "以下是普通话的句子，使用简体中文，带标点符号。";

/**
 * 把录音交给识别服务，返回文字。
 * 不走 OpenAI SDK：它配上全局 fetch 后上传文件会报「duplex option is required」，
 * 直接用原生 fetch + FormData 发 multipart 最省事。
 */
export async function transcribe(wav: Buffer, ep: VoiceEndpoint): Promise<string> {
  const language = (ep.language || "").trim();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "voice.wav");
  form.append("model", ep.model);
  form.append("response_format", "json");
  if (language) form.append("language", language);
  if (!language || language.startsWith("zh")) form.append("prompt", ZH_PROMPT);
  const headers: Record<string, string> = ep.apiKeyHeader === "x-api-key" ? { "x-api-key": ep.apiKey } : { Authorization: `Bearer ${ep.apiKey}` };
  const url = `${ep.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: form, signal: AbortSignal.timeout(110_000) });
  } catch (err) {
    throw new Error(`语音识别请求没有发出去：${(err as Error).message}`);
  }
  const raw = await res.text();
  if (res.status === 404) throw new Error(`「${ep.label}」不支持语音识别接口（/audio/transcriptions 返回 404）。换一个支持的服务商，比如 OpenAI、硅基流动、Groq。`);
  if (!res.ok) {
    let msg = raw.slice(0, 300);
    try { msg = (JSON.parse(raw) as { error?: { message?: string }; message?: string }).error?.message || JSON.parse(raw).message || msg; } catch { /* 原样显示 */ }
    throw new Error(`语音识别失败（HTTP ${res.status}）：${msg}`);
  }
  try {
    return String((JSON.parse(raw) as { text?: string }).text ?? "").trim();
  } catch {
    return raw.trim(); // 少数服务即使要了 json 也回纯文本
  }
}
