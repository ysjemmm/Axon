/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Extension bundling: bundles ESM @axon/core / @axon/host-vscode with the extension
 * entry point into a single CJS file.
 *
 * VS Code extension host loads the main entry as CommonJS, but @axon/* is pure ESM.
 * esbuild bundles the entire dependency tree into a CJS bundle and marks "vscode"
 * as external (injected by the host at runtime).
 */

import { build, context } from "esbuild";
import { cpSync, existsSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const options = {
	entryPoints: ["src/extension.ts"],
	bundle: true,
	outfile: "dist/extension.js",
	platform: "node",
	format: "cjs",
	target: "node18",
	// vscode is provided by the extension host at runtime - do not bundle.
	// playwright-core contains dynamic require + browser binary resolution
	// logic that breaks when bundled - mark as external, resolve from
	// node_modules at runtime (must be shipped as a dependency).
	external: ["vscode", "playwright-core"],
	banner: {
		js: `// Suppress punycode deprecation warning (openai SDK -> node-fetch@2 -> whatwg-url@5 -> punycode)\n(function(){var e=process.emit;process.emit=function(t,w){if(t==='warning'&&w&&w.message&&String(w.message).includes('punycode'))return!1;return e.apply(process,arguments)}})();`,
	},
	sourcemap: true,
	// ESM dependencies (@axon/core etc.) are bundled together
	mainFields: ["module", "main"],
	conditions: ["import", "node"],
	logLevel: "info",
};

/**
 * playwright-core 不能打进 bundle（见上面 external 的说明），但 .vscodeignore 排除了 node_modules/**，
 * 扩展也没有运行时依赖 —— 装好的 VSIX 里根本找不到它，浏览器 / 截图功能一用就报错。
 * 这里把它整个复制到 dist/node_modules/：dist/extension.js 里的 import("playwright-core")
 * 会先在 dist/node_modules 里找到它。
 */
function shipPlaywright() {
	try {
		const require = createRequire(join(process.cwd(), "../../packages/host-node/package.json"));
		const pkgDir = dirname(realpathSync(require.resolve("playwright-core/package.json")));
		const target = join("dist", "node_modules", "playwright-core");
		if (existsSync(target)) rmSync(target, { recursive: true, force: true });
		cpSync(pkgDir, target, { recursive: true, dereference: true });
		console.log(`[esbuild] playwright-core → ${target}`);
	} catch (err) {
		console.warn("[esbuild] 没找到 playwright-core，浏览器能力在打包后不可用：", err.message);
	}
}

if (watch) {
	shipPlaywright();
	const ctx = await context(options);
	await ctx.watch();
} else {
	await build(options);
	shipPlaywright();
}
