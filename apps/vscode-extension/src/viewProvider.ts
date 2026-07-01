/**
 * AxonViewProvider —— 侧栏 webview 视图，承载现有 web 的 React UI
 *
 * 职责：
 * - resolveWebviewView：加载 web 构建产物（media/web/）的 HTML，改写资源 URI 与注入 CSP
 * - 出站：把 webview 绑定到 VSCodeChannel（AgentEvent → postMessage）
 * - 入站分流：
 *     · __axonReq（REST 请求）→ RequestRouter.handle → 回 __axonRes
 *     · ControlCommand（{type:...} 对话指令）→ dispatch（SessionHub）
 *
 * web 产物位置：扩展构建时把 web 的 dist 拷到 media/web/（见 scripts/copy-web）。
 * 缺失时回退占位页，保证视图可加载、内核链路可联调。
 */

import * as vscode from "vscode";
import type { ControlCommand } from "@axon/core";
import type { VSCodeChannel } from "./vscodeChannel.js";
import type { RequestRouter } from "./requestRouter.js";

export class AxonViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "axon.chat";

  private view: vscode.WebviewView | null = null;

  constructor(
    private context: vscode.ExtensionContext,
    private channel: VSCodeChannel,
    private dispatch: (cmd: ControlCommand) => Promise<void>,
    private router: RequestRouter,
  ) {
    // 注册 diff 虚拟文档 provider：用内存 Map 存内容，URI 只携带 key
    const diffContents = new Map<string, string>();
    (this as any)._diffContents = diffContents; // 暴露给 open_diff 处理用
    const diffContentProvider: vscode.TextDocumentContentProvider = {
      provideTextDocumentContent: (uri) => {
        return diffContents.get(uri.toString()) ?? "";
      },
    };
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider("axon-diff-old", diffContentProvider),
      vscode.workspace.registerTextDocumentContentProvider("axon-diff-new", diffContentProvider),
    );
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    const webRoot = vscode.Uri.joinPath(this.context.extensionUri, "media", "web");

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [webRoot],
    };

    // 先显示 loading 占位（防止 buildHtml 耗时导致白屏）
    view.webview.html = this.loadingHtml(view.webview);

    // 出站：绑定 channel
    this.channel.setWebview(view.webview);

    // 入站分流
    view.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg as Record<string, unknown>;

      // 聚焦 Axon 终端（从工具卡片"打开终端"按钮）
      if (m.type === "focus_terminal") {
        try {
          const { focusTerminal } = require("@axon/host-vscode");
          focusTerminal();
        } catch { /* 忽略 */ }
        return;
      }

      // 聚焦 open_browser 打开的浏览器页面（从浏览器卡片输出点击）
      if (m.type === "focus_browser") {
        try { await this.dispatch({ type: "focus_browser" } as ControlCommand); } catch { /* 忽略 */ }
        return;
      }

      // 用系统浏览器打开外部链接（webview 中 target=_blank 被拦截）
      if (m.type === "open_external" && typeof m.url === "string") {
        try {
          await vscode.env.openExternal(vscode.Uri.parse(m.url as string));
        } catch {
          vscode.window.showWarningMessage(`无法打开链接：${m.url}`);
        }
        return;
      }

      // 打开文件（从工具卡片文件名标签点击）
      if (m.type === "open_file" && typeof m.path === "string") {
        const filePath = m.path as string;
        const startLine = typeof m.startLine === "number" ? m.startLine : undefined;
        const endLine = typeof m.endLine === "number" ? m.endLine : undefined;
        const path = require("path");
        try {
          // 如果是相对路径，基于工作区根目录 resolve 为绝对路径
          let absPath = filePath;
          if (!path.isAbsolute(filePath)) {
            const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (wsFolder) {
              absPath = path.resolve(wsFolder, filePath);
            }
          }
          const uri = vscode.Uri.file(absPath);
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type === vscode.FileType.File) {
            const editor = await vscode.window.showTextDocument(uri, { preview: true });
            // 带行号时：滚动到起始行并选中行范围内的代码
            if (startLine && startLine >= 1) {
              const doc = editor.document;
              const startIdx = Math.min(startLine - 1, Math.max(0, doc.lineCount - 1));
              const endIdx = endLine && endLine >= 1
                ? Math.min(endLine - 1, Math.max(0, doc.lineCount - 1))
                : startIdx;
              const endCol = doc.lineAt(endIdx).text.length;
              const selection = new vscode.Selection(startIdx, 0, endIdx, endCol);
              editor.selection = selection;
              editor.revealRange(
                new vscode.Range(startIdx, 0, endIdx, endCol),
                vscode.TextEditorRevealType.InCenterIfOutsideViewport,
              );
            }
          } else if (stat.type === vscode.FileType.Directory) {
            await vscode.commands.executeCommand("revealInExplorer", uri);
          }
        } catch {
          // 文件不存在或无法打开，静默忽略
        }
        return;
      }

      // 搜索工作区资源（文件/文件夹）——输入框斜杠命令的二级选择
      if (m.type === "search_resources" && typeof m.requestId === "string") {
        const clientId = typeof m.clientId === "string" ? (m.clientId as string) : undefined;
        const query = typeof m.query === "string" ? (m.query as string) : "";
        const scope = m.scope === "folder" ? "folder" : "file";
        const items = await this.searchWorkspaceResources(query, scope);
        this.postToWebview({ type: "resource_results", clientId, requestId: m.requestId as string, items });
        return;
      }

      // 把“当前打开文件”作为上下文加入输入框
      if (m.type === "add_active_file_context") {
        await this.pushActiveFileContext(
          typeof m.clientId === "string" ? (m.clientId as string) : undefined,
          typeof m.contextId === "string" ? (m.contextId as string) : undefined,
        );
        return;
      }

      // 把指定资源（文件/文件夹）作为上下文加入输入框
      if (m.type === "add_resource_context" && typeof m.path === "string") {
        const scope = m.kind === "folder" ? "folder" : "file";
        await this.pushResourceContext(
          m.path as string,
          scope,
          typeof m.clientId === "string" ? (m.clientId as string) : undefined,
          typeof m.contextId === "string" ? (m.contextId as string) : undefined,
        );
        return;
      }

      // 把“当前文件的问题/诊断”作为上下文加入输入框
      if (m.type === "add_diagnostics_context") {
        await this.pushDiagnosticsContext(
          typeof m.clientId === "string" ? (m.clientId as string) : undefined,
          typeof m.contextId === "string" ? (m.contextId as string) : undefined,
        );
        return;
      }

      // 打开 Provider 配置面板
      if (m.type === "open_provider") {
        vscode.commands.executeCommand("axon.openProvider");
        return;
      }

      // 打开 Relay 详情 Tab（webview panel 渲染完整 Relay 面板）
      if (m.type === "open_relay" && typeof m.relayId === "string") {
        const relayId = m.relayId as string;
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
        const { openOrFocusPanel } = require("./panelManager.js");
        openOrFocusPanel({
          id: `relay-${relayId}`,
          title: `Relay: ${relayId}`,
          query: `view=relay&id=${encodeURIComponent(relayId)}&workspace=${encodeURIComponent(workspace)}`,
          extensionUri: this.context.extensionUri,
          router: this.router,
          postToSidebar: (msg: unknown) => this.postToWebview(msg),
          icon: "media/relay.svg",
        });
        return;
      }

      // 打开 Power 详情 Tab（从聊天卡片点击 Power 名称）
      if (m.type === "open_power_tab" && typeof m.powerName === "string") {
        const powerName = m.powerName as string;
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
        const { openOrFocusPanel } = require("./panelManager.js");
        openOrFocusPanel({
          id: `power-${powerName}`,
          title: `Power: ${powerName}`,
          query: `view=powers&name=${encodeURIComponent(powerName)}&workspace=${encodeURIComponent(workspace)}`,
          extensionUri: this.context.extensionUri,
          router: this.router,
          icon: "media/powers.svg",
        });
        return;
      }

      // 打开原生 diff 视图（对标 Kiro：oldContent ↔ newContent 双栏对比）
      if (m.type === "open_diff" && typeof m.path === "string") {
        const filePath = m.path as string;
        const oldContent = typeof m.oldContent === "string" ? (m.oldContent as string) : "";
        const newContent = typeof m.newContent === "string" ? (m.newContent as string) : "";
        try {
          const path = require("path");
          const fileName = path.basename(filePath);
          const diffContents = (this as any)._diffContents as Map<string, string>;
          // 用唯一 key 存内容到 Map，URI 只携带 key（避免 URI malformed）
          const ts = Date.now();
          const leftUri = vscode.Uri.parse(`axon-diff-old:${fileName}?id=${ts}`);
          const rightUri = vscode.Uri.parse(`axon-diff-new:${fileName}?id=${ts}`);
          diffContents.set(leftUri.toString(), oldContent);
          diffContents.set(rightUri.toString(), newContent);
          const title = `${fileName} ↔ ${fileName} (Axon)`;
          await vscode.commands.executeCommand("vscode.diff", leftUri, rightUri, title, { preview: false });
        } catch {
          // 文件可能不存在（已被拒绝/删除），静默忽略
        }
        return;
      }

      // REST 请求
      if (m.__axonReq === true && typeof m.id === "string") {
        try {
          const data = await this.router.handle(
            String(m.method || "GET"),
            String(m.path || ""),
            m.body,
          );
          void view.webview.postMessage({ __axonRes: true, id: m.id, ok: true, data });
        } catch (err) {
          void view.webview.postMessage({ __axonRes: true, id: m.id, ok: false, error: (err as Error).message });
        }
        return;
      }

      // Agent 控制指令
      if (typeof m.type === "string") {
        void this.dispatch(m as unknown as ControlCommand);
      }
    });

    view.onDidDispose(() => {
      this.channel.setWebview(null);
      this.view = null;
    });

    view.webview.html = await this.buildHtml(view.webview, webRoot);

    // 主动推送当前工作区信息给 webview（VS Code 扩展模式下工作区已确定，不需要用户手动选）
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      const workspaces = folders.map((f) => f.uri.fsPath);
      void view.webview.postMessage({
        type: "workspace_set",
        workspace: workspaces[0],
        workspaces,
      });
    }
  }

  postToWebview(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  /** 资源条目（回传给 webview 斜杠命令菜单） */
  private async searchWorkspaceResources(
    query: string,
    scope: "file" | "folder",
  ): Promise<Array<{ name: string; relativePath: string; path: string; kind: "file" | "folder" }>> {
    const path = require("path");
    // 排除所有非源码目录：依赖、版本控制、构建产物、缓存等
    const exclude = "**/{node_modules,.git,dist,build,out,target,bin,obj,.next,.turbo,.venv,venv,__pycache__,coverage,.idea,.cache,.axon,.DS_Store,*.egg-info,*.class,*.pyc}/**";
    // 严格限定搜索范围：只在已加入工作区的文件夹内搜索，不搜工作区之外的路径。
    const wsFolders = vscode.workspace.workspaceFolders ?? [];
    let uris: vscode.Uri[] = [];
    if (wsFolders.length > 0) {
      for (const folder of wsFolders) {
        const hits = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, "**/*"),
          exclude,
          4000,
        );
        uris = uris.concat(hits);
      }
    }
    const q = query.trim().toLowerCase();

    // 排序+截断：优先文件名命中（完全相等 > 前缀 > 包含），其次路径包含；空查询取前 N 条。
    const RESULT_LIMIT = 20;
    const rankAndLimit = <T extends { name: string; relativePath: string }>(list: T[]): T[] => {
      if (!q) return list.slice(0, RESULT_LIMIT);
      const scored: Array<{ it: T; score: number }> = [];
      for (const it of list) {
        const name = it.name.toLowerCase();
        const rel = it.relativePath.toLowerCase();
        let score: number;
        if (name === q) score = 0;
        else if (name.startsWith(q)) score = 1;
        else if (name.includes(q)) score = 2;
        else if (rel.includes(q)) score = 3;
        else continue;
        scored.push({ it, score });
      }
      scored.sort((a, b) => a.score - b.score || a.it.relativePath.length - b.it.relativePath.length);
      return scored.slice(0, RESULT_LIMIT).map((s) => s.it);
    };

    if (scope === "file") {
      const items = uris.map((u) => ({
        name: path.basename(u.fsPath) as string,
        relativePath: vscode.workspace.asRelativePath(u, false),
        path: u.fsPath,
        kind: "file" as const,
      }));
      return rankAndLimit(items);
    }

    // folder：从文件相对路径派生出所有祖先目录，去重
    const wsRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const folderMap = new Map<string, { name: string; relativePath: string; path: string; kind: "folder" }>();
    for (const u of uris) {
      const relFile = vscode.workspace.asRelativePath(u, false);
      const segs = relFile.split(/[\\/]/);
      let acc = "";
      for (let i = 0; i < segs.length - 1; i++) {
        acc = acc ? `${acc}/${segs[i]}` : segs[i];
        if (!folderMap.has(acc)) {
          // 多根工作区下，找到该文件实际所属的工作区根来拼接绝对路径
          const root = wsRoots.find((r) => u.fsPath.startsWith(r + path.sep)) || wsRoots[0] || "";
          folderMap.set(acc, { name: segs[i], relativePath: acc, path: path.join(root, acc), kind: "folder" });
        }
      }
    }
    return rankAndLimit(Array.from(folderMap.values()));
  }

  /** 取“当前活动的文件型编辑器”（webview 聚焦时回退到可见编辑器） */
  private activeFileEditor(): vscode.TextEditor | undefined {
    const active = vscode.window.activeTextEditor;
    if (active && active.document.uri.scheme === "file") return active;
    return vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === "file");
  }

  /** 把内容裁剪到上限，避免超大文件灌爆上下文 */
  private clampContent(text: string): string {
    const MAX = 100 * 1024;
    return text.length > MAX ? `${text.slice(0, MAX)}\n…（内容过长已截断）` : text;
  }

  /** 推送“当前打开文件”作为上下文芯片 */
  private async pushActiveFileContext(clientId?: string, contextId?: string): Promise<void> {
    const editor = this.activeFileEditor();
    if (!editor) {
      this.postToWebview({ type: "add_context", source: "file", clientId, contextId, label: "（无打开的文件）", text: "当前没有打开的文件。", size: 0 });
      return;
    }
    const doc = editor.document;
    const rel = vscode.workspace.asRelativePath(doc.uri, false);
    const text = this.clampContent(doc.getText());
    this.postToWebview({ type: "add_context", source: "file", clientId, contextId, label: rel, text, size: text.length });
  }

  /** 推送指定资源（文件读内容 / 文件夹给文件树清单）作为上下文芯片 */
  private async pushResourceContext(p: string, kind: "file" | "folder", clientId?: string, contextId?: string): Promise<void> {
    const uri = vscode.Uri.file(p);
    const rel = vscode.workspace.asRelativePath(uri, false);
    if (kind === "folder") {
      // 选目录 = 注入该目录的文件树清单（相对路径列表，封顶 300 条），让 AI 看结构而非塞全部内容
      const exclude = "**/{node_modules,.git,dist,build,out,.next,.turbo,.venv,venv,__pycache__,coverage,.idea,.cache}/**";
      const found = await vscode.workspace.findFiles(new vscode.RelativePattern(uri, "**/*"), exclude, 300);
      const rels = found.map((f) => vscode.workspace.asRelativePath(f, false)).sort();
      const truncated = found.length >= 300 ? "\n…（文件过多已截断）" : "";
      const text = `文件夹 ${rel}（${rels.length} 个文件）：\n${rels.join("\n")}${truncated}`;
      this.postToWebview({ type: "add_context", source: "folder", clientId, contextId, label: rel, text, size: text.length });
      return;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = this.clampContent(Buffer.from(bytes).toString("utf8"));
      this.postToWebview({ type: "add_context", source: "file", clientId, contextId, label: rel, text, size: text.length });
    } catch {
      this.postToWebview({ type: "add_context", source: "file", clientId, contextId, label: rel, text: `（无法读取文件 ${rel}）`, size: 0 });
    }
  }

  /** 推送“当前文件的问题/诊断”作为上下文芯片 */
  private async pushDiagnosticsContext(clientId?: string, contextId?: string): Promise<void> {
    const editor = this.activeFileEditor();
    if (!editor) {
      this.postToWebview({ type: "add_context", source: "diagnostics", clientId, contextId, label: "诊断", text: "当前没有打开的文件。", size: 0 });
      return;
    }
    const uri = editor.document.uri;
    const rel = vscode.workspace.asRelativePath(uri, false);
    const diags = vscode.languages.getDiagnostics(uri);
    if (diags.length === 0) {
      const text = `文件 ${rel} 当前没有诊断问题。`;
      this.postToWebview({ type: "add_context", source: "diagnostics", clientId, contextId, label: `${rel} · 无问题`, text, size: text.length });
      return;
    }
    const sevLabel = (s: vscode.DiagnosticSeverity): string =>
      s === vscode.DiagnosticSeverity.Error ? "Error"
        : s === vscode.DiagnosticSeverity.Warning ? "Warning"
          : s === vscode.DiagnosticSeverity.Information ? "Info"
            : "Hint";
    const lines = diags
      .slice(0, 50)
      .map((d) => `[${sevLabel(d.severity)}] L${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}${d.source ? ` (${d.source})` : ""}`);
    const text = lines.join("\n");
    this.postToWebview({ type: "add_context", source: "diagnostics", clientId, contextId, label: `${rel} · ${diags.length} 问题`, text, size: text.length });
  }


  /** 加载 web 构建产物的 index.html，改写其中的资源引用为 webview 可用的 URI */
  private async buildHtml(webview: vscode.Webview, webRoot: vscode.Uri): Promise<string> {
    const indexUri = vscode.Uri.joinPath(webRoot, "index.html");
    let html: string;
    try {
      const bytes = await vscode.workspace.fs.readFile(indexUri);
      html = new TextDecoder("utf-8").decode(bytes);
    } catch {
      return this.placeholderHtml(webview);
    }

    // 把 /assets/xxx 或 ./assets/xxx 形式的资源引用改写为 webview.asWebviewUri
    const baseUri = webview.asWebviewUri(webRoot).toString().replace(/\/$/, "");
    html = html
      .replace(/(src|href)="\.?\/assets\//g, `$1="${baseUri}/assets/`)
      .replace(/(src|href)="\.\/(?!assets)/g, `$1="${baseUri}/`);

    // 注入 CSP（允许 webview 资源 + inline 样式；脚本仅限 webview 源）
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`,
      `font-src ${webview.cspSource} data:`,
      `connect-src ${webview.cspSource}`,
    ].join("; ");
    if (!/Content-Security-Policy/.test(html)) {
      html = html.replace(/<head>/i, `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}" />`);
    }
    return html;
  }

  private placeholderHtml(webview: vscode.Webview): string {
    const csp = `default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline';`;
    return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:16px}.hint{opacity:.7;font-size:12px;line-height:1.6}code{background:var(--vscode-textCodeBlock-background);padding:1px 4px;border-radius:3px}</style>
</head><body>
<h3>Axon</h3>
<p class="hint">未找到 web 构建产物（<code>media/web/index.html</code>）。<br/>请先构建 web 并拷贝到扩展：<code>pnpm --filter axon-ide build:web</code>。<br/>内核链路（webview ↔ SessionHub ↔ AgentSession）已就绪。</p>
</body></html>`;
  }

  /** 加载中占位页：Extension Host 初始化/读文件时避免白屏 */
  private loadingHtml(webview: vscode.Webview): string {
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';`;
    return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.loader{display:flex;flex-direction:column;align-items:center;gap:12px}
.spinner{width:24px;height:24px;border:2px solid var(--vscode-foreground);border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.text{font-size:12px;opacity:.7}
</style>
</head><body>
<div class="loader">
<div class="spinner"></div>
<span class="text">Axon 加载中...</span>
</div>
</body></html>`;
  }
}
