/**
 * 构建 web 并把产物拷贝到扩展的 media/web/，供 webview 加载。
 *
 * 跨平台、无 shell 依赖：用 node 直接 spawn web 的构建（设 AXON_WEB_BASE="./" 产出相对基址，
 * 便于 webview 解析本地资源），再把 web/dist 拷到 media/web。
 *
 * 用法：node scripts/copy-web.mjs          （构建 web 再拷贝）
 *       node scripts/copy-web.mjs --no-build （仅拷贝已有 web/dist）
 */

import { cp, rm, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = join(here, "..");
const repoRoot = join(extRoot, "..", "..");
const webRoot = join(repoRoot, "web");
const webDist = join(webRoot, "dist");
const target = join(extRoot, "media", "web");

const noBuild = process.argv.includes("--no-build");

if (!noBuild) {
  console.log("[copy-web] 构建 web（AXON_WEB_BASE=./）...");
  // 直接调用 web 本地的 vite bin（不走 web 的 "tsc -b && vite build"，避免 web 既有 tsconfig 遗留问题）。
  const viteBin = join(webRoot, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
  spawnSync(viteBin, ["build"], {
    cwd: webRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, AXON_WEB_BASE: "./" },
  });
  // 注：部分 shell 包装下 vite 退出码传递不可靠，成功与否以下方 webDist 可访问性为准（fail-fast）。
}

try {
  await access(webDist);
} catch {
  console.error(`[copy-web] 未找到 web 构建产物：${webDist}`);
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await cp(webDist, target, { recursive: true });
console.log(`[copy-web] 已拷贝 ${webDist} -> ${target}`);
