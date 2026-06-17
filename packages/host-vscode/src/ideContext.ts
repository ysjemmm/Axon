/**
 * VSCodeIdeContext —— 基于 vscode 窗口/编辑器状态的 IdeContextProvider 实现
 *
 * 这是"品牌 AI IDE 原生感"的来源：Agent 能感知用户当前在编辑器里的状态
 * （活动文件、选区、打开的文件），对应 EnvironmentContext 的 ACTIVE-EDITOR-FILE /
 * OPEN-EDITOR-FILES。git diff 在扩展宿主（Node 环境）用 child_process 跑 `git diff`。
 */

import * as vscode from "vscode";
import { exec } from "node:child_process";
import type { IdeContextProvider, ActiveEditorInfo, TextRange } from "@axon/core";

export class VSCodeIdeContext implements IdeContextProvider {
  /** 工作区根（用于 git diff 的 cwd）；多根时取第一个 */
  private rootDir(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  activeEditor(): ActiveEditorInfo | null {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return null;
    const sel = ed.selection;
    const selection: TextRange = {
      startLine: sel.start.line,
      startCharacter: sel.start.character,
      endLine: sel.end.line,
      endCharacter: sel.end.character,
    };
    const selectedText = ed.document.getText(sel);
    return {
      path: ed.document.uri.fsPath,
      selection,
      selectedText: selectedText || undefined,
    };
  }

  openFiles(): string[] {
    // visibleTextEditors 只含当前可见的；用 tabGroups 枚举所有打开的标签更全
    const paths = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input as { uri?: vscode.Uri } | undefined;
        if (input?.uri && input.uri.scheme === "file") {
          paths.add(input.uri.fsPath);
        }
      }
    }
    return [...paths];
  }

  gitDiff(): Promise<string> {
    const cwd = this.rootDir();
    if (!cwd) return Promise.resolve("");
    return new Promise<string>((resolve) => {
      exec("git diff", { cwd, timeout: 10_000, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve("");
        resolve(stdout || "");
      });
    });
  }
}
