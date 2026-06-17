/*---------------------------------------------------------------------------------------------
 *  Axon —— Git 追溯注解（对标 IntelliJ IDEA「Annotate with Git Blame」）
 *
 *  在编辑器行号/装订区右键菜单提供「使用 Git 追溯注解」。点击后：
 *   1) 校验当前文件是否处于 Git 仓库；不是则弹出来源为「Axon」的警告（扩展 displayName 即 Axon）。
 *   2) 运行 `git blame --line-porcelain` 解析逐行的最近提交作者与时间。
 *   3) 以注入式装饰（before）在每行正文前渲染「日期 + 作者」列，再次点击同一文件即切换关闭。
 *
 *  设计：Controller 持有每个文档的注解状态与生命周期（编辑/关闭时自动清除，避免行号错位）。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import { execFile, spawn } from "node:child_process";
import { dirname } from "node:path";

/** 切换 Git 追溯注解的命令 id（package.json 同步贡献到 editor/lineNumber/context）。 */
export const TOGGLE_BLAME_COMMAND_ID = "axon.git.toggleBlameAnnotation";

/** 单行的 blame 元数据 */
interface LineBlame {
  author: string;
  /** 提交时间（unix 秒） */
  time: number;
  /** 是否为尚未提交的本地改动 */
  uncommitted: boolean;
}

/** 注册 Git 追溯注解功能（命令 + 生命周期监听）。 */
export function registerGitBlameAnnotation(context: vscode.ExtensionContext): void {
  const controller = new BlameController();
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand(TOGGLE_BLAME_COMMAND_ID, () => controller.toggleActiveEditor()),
    // 文档被编辑后防抖重算 blame（基于当前缓冲区内容，保证行号对齐且实时更新）
    vscode.workspace.onDidChangeTextDocument((e) => controller.onDocumentChanged(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => controller.clear(doc.uri)),
  );
}

/** 单个文档的注解状态：装饰类型 + 防抖刷新计时器。 */
interface BlameEntry {
  type: vscode.TextEditorDecorationType;
  refreshTimer?: ReturnType<typeof setTimeout>;
}

/** 编辑后重算 blame 的防抖延迟（ms）。 */
const REFRESH_DEBOUNCE_MS = 500;

/** 注解控制器：按文档 uri 管理装饰类型与开关状态。 */
class BlameController implements vscode.Disposable {
  private readonly active = new Map<string, BlameEntry>();

  async toggleActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const key = editor.document.uri.toString();
    if (this.active.has(key)) {
      this.clear(editor.document.uri);
      return;
    }
    await this.show(editor);
  }

  /** 清除指定文档的注解（释放装饰类型即从编辑器移除）。 */
  clear(uri: vscode.Uri): void {
    const key = uri.toString();
    const entry = this.active.get(key);
    if (entry) {
      if (entry.refreshTimer) {
        clearTimeout(entry.refreshTimer);
      }
      entry.type.dispose();
      this.active.delete(key);
    }
  }

  /** 文档变更：若该文档处于注解开启状态，防抖后基于当前缓冲区内容重算并更新注解。 */
  onDocumentChanged(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const entry = this.active.get(key);
    if (!entry) {
      return;
    }
    if (entry.refreshTimer) {
      clearTimeout(entry.refreshTimer);
    }
    entry.refreshTimer = setTimeout(() => {
      entry.refreshTimer = undefined;
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
      if (editor) {
        void this.renderBlame(editor, doc.uri.fsPath, dirname(doc.uri.fsPath), false);
      }
    }, REFRESH_DEBOUNCE_MS);
  }

  dispose(): void {
    for (const entry of this.active.values()) {
      if (entry.refreshTimer) {
        clearTimeout(entry.refreshTimer);
      }
      entry.type.dispose();
    }
    this.active.clear();
  }

  /** 校验 + 首次渲染。 */
  private async show(editor: vscode.TextEditor): Promise<void> {
    const uri = editor.document.uri;
    if (uri.scheme !== "file") {
      warn("仅支持对已保存的本地文件使用 Git 追溯注解。");
      return;
    }
    if (editor.document.isUntitled) {
      warn("请先保存文件后再使用 Git 追溯注解。");
      return;
    }
    const filePath = uri.fsPath;
    const cwd = dirname(filePath);
    if (!(await isInsideGitRepo(cwd))) {
      warn("当前文件不在 Git 仓库中，无法使用 Git 追溯注解。");
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "Axon：正在生成 Git 追溯注解…" },
      async () => this.renderBlame(editor, filePath, cwd, true),
    );
  }

  /**
   * 执行 blame 并把装饰应用到编辑器。
   * 始终以编辑器当前缓冲区内容（含未保存改动）作为 blame 输入，保证行号对齐：
   * 与历史提交一致的行归属对应提交，本地改动/新增行归零 SHA → 注解留空（对齐 IDEA）。
   * @param create true=首次开启（失败时提示用户）；false=编辑后静默刷新。
   */
  private async renderBlame(editor: vscode.TextEditor, filePath: string, cwd: string, create: boolean): Promise<void> {
    let stdout: string;
    try {
      stdout = await gitBlame(filePath, cwd, editor.document.getText());
    } catch (err) {
      if (create) {
        warn(`Git 追溯注解失败：${(err as Error).message}`);
      }
      return;
    }
    const blameByLine = parseLinePorcelain(stdout);
    const key = editor.document.uri.toString();
    const entry = this.active.get(key);
    const type = entry?.type ?? createBlameDecorationType();
    editor.setDecorations(type, buildDecorationOptions(editor.document, blameByLine));
    if (!entry) {
      this.active.set(key, { type });
    }
  }
}

/** 弹出来源为「Axon」的警告（source 由扩展 displayName 决定）。 */
function warn(message: string): void {
  vscode.window.showWarningMessage(message);
}

/** 判定目录是否在 Git 工作区内。 */
async function isInsideGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await execGit(["rev-parse", "--is-inside-work-tree"], cwd);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** 运行 git blame --line-porcelain，以缓冲区内容（含未保存改动）作为输入保证行号对齐。 */
async function gitBlame(filePath: string, cwd: string, contents: string): Promise<string> {
  return spawnGit(["blame", "--line-porcelain", "--contents", "-", "--", filePath], cwd, contents);
}

/** 统一的 git 子进程调用（execFile，无 stdin 输入场景）。 */
function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || "").trim() || "git 命令执行失败"));
        return;
      }
      resolve(stdout);
    });
  });
}

/** 需要 stdin 输入的 git 调用（spawn，把内容喂给 --contents -）。 */
function spawnGit(args: string[], cwd: string, input: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `git 退出码 ${code}`));
      }
    });
    // 写入缓冲区内容；忽略 EPIPE（git 提前退出时）
    child.stdin.on("error", () => { /* ignore */ });
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * 解析 `git blame --line-porcelain` 输出。
 * 每行块以 `<sha> <orig> <final> [<n>]` 开头，随后 author / author-time 等字段重复出现，
 * 最后以 `\t<原文行>` 收尾。返回 final 行号(1-based) → LineBlame 的映射。
 */
function parseLinePorcelain(stdout: string): Map<number, LineBlame> {
  const result = new Map<number, LineBlame>();
  const lines = stdout.split("\n");
  const headerRe = /^([0-9a-f]{40}) \d+ (\d+)/;
  let finalLine = -1;
  let author = "";
  let time = 0;
  let sha = "";
  for (const raw of lines) {
    const header = headerRe.exec(raw);
    if (header) {
      sha = header[1];
      finalLine = parseInt(header[2], 10);
      author = "";
      time = 0;
      continue;
    }
    if (raw.startsWith("author ")) {
      author = raw.slice("author ".length).trim();
    } else if (raw.startsWith("author-time ")) {
      time = parseInt(raw.slice("author-time ".length).trim(), 10) || 0;
    } else if (raw.startsWith("\t") && finalLine > 0) {
      const uncommitted = /^0{40}$/.test(sha);
      result.set(finalLine, { author: uncommitted ? "未提交" : author || "未知", time, uncommitted });
      finalLine = -1;
    }
  }
  return result;
}

/** 创建注解装饰类型（注入式 before 列，使用行号前景色，弱化展示）。 */
function createBlameDecorationType(): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    before: {
      color: new vscode.ThemeColor("editorLineNumber.foreground"),
      margin: "0 1.2em 0 0",
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
}

/** 为每一行构建带 before 内容的装饰项，列宽对齐。 */
function buildDecorationOptions(
  doc: vscode.TextDocument,
  blameByLine: Map<number, LineBlame>,
): vscode.DecorationOptions[] {
  const authorWidth = computeAuthorWidth(blameByLine);
  const options: vscode.DecorationOptions[] = [];
  for (let i = 0; i < doc.lineCount; i++) {
    const blame = blameByLine.get(i + 1);
    // 未提交（尚未 commit）的行没有归属，注解列留空——对齐 IDEA 行为
    const contentText = blame && !blame.uncommitted ? formatAnnotation(blame, authorWidth) : "";
    options.push({
      range: new vscode.Range(i, 0, i, 0),
      renderOptions: { before: { contentText } },
    });
  }
  return options;
}

/** 作者列宽（按字符数，限制上限避免过宽；忽略未提交行）。 */
function computeAuthorWidth(blameByLine: Map<number, LineBlame>): number {
  let width = 0;
  for (const b of blameByLine.values()) {
    if (b.uncommitted) {
      continue;
    }
    width = Math.max(width, b.author.length);
  }
  return Math.min(width, 16);
}

/** 单行注解文本：`YYYY/MM/DD  作者`（作者右侧补空格对齐）。 */
function formatAnnotation(blame: LineBlame, authorWidth: number): string {
  const date = blame.time > 0 ? formatDate(blame.time) : "          ";
  const author = truncatePad(blame.author, authorWidth);
  return `${date}  ${author}`;
}

/** unix 秒 → YYYY/MM/DD（零补齐，固定 10 字符宽便于列对齐）。 */
function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

/** 截断到 width 字符并右侧补空格对齐。 */
function truncatePad(text: string, width: number): string {
  const t = text.length > width ? `${text.slice(0, width - 1)}…` : text;
  return t.padEnd(width, " ");
}
