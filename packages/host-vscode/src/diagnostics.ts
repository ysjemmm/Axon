/**
 * VSCodeDiagnostics —— 基于 vscode.languages.getDiagnostics 的 HostDiagnostics 实现
 *
 * 这是 VS Code 形态相对 Node(tsc) 形态的核心优势：
 * - 实时：直接读语言服务已计算的诊断，无需起 tsc 子进程
 * - 全语言：TS/JS/Python/Go/Rust... 任何装了语言扩展的语言都覆盖，不限 TS 项目
 * - 精确到文件：按 Uri 取诊断，天然按文件归类
 *
 * 完整性处理：文件可能尚未被语言服务分析（刚由 Agent 写盘、未在编辑器打开）。
 * 因此先 openTextDocument 触发分析，给语言服务一个短暂窗口产出诊断后再读取。
 */

import * as vscode from "vscode";
import { relative, sep } from "node:path";
import type { HostDiagnostics, DiagnosticFileResult } from "@axon/core";

/** 等待语言服务产出诊断的最大轮询时间与间隔 */
const SETTLE_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 250;

function toRel(cwd: string, abs: string): string {
  return relative(cwd, abs).split(sep).join("/");
}

export class VSCodeDiagnostics implements HostDiagnostics {
  async check(cwd: string, absPaths: string[]): Promise<DiagnosticFileResult[]> {
    // 无指定文件：汇总整个工作区当前所有 error 级诊断
    if (absPaths.length === 0) {
      return this.collectAll(cwd);
    }

    const results: DiagnosticFileResult[] = [];
    for (const abs of absPaths) {
      const uri = vscode.Uri.file(abs);
      // 触发语言服务分析（打开但不显示），等待诊断稳定
      try {
        await vscode.workspace.openTextDocument(uri);
      } catch {
        /* 文件可能不存在/无法打开，按无诊断处理 */
      }
      const diags = await this.waitForDiagnostics(uri);
      const errors = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
      const rel = toRel(cwd, abs);
      results.push({
        path: rel,
        ok: errors.length === 0,
        errorCount: errors.length,
        details: errors.length > 0
          ? errors.map((d) => `第 ${d.range.start.line + 1} 行: ${d.message}`).join("\n")
          : undefined,
      });
    }
    return results;
  }

  /** 轮询等待某文件的诊断稳定（语言服务异步产出），超时即返回当前结果 */
  private async waitForDiagnostics(uri: vscode.Uri): Promise<readonly vscode.Diagnostic[]> {
    const start = Date.now();
    let last = vscode.languages.getDiagnostics(uri);
    while (Date.now() - start < SETTLE_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const cur = vscode.languages.getDiagnostics(uri);
      // 诊断数量稳定（连续两次相同）视为已 settle
      if (cur.length === last.length) return cur;
      last = cur;
    }
    return last;
  }

  /** 汇总整个工作区所有含 error 的文件 */
  private collectAll(cwd: string): DiagnosticFileResult[] {
    const all = vscode.languages.getDiagnostics();
    const results: DiagnosticFileResult[] = [];
    for (const [uri, diags] of all) {
      const errors = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
      if (errors.length === 0) continue;
      results.push({
        path: toRel(cwd, uri.fsPath),
        ok: false,
        errorCount: errors.length,
        details: errors.map((d) => `第 ${d.range.start.line + 1} 行: ${d.message}`).join("\n"),
      });
    }
    if (results.length === 0) {
      results.push({ path: "（整个项目）", ok: true, errorCount: 0, scope: "project" });
    }
    return results;
  }
}
