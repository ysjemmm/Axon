/**
 * 编辑器 Tab 面板管理（Relay / Skill）
 *
 * 使用 VS Code WebviewPanel 在编辑器区域打开独立标签页。
 * 加载同一份 web 构建产物，通过 URL 参数 `?view=xxx` 路由到不同视图。
 */

import * as vscode from "vscode";

/** 已打开的面板缓存（按 panelId 去重） */
const activePanels = new Map<string, vscode.WebviewPanel>();

export interface PanelOptions {
  id: string;
  title: string;
  /** URL query 参数（如 view=skills&workspace=/path） */
  query: string;
  extensionUri: vscode.Uri;
  /** 可选：REST 请求路由器（让 Panel 内的 webview 也能代理 REST 请求） */
  router?: { handle(method: string, path: string, body?: unknown): Promise<unknown> };
  /** 可选：Tab 图标路径（相对 extensionUri） */
  icon?: string;
  /** 可选：向侧栏 webview 发消息（跨 webview 通信） */
  postToSidebar?: (message: unknown) => void;
}

/**
 * 打开或聚焦一个编辑器 Tab 面板。
 * 同一 id 只会存在一个实例，重复调用聚焦已有面板。
 */
export function openOrFocusPanel(options: PanelOptions): vscode.WebviewPanel {
  const existing = activePanels.get(options.id);
  if (existing) {
    existing.reveal(vscode.ViewColumn.One);
    return existing;
  }

  const webRoot = vscode.Uri.joinPath(options.extensionUri, "media", "web");

  const panel = vscode.window.createWebviewPanel(
    options.id,
    options.title,
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [webRoot],
    },
  );

  panel.webview.html = buildWebviewHtml(panel.webview, webRoot, options.query);

  // 设置 Tab 图标
  if (options.icon) {
    const iconUri = vscode.Uri.joinPath(options.extensionUri, options.icon);
    panel.iconPath = { light: iconUri, dark: iconUri };
  }

  // 绑定 REST 请求代理（让 Panel 内的 apiClient 能通过 postMessage 走 RequestRouter）
  if (options.router) {
    const router = options.router;
    panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg as Record<string, unknown>;

      // 打开 Power Tab（点击聊天卡片中的 Power 名称）
      if (m.type === "open_power_tab" && typeof m.powerName === "string") {
        const powerName = m.powerName as string;
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
        // 调用 openOrFocusPanel 打开或聚焦 Power Tab
        openOrFocusPanel({
          id: `power-${powerName}`,
          title: `Power: ${powerName}`,
          query: `view=powers&name=${encodeURIComponent(powerName)}&workspace=${encodeURIComponent(workspace)}`,
          extensionUri: options.extensionUri,
          router: options.router,
          icon: "media/powers.svg",
        });
        return;
      }

      // 打开文件到 VS Code 编辑器
      if (m.type === "open_file" && typeof m.filePath === "string") {
        try {
          await vscode.window.showTextDocument(vscode.Uri.file(m.filePath as string), { preview: true });
        } catch {
          vscode.window.showWarningMessage(`无法打开文件：${m.filePath}`);
        }
        return;
      }

      // 从 Relay Tab 跳转到并行面板：转发给侧栏 webview
      if (m.type === "navigate_parallel") {
        if (options.postToSidebar) {
          options.postToSidebar({ type: "navigate_parallel", batchId: m.batchId || null, relayId: m.relayId || null });
        } else {
          vscode.window.showInformationMessage("未找到关联的并行执行记录。请在侧栏「并行」面板中查看。");
        }
        return;
      }

      // 创建 steering 文件
      if (m.type === "create_steering_file") {
        const powerName = String(m.powerName || "");
        const fileName = String(m.fileName || "");
        const workspace = String(m.workspace || "");
        if (!powerName || !fileName) return;
        try {
          const { PowerRegistry } = await import("@axon/core");
          const { createVSCodeAgentHost } = await import("@axon/host-vscode");
          const { homedir } = await import("node:os");
          const { join } = await import("node:path");
          const registry = new PowerRegistry([workspace || process.cwd()], createVSCodeAgentHost(), homedir());
          const metas = await registry.discover();
          const meta = metas.find((p) => p.name === powerName);
          if (!meta) return;
          const steeringDir = join(meta.dir, "steering");
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(steeringDir));
          const filePath = join(steeringDir, fileName);
          const template = `# ${fileName.replace(/\.md$/, "")}\n\n在这里编写工作流引导内容。\n`;
          await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), new TextEncoder().encode(template));
          await vscode.window.showTextDocument(vscode.Uri.file(filePath));
        } catch (err) {
          vscode.window.showErrorMessage(`创建失败：${(err as Error).message}`);
        }
        return;
      }

      // 删除 steering 文件
      if (m.type === "delete_steering_file") {
        const powerName = String(m.powerName || "");
        const fileName = String(m.fileName || "");
        const workspace = String(m.workspace || "");
        if (!powerName || !fileName) return;
        try {
          const { PowerRegistry } = await import("@axon/core");
          const { createVSCodeAgentHost } = await import("@axon/host-vscode");
          const { homedir } = await import("node:os");
          const { join } = await import("node:path");
          const registry = new PowerRegistry([workspace || process.cwd()], createVSCodeAgentHost(), homedir());
          const metas = await registry.discover();
          const meta = metas.find((p) => p.name === powerName);
          if (!meta) return;
          const filePath = join(meta.dir, "steering", fileName);
          await vscode.workspace.fs.delete(vscode.Uri.file(filePath));
        } catch (err) {
          vscode.window.showErrorMessage(`删除失败：${(err as Error).message}`);
        }
        return;
      }

      // 导入 steering 文件（选择 .md 文件）
      if (m.type === "import_steering_file") {
        const powerName = String(m.powerName || "");
        const workspace = String(m.workspace || "");
        if (!powerName) return;
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: true,
          openLabel: "选择 Steering 文件",
          title: "选择要导入的 .md 文件",
          filters: { "Markdown": ["md"] },
        });
        if (!uris || uris.length === 0) return;
        try {
          const { PowerRegistry } = await import("@axon/core");
          const { createVSCodeAgentHost } = await import("@axon/host-vscode");
          const { homedir } = await import("node:os");
          const { join, basename } = await import("node:path");
          const registry = new PowerRegistry([workspace || process.cwd()], createVSCodeAgentHost(), homedir());
          const metas = await registry.discover();
          const meta = metas.find((p) => p.name === powerName);
          if (!meta) {
            vscode.window.showErrorMessage(`Power「${powerName}」不存在`);
            return;
          }
          const steeringDir = join(meta.dir, "steering");
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(steeringDir));
          for (const uri of uris) {
            const fileName = basename(uri.fsPath);
            const targetPath = join(steeringDir, fileName);
            // 重名校验
            try {
              await vscode.workspace.fs.stat(vscode.Uri.file(targetPath));
              vscode.window.showErrorMessage(`Steering 文件「${fileName}」已存在，跳过。`);
              continue;
            } catch { /* 不存在，可以复制 */ }
            await vscode.workspace.fs.copy(uri, vscode.Uri.file(targetPath));
          }
          vscode.window.showInformationMessage(`已导入 ${uris.length} 个 Steering 文件`);
          void panel.webview.postMessage({ type: "steering_imported", powerName });
        } catch (err) {
          vscode.window.showErrorMessage(`导入失败：${(err as Error).message}`);
        }
        return;
      }

      // VS Code 原生文件选择器：导入 Skill 到 Power
      if (m.type === "import_skill_to_power") {
        const powerName = String(m.powerName || "");
        const workspace = String(m.workspace || "");
        if (!powerName) return;
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "选择 Skill 目录",
          title: "选择要导入的 Skill 目录（应包含 SKILL.md）",
        });
        if (!uris || uris.length === 0) return;
        const sourceDir = uris[0].fsPath;
        const path = require("path");
        const skillName = path.basename(sourceDir);
        // 重名校验 + 复制
        try {
          const { PowerRegistry } = await import("@axon/core");
          const { createVSCodeAgentHost } = await import("@axon/host-vscode");
          const { homedir } = await import("node:os");
          const { join } = await import("node:path");
          const registry = new PowerRegistry([workspace || process.cwd()], createVSCodeAgentHost(), homedir());
          const metas = await registry.discover();
          const meta = metas.find((p) => p.name === powerName);
          if (!meta) {
            vscode.window.showErrorMessage(`Power「${powerName}」不存在`);
            return;
          }
          const targetDir = join(meta.dir, "skills", skillName);
          // 检查目标是否已存在
          try {
            await vscode.workspace.fs.stat(vscode.Uri.file(targetDir));
            vscode.window.showErrorMessage(`Skill「${skillName}」已存在于 Power「${powerName}」中，不能重复导入。`);
            return;
          } catch { /* 不存在，可以继续 */ }
          await vscode.workspace.fs.copy(vscode.Uri.file(sourceDir), vscode.Uri.file(targetDir), { overwrite: false });
          vscode.window.showInformationMessage(`已导入 Skill「${skillName}」到 Power「${powerName}」`);
          // 通知 webview 刷新
          void panel.webview.postMessage({ type: "skill_imported", powerName, skillName });
        } catch (err) {
          vscode.window.showErrorMessage(`导入失败：${(err as Error).message}`);
        }
        return;
      }

      if (m.__axonReq === true && typeof m.id === "string") {
        try {
          const data = await router.handle(
            String(m.method || "GET"),
            String(m.path || ""),
            m.body,
          );
          void panel.webview.postMessage({ __axonRes: true, id: m.id, ok: true, data });
        } catch (err) {
          void panel.webview.postMessage({ __axonRes: true, id: m.id, ok: false, error: (err as Error).message });
        }
      }
    });
  }

  panel.onDidDispose(() => {
    activePanels.delete(options.id);
  });

  activePanels.set(options.id, panel);
  return panel;
}

/**
 * 加载 web 构建产物的 index.html，改写资源 URI 并附加 query 参数。
 * 复用 viewProvider 的逻辑但适配 WebviewPanel。
 */
function buildWebviewHtml(webview: vscode.Webview, webRoot: vscode.Uri, query: string): string {
  const baseUri = webview.asWebviewUri(webRoot).toString().replace(/\/$/, "");

  // 简单的 SPA 入口 HTML（加载 web 产物的 JS/CSS）
  // 因为 web 产物的 index.html 内的资源引用是相对路径（./assets/...），
  // 我们直接构造一个加载 index 的页面，通过 URL hash/search 传参数
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'unsafe-eval'`,
    `font-src ${webview.cspSource} data:`,
    `connect-src ${webview.cspSource} ws: wss: http: https:`,
    `worker-src ${webview.cspSource} blob:`,
  ].join("; ");

  // 读取实际的 index.html 并改写
  const fs = require("fs");
  const path = require("path");
  const indexPath = path.join(webRoot.fsPath, "index.html");

  let html: string;
  try {
    html = fs.readFileSync(indexPath, "utf-8");
  } catch {
    return `<!DOCTYPE html><html><body><p>未找到 web 构建产物。请先运行构建。</p></body></html>`;
  }

  // 改写资源路径
  html = html
    .replace(/(src|href)="\.?\/assets\//g, `$1="${baseUri}/assets/`)
    .replace(/(src|href)="\.\/(?!assets)/g, `$1="${baseUri}/`);

  // 注入 CSP
  if (!/Content-Security-Policy/.test(html)) {
    html = html.replace(/<head>/i, `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}" />`);
  }

  // 注入 URL 参数脚本（在 app 加载前设置 location.search 模拟参数）
  // WebviewPanel 的 URL 是 vscode-webview://xxx，不能直接带 query。
  // 改用全局变量传递 view 参数，App.tsx 读它。
  const injectScript = `<script>window.__axonViewParams = "${query}";</script>`;
  html = html.replace(/<head>/i, `<head>\n${injectScript}`);

  return html;
}
