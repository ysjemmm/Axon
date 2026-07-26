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

if (watch) {
	const ctx = await context(options);
	await ctx.watch();
} else {
	await build(options);
}
