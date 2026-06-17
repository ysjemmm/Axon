/**
 * 扩展打包：把 ESM 的 @axon/core / @axon/host-vscode 与扩展入口一起 bundle 成单个 CJS 文件。
 *
 * 为什么需要：VS Code 扩展宿主以 CommonJS 加载 main 入口，而 @axon/* 是纯 ESM。
 * esbuild 把整棵依赖树打成 CJS bundle，并把 "vscode" 标记为 external（运行时由宿主注入）。
 */

import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  // vscode 由扩展宿主在运行时提供，不能打进 bundle。
  // playwright-core 含大量动态 require 与浏览器二进制解析逻辑，bundle 进来会坏 → 标记 external，
  // 运行时从 node_modules 解析（发行打包时需把它作为依赖一并带上）。
  external: ["vscode", "playwright-core"],
  sourcemap: true,
  // ESM 依赖（@axon/core 等）会被一并 bundle 进来
  mainFields: ["module", "main"],
  conditions: ["import", "node"],
  logLevel: "info",
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("[esbuild] watching...");
} else {
  await build(options);
  console.log("[esbuild] build done");
}
