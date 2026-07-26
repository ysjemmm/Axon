/**
 * Agent 可视化表单编辑器
 *
 * 打开一个 webview 面板，提供表单界面编辑 Agent 配置。
 * 新建时草稿存内存（不落盘），保存时才写入文件，避免污染 Agent 列表。
 * 表单 / JSON 视图在 webview 内部切换（纯前端，不落盘、不开新 tab）。
 */

import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

interface AgentJSON {
  name: string;
  description: string;
  systemPrompt: string;
  skills: string[];
  mcpServers: string[];
  powers: string[];
  tools: string[];
}

const DEFAULT_TEMPLATE: AgentJSON = {
  name: "",
  description: "",
  systemPrompt: "你是一个专业的子 Agent。\n\n## 角色\n\n## 工作方式\n\n## 输出格式",
  skills: [],
  mcpServers: [],
  powers: [],
  tools: [],
};

/** 从任意对象规范化为 AgentJSON（供 Untitled JSON 文档解析使用） */
function normalizeAgentJSON(obj: Record<string, unknown>): AgentJSON {
  return {
    name: typeof obj.name === "string" ? obj.name : "",
    description: typeof obj.description === "string" ? obj.description : "",
    systemPrompt: typeof obj.systemPrompt === "string" ? obj.systemPrompt : "",
    skills: Array.isArray(obj.skills) ? obj.skills.filter((v): v is string => typeof v === "string") : [],
    mcpServers: Array.isArray(obj.mcpServers) ? obj.mcpServers.filter((v): v is string => typeof v === "string") : [],
    powers: Array.isArray(obj.powers) ? obj.powers.filter((v): v is string => typeof v === "string") : [],
    tools: Array.isArray(obj.tools) ? obj.tools.filter((v): v is string => typeof v === "string") : [],
  };
}

/** 自定义 Agent 可用的工具列表（按分类组织，供前端权限控制下拉） */
const AGENT_TOOL_CATEGORIES = [
  "文件操作:read_file,create_file,str_replace,apply_patch,search,list_dir",
  "命令执行:execute_command,start_process,get_process_output,stop_process,list_processes",
  "浏览器:open_browser,close_browser,browser_click,browser_type,browser_press,browser_select,browser_scroll,browser_reload,browser_back,browser_forward,get_browser_logs,screenshot_page,get_browser_network,get_browser_storage,browser_eval,browser_hover,browser_wait,browser_get_html,browser_set_viewport",
  "诊断:check_diagnostics",
  "联网:web_search,web_fetch",
  "Skills & Powers:use_skill,activate_power",
];

export class AgentEditor {
  private panel: vscode.WebviewPanel | undefined;
  private filePath: string;
  private isNew: boolean;
  private agent: AgentJSON;
  private dirty = false;
  /** 打开的 JSON Untitled 文档 URI（用于变更监听和关闭清理） */
  private jsonDocUri: vscode.Uri | undefined;
  /** JSON 文档变更监听器 */
  private jsonChangeDisp: vscode.Disposable | undefined;

  private constructor(filePath: string, isNew: boolean, agent?: AgentJSON) {
    this.filePath = filePath;
    this.isNew = isNew;
    this.agent = agent || { ...DEFAULT_TEMPLATE };
  }

  /** 打开已有 Agent 文件进行编辑 */
  static async open(filePath: string, isNew: boolean): Promise<AgentEditor> {
    let agent: AgentJSON | undefined;
    if (!isNew && fs.existsSync(filePath)) {
      try {
        agent = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch { /* ignore */ }
    }
    const editor = new AgentEditor(filePath, isNew, agent);
    editor.show();
    return editor;
  }

  /** 新建草稿：不落盘，草稿数据存内存，保存时才写入文件 */
  static async createDraft(): Promise<AgentEditor> {
    const editor = new AgentEditor("", true);
    editor.show();
    return editor;
  }

  private show() {
    if (this.panel) {
      this.panel.reveal();
      this.postMessage();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "axonAgentEditor",
      this.isNew ? "新建 Agent" : `编辑 Agent: ${this.agent.name}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "save": {
          // 如果 JSON Untitled 文档开着，从文档内容同步（优先于 webview 表单数据）
          if (this.jsonDocUri) {
            const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.jsonDocUri!.toString());
            if (doc) {
              try {
                this.agent = normalizeAgentJSON(JSON.parse(doc.getText()));
              } catch {
                vscode.window.showErrorMessage("JSON 源码有语法错误，无法保存。请修复后重试。");
                return;
              }
            }
          }
          const data = this.jsonDocUri ? this.agent : (msg.data as AgentJSON);
          if (!data.name.trim()) {
            vscode.window.showWarningMessage("Agent 名称为必填");
            return;
          }
          const sanitized = data.name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 50);
          if (!sanitized) return;
          const homeDir = os.homedir();
          const dir = path.join(homeDir, ".axon", "agents");
          fs.mkdirSync(dir, { recursive: true });
          const newPath = path.join(dir, `${sanitized}.json`);
          // 草稿（filePath 为空）或改名时，删除旧文件
          if (newPath !== this.filePath) {
            if (!this.isNew && this.filePath && fs.existsSync(this.filePath)) {
              fs.unlinkSync(this.filePath);
            }
            this.filePath = newPath;
            this.isNew = false;
          }
          fs.writeFileSync(newPath, JSON.stringify({ ...data, name: sanitized }, null, 2), "utf-8");
          this.agent = { ...data, name: sanitized };
          this.dirty = false;
          if (this.panel) this.panel.title = `编辑 Agent: ${sanitized}`;
          vscode.window.showInformationMessage(`Agent "${sanitized}" 已保存`);
          vscode.commands.executeCommand("axon.agent.refresh");
          this.panel?.webview.postMessage({ type: "saved" });
          break;
        }
        case "cancel": {
          if (msg.dirty) {
            const choice = await vscode.window.showWarningMessage(
              "当前 Agent 有未保存的修改，确认放弃？", { modal: true }, "放弃修改",
            );
            if (choice !== "放弃修改") return;
          }
          this.panel?.dispose();
          break;
        }
        case "openJson": {
          // 已打开且文档仍存活 → 切换到 JSON tab
          if (this.jsonDocUri) {
            const existingUri = this.jsonDocUri.toString();
            const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === existingUri);
            if (doc && !doc.isClosed) {
              await vscode.window.showTextDocument(doc, vscode.ViewColumn.Two);
              break;
            }
            // 文档已被用户手动关闭：先 dispose 旧监听器，再清理引用
            this.jsonChangeDisp?.dispose();
            this.jsonChangeDisp = undefined;
            this.jsonDocUri = undefined;
          }
          // 创建 Untitled 文档（纯内存，不落盘）
          const content = JSON.stringify(this.agent, null, 2);
          const doc = await vscode.workspace.openTextDocument({ content, language: "json" });
          this.jsonDocUri = doc.uri;
          // 监听变更：实时同步到 this.agent
          // 用局部变量捕获 uri 字符串，避免闭包访问可能被重置的 this.jsonDocUri
          const watchUri = doc.uri.toString();
          this.jsonChangeDisp?.dispose();
          this.jsonChangeDisp = vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.uri.toString() !== watchUri) return;
            try {
              this.agent = normalizeAgentJSON(JSON.parse(e.document.getText()));
              this.dirty = true;
              // 把更新后的数据同步给前端表单
              this.panel?.webview.postMessage({ type: "jsonSync", data: this.agent });
            } catch { /* JSON 语法错误时不同步，等用户修复 */ }
          });
          await vscode.window.showTextDocument(doc, vscode.ViewColumn.Two);
          this.panel?.webview.postMessage({ type: "jsonOpened" });
          break;
        }
      }
    });

    this.panel.onDidDispose(() => {
      this.jsonChangeDisp?.dispose();
      this.jsonChangeDisp = undefined;
      // 关闭 JSON Untitled 文档：revert 恢复原始内容后关闭，避免 Untitled 弹"是否保存"
      if (this.jsonDocUri) {
        const uri = this.jsonDocUri;
        this.jsonDocUri = undefined;
        (async () => {
          try {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Two);
            await vscode.commands.executeCommand("workbench.action.revertFile");
            await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
          } catch { /* 关闭失败不阻塞 */ }
        })();
      }
      this.panel = undefined;
    });

    this.postMessage();
  }

  private async postMessage() {
    // 扫描全局目录获取可用的 Skills / MCP Servers / Powers 列表
    const homeDir = os.homedir();
    const available: Record<string, string[]> = { skills: [], mcpServers: [], powers: [], toolCategories: [] };
    for (const [key, dirName] of [["skills", "skills"], ["mcpServers", "mcp"], ["powers", "powers"]] as const) {
      try {
        const d = path.join(homeDir, ".axon", dirName);
        const entries = fs.readdirSync(d, { withFileTypes: true });
        available[key] = entries
          .filter((e) => e.isFile() && /\.(md|json)$/i.test(e.name))
          .map((e) => e.name.replace(/\.(md|json)$/i, ""));
      } catch { /* ignore */ }
    }
    // 可用工具列表（按分类组织），传给前端下拉
    available.toolCategories = AGENT_TOOL_CATEGORIES;
    this.panel?.webview.postMessage({ type: "init", data: this.agent, available });
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Editor</title>
  <style>
    :root {
      --radius: 10px;
      --radius-sm: 6px;
      --card-bg: color-mix(in srgb, var(--vscode-foreground, #ccc) 4%, var(--vscode-editor-background, #1e1e1e));
      --card-border: color-mix(in srgb, var(--vscode-foreground, #ccc) 8%, transparent);
      --accent: var(--vscode-focusBorder, #007acc);
      --accent-soft: color-mix(in srgb, var(--vscode-focusBorder, #007acc) 15%, transparent);
      --text-primary: var(--vscode-foreground, #ccc);
      --text-secondary: var(--vscode-descriptionForeground, #888);
      --input-bg: var(--vscode-input-background, #2a2a2a);
      --input-border: var(--vscode-input-border, rgba(255,255,255,0.1));
      --surface: var(--vscode-editor-background, #1e1e1e);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, 'Segoe UI', sans-serif);
      font-size: 13px;
      color: var(--text-primary);
      background: var(--surface);
      padding: 0;
      line-height: 1.6;
      overflow-y: auto;
    }

    /* Layout */
    .page { display: flex; flex-direction: column; min-height: 100vh; }
    .scroll-area { flex: 1; overflow-y: auto; padding: 32px 40px 100px; }
    .container { max-width: 720px; margin: 0 auto; width: 100%; }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 32px;
    }
    .header-avatar {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 60%, #a855f7));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      color: #fff;
      flex-shrink: 0;
      box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 30%, transparent);
    }
    .header-text { flex: 1; min-width: 0; }
    .header-title {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.3px;
      color: var(--text-primary);
    }
    .header-sub {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 1px;
    }
    .header-actions { display: flex; gap: 8px; flex-shrink: 0; }

    /* Card */
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius);
      padding: 24px;
      margin-bottom: 16px;
    }
    .card-title {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text-primary);
    }
    .card-title-icon {
      width: 18px;
      height: 18px;
      border-radius: 5px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      background: var(--accent-soft);
      color: var(--accent);
    }

    /* Form fields */
    .field { margin-bottom: 18px; }
    .field:last-child { margin-bottom: 0; }
    .field-label {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-secondary);
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .field-required { color: var(--vscode-errorForeground, #f44); font-size: 14px; line-height: 1; }
    .field-hint {
      font-size: 11px;
      color: var(--text-secondary);
      margin-top: 6px;
      line-height: 1.5;
      opacity: 0.8;
    }

    /* Inputs */
    input[type="text"], textarea {
      width: 100%;
      padding: 10px 14px;
      background: var(--input-bg);
      color: var(--text-primary);
      border: 1px solid var(--input-border);
      border-radius: var(--radius-sm);
      font-family: inherit;
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input[type="text"]:focus, textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-soft);
    }
    input[type="text"]::placeholder, textarea::placeholder {
      color: var(--text-secondary);
      opacity: 0.6;
    }
    textarea {
      min-height: 220px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
      font-size: 12px;
      line-height: 1.7;
      padding: 14px 16px;
    }

    /* Permission grid */
    .perm-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    @media (max-width: 640px) { .perm-grid { grid-template-columns: 1fr; } }
    .perm-card {
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      border-radius: var(--radius-sm);
      padding: 14px 16px;
      transition: border-color 0.2s;
    }
    .perm-card:hover { border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
    .perm-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    .perm-card-icon {
      width: 22px;
      height: 22px;
      border-radius: 5px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
    }
    .perm-card-icon.skills { background: #dbeafe20; color: #60a5fa; }
    .perm-card-icon.mcp { background: #d1fae520; color: #34d399; }
    .perm-card-icon.powers { background: #fef3c720; color: #fbbf24; }
    .perm-card-icon.tools { background: #ede9fe20; color: #a78bfa; }
    .perm-card-label { font-size: 12px; font-weight: 600; color: var(--text-primary); }

    /* Tags */
    .tag-list {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-bottom: 10px;
      min-height: 24px;
      align-items: center;
    }
    .tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 4px 2px 9px;
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--text-primary);
      border-radius: 4px;
      font-size: 11px;
      line-height: 1.4;
      border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
    }
    .tag-remove {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 15px;
      height: 15px;
      border-radius: 3px;
      cursor: pointer;
      opacity: 0.5;
      font-size: 12px;
      transition: opacity 0.15s, background 0.15s;
    }
    .tag-remove:hover { opacity: 1; background: rgba(255,255,255,0.1); }
    .empty-state {
      display: inline-flex;
      align-items: center;
      padding: 2px 10px;
      color: var(--text-secondary);
      border-radius: 4px;
      font-size: 11px;
      border: 1px dashed var(--input-border);
      background: transparent;
      opacity: 0.7;
    }

    /* Combobox — shadcn-style popover */
    .combo-wrapper { position: relative; }
    .combo-input {
      width: 100% !important;
      padding: 7px 32px 7px 10px !important;
      font-size: 12px !important;
      border-radius: 4px !important;
      background: var(--surface) !important;
      border: 1px solid var(--input-border) !important;
      transition: border-color 0.2s, box-shadow 0.2s !important;
    }
    .combo-input:focus {
      border-color: var(--accent) !important;
      box-shadow: 0 0 0 3px var(--accent-soft) !important;
    }
    .combo-wrapper::after {
      content: '⌄';
      position: absolute;
      right: 10px;
      top: 50%;
      transform: translateY(-50%);
      font-size: 14px;
      color: var(--text-secondary);
      pointer-events: none;
      opacity: 0.6;
    }
    .combo-dropdown {
      display: none;
      position: fixed;
      width: 260px;
      max-height: 240px;
      overflow-y: auto;
      overflow-x: hidden;
      background: var(--vscode-dropdown-background, #252526);
      border: 1px solid var(--vscode-dropdown-border, #454545);
      border-radius: 8px;
      z-index: 9999;
      box-shadow: 0 10px 40px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.3);
      padding: 4px;
      animation: popIn 0.12s ease-out;
    }
    @keyframes popIn {
      from { opacity: 0; transform: translateY(-4px) scale(0.97); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .combo-item {
      padding: 7px 10px;
      font-size: 12px;
      cursor: pointer;
      color: var(--vscode-dropdown-foreground, #ccc);
      border-radius: 5px;
      transition: background 0.08s;
      margin: 1px 0;
    }
    .combo-item:hover, .combo-item.active {
      background: var(--accent-soft);
      color: var(--text-primary);
    }
    .combo-cat {
      padding: 8px 10px 4px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--text-secondary);
      letter-spacing: 0.5px;
      pointer-events: none;
      opacity: 0.7;
    }
    .combo-cat:not(:first-child) {
      margin-top: 4px;
      padding-top: 8px;
      border-top: 1px solid var(--input-border);
    }
    .combo-empty {
      padding: 12px 10px;
      font-size: 11px;
      color: var(--text-secondary);
      text-align: center;
      opacity: 0.7;
    }

    /* Buttons */
    .btn {
      padding: 8px 18px;
      border: none;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      font-family: inherit;
      transition: all 0.15s;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn:hover { transform: translateY(-1px); }
    .btn:active { transform: translateY(0); }
    .btn-primary {
      background: var(--accent);
      color: #fff;
      box-shadow: 0 2px 8px color-mix(in srgb, var(--accent) 30%, transparent);
    }
    .btn-primary:hover { box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 40%, transparent); }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, #3a3a3a);
      color: var(--vscode-button-secondaryForeground, #ccc);
    }
    .btn-ghost {
      background: transparent;
      color: var(--text-secondary);
      border: 1px solid var(--input-border);
      font-weight: 500;
    }
    .btn-ghost:hover { border-color: var(--accent); color: var(--text-primary); }

    /* Footer */
    .footer {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      display: flex;
      gap: 10px;
      padding: 16px 40px;
      background: var(--surface);
      border-top: 1px solid var(--card-border);
      backdrop-filter: blur(8px);
      z-index: 50;
    }

    code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      color: var(--accent);
      padding: 1px 6px;
      border-radius: 3px;
    }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
  </style>
</head>
<body>
  <div class="page">
    <div class="scroll-area">
      <div class="container">
        <div class="header">
          <div class="header-avatar">✦</div>
          <div class="header-text">
            <div class="header-title">Agent 配置</div>
            <div class="header-sub">创建并配置自定义子 Agent</div>
          </div>
          <div class="header-actions">
            <button class="btn btn-ghost" id="btnJson">{ } JSON</button>
          </div>
        </div>

        <!-- 基本信息 -->
        <div class="card">
          <div class="card-title"><span class="card-title-icon">①</span> 基本信息</div>
          <div class="field">
            <label class="field-label">名称 <span class="field-required">*</span></label>
            <input type="text" id="name" placeholder="my-agent" />
            <div class="field-hint">唯一标识，用于 <code>@AgentName</code> 调用。只允许字母、数字、短横线。</div>
          </div>
          <div class="field">
            <label class="field-label">描述</label>
            <input type="text" id="description" placeholder="一句话描述这个 Agent 的职责" />
          </div>
        </div>

        <!-- 系统提示词 -->
        <div class="card">
          <div class="card-title"><span class="card-title-icon">②</span> 系统提示词</div>
          <div class="field">
            <textarea id="systemPrompt" placeholder="描述 Agent 的角色、工作方式、输出格式..."></textarea>
            <div class="field-hint">支持 Markdown。这是子 Agent 的核心指令，决定它的行为模式。</div>
          </div>
        </div>

        <!-- 权限控制 -->
        <div class="card">
          <div class="card-title"><span class="card-title-icon">③</span> 权限控制</div>
          <div class="field-hint" style="margin-bottom:16px;margin-top:-8px;">限制此 Agent 可使用的资源和工具。留空表示全部可用（不限制）。</div>
          <div class="perm-grid">
            <div class="perm-card">
              <div class="perm-card-header">
                <span class="perm-card-icon skills">⚡</span>
                <span class="perm-card-label">Skills</span>
              </div>
              <div class="tag-list" id="skillsTags"></div>
              <div class="combo-wrapper">
                <input type="text" id="skillsInput" class="combo-input" placeholder="添加 Skill..." autocomplete="off" />
                <div class="combo-dropdown" id="skillsDropdown"></div>
              </div>
            </div>
            <div class="perm-card">
              <div class="perm-card-header">
                <span class="perm-card-icon mcp">⬡</span>
                <span class="perm-card-label">MCP 服务器</span>
              </div>
              <div class="tag-list" id="mcpServersTags"></div>
              <div class="combo-wrapper">
                <input type="text" id="mcpServersInput" class="combo-input" placeholder="添加 MCP..." autocomplete="off" />
                <div class="combo-dropdown" id="mcpServersDropdown"></div>
              </div>
            </div>
            <div class="perm-card">
              <div class="perm-card-header">
                <span class="perm-card-icon powers">⚙</span>
                <span class="perm-card-label">Powers</span>
              </div>
              <div class="tag-list" id="powersTags"></div>
              <div class="combo-wrapper">
                <input type="text" id="powersInput" class="combo-input" placeholder="添加 Power..." autocomplete="off" />
                <div class="combo-dropdown" id="powersDropdown"></div>
              </div>
            </div>
            <div class="perm-card">
              <div class="perm-card-header">
                <span class="perm-card-icon tools">🔧</span>
                <span class="perm-card-label">可用工具</span>
              </div>
              <div class="tag-list" id="toolsTags"></div>
              <div class="combo-wrapper">
                <input type="text" id="toolsInput" class="combo-input" placeholder="添加工具..." autocomplete="off" />
                <div class="combo-dropdown" id="toolsDropdown"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="footer">
      <button class="btn btn-primary" id="btnSave">保存 Agent</button>
      <button class="btn btn-secondary" id="btnCancel">取消</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let data = { name: '', description: '', systemPrompt: '', skills: [], mcpServers: [], powers: [] };
    let available = { skills: [], mcpServers: [], powers: [] };
    let dirty = false;

    window.addEventListener('message', (e) => {
      const msg = e.data;
      if (msg.type === 'init') {
        data = msg.data;
        available = msg.available || available;
        dirty = false;
        render();
        updateSaveBtn();
      } else if (msg.type === 'saved') {
        dirty = false;
        updateSaveBtn();
      } else if (msg.type === 'jsonSync') {
        // JSON Untitled 文档编辑后，后端同步数据到前端表单
        data = msg.data;
        render();
        markDirty();
      }
    });

    function markDirty() {
      dirty = true;
      updateSaveBtn();
    }

    function updateSaveBtn() {
      document.getElementById('btnSave').textContent = dirty ? '保存 *' : '保存';
    }

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    /** 从任意对象规范化为 AgentJSON（供 JSON 视图解析使用） */
    function normalizeData(obj) {
      return {
        name: typeof obj.name === 'string' ? obj.name : '',
        description: typeof obj.description === 'string' ? obj.description : '',
        systemPrompt: typeof obj.systemPrompt === 'string' ? obj.systemPrompt : '',
        skills: Array.isArray(obj.skills) ? obj.skills.filter(v => typeof v === 'string') : [],
        mcpServers: Array.isArray(obj.mcpServers) ? obj.mcpServers.filter(v => typeof v === 'string') : [],
        powers: Array.isArray(obj.powers) ? obj.powers.filter(v => typeof v === 'string') : [],
        tools: Array.isArray(obj.tools) ? obj.tools.filter(v => typeof v === 'string') : [],
      };
    }

    function render() {
      document.getElementById('name').value = data.name || '';
      document.getElementById('description').value = data.description || '';
      document.getElementById('systemPrompt').value = data.systemPrompt || '';
      ['skills','mcpServers','powers','tools'].forEach(key => { renderField(key); });
    }

    function renderField(key) {
      renderTags(key);
      renderDropdown(key, document.getElementById(key + 'Input').value);
    }

    function renderTags(key) {
      const container = document.getElementById(key + 'Tags');
      const values = data[key] || [];
      if (values.length === 0) {
        container.innerHTML = '<span class="empty-state">全部可用（未限制）</span>';
        return;
      }
      container.innerHTML = values.map((v, i) =>
        '<span class="tag">' + esc(v) +
        '<span class="tag-remove" data-key="' + key + '" data-idx="' + i + '">&times;</span></span>'
      ).join('');
    }

    function getAvailable(key, filter) {
      const f = filter.toLowerCase();
      if (key === 'tools') {
        // 工具列表按分类组织（每项格式：分类名:tool1,tool2,tool3）
        const cats = available.toolCategories || [];
        const used = new Set(data[key] || []);
        const result = [];
        for (const cat of cats) {
          const colon = cat.indexOf(':');
          const catName = cat.slice(0, colon);
          const tools = cat.slice(colon + 1).split(',');
          const matches = tools.filter(t => t.toLowerCase().includes(f) && !used.has(t));
          if (matches.length > 0) result.push({ cat: catName, tools: matches });
        }
        return result;
      }
      const all = available[key] || [];
      const used = new Set(data[key] || []);
      return all.filter(v => v.toLowerCase().includes(f) && !used.has(v));
    }

    function renderDropdown(key, filter) {
      const dd = document.getElementById(key + 'Dropdown');
      if (key === 'tools') {
        const groups = getAvailable(key, filter);
        if (groups.length === 0) {
          dd.innerHTML = '<div class="combo-empty">' + (filter ? '无匹配项' : '已全部添加') + '</div>';
          // 只有当前激活的 key 才显示下拉框
          dd.style.display = (key === activeKey) ? 'block' : 'none';
          return;
        }
        let html = '';
        for (const g of groups) {
          html += '<div class="combo-cat">' + esc(g.cat) + '</div>';
          for (const t of g.tools) {
            html += '<div class="combo-item" data-key="' + key + '" data-value="' + esc(t) + '">' + esc(t) + '</div>';
          }
        }
        dd.innerHTML = html;
        dd.style.display = (key === activeKey) ? 'block' : 'none';
        return;
      }
      const items = getAvailable(key, filter);
      if (items.length === 0) {
        dd.innerHTML = '<div class="combo-empty">' + (filter ? '无匹配项' : '已全部添加') + '</div>';
        dd.style.display = (key === activeKey) ? 'block' : 'none';
        return;
      }
      dd.innerHTML = items.slice(0, 50).map(v =>
        '<div class="combo-item" data-key="' + key + '" data-value="' + esc(v) + '">' + esc(v) + '</div>'
      ).join('');
      dd.style.display = (key === activeKey) ? 'block' : 'none';
    }

    // 事件委托：tag 删除 + combo 选择
    document.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.tag-remove');
      if (removeBtn) {
        const key = removeBtn.dataset.key;
        const idx = parseInt(removeBtn.dataset.idx);
        if (!isNaN(idx)) {
          data[key].splice(idx, 1);
          markDirty();
          renderTags(key);
          // 删除 tag 时不触发下拉框，只更新 tags 显示
        }
        return;
      }
      const item = e.target.closest('.combo-item');
      if (item) {
        const key = item.dataset.key;
        const val = item.dataset.value;
        if (key && val) {
          if (!data[key]) data[key] = [];
          data[key].push(val);
          markDirty();
          const input = document.getElementById(key + 'Input');
          input.value = '';
          // 刷新列表（已选项自动排除），保持下拉框打开继续选
          renderTags(key);
          showDropdown(key);
          input.focus();
        }
      }
    });

    // combobox 输入交互（shadcn-style: fixed positioning + keyboard nav）
    let activeKey = null;
    let activeIdx = -1;
    let blurTimer = null;

    function positionDropdown(key) {
      const input = document.getElementById(key + 'Input');
      const dd = document.getElementById(key + 'Dropdown');
      const rect = input.getBoundingClientRect();
      const maxH = 200; // combo-dropdown max-height
      const spaceBelow = window.innerHeight - rect.bottom - 8;
      const spaceAbove = rect.top - 8;
      const width = Math.max(rect.width, 220);
      dd.style.left = rect.left + 'px';
      dd.style.width = width + 'px';
      if (spaceBelow >= maxH || spaceBelow >= spaceAbove) {
        // 向下弹出
        dd.style.top = (rect.bottom + 4) + 'px';
        dd.style.bottom = 'auto';
        dd.style.maxHeight = Math.min(maxH, spaceBelow) + 'px';
      } else {
        // 向上翻转
        dd.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
        dd.style.top = 'auto';
        dd.style.maxHeight = Math.min(maxH, spaceAbove) + 'px';
      }
    }

    function showDropdown(key) {
      if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; }
      const dd = document.getElementById(key + 'Dropdown');
      renderDropdown(key, document.getElementById(key + 'Input').value);
      if (dd.innerHTML) {
        positionDropdown(key);
        dd.style.display = 'block';
        activeKey = key;
        activeIdx = -1;
        highlightItem(key);
      }
    }

    function hideDropdown(key) {
      const dd = document.getElementById(key + 'Dropdown');
      dd.style.display = 'none';
      activeKey = null;
      activeIdx = -1;
    }

    function highlightItem(key) {
      const dd = document.getElementById(key + 'Dropdown');
      const items = dd.querySelectorAll('.combo-item');
      items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
      if (activeIdx >= 0 && items[activeIdx]) {
        items[activeIdx].scrollIntoView({ block: 'nearest' });
      }
    }

    ['skills','mcpServers','powers','tools'].forEach(key => {
      const input = document.getElementById(key + 'Input');
      input.addEventListener('input', () => { showDropdown(key); });
      input.addEventListener('focus', () => { showDropdown(key); });
      input.addEventListener('blur', () => { blurTimer = setTimeout(() => hideDropdown(key), 180); });
      input.addEventListener('focus', () => { if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; } });
      input.addEventListener('keydown', (e) => {
        const dd = document.getElementById(key + 'Dropdown');
        if (dd.style.display === 'none') return;
        const items = dd.querySelectorAll('.combo-item');
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          activeIdx = Math.min(activeIdx + 1, items.length - 1);
          highlightItem(key);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          activeIdx = Math.max(activeIdx - 1, 0);
          highlightItem(key);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (activeIdx >= 0 && items[activeIdx]) {
            items[activeIdx].click();
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          hideDropdown(key);
          input.blur();
        }
      });
    });

    // 滚动/resize 时重定位已打开的 dropdown
    window.addEventListener('scroll', () => { if (activeKey) positionDropdown(activeKey); }, true);
    window.addEventListener('resize', () => { if (activeKey) positionDropdown(activeKey); });

    // 字段实时同步
    ['name','description','systemPrompt'].forEach(id => {
      document.getElementById(id).addEventListener('input', (e) => {
        data[id] = e.target.value;
        markDirty();
      });
    });

    // 按钮事件
    document.getElementById('btnSave').addEventListener('click', () => {
      vscode.postMessage({ type: 'save', data: { ...data } });
    });
    document.getElementById('btnCancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel', dirty });
    });
    document.getElementById('btnJson').addEventListener('click', () => {
      vscode.postMessage({ type: 'openJson' });
    });
  </script>
</body>
</html>`;
  }
}
