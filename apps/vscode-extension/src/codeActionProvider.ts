/**
 * "Axon: Fix" Quick Fix CodeActionProvider
 *
 * Registers a CodeActionProvider for all files that adds
 * "Axon: Fix" to the Quick Fix list.
 * Sends diagnostics + code context to the Axon chat panel.
 */

import * as vscode from "vscode";
import type { AxonViewProvider } from "./viewProvider.js";

export function registerAskAxonCodeAction(
	context: vscode.ExtensionContext,
	axonProvider: AxonViewProvider,
): void {
	// Register command before CodeActionProvider (otherwise the lightbulb menu can't find it)
	context.subscriptions.push(
		vscode.commands.registerCommand(
			"axon.askFix",
			async (uri: vscode.Uri, diags: vscode.Diagnostic[], triggerRange: vscode.Range) => {
				const document = await vscode.workspace.openTextDocument(uri);
				const relPath = vscode.workspace.asRelativePath(uri, false);

				// Capture code around diagnostic lines (+/- 20 lines context)
				const lines: string[] = [];
				let minLine = Infinity;
				let maxLine = -Infinity;
				for (const d of diags) {
					const sl = d.range.start.line;
					const el = d.range.end.line;
					minLine = Math.min(minLine, sl);
					maxLine = Math.max(maxLine, el);
				}
				const ctxBefore = 20;
				const ctxAfter = 20;
				const start = Math.max(0, minLine - ctxBefore);
				const end = Math.min(document.lineCount - 1, maxLine + ctxAfter);
				for (let i = start; i <= end; i++) {
					lines.push(`${String(i + 1).padStart(4, " ")}| ${document.lineAt(i).text}`);
				}

				// Build diagnostic descriptions
				const sevLabel = (s: vscode.DiagnosticSeverity): string =>
					s === vscode.DiagnosticSeverity.Error ? "Error"
						: s === vscode.DiagnosticSeverity.Warning ? "Warning"
							: s === vscode.DiagnosticSeverity.Information ? "Info"
								: "Hint";
				const diagLines = diags.map((d) =>
					`[${sevLabel(d.severity)}] L${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}${d.code ? `  (ts${d.code})` : ""}`,
				);

				// Build context for AI: diagnostics + nearby code + full file (for small files)
				const parts: string[] = [];
				parts.push(`Please fix the following issues in \`${relPath}\`:`);
				parts.push("");
				parts.push(diagLines.join("\n"));
				parts.push("");
				parts.push("```" + (document.languageId || ""));
				parts.push(lines.join("\n"));
				parts.push("```");

				// Small files (<= 200 lines): include full content
				if (document.lineCount <= 200) {
					const fullLines: string[] = [];
					for (let i = 0; i < document.lineCount; i++) {
						fullLines.push(`${String(i + 1).padStart(4, " ")}| ${document.lineAt(i).text}`);
					}
					parts.push("");
					parts.push("Full file:");
					parts.push("```" + (document.languageId || ""));
					parts.push(fullLines.join("\n"));
					parts.push("```");
				}

				const text = parts.join("\n");

				// Focus Axon panel, then wait a microtask for webview to be ready
				await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
				await vscode.commands.executeCommand("axon.chat.focus");
				await new Promise((r) => setTimeout(r, 100));

				axonProvider.postToWebview({
					type: "add_context",
					source: "diagnostics",
					label: `${relPath} / ${diags.length} issues`,
					text,
					size: text.length,
				});
			},
		),
	);

	const provider: vscode.CodeActionProvider = {
		provideCodeActions(document, range, ctx, _token) {
			const diags = ctx.diagnostics;
			if (!diags || diags.length === 0) return [];

			const action = new vscode.CodeAction(
				"Axon: Fix",
				vscode.CodeActionKind.QuickFix,
			);
			action.diagnostics = [...diags];

			action.command = {
				command: "axon.askFix",
				title: "Ask Axon -- let AI fix this",
				arguments: [document.uri, diags, range],
			};

			return [action];
		},
	};

	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			{ pattern: "**" },
			provider,
			{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
		),
	);
}
