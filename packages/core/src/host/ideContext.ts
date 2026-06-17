/**
 * IDE 上下文提供者（执行端 ① 的可选能力，进程内 IDE 形态独有）
 *
 * 这是“品牌 AI IDE 原生感”的来源：Agent 能感知当前编辑器状态（活动文件、选区、
 * 打开的文件、未保存改动、git diff、可见诊断），对应你给的 EnvironmentContext 里
 * OPEN-EDITOR-FILES / ACTIVE-EDITOR-FILE 那套信息。
 *
 * - VSCodeAgentHost：基于 window.activeTextEditor / visibleTextEditors / git 扩展实现
 * - NodeAgentHost：不实现（web/cli 形态没有“编辑器”概念），AgentHost.ideContext 为 undefined。
 *
 * core 对该能力做可选判空：存在则把上下文注入到给模型的请求里，不存在则跳过。
 */

/** 文本范围（0-indexed，半开区间，与 VS Code Selection 对齐） */
export interface TextRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

/** 活动编辑器信息 */
export interface ActiveEditorInfo {
  /** 文件绝对路径 */
  path: string;
  /** 当前选区（无选区时为光标位置的空区间） */
  selection?: TextRange;
  /** 选中的文本（便于直接注入，避免 core 再去读文件切片） */
  selectedText?: string;
}

/** Agent 可感知的 IDE 上下文 */
export interface IdeContextProvider {
  /** 当前活动编辑器；无则返回 null */
  activeEditor(): ActiveEditorInfo | null;

  /** 当前打开的所有文件绝对路径 */
  openFiles(): string[];

  /** 工作区 git diff（未跟踪/已暂存视实现而定）；无 git 或失败返回空串 */
  gitDiff(): Promise<string>;
}
