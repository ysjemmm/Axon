/**
 * ffmpegProvision —— ffmpeg 的自动获取（用户零安装）
 *
 * ── 为什么要自己管 ffmpeg ──
 * 出片必须靠 ffmpeg 编码。让用户自己去装（winget / brew / 配 PATH）是不可接受的门槛：
 * 绝大多数人装完 Axon 就想直接用，不会为了一个功能去折腾包管理器。
 *
 * ── 为什么选 BtbN 的 LGPL 构建 ──
 * 主流的 ffmpeg 便捷分发（gyan.dev / ffmpeg-static）都带 libx264，那是 GPL 组件：
 * 随产品分发会带来 GPL 传染与源码提供义务，闭源分发很被动。
 * BtbN 的 lgpl 构建不含任何 GPL 组件，H.264 用 libopenh264（Cisco BSD）编码，
 * 实测能出 Constrained Baseline H.264 + AAC —— 浏览器和各类播放器都吃这套，够用且授权干净。
 *
 * ── 查找顺序 ──
 * 1. AXON_FFMPEG_PATH 显式指定（企业内网 / 已有 ffmpeg 的场景）
 * 2. 随应用打包的 vendor 目录（安装包里预置了就完全不联网）
 * 3. 用户缓存 ~/.axon/bin/ffmpeg/<版本>/（本模块下载后的落点）
 * 4. 系统 PATH（机器上已经装过就直接用）
 * 5. 都没有 → 自动下载到 3
 *
 * 下载走 curl（Windows 10+/macOS/主流 Linux 自带）：它能正确处理 301/302 跳转、断点续传和
 * HTTP 代理；Node 自带的 https 在代理下要么自己实现 CONNECT 隧道，要么直接连不上，
 * 而"默认连不上"在受限网络里就是必现故障。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 固定的发布版本。
 *
 * 刻意钉死 tag 而不是用 latest：latest 指向的资产名会随构建变化，昨天能下的 URL 今天就 404；
 * 而这份 URL 会长期留在每个用户的机器上。文件名里的源码 hash（gc8de997cb1）保证内容不会漂移。
 */
export const FFMPEG_RELEASE_TAG = "autobuild-2026-10-21-13-06";
const RELEASE_BASE = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_RELEASE_TAG}`;

/**
 * macOS 构建的下载地址。
 *
 * 没有第三方提供许可干净的 macOS LGPL 静态构建（OSXExperts 明确"仅供教育用途"、evermeet 是 GPL），
 * 所以由本仓库的 CI 自建：.github/workflows/build-ffmpeg-macos.yml 跑完会把
 * ffmpeg-darwin-arm64.tar.gz / ffmpeg-darwin-x64.tar.gz 传到一个 release 上。
 *
 * 换了发布位置时只改这一处，或用环境变量 AXON_FFMPEG_MACOS_BASE 临时覆盖（便于内网镜像）。
 */
const MACOS_RELEASE_BASE =
  (process.env.AXON_FFMPEG_MACOS_BASE || "").trim() ||
  "https://github.com/ysjemmm/Axon/releases/download/macos-v1";

/** 一次下载的可选资产（按平台/架构挑选） */
export interface FfmpegAsset {
  /** 资产文件名（拼在 RELEASE_BASE 后面） */
  file: string;
  /** 压缩包类型：决定用哪种方式解压 */
  archive: "zip" | "tar.xz";
  /** 下载体积（字节，用于进度展示；与真实大小有偏差不影响下载） */
  sizeHint: number;
  /** 解压后二进制在包内的相对路径 */
  binaryInArchive: string;
  /** 该资产所属的下载基址；缺省用 RELEASE_BASE（BtbN），macOS 用自建构建 */
  baseUrl?: string;
  /**
   * SHA-256（十六进制，小写）。自建构建可以随产物发布校验和，下载后逐一比对，
   * 避免半截包 / 中间人替换被当成正常二进制跑起来。
   */
  sha256?: string;
  /** macOS 下载后必须去隔离属性并 ad-hoc 签名，否则 Apple Silicon 拒绝执行 */
  darwinPostProcess?: boolean;
}

/** 各平台资产。缺失的平台返回 null，由调用方给出明确的替代方案。 */
const ASSETS: Record<string, FfmpegAsset> = {
  "win32-x64": {
    file: "ffmpeg-n8.1.3-20-gc8de997cb1-win64-lgpl-8.1.zip",
    archive: "zip",
    sizeHint: 170_498_048,
    binaryInArchive: "bin/ffmpeg.exe",
  },
  "win32-arm64": {
    file: "ffmpeg-n8.1.3-20-gc8de997cb1-winarm64-lgpl-8.1.zip",
    archive: "zip",
    sizeHint: 116_391_936,
    binaryInArchive: "bin/ffmpeg.exe",
  },
  "linux-x64": {
    file: "ffmpeg-n8.1.3-20-gc8de997cb1-linux64-lgpl-8.1.tar.xz",
    archive: "tar.xz",
    sizeHint: 137_052_160,
    binaryInArchive: "bin/ffmpeg",
  },
  "linux-arm64": {
    file: "ffmpeg-n8.1.3-20-gc8de997cb1-linuxarm64-lgpl-8.1.tar.xz",
    archive: "tar.xz",
    sizeHint: 116_077_773,
    binaryInArchive: "bin/ffmpeg",
  },
  // macOS：本仓库 CI 自建（LGPL + VideoToolbox），见文件头说明
  "darwin-arm64": {
    file: "ffmpeg-darwin-arm64.tar.gz",
    archive: "tar.xz",
    sizeHint: 40 * 1024 * 1024,
    binaryInArchive: "ffmpeg",
    baseUrl: MACOS_RELEASE_BASE,
    darwinPostProcess: true,
  },
  "darwin-x64": {
    file: "ffmpeg-darwin-x64.tar.gz",
    archive: "tar.xz",
    sizeHint: 45 * 1024 * 1024,
    binaryInArchive: "ffmpeg",
    baseUrl: MACOS_RELEASE_BASE,
    darwinPostProcess: true,
  },
};

/** 按平台挑资产。macOS 没有官方 LGPL 构建，返回 null（见 ensureFfmpeg 的错误文案）。 */
export function pickAsset(platform: string, arch: string): FfmpegAsset | null {
  const key = `${platform}-${arch}`;
  return ASSETS[key] ?? null;
}

/** ffmpeg 可执行文件名 */
export function ffmpegBinaryName(platform: string): string {
  return platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

/**
 * 从环境变量里取代理地址。
 * 同时认大小写两种写法：不同工具链/Hook 设的变量名不一致，只认一种就会在真实用户那里失效。
 */
export function parseProxyEnv(env: NodeJS.ProcessEnv): string | null {
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    const v = (env[key] || "").trim();
    if (v) return v;
  }
  return null;
}

/**
 * 解析 Windows 注册表里的系统代理。
 *
 * 很多人（包括用 Xray / Clash 的）只在系统设置里开了代理，没有设环境变量。
 * 不读这里，用户明明"代理是通的"，Axon 却下不动 —— 这种"明明能用却失败"最难排查。
 */
export function parseWindowsProxyReg(proxyEnable: string, proxyServer: string): string | null {
  const enabled = regValue(proxyEnable);
  if (!/^(0x)?1$/i.test(enabled)) return null;
  const server = regValue(proxyServer);
  if (!server) return null;
  // 形如 "127.0.0.1:10808" 或 "http=127.0.0.1:10808;https=127.0.0.1:10808"
  const https = /https=([^;]+)/i.exec(server);
  const raw = https ? https[1] : server.includes("=") ? "" : server;
  const target = raw.trim();
  if (!target) return null;
  return /^[a-z]+:\/\//i.test(target) ? target : `http://${target}`;
}

/**
 * 从 `reg query` 的输出里取出真正的值。
 *
 * 输出形如：`    ProxyServer    REG_SZ    127.0.0.1:10808`
 * 少了这一步就会把「变量名 + 类型」整段当成地址，拼出 `http://ProxyServer REG_SZ 127.0.0.1:10808`
 * 这种非法代理地址 —— curl 直接失败，表现为"明明代理通着却下载不动"。
 * 同时兼容调用方直接传裸值（测试或其它来源）。
 */
function regValue(raw: string): string {
  const text = String(raw ?? "");
  const line = text.split(/\r?\n/).find((l) => /REG_(?:SZ|EXPAND_SZ|DWORD)\b/i.test(l)) ?? text;
  const m = /REG_(?:SZ|EXPAND_SZ|DWORD)\s+(.+)$/i.exec(line);
  return (m ? m[1] : line).trim();
}

/** 探测系统代理（Windows 读注册表；其它平台只看环境变量） */
async function detectSystemProxy(): Promise<string | null> {
  const fromEnv = parseProxyEnv(process.env);
  if (fromEnv) return fromEnv;
  if (process.platform !== "win32") return null;
  try {
    const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const [enable, server] = await Promise.all([
      execFileAsync("reg", ["query", key, "/v", "ProxyEnable"], { windowsHide: true }),
      execFileAsync("reg", ["query", key, "/v", "ProxyServer"], { windowsHide: true }),
    ]);
    return parseWindowsProxyReg(enable.stdout, server.stdout);
  } catch {
    return null;
  }
}

/** 跑一次 ffmpeg -version 判断这个可执行文件是否真的能用 */
async function probe(bin: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(bin, ["-version"], { windowsHide: true, timeout: 15_000 });
    return /^ffmpeg version /m.test(stdout);
  } catch {
    return false;
  }
}

/** ffmpeg 位置与来源 */
export interface FfmpegLocation {
  bin: string;
  source: "env" | "bundled" | "cache" | "path" | "downloaded";
}

/** 用户级缓存根：与 Axon 其它用户数据放一起，随卸载一起清 */
function cacheRoot(): string {
  return join(homedir(), ".axon", "bin", "ffmpeg");
}

/** 本版本对应的缓存目录 */
function cacheDir(): string {
  return join(cacheRoot(), FFMPEG_RELEASE_TAG);
}

/** 随应用打包的 vendor 目录候选（安装包里预置时零联网） */
function bundledCandidates(): string[] {
  const name = ffmpegBinaryName(process.platform);
  const roots = [
    // 包内相对位置（构建时把二进制放到 packages/host-node/vendor/ffmpeg/）
    join(process.cwd(), "vendor", "ffmpeg"),
    join(homedir(), ".axon", "vendor", "ffmpeg"),
  ];
  return roots.map((r) => join(r, name));
}

/**
 * 找出可用的 ffmpeg（不触发下载）。找不到返回 null。
 * 这是便宜路径：每次渲染前都会调一次，要足够快，所以全部走 probe 而不是分析目录结构。
 */
export async function findFfmpeg(): Promise<FfmpegLocation | null> {
  const envPath = (process.env.AXON_FFMPEG_PATH || "").trim();
  if (envPath && (await probe(envPath))) return { bin: envPath, source: "env" };

  for (const candidate of bundledCandidates()) {
    if (await probe(candidate)) return { bin: candidate, source: "bundled" };
  }

  const cached = join(cacheDir(), ffmpegBinaryName(process.platform));
  if (await probe(cached)) return { bin: cached, source: "cache" };

  // PATH 上的（用户自己装过的）
  if (await probe(ffmpegBinaryName(process.platform))) {
    return { bin: ffmpegBinaryName(process.platform), source: "path" };
  }
  return null;
}

/** 下载进度 */
export interface ProvisionProgress {
  phase: "download" | "extract" | "verify";
  doneBytes: number;
  totalBytes: number;
}

export interface EnsureOptions {
  onProgress?: (p: ProvisionProgress) => void;
  signal?: AbortSignal;
  /** 下载超时（毫秒），默认 10 分钟 */
  timeoutMs?: number;
}

/** 同一进程内的并发渲染共用一次下载，避免两个任务把同一个包下两遍 */
let inflight: Promise<FfmpegLocation> | null = null;

/**
 * 确保 ffmpeg 可用：本地有就直接返回，没有就下载到用户缓存。
 *
 * 失败时抛出的是"用户能照着做"的话：不给下载地址、不说清是网络还是解压问题，
 * 用户只能看到一句"渲染失败"。
 */
export async function ensureFfmpeg(opts: EnsureOptions = {}): Promise<FfmpegLocation> {
  const existing = await findFfmpeg();
  if (existing) return existing;

  if (!inflight) {
    inflight = provision(opts).finally(() => { inflight = null; });
  }
  return inflight;
}

async function provision(opts: EnsureOptions): Promise<FfmpegLocation> {
  const asset = pickAsset(process.platform, process.arch);
  if (!asset) {
    throw new Error(
      `当前系统（${process.platform}-${process.arch}）没有可自动获取的渲染组件。` +
        `请安装 ffmpeg 并加入 PATH，或用环境变量 AXON_FFMPEG_PATH 指定 ffmpeg 可执行文件路径。`,
    );
  }

  const url = `${asset.baseUrl ?? RELEASE_BASE}/${asset.file}`;
  const dir = cacheDir();
  await mkdir(dir, { recursive: true });

  const tmpArchive = join(tmpdir(), `axon-ffmpeg-${Date.now()}-${basename(asset.file)}`);
  const extractDir = join(tmpdir(), `axon-ffmpeg-x-${Date.now()}`);

  try {
    await download(url, tmpArchive, asset.sizeHint, opts);
    // 自建产物带校验和：半截包或中间人替换绝不能当成正常二进制跑起来
    if (asset.sha256) await verifySha256(tmpArchive, asset.sha256);
    opts.onProgress?.({ phase: "extract", doneBytes: 0, totalBytes: 0 });
    await extract(tmpArchive, extractDir);
    const name = ffmpegBinaryName(process.platform);
    const extracted = await locateBinary(extractDir, name);
    if (!extracted) throw new Error("渲染组件包里没有 ffmpeg 可执行文件，可能下载不完整，请重试。");
    const target = join(dir, name);
    await copyFile(extracted, target);
    if (process.platform !== "win32") await chmod(target, 0o755);
    // macOS：下载来的文件带隔离属性时无法执行；Apple Silicon 还要求有签名
    if (asset.darwinPostProcess) await prepareDarwinBinary(target);

    opts.onProgress?.({ phase: "verify", doneBytes: 0, totalBytes: 0 });
    if (!(await probe(target))) {
      await rm(target, { force: true });
      throw new Error("下载的渲染组件无法运行，可能已损坏。请检查网络后重试。");
    }
    return { bin: target, source: "downloaded" };
  } finally {
    await rm(tmpArchive, { force: true }).catch(() => {});
    await rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 用 curl 下载：自动跟跳转、支持 HTTP 代理 */
async function download(url: string, dest: string, sizeHint: number, opts: EnsureOptions): Promise<void> {
  const proxy = await detectSystemProxy();
  const args = ["--fail", "--location", "--silent", "--show-error", "--retry", "3", "--connect-timeout", "30", "-o", dest];
  if (proxy) args.push("--proxy", proxy);
  args.push(url);

  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  // 边下边报进度：大包要下好几分钟，界面没有任何动静会被当成卡死
  const timer = setInterval(() => {
    void stat(dest).then(
      (s) => opts.onProgress?.({ phase: "download", doneBytes: s.size, totalBytes: sizeHint }),
      () => {},
    );
  }, 500);
  opts.onProgress?.({ phase: "download", doneBytes: 0, totalBytes: sizeHint });

  try {
    await execFileAsync("curl", args, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      signal: opts.signal,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; code?: string | number };
    if (e.code === "ENOENT") throw new Error("系统缺少 curl，无法自动下载渲染组件。请安装 ffmpeg 后用 AXON_FFMPEG_PATH 指定。");
    const detail = (e.stderr || e.message || "").trim().split(/\r?\n/).slice(-2).join(" ");
    const proxyHint = proxy ? `（已尝试代理 ${proxy}）` : "";
    throw new Error(
      `下载渲染组件失败${proxyHint}：${detail || "网络不可达"}。` +
        `请检查网络后重试；无法联网时，可手动把 ffmpeg 放好后用环境变量 AXON_FFMPEG_PATH 指定。`,
    );
  } finally {
    clearInterval(timer);
  }
}

/**
 * 解压。
 *
 * 统一走系统 tar：Windows 10+ 自带的 bsdtar 能直接解 zip（实测可用），
 * Linux/macOS 的 tar 天然支持 tar.xz。少一个有平台差异的依赖，就少一类只在某个平台炸的故障。
 */
async function extract(archive: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  try {
    await execFileAsync("tar", ["-xf", archive, "-C", dest], { windowsHide: true, timeout: 5 * 60 * 1000 });
  } catch (err) {
    const detail = ((err as { stderr?: string }).stderr || (err as Error).message || "").trim();
    throw new Error(`解压渲染组件失败：${detail.split(/\r?\n/).slice(-1)[0] || "tar 执行失败"}`);
  }
}

/**
 * 在解压结果里找 ffmpeg 可执行文件。
 *
 * 不按固定路径拼：压缩包顶层目录名带版本与源码 hash（ffmpeg-n8.1.3-20-gc8de997cb1-win64-lgpl-8.1），
 * 每换一次版本就得同步改常量，写死的结果就是"解压成功却报找不到文件"。按文件名递归找，
 * 深度上限 4 层（实际结构是 <顶层目录>/bin/ffmpeg，足够）。
 */
async function locateBinary(root: string, name: string, depth = 0): Promise<string | null> {
  if (depth > 4) return null;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      const found = await locateBinary(full, name, depth + 1);
      if (found) return found;
    } else if (e.name === name) {
      return full;
    }
  }
  return null;
}

/**
 * 预热：启动后可以先调一次，把下载挪到用户察觉不到的空闲时刻。
 * 失败静默——预热不该污染任何界面，真到用的时候 ensureFfmpeg 会再报一次。
 */
/** 校验下载包的 SHA-256。自建产物才有校验和；BtbN 不提供，故仅在配置了才校验。 */
async function verifySha256(file: string, expected: string): Promise<void> {
  const actual = createHash("sha256").update(await readFile(file)).digest("hex").toLowerCase();
  const want = expected.trim().toLowerCase();
  if (actual !== want) {
    throw new Error(
      `渲染组件校验失败（期望 ${want.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…），可能下载不完整或被篡改，请重试。`,
    );
  }
}

/**
 * macOS 下载后的必要处理。
 *
 * 1. 去掉隔离属性：从网络下载的文件默认带 com.apple.quarantine，不清掉会被 Gatekeeper 直接拦；
 * 2. ad-hoc 签名：Apple Silicon 只执行有签名的二进制，未签名会被内核拒绝（code signature invalid）。
 *
 * 两步都不是功能需要，纯粹是 macOS 的启动前置条件。签名失败不在这里抛错——
 * 有的环境（老 Intel 机型、已签名的系统）不清也能跑，最终以 probe 能否实际启动为准。
 */
async function prepareDarwinBinary(bin: string): Promise<void> {
  await execFileAsync("xattr", ["-cr", bin], { windowsHide: true }).catch(() => {});
  await execFileAsync("codesign", ["--force", "--sign", "-", bin], { windowsHide: true }).catch(() => {});
}

let warmupStarted = false;

export async function warmupFfmpeg(): Promise<void> {
  // 每个会话都会建一个 host，这里要自己去重，否则会反复 probe（虽然命中缓存很快，
  // 但多会话并发时仍是无意义的磁盘调用）
  if (warmupStarted) return;
  warmupStarted = true;
  try {
    await ensureFfmpeg();
  } catch {
    /* 静默 */
  }
}
