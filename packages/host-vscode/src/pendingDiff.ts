/**
 * PendingDiffPresenter —— 用 VS Code 原生 diff 编辑器呈现"待确认改动"（方案 C 核心体验）
 *
 * manual 模式下，Agent 的每处改动不直接落盘，而是：
 *  1. 把"新内容"放进一个 axon-pending: 虚拟文档（由 TextDocumentContentProvider 提供）
 *  2. 打开原生 diff 编辑器：左=磁盘原内容，右=待确认新内容（虚拟文档，只读）
 *  3. 用户在原生 diff 视图里审阅；accept 落盘、reject 丢弃，对应关闭 diff
 *
 * 这是与 Node/web 形态（自绘 diff）的关键差异：复用 IDE 自身的 diff/并排视图与导航能力。
 *
 * 注意：本类仅负责"呈现层"。暂存数据仍由 VSCodeEditPresenter 持有；本类向它回查内容，
 * 通过注入的 contentResolver 把 absPath → 待确认新内容暴露给虚拟文档 provider。
 */

import * as vscode from "vscode";
import { basename } from "node:path";

/** axon 待确认改动的虚拟文档 scheme */
export const PENDING_SCHEME = "axon-pending";

export class PendingDiffPresenter {
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  private disposables: vscode.Disposable[] = [];

  /**
   * @param contentResolver 由 EditPresenter 注入：根据 absPath 返回当前待确认的新内容；
   *        无暂存返回 null（虚拟文档显示空）。
   */
  constructor(private contentResolver: (absPath: string) => string | null) {
    const provider: vscode.TextDocumentContentProvider = {
      onDidChange: this.emitter.event,
      provideTextDocumentContent: (uri) => {
        // 虚拟 uri 的 path 即真实文件绝对路径（见 pendingUri）
        const absPath = uriToAbsPath(uri);
        return this.contentResolver(absPath) ?? "";
      },
    };
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(PENDING_SCHEME, provider),
    );
  }

  /** 打开/聚焦某文件的原生 diff（左=磁盘原内容，右=待确认新内容） */
  async openDiff(absPath: string, isNew: boolean): Promise<void> {
    const right = pendingUri(absPath);
    // 通知虚拟文档刷新（内容可能已更新）
    this.emitter.fire(right);
    const left = isNew
      // 新建文件：左侧用一个空的同 scheme 文档表示"原本不存在"
      ? pendingUri(absPath + ".__empty__")
      : vscode.Uri.file(absPath);
    const title = `${basename(absPath)} (Axon 待确认)`;
    await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true });
  }

  /** 改动内容更新后刷新对应 diff 的右侧虚拟文档 */
  refresh(absPath: string): void {
    this.emitter.fire(pendingUri(absPath));
  }

  /** 关闭某文件的待确认 diff（accept/reject 后调用）。VS Code 无精确关闭单个 diff 的 API，
   * 这里通过刷新让虚拟文档变空；标签由用户或后续操作自然替换。 */
  close(absPath: string): void {
    this.emitter.fire(pendingUri(absPath));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }
}

/** 把真实文件绝对路径编码为 axon-pending: 虚拟 uri */
export function pendingUri(absPath: string): vscode.Uri {
  // 用 query 携带绝对路径，避免 Windows 盘符冒号与 scheme 冲突
  return vscode.Uri.from({ scheme: PENDING_SCHEME, path: "/pending", query: absPath });
}

/** 从虚拟 uri 还原真实文件绝对路径 */
function uriToAbsPath(uri: vscode.Uri): string {
  return uri.query;
}
