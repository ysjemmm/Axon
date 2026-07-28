/**
 * 构建 web 并把产物拷贝到扩展的 media/web/，供 webview 加载。
 *
 * 跨平台、无 shell 依赖：用 node 直接 spawn web 的构建（设 AXON_WEB_BASE="./" 产出相对基址，
 * 便于 webview 解析本地资源），再把 web/dist 拷到 media/web。
 *
 * 用法：node scripts/copy-web.mjs          （构建 web 再拷贝）
 *       node scripts/copy-web.mjs --no-build （仅拷贝已有 web/dist）
 */

import { cp, rm, access, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = join(here, "..");
const repoRoot = join(extRoot, "..", "..");
const webRoot = join(repoRoot, "web");
const webDist = join(webRoot, "dist");
const target = join(extRoot, "media", "web");

const noBuild = process.argv.includes("--no-build");

/** 读 web/dist/index.html 的 mtime（毫秒），不存在返回 0。用于校验构建是否真的产出了新文件。 */
async function distStamp() {
  try {
    return (await stat(join(webDist, "index.html"))).mtimeMs;
  } catch {
    return 0;
  }
}

if (!noBuild) {
  console.log("[copy-web] 构建 web（AXON_WEB_BASE=./）...");
  // 直接调用 web 本地的 vite bin（不走 web 的 "tsc -b && vite build"，避免 web 既有 tsconfig 遗留问题）。
  const before = await distStamp();
  const viteBin = join(webRoot, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
  const { status } = spawnSync(viteBin, ["build"], {
    cwd: webRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, AXON_WEB_BASE: "./" },
  });

  // 成功判定分两道，缺一不可：
  //  ① 退出码为 0（部分 shell 包装下会传成 null，此时退回看 ②）
  //  ② index.html 的 mtime 变新了 —— 证明这一次真的重新产出了文件。
  // 只看 webDist 是否存在是不够的：增量构建时它本来就在，vite 失败也照样存在，
  // 于是会把【上一次的旧产物】拷进 media/web，构建显示成功却发布了旧代码。
  const after = await distStamp();
  const producedFresh = after > before;
  if (status !== 0 && status !== null) {
    console.error(`[copy-web] vite build 退出码 ${status}，构建失败`);
    process.exit(1);
  }
  if (!producedFresh) {
    console.error(
      `[copy-web] web/dist/index.html 未被刷新（mtime 没变），判定 vite build 失败——` +
      `拒绝拷贝旧产物。请查看上方 vite 输出。`,
    );
    process.exit(1);
  }
}

try {
  await access(webDist);
} catch {
  console.error(`[copy-web] 未找到 web 构建产物：${webDist}`);
  process.exit(1);
}

async function normalizeAssetBase(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      await normalizeAssetBase(p);
      continue;
    }
    if (!/\.(html|css|js|mjs)$/.test(entry.name)) continue;
    const text = await readFile(p, "utf8");
    const rel = relative(webDist, p).replace(/\\/g, "/");
    const inAssetsDir = rel.startsWith("assets/");
    const assetPrefix = inAssetsDir ? "./" : "./assets/";
    const next = text
      .replace(/(["'`(=])\/assets\//g, `$1${assetPrefix}`)
      .replace(/(["'`(=])assets\//g, inAssetsDir ? "$1./" : "$1assets/")
      .replace(/(["'(=])\/favicon\./g, "$1./favicon.");
    if (next !== text) await writeFile(p, next, "utf8");
  }
}

await normalizeAssetBase(webDist);
await rm(target, { recursive: true, force: true });
await cp(webDist, target, { recursive: true });
console.log(`[copy-web] 已拷贝 ${webDist} -> ${target}`);
