/**
 * 语音输入：在扩展进程里录音，录完交给语音识别服务转成文字，填回输入框。
 *
 * ── 为什么不在界面里录 ──
 * VS Code 的 webview 拿不到麦克风：主进程的权限处理只给 webview 放行剪贴板，
 * getUserMedia 一律被拒，iframe 也没有 allow="microphone"。所以录音只能放在扩展进程，
 * 由系统自带的录音能力或 ffmpeg 来做。
 *
 * ── 录音后端（按平台挑，挑不到给出明确的安装建议）──
 *   · Windows：PowerShell 里调系统自带的 winmm waveIn，零依赖
 *   · macOS：系统自带的 osascript 调 AVFoundation，零依赖（找不到 osascript 才退回 ffmpeg / sox）
 *   · Linux：arecord（ALSA 自带）→ ffmpeg（pulse / alsa）
 * 除 macOS 外都让录音程序把 16kHz 单声道 PCM 写到标准输出，这边边收边算音量（界面画波形），
 * 停止时自己拼成 WAV；macOS 由系统录音器写文件、实时报分贝。
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
  /** 用哪个 Provider 的地址和 Key */
  provider: string;
  /** 识别模型，如 whisper-1 / gpt-4o-mini-transcribe / FunAudioLLM/SenseVoiceSmall */
  model: string;
  /** 语言（ISO-639-1，如 zh / en）；留空让服务自动判断 */
  language?: string;
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
  /** macOS：录音写到这个文件，停止标记文件出现后录音程序收尾退出 */
  wavPath?: string;
  stopFlag?: string;
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
 * Windows：PowerShell 里编译一小段 C#，直接调系统自带的 winmm waveIn 接口录音，
 * 把 16kHz 单声道 PCM 原样写到标准输出 —— 和其它平台的录音程序同一套处理（实时音量、拼 WAV）。
 *
 * 早先用 MCI（mciSendString record / save）：拿不到实时音频，音量只能靠 status level，
 * 不少机器上它一直返回 0，波形是平的；录到的是不是静音也只有录完才知道。
 * waveIn 是最底层的录音接口，任何 Windows 都有，不用装东西。
 */
function waveInScript(action: string): string {
  return `
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class AxonWaveIn {
  [StructLayout(LayoutKind.Sequential, Pack = 2)]
  struct WaveFormat { public ushort tag; public ushort channels; public uint rate; public uint bytesPerSec; public ushort align; public ushort bits; public ushort cb; }
  [DllImport("winmm.dll")] static extern int waveInGetNumDevs();
  [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr h, uint dev, ref WaveFormat f, IntPtr cb, IntPtr inst, uint flags);
  [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr h, IntPtr hdr, uint size);
  [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr h, IntPtr hdr, uint size);
  [DllImport("winmm.dll")] static extern int waveInStart(IntPtr h);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct WaveInCaps { public ushort mid; public ushort pid; public uint driverVersion; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string name; public uint formats; public ushort channels; public ushort reserved; }
  [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern int waveInGetDevCapsW(UIntPtr id, ref WaveInCaps caps, uint size);
  static string DeviceName(int i) {
    WaveInCaps c = new WaveInCaps();
    return waveInGetDevCapsW((UIntPtr)(uint)i, ref c, (uint)Marshal.SizeOf(typeof(WaveInCaps))) == 0 ? c.name : null;
  }
  // 每行「序号<TAB>名称」，UTF-8 输出（设备名常有中文）
  public static int List() {
    Stream o = Console.OpenStandardOutput();
    int n = waveInGetNumDevs();
    for (int i = 0; i < n; i++) {
      string name = DeviceName(i);
      if (name == null) continue;
      byte[] b = System.Text.Encoding.UTF8.GetBytes(i + "\\t" + name + "\\n");
      o.Write(b, 0, b.Length);
    }
    o.Flush();
    return 0;
  }
  // 按名称找设备（序号会随插拔变化，名称稳定）；找不到用系统默认
  static uint FindDevice(string name) {
    if (string.IsNullOrEmpty(name)) return 0xFFFFFFFF;
    int n = waveInGetNumDevs();
    for (int i = 0; i < n; i++) if (DeviceName(i) == name) return (uint)i;
    return 0xFFFFFFFF;
  }
  public static int Run(int rate, string device) {
    if (waveInGetNumDevs() == 0) { Console.Error.WriteLine("没有检测到录音设备（麦克风）"); return 3; }
    WaveFormat f = new WaveFormat();
    f.tag = 1; f.channels = 1; f.rate = (uint)rate; f.bytesPerSec = (uint)(rate * 2); f.align = 2; f.bits = 16; f.cb = 0;
    IntPtr h;
    int r = waveInOpen(out h, FindDevice(device), ref f, IntPtr.Zero, IntPtr.Zero, 0);
    if (r != 0) { Console.Error.WriteLine("打开麦克风失败（waveInOpen " + r + "）"); return 2; }
    // WAVEHDR：lpData, dwBufferLength, dwBytesRecorded, dwUser, dwFlags, dwLoops, lpNext, reserved
    int ps = IntPtr.Size;
    uint hdrSize = (uint)(ps * 4 + 16);
    int recOff = ps + 4, flagsOff = ps * 2 + 8;
    int bufBytes = rate * 2 / 10;
    const int N = 4;
    IntPtr[] hdrs = new IntPtr[N];
    for (int i = 0; i < N; i++) {
      IntPtr hdr = Marshal.AllocHGlobal((int)hdrSize);
      for (int k = 0; k < hdrSize; k++) Marshal.WriteByte(hdr, k, 0);
      Marshal.WriteIntPtr(hdr, 0, Marshal.AllocHGlobal(bufBytes));
      Marshal.WriteInt32(hdr, ps, bufBytes);
      waveInPrepareHeader(h, hdr, hdrSize);
      waveInAddBuffer(h, hdr, hdrSize);
      hdrs[i] = hdr;
    }
    r = waveInStart(h);
    if (r != 0) { Console.Error.WriteLine("开始录音失败（waveInStart " + r + "）"); return 2; }
    Stream o = Console.OpenStandardOutput();
    byte[] tmp = new byte[bufBytes];
    int next = 0;
    while (true) {
      IntPtr hdr = hdrs[next];
      int flags = Marshal.ReadInt32(hdr, flagsOff);
      if ((flags & 1) == 0) { Thread.Sleep(10); continue; }
      int n = Marshal.ReadInt32(hdr, recOff);
      if (n > 0) { Marshal.Copy(Marshal.ReadIntPtr(hdr, 0), tmp, 0, n); o.Write(tmp, 0, n); o.Flush(); }
      Marshal.WriteInt32(hdr, flagsOff, flags & ~1);
      waveInAddBuffer(h, hdr, hdrSize);
      next = (next + 1) % N;
    }
  }
}
'@
# 编译结果缓存到临时目录：第一次要编译一两秒，之后直接加载；缓存坏了就退回内存编译
$dll = Join-Path $env:TEMP 'axon-wavein-v2.dll'
try {
  if (-not (Test-Path -LiteralPath $dll)) { Add-Type -TypeDefinition $src -OutputAssembly $dll -OutputType Library }
  Add-Type -Path $dll
} catch {
  Add-Type -TypeDefinition $src
}
exit (${action})
`;
}

/**
 * macOS：用系统自带的 osascript（JavaScript for Automation）调 AVFoundation 的 AVAudioRecorder，零依赖。
 * 录到 16kHz 单声道 WAV 文件；每 80ms 输出一行「L <分贝>」给界面画波形；停止标记文件出现后收尾退出。
 *
 * 不用 ffmpeg：Axon 自动下载的 macOS ffmpeg 为了许可干净关掉了自动探测（--disable-autodetect），
 * 不带 avfoundation 录音输入，用户自己没装 Homebrew 版就录不了。
 */
const MAC_RECORDER_JXA = `
ObjC.import('AVFoundation');
ObjC.import('Foundation');
function out(s) {
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(s + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
}
function run(argv) {
  var settings = $.NSMutableDictionary.alloc.init;
  settings.setObjectForKey($.NSNumber.numberWithInt(1819304813), $('AVFormatIDKey'));
  settings.setObjectForKey($.NSNumber.numberWithDouble(${SAMPLE_RATE}), $('AVSampleRateKey'));
  settings.setObjectForKey($.NSNumber.numberWithInt(1), $('AVNumberOfChannelsKey'));
  settings.setObjectForKey($.NSNumber.numberWithInt(16), $('AVLinearPCMBitDepthKey'));
  settings.setObjectForKey($.NSNumber.numberWithBool(false), $('AVLinearPCMIsFloatKey'));
  settings.setObjectForKey($.NSNumber.numberWithBool(false), $('AVLinearPCMIsBigEndianKey'));
  var err = Ref();
  var rec = $.AVAudioRecorder.alloc.initWithURLSettingsError($.NSURL.fileURLWithPath(argv[0]), settings, err);
  if (!rec || rec.isNil()) { throw new Error('无法创建录音器'); }
  rec.meteringEnabled = true;
  if (!rec.record) { throw new Error('无法开始录音'); }
  out('READY');
  var fm = $.NSFileManager.defaultManager;
  while (!fm.fileExistsAtPath(argv[1])) {
    rec.updateMeters;
    out('L ' + rec.averagePowerForChannel(0));
    delay(0.08);
  }
  rec.stop;
  out('SAVED');
}
`;

/** macOS：列出录音设备，每行「uniqueID<TAB>名称」 */
const MAC_LIST_JXA = `
ObjC.import('AVFoundation');
ObjC.import('Foundation');
function run() {
  var ds = $.AVCaptureDevice.devicesWithMediaType($('soun'));
  var lines = [];
  for (var i = 0; i < ds.count; i++) {
    var d = ds.objectAtIndex(i);
    lines.push(d.uniqueID.js + '\\t' + d.localizedName.js);
  }
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(lines.join('\\n') + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
}
`;

/**
 * macOS：从指定设备录音。AVAudioRecorder 只能用系统默认输入，指定设备要走 AVCaptureSession +
 * AVCaptureAudioFileOutput；音量从连接的 audioChannels 读（同样是分贝）。输出协议与 MAC_RECORDER_JXA 一致。
 */
const MAC_DEVICE_RECORDER_JXA = `
ObjC.import('AVFoundation');
ObjC.import('Foundation');
function out(s) {
  $.NSFileHandle.fileHandleWithStandardOutput.writeData($(s + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
}
function spin(sec) {
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(sec));
}
var finished = false;
ObjC.registerSubclass({
  name: 'AxonRecordingDelegate',
  protocols: ['AVCaptureFileOutputRecordingDelegate'],
  methods: {
    'captureOutput:didFinishRecordingToOutputFileAtURL:fromConnections:error:': {
      types: ['void', ['id', 'id', 'id', 'id']],
      implementation: function () { finished = true; }
    }
  }
});
function run(argv) {
  var dev = $.AVCaptureDevice.deviceWithUniqueID($(argv[2]));
  if (!dev || dev.isNil()) { throw new Error('找不到选中的麦克风，可能已断开'); }
  var err = Ref();
  var input = $.AVCaptureDeviceInput.deviceInputWithDeviceError(dev, err);
  if (!input || input.isNil()) { throw new Error('无法打开选中的麦克风'); }
  var session = $.AVCaptureSession.alloc.init;
  session.addInput(input);
  var output = $.AVCaptureAudioFileOutput.alloc.init;
  var settings = $.NSMutableDictionary.alloc.init;
  settings.setObjectForKey($.NSNumber.numberWithInt(1819304813), $('AVFormatIDKey'));
  settings.setObjectForKey($.NSNumber.numberWithDouble(${SAMPLE_RATE}), $('AVSampleRateKey'));
  settings.setObjectForKey($.NSNumber.numberWithInt(1), $('AVNumberOfChannelsKey'));
  settings.setObjectForKey($.NSNumber.numberWithInt(16), $('AVLinearPCMBitDepthKey'));
  settings.setObjectForKey($.NSNumber.numberWithBool(false), $('AVLinearPCMIsFloatKey'));
  settings.setObjectForKey($.NSNumber.numberWithBool(false), $('AVLinearPCMIsBigEndianKey'));
  settings.setObjectForKey($.NSNumber.numberWithBool(false), $('AVLinearPCMIsNonInterleaved'));
  output.audioSettings = settings;
  session.addOutput(output);
  session.startRunning;
  output.startRecordingToOutputFileURLOutputFileTypeRecordingDelegate($.NSURL.fileURLWithPath(argv[0]), $('com.microsoft.waveform-audio'), $.AxonRecordingDelegate.alloc.init);
  out('READY');
  var fm = $.NSFileManager.defaultManager;
  while (!fm.fileExistsAtPath(argv[1])) {
    var db = -160;
    var conns = output.connections;
    if (conns.count > 0) {
      var chans = conns.objectAtIndex(0).audioChannels;
      if (chans.count > 0) db = chans.objectAtIndex(0).averagePowerLevel;
    }
    out('L ' + db);
    spin(0.08);
  }
  output.stopRecording;
  for (var i = 0; i < 40 && !finished; i++) spin(0.05);
  session.stopRunning;
  out('SAVED');
}
`;

/** 从 WAV 文件里取出 data 块（AVAudioRecorder 写的 WAV 前面常带 FLLR 之类的填充块，不能按 44 字节头硬切） */
function pcmFromWav(wav: Buffer): Buffer {
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "data") return wav.subarray(off + 8, Math.min(wav.length, off + 8 + size));
    off += 8 + size + (size % 2);
  }
  return Buffer.alloc(0);
}

/** 拼出当前平台可用的 PCM 录音命令（stdout 输出 s16le / 16kHz / 单声道）；都没有返回 null */
async function pcmRecorderCommand(device?: InputDevice | null): Promise<{ bin: string; args: string[]; backend: string } | null> {
  const pcmOut = ["-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"];
  if (process.platform === "win32") {
    // 设备名作为 PowerShell 单引号字符串传入：单引号内只需把 ' 写成 ''，其余原样（不会展开 $）
    const name = (device?.name ?? "").replace(/'/g, "''");
    const encoded = Buffer.from(waveInScript(`[AxonWaveIn]::Run(${SAMPLE_RATE}, '${name}')`), "utf16le").toString("base64");
    return { bin: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], backend: "waveIn" };
  }
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

/** 录音设备（id 用于录音，name 给人看；Windows 按名称匹配，因为序号会随插拔变化） */
export interface InputDevice {
  id: string;
  name: string;
}

function runCapture(bin: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { proc.kill(); reject(new Error("列出设备超时")); }, timeoutMs);
    proc.stdout!.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    proc.stderr!.on("data", (d: Buffer) => { err += d.toString(); });
    proc.on("error", (e) => { clearTimeout(timer); reject(e); });
    proc.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(err.trim().slice(0, 300) || `退出码 ${code}`)); });
  });
}

/** 列出本机的录音设备；不支持列举的平台返回空数组（界面只显示「系统默认」） */
export async function listInputDevices(): Promise<InputDevice[]> {
  let raw = "";
  if (process.platform === "win32") {
    const encoded = Buffer.from(waveInScript("[AxonWaveIn]::List()"), "utf16le").toString("base64");
    raw = await runCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded]);
  } else if (process.platform === "darwin" && existsSync("/usr/bin/osascript")) {
    raw = await runCapture("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_LIST_JXA]);
  } else {
    return [];
  }
  const seen = new Set<string>();
  const devices: InputDevice[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const id = line.slice(0, tab).trim();
    const name = line.slice(tab + 1).trim();
    if (!name || seen.has(id)) continue;
    seen.add(id);
    devices.push({ id, name });
  }
  return devices;
}

export function isRecording(): boolean {
  return !!current;
}

/** 开始录音。已在录就直接返回 */
export async function startRecording(device?: InputDevice | null): Promise<void> {
  if (current) return;
  // macOS 上选中的设备拔掉了（或打不开）：退回系统默认，别让用户卡在一个不存在的设备上。
  // Windows 在录音脚本里按名称找不到就自动用默认设备，不用这层兜底
  if (process.platform === "darwin" && device?.id) {
    try {
      return await startRecordingWith(device);
    } catch {
      return await startRecordingWith(null);
    }
  }
  return startRecordingWith(device ?? null);
}

async function startRecordingWith(device: InputDevice | null): Promise<void> {
  let rec: Recording;
  if (process.platform === "darwin" && existsSync("/usr/bin/osascript")) {
    const dir = await mkdtemp(join(tmpdir(), "axon-voice-"));
    const wavPath = join(dir, "voice.wav");
    const stopFlag = join(dir, "stop");
    // 选了具体设备走 AVCaptureSession；系统默认走 AVAudioRecorder（更简单、最稳）
    const script = device?.id ? MAC_DEVICE_RECORDER_JXA : MAC_RECORDER_JXA;
    const args = ["-l", "JavaScript", "-e", script, wavPath, stopFlag, ...(device?.id ? [device.id] : [])];
    const proc = spawn("/usr/bin/osascript", args, { stdio: ["ignore", "pipe", "pipe"] });
    rec = makeRecording(proc, "avfoundation", { wavPath, stopFlag, tmpDir: dir });
    let buf = "";
    let resolveReady: () => void = () => undefined;
    proc.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line === "READY") resolveReady();
        const m = /^L\s+(-?[\d.]+)/.exec(line);
        // AVAudioRecorder 报的是分贝（-160~0），换成和 PCM 后端同一套 0~1 刻度
        if (m) rec.levels.push(Math.max(0, Math.min(1, (Number(m[1]) + 55) / 50)));
      }
    });
    await waitReady(rec, (resolve) => { resolveReady = resolve; });
  } else {
    const cmd = await pcmRecorderCommand(device);
    if (!cmd) throw new Error(missingRecorderHint());
    const proc = spawn(cmd.bin, cmd.args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), rec.backend === "waveIn" ? 15_000 : 8000)),
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

/** 16bit PCM 的峰值幅度（0~32767） */
function pcmPeak(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return peak;
}

/**
 * 录到的是不是有效声音。全 0 几乎只有一种可能：系统挡住了麦克风（Windows 的隐私设置关掉了
 * 「允许桌面应用访问麦克风」时，录音照常进行但数据全是 0，不报任何错）。
 */
function checkAudible(pcm: Buffer): void {
  const peak = pcmPeak(pcm);
  if (peak === 0) {
    throw new Error(process.platform === "win32"
      ? "录到的全是静音：Windows 可能禁止了桌面应用使用麦克风。打开「设置 → 隐私和安全性 → 麦克风」，打开「麦克风访问」和「允许桌面应用访问麦克风」，再试一次。"
      : process.platform === "darwin"
        ? "录到的全是静音：macOS 可能没有允许 VS Code 使用麦克风。打开「系统设置 → 隐私与安全性 → 麦克风」勾选它，再试一次。"
        : "录到的全是静音：请检查麦克风是否被静音或被其它程序占用。");
  }
  if (peak < 300) throw new Error("几乎没录到声音：麦克风音量太小或选错了输入设备，检查一下系统的默认录音设备。");
}

/** 停止录音，返回 WAV；cancel 时丢弃录音返回 null */
export async function stopRecording(cancel = false): Promise<Buffer | null> {
  const rec = current;
  if (!rec) return null;
  current = null;
  clearTimeout(rec.timer);
  if (rec.backend === "avfoundation") {
    try {
      if (cancel) { rec.proc.kill(); return null; }
      await writeFile(rec.stopFlag!, "");
      const code = await Promise.race([rec.exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5000))]);
      if (code === "timeout") rec.proc.kill();
      if (!existsSync(rec.wavPath!)) throw new Error(`录音没有保存下来。${rec.stderr.trim().slice(0, 300)}`);
      const pcm = pcmFromWav(await readFile(rec.wavPath!));
      if (pcm.length < SAMPLE_RATE * 2 * 0.3) throw new Error("录音太短了，说完再停。");
      checkAudible(pcm);
      return wavFromPcm(pcm);
    } finally {
      void rm(rec.tmpDir!, { recursive: true, force: true });
    }
  }
  // 让程序正常结束（ffmpeg 收到 SIGINT 会刷完缓冲），没反应再强杀；Windows 上直接结束进程，已收到的音频都在内存里
  rec.proc.kill("SIGINT");
  const code = await Promise.race([rec.exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000))]);
  if (code === "timeout") rec.proc.kill("SIGKILL");
  if (cancel) return null;
  const pcm = Buffer.concat(rec.chunks);
  if (pcm.length < SAMPLE_RATE * 2 * 0.3) throw new Error("录音太短了，说完再停。");
  checkAudible(pcm);
  return wavFromPcm(pcm);
}

/** SenseVoice 一类模型可能带出 <|zh|><|NEUTRAL|><|Speech|> 这样的标签，去掉 */
function cleanTranscript(text: string): string {
  return text.replace(/<\|[^|>]*\|>/g, "").trim();
}

/** 中文提示词：让 Whisper 一类模型输出简体中文并带标点（不加时它常给出无标点或繁体的结果） */
const ZH_PROMPT = "以下是普通话的句子，使用简体中文，带标点符号。";

/**
 * 把录音交给识别服务，返回文字。
 * 不走 OpenAI SDK：它配上全局 fetch 后上传文件会报「duplex option is required」，
 * 直接用原生 fetch + FormData 发 multipart 最省事。
 */
export async function transcribe(wav: Buffer, cfg: VoiceInputConfig): Promise<string> {
  const name = resolveProviderName(cfg.provider) ?? cfg.provider;
  const p = getResolvedProviders().find((x) => x.name === name);
  if (!p || !p.apiKey) throw new Error(`语音识别服务「${cfg.provider}」没有配置或缺少 API Key。`);
  const language = (cfg.language || "").trim();
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "voice.wav");
  form.append("model", cfg.model);
  form.append("response_format", "json");
  if (language) form.append("language", language);
  if (!language || language.startsWith("zh")) form.append("prompt", ZH_PROMPT);
  const headers: Record<string, string> = p.apiKeyHeader === "x-api-key" ? { "x-api-key": p.apiKey } : { Authorization: `Bearer ${p.apiKey}` };
  const url = `${p.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers, body: form, signal: AbortSignal.timeout(110_000) });
  } catch (err) {
    throw new Error(`语音识别请求没有发出去：${(err as Error).message}`);
  }
  const raw = await res.text();
  if (res.status === 404) throw new Error(`「${p.label || p.name}」不支持语音识别接口（/audio/transcriptions 返回 404）。换一个支持的服务商，比如 OpenAI、硅基流动、Groq。`);
  if (!res.ok) {
    let msg = raw.slice(0, 300);
    try { msg = (JSON.parse(raw) as { error?: { message?: string }; message?: string }).error?.message || JSON.parse(raw).message || msg; } catch { /* 原样显示 */ }
    throw new Error(`语音识别失败（HTTP ${res.status}）：${msg}`);
  }
  try {
    return cleanTranscript(String((JSON.parse(raw) as { text?: string }).text ?? ""));
  } catch {
    return cleanTranscript(raw); // 少数服务即使要了 json 也回纯文本
  }
}
