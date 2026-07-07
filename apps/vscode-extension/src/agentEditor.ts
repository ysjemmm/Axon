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
}

const DEFAULT_TEMPLATE: AgentJSON = {
  name: "",
  description: "",
  systemPrompt: "你是一个专业的子 Agent。\n\n## 角色\n\n## 工作方式\n\n## 输出格式",
  skills: [],
  mcpServers: [],
  powers: [],
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
  };
}

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
    const available: Record<string, string[]> = { skills: [], mcpServers: [], powers: [] };
    for (const [key, dirName] of [["skills", "skills"], ["mcpServers", "mcp"], ["powers", "powers"]] as const) {
      try {
        const d = path.join(homeDir, ".axon", dirName);
        const entries = fs.readdirSync(d, { withFileTypes: true });
        available[key] = entries
          .filter((e) => e.isFile() && /\.(md|json)$/i.test(e.name))
          .map((e) => e.name.replace(/\.(md|json)$/i, ""));
      } catch { /* ignore */ }
    }
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
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, -apple-system, 'Segoe UI', sans-serif);
      font-size: 13px;
      color: var(--vscode-foreground, #ccc);
      background: var(--vscode-editor-background, #1e1e1e);
      padding: 28px 32px;
      line-height: 1.6;
    }
    .container { max-width: 780px; margin: 0 auto; }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 28px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
    }
    .header-icon { font-size: 20px; line-height: 1; }
    .header-title { font-size: 17px; font-weight: 600; flex: 1; }
    .header-actions { display: flex; gap: 8px; }

    /* Form fields */
    .field { margin-bottom: 20px; }
    .field-label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-foreground, #ccc);
      margin-bottom: 6px;
    }
    .field-required { color: var(--vscode-errorForeground, #f44); margin-left: 2px; }
    .field-hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      margin-top: 5px;
      line-height: 1.5;
    }

    /* Inputs */
    input[type="text"], textarea {
      width: 100%;
      padding: 8px 12px;
      background: var(--vscode-input-background, #2a2a2a);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 5px;
      font-family: inherit;
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s;
    }
    input[type="text"]:focus, textarea:focus {
      border-color: var(--vscode-focusBorder, #007acc);
    }
    textarea {
      min-height: 200px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family, 'Consolas', 'Courier New', monospace);
      font-size: 12px;
      line-height: 1.6;
    }

    /* Section */
    .section {
      margin-top: 28px;
      padding-top: 20px;
      border-top: 1px solid var(--vscode-panel-border, #333);
    }
    .section-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
    .section-desc {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #888);
      margin-bottom: 16px;
    }

    /* Permission card */
    .perm-card {
      background: var(--vscode-textBlockQuote-background, rgba(255,255,255,0.04));
      border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08));
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 14px;
    }
    .perm-card-label { font-size: 12px; font-weight: 600; margin-bottom: 8px; display: block; }

    /* Tags */
    .tag-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 8px;
      min-height: 26px;
      align-items: center;
    }
    .tag {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 4px 3px 10px;
      background: var(--vscode-badge-background, #4a4a4a);
      color: var(--vscode-badge-foreground, #fff);
      border-radius: 12px;
      font-size: 11px;
      line-height: 1.4;
    }
    .tag-remove {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      cursor: pointer;
      opacity: 0.6;
      font-size: 13px;
      transition: opacity 0.15s, background 0.15s;
    }
    .tag-remove:hover { opacity: 1; background: rgba(255,255,255,0.15); }
    .empty-state {
      display: inline-flex;
      align-items: center;
      padding: 3px 12px;
      color: var(--vscode-descriptionForeground, #888);
      border-radius: 12px;
      font-size: 11px;
      border: 1px dashed var(--vscode-input-border, #555);
      background: transparent;
    }

    /* Combobox */
    .combo-wrapper { position: relative; }
    .combo-input {
      width: 240px !important;
      padding: 5px 10px !important;
      font-size: 12px !important;
    }
    .combo-dropdown {
      display: none;
      position: absolute;
      top: calc(100% + 2px);
      left: 0;
      width: 260px;
      max-height: 180px;
      overflow-y: auto;
      background: var(--vscode-dropdown-background, #252526);
      border: 1px solid var(--vscode-dropdown-border, #454545);
      border-radius: 0 0 5px 5px;
      z-index: 10;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }
    .combo-item {
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
      color: var(--vscode-dropdown-foreground, #ccc);
      transition: background 0.1s;
    }
    .combo-item:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }

    /* Buttons */
    .btn {
      padding: 6px 16px;
      border: none;
      border-radius: 5px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      font-family: inherit;
      transition: opacity 0.15s;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .btn:hover { opacity: 0.85; }
    .btn-primary {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
    }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, #3a3a3a);
      color: var(--vscode-button-secondaryForeground, #ccc);
    }
    .btn-ghost {
      background: transparent;
      color: var(--vscode-foreground, #ccc);
      border: 1px solid var(--vscode-button-border, #555);
    }

    /* Footer */
    .footer {
      display: flex;
      gap: 8px;
      margin-top: 28px;
      padding-top: 20px;
      border-top: 1px solid var(--vscode-panel-border, #333);
    }
    code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      background: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.08));
      padding: 1px 5px;
      border-radius: 3px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="header-icon">🤖</span>
      <span class="header-title">Agent 配置</span>
      <div class="header-actions">
        <button class="btn btn-ghost" id="btnJson">JSON 源码</button>
      </div>
    </div>

    <div class="field">
      <label class="field-label" for="name">名称<span class="field-required">*</span></label>
      <input type="text" id="name" placeholder="my-agent" />
      <div class="field-hint">唯一标识，用于 <code>@AgentName</code> 调用。只允许字母、数字、短横线。</div>
    </div>

    <div class="field">
      <label class="field-label" for="description">描述</label>
      <input type="text" id="description" placeholder="一句话描述这个 Agent 的职责" />
    </div>

    <div class="field">
      <label class="field-label" for="systemPrompt">系统提示词</label>
      <textarea id="systemPrompt" placeholder="描述 Agent 的角色、工作方式、输出格式..."></textarea>
      <div class="field-hint">支持 Markdown 格式。这是子 Agent 的核心指令。</div>
    </div>

    <div class="section">
      <div class="section-title">权限控制</div>
      <div class="section-desc">限制此 Agent 可使用的 Skills、MCP 服务器和 Powers。留空表示全部可用。</div>

      <div class="perm-card">
        <span class="perm-card-label">Skills</span>
        <div class="tag-list" id="skillsTags"></div>
        <div class="combo-wrapper">
          <input type="text" id="skillsInput" class="combo-input" placeholder="搜索并添加 skill..." autocomplete="off" />
          <div class="combo-dropdown" id="skillsDropdown"></div>
        </div>
      </div>

      <div class="perm-card">
        <span class="perm-card-label">MCP Servers</span>
        <div class="tag-list" id="mcpServersTags"></div>
        <div class="combo-wrapper">
          <input type="text" id="mcpServersInput" class="combo-input" placeholder="搜索并添加 MCP..." autocomplete="off" />
          <div class="combo-dropdown" id="mcpServersDropdown"></div>
        </div>
      </div>

      <div class="perm-card">
        <span class="perm-card-label">Powers</span>
        <div class="tag-list" id="powersTags"></div>
        <div class="combo-wrapper">
          <input type="text" id="powersInput" class="combo-input" placeholder="搜索并添加 Power..." autocomplete="off" />
          <div class="combo-dropdown" id="powersDropdown"></div>
        </div>
      </div>
    </div>
    </div>

    <div class="footer">
      <button class="btn btn-primary" id="btnSave">保存</button>
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
      };
    }

    function render() {
      document.getElementById('name').value = data.name || '';
      document.getElementById('description').value = data.description || '';
      document.getElementById('systemPrompt').value = data.systemPrompt || '';
      ['skills','mcpServers','powers'].forEach(key => { renderField(key); });
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
      const all = available[key] || [];
      const used = new Set(data[key] || []);
      return all.filter(v => v.toLowerCase().includes(f) && !used.has(v));
    }

    function renderDropdown(key, filter) {
      const dd = document.getElementById(key + 'Dropdown');
      const items = getAvailable(key, filter);
      if (items.length === 0) { dd.style.display = 'none'; return; }
      dd.innerHTML = items.slice(0, 50).map(v =>
        '<div class="combo-item" data-key="' + key + '" data-value="' + esc(v) + '">' + esc(v) + '</div>'
      ).join('');
      dd.style.display = 'block';
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
          renderDropdown(key, document.getElementById(key + 'Input').value);
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
          renderTags(key);
          renderDropdown(key, '');
          input.focus();
        }
      }
    });

    // combobox 输入交互
    ['skills','mcpServers','powers'].forEach(key => {
      const input = document.getElementById(key + 'Input');
      const dd = document.getElementById(key + 'Dropdown');
      input.addEventListener('input', () => { renderDropdown(key, input.value); });
      input.addEventListener('focus', () => { renderDropdown(key, input.value); });
      input.addEventListener('blur', () => { setTimeout(() => { dd.style.display = 'none'; }, 150); });
    });

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
