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
    // ⚠️ NODE_ENV 必须显式钉成 production，绝不能随 process.env 透传。
    //
    // IDE 的集成终端里 NODE_ENV 往往已被设成 development（Electron / Code OSS 会带这个值）。
    // Vite 见到环境里已有的 NODE_ENV 就不用 mode 覆盖它，转而启用 development 解析条件，
    // react-dom 于是被解析到 react-dom-client.development.js —— 开发版 React 直接进产物。
    //
    // 开发版 React 带 Performance Tracks：它把组件 props 塞进 performance.measure 的
    // detail 选项，而 detail 会被结构化克隆。props 里只要有函数、DOM 节点这类不可克隆的值，
    // 就抛 DataCloneError；该异常抛在 React 提交阶段内部（不在任何组件里），Error Boundary
    // 拦不住，React 只能卸载整棵树 —— 表现就是"AI 回复到一半界面整片变灰"。
    env: { ...process.env, NODE_ENV: "production", AXON_WEB_BASE: "./" },
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

/**
 * 产物守门：拒绝把含「开发版 React」的前端产物拷进扩展。
 *
 * 为什么必须拦：开发版 React 自带 Performance Tracks，会把组件 props 塞进
 * `performance.measure(name, { detail })`。`detail` 会被结构化克隆，props 里只要有函数、
 * DOM 节点这类不可克隆的值就抛 DataCloneError。该异常抛出在 React 提交阶段【内部】，
 * 不在任何组件里，Error Boundary 拦不到 —— React 只能卸载整棵树，表现就是
 * 「AI 回复到一半界面整片变灰」。
 *
 * 判定依据：`react.dev/link` 是开发版专属的错误文档链接；生产版把同样的报错压成
 * `Minified React error #xx`，不会出现这个域名。所以命中即等价于「这是开发版」。
 * 典型成因是构建时环境变量里带了 NODE_ENV=development（见上方 vite 调用的注释）。
 */
async function assertProductionBundle() {
  let html;
  try {
    html = await readFile(join(webDist, "index.html"), "utf8");
  } catch (err) {
    console.error(`[copy-web] 守门校验无法读取 web/dist/index.html：${err.message}`);
    process.exit(1);
  }

  // 从 index.html 找出入口脚本（webview 实际加载的就是它），据此定位要检查的产物
  const match = html.match(/src="([^"]*index-[^"]+\.js)"/);
  if (!match) {
    console.error(
      "[copy-web] 守门校验失败：index.html 里找不到入口脚本（形如 assets/index-*.js），" +
      "无法确认产物是生产版，拒绝拷贝。",
    );
    process.exit(1);
  }
  const entryPath = join(webDist, match[1].replace(/^\.?\//, ""));

  let bundle;
  try {
    bundle = await readFile(entryPath, "utf8");
  } catch (err) {
    console.error(`[copy-web] 守门校验无法读取入口产物 ${entryPath}：${err.message}`);
    process.exit(1);
  }

  if (bundle.includes("react.dev/link")) {
    console.error(
      "[copy-web] ⛔ 产物里含 React【开发版】（命中 react.dev/link），已拒绝拷贝。\n" +
      "  开发版会启用 Performance Tracks：performance.measure 的 detail 结构化克隆组件 props，\n" +
      "  遇到函数/DOM 节点即抛 DataCloneError；异常在 React 提交阶段内部抛出，Error Boundary\n" +
      "  拦不住，整棵树被卸载 —— 用户看到的是界面整片变灰。\n" +
      "  常见成因：构建时环境里有 NODE_ENV=development（检查 IDE 集成终端 / CI 的环境变量）。",
    );
    process.exit(1);
  }
}

await assertProductionBundle();

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
