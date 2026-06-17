/**
 * 左侧管理面板的 TreeView 实现（对标 Kiro 的 SPECS / STEERING / MCP SERVERS）
 *
 * 三个面板：
 *  - Relay：列出当前工作区的 Relay 工作流（对应 Kiro SPECS）
 *  - Skills：列出已安装的 Skill（对应 Kiro AGENT STEERING & SKILLS）
 *  - Provider：显示已配置的 LLM provider 状态
 *
 * 最小可用版本：显示条目列表，点击可展开/操作。后续迭代加丰富交互。
 */

import * as vscode from "vscode";

// ─── 通用 TreeItem ──────────────────────────────────────────────────────────

class SimpleItem extends vscode.TreeItem {
  constructor(label: string, description?: string, icon?: string, commandId?: string, commandArgs?: unknown[], contextValue?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    if (icon) this.iconPath = new vscode.ThemeIcon(icon);
    if (commandId) {
      this.command = { command: commandId, title: label, arguments: commandArgs };
    }
    if (contextValue) this.contextValue = contextValue;
  }
}

// ─── Relay TreeView ─────────────────────────────────────────────────────────

export class RelayTreeProvider implements vscode.TreeDataProvider<SimpleItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private items: SimpleItem[] = [];

  refresh(relays: { id: string; title: string; phase: string }[]): void {
    this.items = relays.length > 0
      ? relays.map((r) => {
          const phaseIcon = r.phase === "done" ? "check" : r.phase === "executing" ? "play" : "edit";
          return new SimpleItem(r.title, r.phase, phaseIcon, "axon.openRelay", [r.id], "relayItem");
        })
      : [new SimpleItem("暂无 Relay 工作流", "在对话中创建", "add")];
    this._onDidChange.fire();
  }

  getTreeItem(element: SimpleItem): vscode.TreeItem {
    return element;
  }

  getChildren(): SimpleItem[] {
    return this.items;
  }
}

// ─── Skills TreeView（分组：项目 / 全局 / 内置）────────────────────────────

type SkillTreeNode = SkillGroupItem | SimpleItem;

class SkillGroupItem extends vscode.TreeItem {
  readonly nodeType = "skillGroup" as const;
  constructor(public readonly groupLabel: string, public readonly groupSource: string) {
    super(groupLabel, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "skillSourceGroup";
  }
}

export class SkillsTreeProvider implements vscode.TreeDataProvider<SkillTreeNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private allSkills: { name: string; source: string; disabled: boolean; skillFile?: string }[] = [];

  refresh(skills: { name: string; source: string; disabled: boolean; skillFile?: string }[]): void {
    this.allSkills = skills;
    this._onDidChange.fire();
  }

  getTreeItem(element: SkillTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SkillTreeNode): SkillTreeNode[] {
    if (!element) {
      // 顶层：分组节点
      const groups: SkillTreeNode[] = [];
      const workspace = this.allSkills.filter((s) => s.source === "workspace");
      const global = this.allSkills.filter((s) => s.source === "global");
      const builtin = this.allSkills.filter((s) => s.source === "builtin");
      if (workspace.length > 0) groups.push(new SkillGroupItem("项目", "workspace"));
      if (global.length > 0) groups.push(new SkillGroupItem("全局", "global"));
      if (builtin.length > 0) groups.push(new SkillGroupItem("内置", "builtin"));
      if (groups.length === 0) {
        return [new SimpleItem("暂无 Skill", "点击新建", "add", "axon.openSkill", [{ create: true }])];
      }
      return groups;
    }
    if (element instanceof SkillGroupItem) {
      const items = this.allSkills
        .filter((s) => s.source === element.groupSource)
        // 未禁用排前、禁用排后（内置无禁用态，不受影响）
        .sort((a, b) => Number(a.disabled) - Number(b.disabled));
      return items.map((s) => {
        const icon = s.source === "builtin" ? "library" : s.disabled ? "circle-slash" : "file";
        const desc = s.disabled ? "已禁用" : "";
        const ctxValue = s.source === "builtin" ? undefined : "skillToggleable";
        return new SimpleItem(
          s.name,
          desc,
          icon,
          "axon.openSkill",
          [{ name: s.name, source: s.source, skillFile: s.skillFile || "", disabled: s.disabled }],
          ctxValue,
        );
      });
    }
    return [];
  }
}

// ─── Provider TreeView（分组：内置 / 自定义）─────────────────────────────────

/** 树展示用的 provider 信息（来自 ProviderRegistry 解析结果，已脱敏） */
export interface ProviderTreeInfo {
  name: string;
  label: string;
  builtin: boolean;
  locked: boolean;
  configured: boolean;
  modelCount: number;
}

class ProviderGroupItem extends vscode.TreeItem {
  readonly nodeType = "providerGroup" as const;
  constructor(public readonly groupLabel: string, public readonly builtin: boolean) {
    super(groupLabel, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "providerSourceGroup";
  }
}

class ProviderItem extends vscode.TreeItem {
  readonly nodeType = "providerItem" as const;
  constructor(public readonly info: ProviderTreeInfo) {
    super(info.label || info.name, vscode.TreeItemCollapsibleState.None);
    const parts: string[] = [];
    parts.push(info.configured ? "已配置" : "未配置");
    if (info.modelCount > 0) parts.push(`${info.modelCount} 模型`);
    if (info.locked) parts.push("仅 Key");
    this.description = parts.join(" · ");
    this.iconPath = info.configured
      ? new vscode.ThemeIcon("cloud")
      : new vscode.ThemeIcon("cloud", new vscode.ThemeColor("disabledForeground"));
    // 菜单可见性：esign（locked）只给"设置 Key"；其它内置给"设置 Key"；自定义给"编辑/删除"
    this.contextValue = info.locked ? "providerLocked" : info.builtin ? "providerBuiltin" : "providerCustom";
    this.command = { command: "axon.openProvider", title: info.label || info.name, arguments: [] };
    this.tooltip = `${info.label || info.name}（${info.builtin ? "内置" : "自定义"}）`;
  }
}

type ProviderTreeNode = ProviderGroupItem | ProviderItem | SimpleItem;

export class ProviderTreeProvider implements vscode.TreeDataProvider<ProviderTreeNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private providers: ProviderTreeInfo[] = [];

  refresh(providers: ProviderTreeInfo[]): void {
    this.providers = providers;
    this._onDidChange.fire();
  }

  getTreeItem(element: ProviderTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ProviderTreeNode): ProviderTreeNode[] {
    if (!element) {
      if (this.providers.length === 0) {
        return [new SimpleItem("未配置 Provider", "点击 + 添加", "warning", "axon.openProvider")];
      }
      const groups: ProviderTreeNode[] = [];
      if (this.providers.some((p) => p.builtin)) groups.push(new ProviderGroupItem("内置", true));
      if (this.providers.some((p) => !p.builtin)) groups.push(new ProviderGroupItem("自定义", false));
      return groups;
    }
    if (element instanceof ProviderGroupItem) {
      return this.providers
        .filter((p) => p.builtin === element.builtin)
        // 已配置排前、未配置排后
        .sort((a, b) => Number(b.configured) - Number(a.configured))
        .map((p) => new ProviderItem(p));
    }
    return [];
  }
}

// ─── Powers TreeView ────────────────────────────────────────────────────────

// ─── Powers TreeView（分组：项目 / 全局）─────────────────────────────────────

type PowerTreeNode = PowerGroupItem | SimpleItem;

class PowerGroupItem extends vscode.TreeItem {
  readonly nodeType = "powerGroup" as const;
  constructor(public readonly groupLabel: string, public readonly groupSource: string) {
    super(groupLabel, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "powerSourceGroup";
  }
}

export class PowersTreeProvider implements vscode.TreeDataProvider<PowerTreeNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private allPowers: { name: string; displayName: string; source: string; enabled: boolean; mcpServerCount: number; skillCount: number; dir: string }[] = [];

  refresh(powers: { name: string; displayName: string; source: string; enabled: boolean; mcpServerCount: number; skillCount: number; dir: string }[]): void {
    this.allPowers = powers;
    this._onDidChange.fire();
  }

  getTreeItem(element: PowerTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PowerTreeNode): PowerTreeNode[] {
    if (!element) {
      const groups: PowerTreeNode[] = [];
      const workspace = this.allPowers.filter((p) => p.source === "workspace");
      const global = this.allPowers.filter((p) => p.source === "global");
      if (workspace.length > 0) groups.push(new PowerGroupItem("项目", "workspace"));
      if (global.length > 0) groups.push(new PowerGroupItem("全局", "global"));
      if (groups.length === 0) {
        return [new SimpleItem("暂无 Power", "点击 + 新建或导入", "extensions")];
      }
      return groups;
    }
    if (element instanceof PowerGroupItem) {
      const items = this.allPowers.filter((p) => p.source === element.groupSource);
      return items.map((p) => {
        const parts: string[] = [];
        if (p.mcpServerCount > 0) parts.push(`${p.mcpServerCount} MCP`);
        if (p.skillCount > 0) parts.push(`${p.skillCount} Skills`);
        if (!p.enabled) parts.push("已禁用");
        const desc = parts.join(" · ");
        const icon = p.mcpServerCount > 0 ? "plug" : p.skillCount > 0 ? "package" : "extensions";
        return new SimpleItem(
          p.displayName || p.name,
          desc,
          icon,
          "axon.openPower",
          [{ name: p.name, source: p.source, dir: p.dir, enabled: p.enabled }],
          "powerItem",
        );
      });
    }
    return [];
  }
}

// ─── Custom Skills TreeView（Explorer 侧栏，分项目/全局两组，展示文件子树） ───

/** Skill 树节点类型 */
type SkillNode = SkillGroupNode | SkillDirNode | SkillFileNode;

/** 分组节点（项目/全局） */
class SkillGroupNode extends vscode.TreeItem {
  readonly nodeType = "group" as const;
  constructor(public readonly groupLabel: string, public readonly rootDir: string, public readonly source: "workspace" | "global") {
    super(groupLabel, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "skillGroup";
  }
}

/** Skill 目录节点（可展开查看内部文件） */
class SkillDirNode extends vscode.TreeItem {
  readonly nodeType = "skillDir" as const;
  constructor(public readonly name: string, public readonly dirPath: string, public readonly source: "workspace" | "global") {
    super(name, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon("package");
    this.contextValue = "skillItem";
    this.tooltip = dirPath;
  }
}

/** Skill 内部文件/目录节点 */
class SkillFileNode extends vscode.TreeItem {
  readonly nodeType = "file" as const;
  constructor(public readonly fileName: string, public readonly filePath: string, public readonly isDirectory: boolean) {
    super(fileName, isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.iconPath = isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    this.contextValue = isDirectory ? "skillSubDir" : "skillFile";
    this.tooltip = filePath;
    if (!isDirectory) {
      this.command = { command: "vscode.open", title: "打开", arguments: [vscode.Uri.file(filePath)] };
    }
  }
}

export class CustomSkillsTreeProvider implements vscode.TreeDataProvider<SkillNode> {
  private _onDidChange = new vscode.EventEmitter<SkillNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private projectRoot = "";
  private globalRoot = "";
  private skills: { name: string; dir: string; source: "workspace" | "global" }[] = [];

  refresh(skills: { name: string; source: string; disabled: boolean; skillFile?: string; dir?: string }[], projectRoot: string, globalRoot: string): void {
    this.projectRoot = projectRoot;
    this.globalRoot = globalRoot;
    this.skills = skills
      .filter((s) => s.source !== "builtin" && !s.disabled && s.dir)
      .map((s) => ({ name: s.name, dir: s.dir!, source: s.source as "workspace" | "global" }));
    this._onDidChange.fire(undefined);
  }

  getTreeItem(element: SkillNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SkillNode): Promise<SkillNode[]> {
    if (!element) {
      // 顶层：项目组 + 全局组
      return [
        new SkillGroupNode("项目", this.projectRoot, "workspace"),
        new SkillGroupNode("全局", this.globalRoot, "global"),
      ];
    }

    if (element instanceof SkillGroupNode) {
      // 组下面：该组的 skill 目录列表
      const groupSkills = this.skills.filter((s) => s.source === element.source);
      if (groupSkills.length === 0) {
        const hint = new vscode.TreeItem(
          element.source === "workspace" ? "暂无，右键可创建" : "暂无，右键可创建",
          vscode.TreeItemCollapsibleState.None,
        );
        hint.iconPath = new vscode.ThemeIcon("add");
        return [hint as unknown as SkillNode];
      }
      return groupSkills.map((s) => new SkillDirNode(s.name, s.dir, s.source));
    }

    if (element instanceof SkillDirNode) {
      // Skill 目录下的文件列表
      return this.listDir(element.dirPath);
    }

    if (element instanceof SkillFileNode && element.isDirectory) {
      // 子目录下的文件列表
      return this.listDir(element.filePath);
    }

    return [];
  }

  /** 列出目录下的文件和子目录 */
  private async listDir(dirPath: string): Promise<SkillFileNode[]> {
    try {
      const uri = vscode.Uri.file(dirPath);
      const entries = await vscode.workspace.fs.readDirectory(uri);
      const nodes: SkillFileNode[] = [];
      // 先目录后文件，按名称排序
      const dirs = entries.filter(([, t]) => t === vscode.FileType.Directory).sort(([a], [b]) => a.localeCompare(b));
      const files = entries.filter(([, t]) => t === vscode.FileType.File).sort(([a], [b]) => a.localeCompare(b));
      for (const [name] of dirs) {
        if (name.startsWith(".")) continue; // 隐藏文件
        const path = require("path");
        nodes.push(new SkillFileNode(name, path.join(dirPath, name), true));
      }
      for (const [name] of files) {
        if (name.startsWith(".")) continue;
        const path = require("path");
        nodes.push(new SkillFileNode(name, path.join(dirPath, name), false));
      }
      return nodes;
    } catch {
      return [];
    }
  }
}

// ─── MCP TreeView（分组：项目 / 全局 / Power 内嵌）────────────────────────

interface McpServerInfo { name: string; source: string; disabled: boolean }

/** MCP 分组节点（项目/全局/Power） */
class McpGroupItem extends vscode.TreeItem {
  readonly nodeType = "mcpGroup" as const;
  constructor(public readonly groupLabel: string, public readonly groupSource: string) {
    super(groupLabel, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "mcpSourceGroup";
  }
}

/** MCP server 叶子节点（携带 name/source/disabled，供右键删除/启停命令读取） */
class McpServerItem extends vscode.TreeItem {
  readonly nodeType = "mcpServer" as const;
  constructor(public readonly serverName: string, public readonly source: string, public readonly disabled: boolean) {
    super(serverName, vscode.TreeItemCollapsibleState.None);
    this.description = disabled ? "已禁用" : "";
    this.iconPath = disabled
      ? new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"))
      : new vscode.ThemeIcon("plug");
    // Power 内嵌的 MCP 在 Power 里管理，不提供删除/启停（contextValue 区分）
    this.contextValue = source === "power" ? "mcpItemReadonly" : "mcpItem";
    this.command = { command: "axon.openMcp", title: serverName, arguments: [] };
  }
}

type McpTreeNode = McpGroupItem | McpServerItem | SimpleItem;

export class McpTreeProvider implements vscode.TreeDataProvider<McpTreeNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private servers: McpServerInfo[] = [];

  refresh(servers: McpServerInfo[]): void {
    this.servers = servers;
    this._onDidChange.fire();
  }

  getTreeItem(element: McpTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: McpTreeNode): McpTreeNode[] {
    if (!element) {
      // 顶层：分组节点（仅显示有内容的组），顺序对齐 Skills（项目 / 全局 / Power）
      const groups: McpTreeNode[] = [];
      const ws = this.servers.filter((s) => s.source === "workspace");
      const user = this.servers.filter((s) => s.source === "user");
      const power = this.servers.filter((s) => s.source === "power");
      if (ws.length > 0) groups.push(new McpGroupItem("项目", "workspace"));
      if (user.length > 0) groups.push(new McpGroupItem("全局", "user"));
      if (power.length > 0) groups.push(new McpGroupItem("Power 内嵌", "power"));
      if (groups.length === 0) {
        return [new SimpleItem("暂无 MCP 服务器", "配置 mcp.json", "plug", "axon.openMcp")];
      }
      return groups;
    }
    if (element instanceof McpGroupItem) {
      return this.servers
        .filter((s) => s.source === element.groupSource)
        // 未禁用排前、禁用排后（组内稳定排序）
        .sort((a, b) => Number(a.disabled) - Number(b.disabled))
        .map((s) => new McpServerItem(s.name, s.source, s.disabled));
    }
    return [];
  }
}

/**
 * 注册所有管理面板 TreeView 并返回 provider 实例（供 extension.ts 后续刷新数据）。
 */
export function registerTreeViews(context: vscode.ExtensionContext) {
  const relayTree = new RelayTreeProvider();
  const skillsTree = new SkillsTreeProvider();
  const providerTree = new ProviderTreeProvider();
  const powersTree = new PowersTreeProvider();
  const customSkillsTree = new CustomSkillsTreeProvider();
  const mcpTree = new McpTreeProvider();

  context.subscriptions.push(
    vscode.window.createTreeView("axon.relay", { treeDataProvider: relayTree, showCollapseAll: false }),
    vscode.window.createTreeView("axon.skills", { treeDataProvider: skillsTree, showCollapseAll: false }),
    vscode.window.createTreeView("axon.powers", { treeDataProvider: powersTree, showCollapseAll: false }),
    vscode.window.createTreeView("axon.provider", { treeDataProvider: providerTree, showCollapseAll: false }),
    vscode.window.createTreeView("axon.mcp", { treeDataProvider: mcpTree, showCollapseAll: false }),
    vscode.window.createTreeView("axon.customSkills", { treeDataProvider: customSkillsTree }),
  );

  return { relayTree, skillsTree, providerTree, powersTree, customSkillsTree, mcpTree };
}
