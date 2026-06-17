/**
 * 诊断（类型/编译检查）抽象（执行端 ① 的一部分）
 *
 * 对应 tools.ts 的 check_diagnostics。形态差异巨大，是抽象的重点收益之一：
 * - NodeAgentHost：调用 tsc --noEmit，解析输出（仅 TS 项目，需起子进程，慢）
 * - VSCodeAgentHost：直接读 vscode.languages.getDiagnostics（实时、全语言、零子进程）
 *
 * core 只消费标准化的 DiagnosticFileResult，不关心底层用什么引擎产出。
 */

/** 单个文件的诊断结果（与现有 tools.DiagnosticFileResult 对齐） */
export interface DiagnosticFileResult {
  /** 相对工作区路径 */
  path: string;
  /** 是否无错误 */
  ok: boolean;
  /** 错误条数 */
  errorCount: number;
  /** 可选：错误明细文本（行号 + 原因），供前端展开展示 */
  details?: string;
  /** 结果作用域：'project' 表示整个项目的汇总结果（非单个文件）。缺省为文件级。 */
  scope?: 'project';
}

/** Agent 可用的诊断能力 */
export interface HostDiagnostics {
  /**
   * 对指定文件做诊断。
   * @param cwd 工作区根（绝对路径），用于把绝对路径转回相对路径展示
   * @param absPaths 要检查的文件绝对路径数组；为空表示检查整个项目
   */
  check(cwd: string, absPaths: string[]): Promise<DiagnosticFileResult[]>;
}
