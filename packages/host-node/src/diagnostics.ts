/**
 * NodeDiagnostics —— 基于 tsc --noEmit 的 HostDiagnostics 实现
 *
 * 迁移自 tools.ts 的 checkDiagnostics：TypeScript 项目跑一次项目级 tsc，解析
 * `src/foo.ts(12,5): error TSxxxx: ...` 错误行，按文件归类汇报。
 *
 * 与 core 的差异：core 传入的是【绝对路径数组】，这里转回相对 cwd 路径用于展示与匹配。
 * 非 TS 项目返回“无法诊断”，与原实现语义一致。
 */

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { HostDiagnostics, DiagnosticFileResult } from "@axon/core";

/** 把绝对路径转成相对 cwd 的正斜杠路径 */
function toRel(cwd: string, abs: string): string {
  return relative(cwd, abs).split(sep).join("/");
}

function runTsc(cwd: string): Promise<string> {
  const wrapped =
    `chcp 65001 > $null; ` +
    `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ` +
    `npx tsc --noEmit 2>&1`;
  return new Promise<string>((resolve) => {
    exec(wrapped, { cwd, timeout: 60_000, encoding: "utf-8", shell: "powershell.exe" }, (err, stdout, stderr) => {
      // tsc 有错误时退出码非 0，错误内容在 stdout
      resolve((stdout || "") + (stderr || ""));
    });
  });
}

export class NodeDiagnostics implements HostDiagnostics {
  async check(cwd: string, absPaths: string[]): Promise<DiagnosticFileResult[]> {
    const relPaths = absPaths.map((p) => toRel(cwd, p));

    if (!existsSync(join(cwd, "tsconfig.json"))) {
      // 非 TS 项目：标记为无法诊断（ok=true 表示无错误可报）
      if (relPaths.length > 0) {
        return relPaths.map((p) => ({ path: p, ok: true, errorCount: 0, details: "非 TypeScript 项目，未做类型检查" }));
      }
      return [{ path: "（整个项目）", ok: true, errorCount: 0, scope: "project", details: "非 TypeScript 项目，未做类型检查" }];
    }

    const raw = await runTsc(cwd);

    // 解析 tsc 输出，按文件归类
    const errorsByFile = new Map<string, string[]>();
    const lineRe = /^(.+?\.\w+)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/;
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(lineRe);
      if (!m) continue;
      const file = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
      const entry = `第 ${m[2]} 行: ${m[5]} ${m[6]}`;
      if (!errorsByFile.has(file)) errorsByFile.set(file, []);
      errorsByFile.get(file)!.push(entry);
    }

    const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
    const results: DiagnosticFileResult[] = [];

    if (relPaths.length > 0) {
      for (const reqPath of relPaths.map(norm)) {
        const matchedKey = [...errorsByFile.keys()].find(
          (k) => k === reqPath || k.endsWith("/" + reqPath) || reqPath.endsWith("/" + k),
        );
        const errs = matchedKey ? errorsByFile.get(matchedKey)! : [];
        results.push({
          path: reqPath,
          ok: errs.length === 0,
          errorCount: errs.length,
          details: errs.length > 0 ? errs.join("\n") : undefined,
        });
      }
    } else if (errorsByFile.size === 0) {
      results.push({ path: "（整个项目）", ok: true, errorCount: 0, scope: "project" });
    } else {
      for (const [file, errs] of errorsByFile) {
        results.push({ path: file, ok: false, errorCount: errs.length, details: errs.join("\n") });
      }
    }

    return results;
  }
}
