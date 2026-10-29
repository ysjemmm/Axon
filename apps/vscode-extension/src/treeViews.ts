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
import { basename } from "node:path";
import { WIKI_CATEGORIES, type WikiPageSummary, type WikiJob } from "@axon/core";

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

  refresh(relays: { id: string; title: string; phase: string; root?: string }[]): void {
    this.items = relays.length > 0
      ? relays.map((r) => {
          const phaseIcon = r.phase === "done" ? "check" : r.phase === "executing" ? "play" : "edit";
          // 带上所在根：Relay 可能落在 Axon 另选的工作区里，打开 / 删除时直接定位，不再只认宿主文件夹
          const item = new SimpleItem(r.title, r.phase, phaseIcon, "axon.openRelay", [r.id, r.root], "relayItem");
          if (r.root) item.tooltip = `${r.title}\n${r.root}`;
          return item;
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

type SkillTreeNode = SkillGroupItem | SimpleItem | ExpandableSkillItem | SkillFileNode;

class SkillGroupItem extends vscode.TreeItem {
  readonly nodeType = "skillGroup" as const;
  constructor(public readonly groupLabel: string, public readonly groupSource: string) {
    super(groupLabel, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = "skillSourceGroup";
  }
}

/**
 * 可展开的 Skill 节点。
 *
 * 一个 skill 不止 SKILL.md：scripts/、assets/、references/ 等一起构成技能包。
 * 这里让节点可展开、就地列出内部文件；点击标题仍打开 SkillStudio。
 * 内置方法论是编译进产物的内存常量（没有磁盘目录），不实例化本类、保持单行。
 */
class ExpandableSkillItem extends vscode.TreeItem {
  readonly nodeType = "skillDir" as const;
  constructor(
    public readonly skillName: string,
    public readonly dir: string,
    public readonly source: string,
    public readonly disabled: boolean,
    icon: string,
    arg: Record<string, unknown>,
    contextValue: string,
  ) {
    super(skillName, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = disabled ? "已禁用" : "";
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = contextValue;
    this.tooltip = dir;
    this.command = { command: "axon.openSkill", title: "打开 Skill", arguments: [arg] };
  }
}

export class SkillsTreeProvider implements vscode.TreeDataProvider<SkillTreeNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private allSkills: { name: string; source: string; disabled: boolean; skillFile?: string; dir?: string }[] = [];

  refresh(skills: { name: string; source: string; disabled: boolean; skillFile?: string; dir?: string }[]): void {
    this.allSkills = skills;
    this._onDidChange.fire();
  }

  getTreeItem(element: SkillTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SkillTreeNode): Promise<SkillTreeNode[]> {
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
        // 未禁用排前、禁用排后
        .sort((a, b) => Number(a.disabled) - Number(b.disabled));
      return items.map((s) => {
        // 禁用态优先：内置 skill 现在也能关，不能再假定它没有禁用态
        const icon = s.disabled ? "circle-slash" : s.source === "builtin" ? "library" : "file";
        const desc = s.disabled ? "已禁用" : "";
        // 内置 skill 同样可启停（写用户级禁用名单），但要与普通 skill 区分：
        // 它没有磁盘目录，"删除"无从谈起，菜单里不该摆这个永远失败的操作。
        // 两者共用 toggle 菜单、只有普通 skill 带 delete/rename（见 package.json 的 view/item/context）。
        const ctxValue = s.source === "builtin" ? "skillBuiltinToggleable" : "skillToggleable";
        const arg = { name: s.name, source: s.source, skillFile: s.skillFile || "", disabled: s.disabled };
        // 有磁盘目录的 skill 可展开查看内部文件（scripts/assets 等）；内置方法论无目录，保持单行
        if (s.dir) {
          return new ExpandableSkillItem(s.name, s.dir, s.source, s.disabled, icon, arg, ctxValue);
        }
        return new SimpleItem(
          s.name,
          desc,
          icon,
          "axon.openSkill",
          [arg],
          ctxValue,
        );
      });
    }
    if (element instanceof ExpandableSkillItem) {
      return listDirNodes(element.dir);
    }
    if (element instanceof SkillFileNode && element.isDirectory) {
      return listDirNodes(element.filePath);
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
      const builtin = this.allPowers.filter((p) => p.source === "builtin");
      const workspace = this.allPowers.filter((p) => p.source === "workspace");
      const global = this.allPowers.filter((p) => p.source === "global");
      // 内置排在最前：它是"本该有但默认关闭"的能力，要让人一眼看到、可自行开
      if (builtin.length > 0) groups.push(new PowerGroupItem("内置（默认关闭）", "builtin"));
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
          // 内置 power 用独立 contextValue：不给它挂"删除/导入"菜单（目录在产物包内，删了也会随升级回来）
          p.source === "builtin" ? "powerItemBuiltin" : "powerItem",
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

/**
 * 列出目录下的文件与子目录（先目录后文件，跳过隐藏项）。
 * 侧边栏两个 Skill 视图共用：一个技能包除了 SKILL.md，还有 scripts/、assets/ 等。
 */
async function listDirNodes(dirPath: string): Promise<SkillFileNode[]> {
  const path = require("path") as typeof import("path");
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
    const dirs = entries.filter(([, t]) => t === vscode.FileType.Directory).sort(([a], [b]) => a.localeCompare(b));
    const files = entries.filter(([, t]) => t === vscode.FileType.File).sort(([a], [b]) => a.localeCompare(b));
    const nodes: SkillFileNode[] = [];
    for (const [name] of dirs) {
      if (name.startsWith(".")) continue; // 隐藏项不进树
      nodes.push(new SkillFileNode(name, path.join(dirPath, name), true));
    }
    for (const [name] of files) {
      if (name.startsWith(".")) continue;
      nodes.push(new SkillFileNode(name, path.join(dirPath, name), false));
    }
    return nodes;
  } catch {
    return [];
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
      return listDirNodes(element.dirPath);
    }

    if (element instanceof SkillFileNode && element.isDirectory) {
      // 子目录下的文件列表
      return listDirNodes(element.filePath);
    }

    return [];
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

// ─── Wiki ───────────────────────────────────────────────────────────────────

/**
 * 可展开的树节点（分组用）。
 *
 * SimpleItem 恒为 CollapsibleState.None（不可展开），而分组需要挂子节点，故单独定义。
 */
class WikiGroupNode extends vscode.TreeItem {
  constructor(
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    /** 子节点；空数组表示暂无内容，仍可展开为「空」 */
    readonly children: vscode.TreeItem[] = [],
  ) {
    super(label, collapsible);
  }
}

// ─── Wiki 页面视图（内容）───────────────────────────────────────────────────

/**
 * 项目 Wiki 页面树。
 *
 * 定位：为「当前仓库」沉淀结构化知识文档，落盘在 <工作区>/.axon/wiki/。
 *
 * 与 Relay 的区别（不要混为一谈）：Relay 是某次任务的中间产物（run-scoped），
 * 任务结束就成历史；Wiki 是仓库本身的长期资产（repo-scoped），任务结束后才开始有用，
 * 且应随 git 提交供团队共享。两者只是 UI 形态相似，数据模型不共用。
 *
 * 数据由 WikiStore.summary() 提供（列表 + 陈旧状态 + 文件绝对路径），本类只负责渲染。
 * 判定逻辑留在 core，一是能脱离 VS Code 跑单测，二是目录约定不会在这里再被复制一份。
 *
 * ⚠️ 生成 / 重新生成页面内容尚未接入（点击提示「该功能即将上线」）；
 *    但列表展示与陈旧检测已是真实数据——手动放 `.axon/wiki/*.md` 就会出现在这里。
 */
/**
 * 生成中的状态 —— 渲染到对应应用节点上（spinner + 进度），而不是视图顶部的 message。
 *
 * 为什么挂在节点上：message 只能回答「在跑」「跑到第几页」，答不了「在生成哪个应用」——
 * 而这个面板是全局的、列着所有工作区的页面，后者恰恰是用户最先要知道的那件事。
 * 两者本来说的就是同一件事，合并到节点上，两个问题一起解决。
 */
export interface WikiGeneratingState {
  /** 目标工作区路径（与 WikiPageSummary.workspace 同口径，用于匹配到对应节点） */
  workspace: string;
  /** 已完成页数 */
  done: number;
  /** 本次规划的页数；0 表示仍在规划阶段（还没有分母） */
  total: number;
  /** 当前正在撰写的页面标题。只进 tooltip —— 列表行宽撑不下它 */
  current?: string;
}

export class WikiTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private items: vscode.TreeItem[] = [emptyWikiItem()];
  /** 最近一次页面快照：生成状态变化时也要据此重建，故必须留存 */
  private pages: WikiPageSummary[] = [];
  private generating: WikiGeneratingState | null = null;

  /**
   * 用最新页面列表重建树。
   * @returns 需要复核的页数（供视图标题栏徽标显示）
   */
  refresh(pages: WikiPageSummary[]): number {
    this.pages = pages;
    this.rebuild();
    return pages.filter((p) => p.stale).length;
  }

  /**
   * 标记「哪个应用正在生成、到第几页了」；传 null 表示生成结束。
   *
   * 与 refresh 分开成两个入口：进度每次落盘都在变，页面列表却未必变。
   * 合成一个会让人以为「进度更新 = 页面有变」——那是两件事。
   */
  setGenerating(state: WikiGeneratingState | null): void {
    this.generating = state;
    this.rebuild();
  }

  private rebuild(): void {
    this.items = buildWikiTree(this.pages, this.generating);
    this._onDidChange.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    // 分组节点返回自己的子项；顶层返回分组集合。
    // 不能只判断 element 存在与否 —— 顶层调用时 element 是 undefined，而展开分组时是节点本身。
    return element instanceof WikiGroupNode ? element.children : this.items;
  }
}

/**
 * 页面列表 → 分组树（两层：工作区 → 分类）。
 *
 * ── 为什么必须有应用（工作区）这一层 ──
 * 这个面板是全局的（活动栏），列的是【所有工作区】的页面。用户绑了十几个工作区，
 * 不标归属就分不清哪页属于哪个项目 —— 而页面标题常常不带项目名
 * （「设置、通知与帮助」「路由结构与页面地图」这类，换个项目照样会有同名页）。
 *
 * ── 为什么只有一个应用时也保留这一层 ──
 * 只有一个应用时它看似多余，但【不能省】。省掉之后，「应用」这个概念就只在多应用时
 * 才出现，树的形状会随应用数量变化 —— 用户得先判断「现在挂了几个应用」才知道该怎么读
 * 这棵树。形状稳定比少一次缩进重要得多。这也是分类那条降级规则的边界：
 * 分类降级不会改变「谁是父、谁是子」，而省掉应用层会。
 * 应用名同时也是视图归属的答案，所以视图描述不再重复显示它。
 *
 * ── 组内的两条组织原则 ──
 * ① 「待复核」独立成组置顶：它是要行动的事项，优先级高于浏览。
 *    视图徽标另有全局计数，所以它即便收在工作区分组内也不会被埋没。
 * ② 其余按固定分类归组，顺序由 WIKI_CATEGORIES 决定，不随页面增减而跳动
 *    （顺序稳定，人才记得住东西在哪）。
 *
 * ── 旧数据的降级 ──
 * 加分类字段之前生成的页面没有 category。此时若仍强行分组，会得到一个装着全部页面的
 * 「未分类」组 —— 展开才能看到内容，比平铺还多一次点击。所以：
 * **一页分类都没有时就不按分类分组**，保持平铺。
 *
 * ── 正在生成的那个应用 ──
 * 目标应用带上 spinner 与进度（见 WikiGeneratingState）。两个细节：
 * ① 它即便还没有任何页面也照样列出 —— 首次生成时磁盘上本来就是空的，而那正是
 *    「在生成哪个应用」最需要被看见的时刻；少了这条，spinner 恰在该出现时缺席。
 * ② 此时 label 不再显示页数、只留名字，进度走 description：页面是随生成逐页落盘的，
 *    「已有几页」与「完成几页」说的是同一件事，并排放两个数字反而费解；
 *    而进度形（3 / 14）还多带一个分母，严格更有信息量。
 */
function buildWikiTree(pages: WikiPageSummary[], generating: WikiGeneratingState | null): vscode.TreeItem[] {
  const byWorkspace = new Map<string, WikiPageSummary[]>();
  for (const p of pages) {
    const list = byWorkspace.get(p.workspace);
    if (list) list.push(p);
    else byWorkspace.set(p.workspace, [p]);
  }

  // 生成中的应用即使尚无页面也要有节点，否则首次生成时 spinner 无处可挂
  if (generating && !byWorkspace.has(generating.workspace)) {
    byWorkspace.set(generating.workspace, []);
  }
  if (byWorkspace.size === 0) return [emptyWikiItem()];

  const out: vscode.TreeItem[] = [];
  // 按目录名排序：分组顺序必须稳定，否则页面一增减组的位置就跳，人会找不到东西
  const ordered = [...byWorkspace.entries()].sort((a, b) => basename(a[0]).localeCompare(basename(b[0])));
  for (const [ws, list] of ordered) {
    const gen = generating?.workspace === ws ? generating : null;
    const node = new WikiGroupNode(
      gen ? basename(ws) : `${basename(ws)} (${list.length})`,
      // 没有页面就没得展开：标成可展开会给出一个点了没反应的三角
      list.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      buildCategoryTree(list),
    );
    if (gen) {
      // spinner 渲染在折叠箭头之后、名字之前 —— 一眼看出「是它在生成」
      node.iconPath = new vscode.ThemeIcon("loading~spin");
      node.description = gen.total > 0 ? `${gen.done} / ${gen.total}` : "正在规划…";
    }
    // 完整路径进 tooltip：两个工作区目录同名时（各挂一份同名项目）靠它分辨。
    // 生成中再补上当前落点 —— 「正在写哪一页」只适合放这儿，列表行宽撑不下它。
    node.tooltip = gen
      ? [
          ws,
          gen.total > 0 ? `正在生成 Wiki：${gen.done} / ${gen.total} 页` : "正在勘察仓库、规划页面…",
          gen.current ? `当前：${gen.current}` : "",
        ].filter(Boolean).join("\n")
      : ws;
    // 供右键菜单定位目标（与页面项挂 wikiSlug/wikiWorkspace 是同一做法：
    // 挂在 item 上，而不是塞进 command.arguments —— 后者会让同一节点的多个命令共用一个参数数组）。
    (node as unknown as { wikiWorkspace?: string }).wikiWorkspace = ws;
    // 生成中的节点不挂删除菜单：那一刻正在往这个目录里写文件，边写边删会留下半截产物。
    // 与「运行中的作业不给删除项」是同一条理由。
    node.contextValue = gen ? "wikiWorkspaceGenerating" : "wikiWorkspace";
    out.push(node);
  }
  return out;
}

/** 单个工作区内的分组：待复核置顶 + 固定分类（该工作区全无分类数据时平铺） */
function buildCategoryTree(pages: WikiPageSummary[]): vscode.TreeItem[] {
  const stale = pages.filter((p) => p.stale);
  const healthy = pages.filter((p) => !p.stale);
  const out: vscode.TreeItem[] = [];

  if (stale.length > 0) {
    out.push(new WikiGroupNode(
      `待复核 (${stale.length})`,
      vscode.TreeItemCollapsibleState.Expanded,
      stale.map(toWikiItem),
    ));
  }

  if (!pages.some((p) => p.category)) {
    out.push(...healthy.map(toWikiItem));
    return out;
  }

  const byCategory = new Map<string, WikiPageSummary[]>();
  for (const p of healthy) {
    const key = p.category?.trim() || "";
    const list = byCategory.get(key);
    if (list) list.push(p);
    else byCategory.set(key, [p]);
  }

  // 固定顺序先出（组名右侧带页数，一眼看出知识分布）
  for (const cat of WIKI_CATEGORIES) {
    const list = byCategory.get(cat);
    if (list?.length) {
      out.push(new WikiGroupNode(`${cat} (${list.length})`, vscode.TreeItemCollapsibleState.Expanded, list.map(toWikiItem)));
    }
    byCategory.delete(cat);
  }
  // 不在固定集合里的分类名（用户手改出来的）—— 原样显示，不静默吞掉
  for (const [key, list] of byCategory) {
    if (!key) continue;
    out.push(new WikiGroupNode(`${key} (${list.length})`, vscode.TreeItemCollapsibleState.Collapsed, list.map(toWikiItem)));
  }
  // 未分类排在最后：它是「待整理」的暂存区，不该占据视线中心
  const uncategorized = byCategory.get("");
  if (uncategorized?.length) {
    out.push(new WikiGroupNode(`未分类 (${uncategorized.length})`, vscode.TreeItemCollapsibleState.Collapsed, uncategorized.map(toWikiItem)));
  }
  return out;
}

/** 单页 → 树节点。陈旧 / 未知各用不同图标与描述，扫一眼就知道哪页需要复核。 */
function toWikiItem(page: WikiPageSummary): SimpleItem {
  const changed = page.changedSources.length;
  const item = page.stale
    ? new SimpleItem(page.title, changed > 0 ? `${changed} 个源文件已变更` : "源文件已变更", "warning", "axon.wiki.openPage", [page.path], "wikiPageStale")
    : page.unknown
      ? new SimpleItem(page.title, "状态未知（缺生成快照）", "question", "axon.wiki.openPage", [page.path], "wikiPage")
      : new SimpleItem(page.title, page.summary, "book", "axon.wiki.openPage", [page.path], "wikiPage");

  // 删除命令靠这两个属性定位目标。挂在 item 上而不是塞进 command.arguments：
  // 那会让打开页面与删除共用一个参数数组，改一边就可能悄悄影响另一边。
  // （与 MCP 树用 item.serverName 传参是同一做法。）
  const retarget = item as unknown as { wikiSlug?: string; wikiWorkspace?: string };
  retarget.wikiSlug = page.slug;
  retarget.wikiWorkspace = page.workspace;

  const tip = new vscode.MarkdownString();
  tip.appendMarkdown(`**${page.title}**\n\n`);
  // 带上文件路径：多工作区下同名页面只能靠它区分归属（列表行本身不显示项目）
  tip.appendMarkdown(`\`${page.path}\`\n\n`);
  if (page.summary) tip.appendMarkdown(`${page.summary}\n\n`);
  if (page.sources.length > 0) {
    tip.appendMarkdown(`依据以下文件生成：\n`);
    for (const s of page.sources) tip.appendMarkdown(`- \`${s}\`\n`);
  }
  if (page.stale && changed > 0) {
    // 列出「具体哪个文件变了」：只说「已过时」人要自己去 diff 才知道影响面，等于没说
    tip.appendMarkdown(`\n⚠️ 这些文件在生成后已变更，页面内容可能已失真：\n`);
    for (const s of page.changedSources) tip.appendMarkdown(`- \`${s}\`\n`);
  }
  item.tooltip = tip;
  return item;
}

/**
 * 空状态：说清「点下去会让你选工作区」，而不是一片空白。
 *
 * 刻意【不】显示任何推定目标。早先显示过推定值，立刻造成误解：用户看到
 * 「将生成到 d:\me\work-prds」，却从未选择过这个工作区——只因恰好有个文件开在编辑器里。
 * 把一个可能不对的猜测摆在显眼处，比不显示更糟。目标由用户在选择框里拍板，
 * 这里只负责说明「下一步会让你选」。
 */
function emptyWikiItem(): SimpleItem {
  const item = new SimpleItem("尚未生成 Wiki", "点标题栏按钮开始", "info");
  item.tooltip = new vscode.MarkdownString(
    "为一个工作区生成结构化知识文档，落盘在该工作区的 `.axon/wiki/`，可随 git 提交供团队共享。\n\n" +
    "**点击后会让你选择目标工作区** —— Wiki 是仓库级资产，一次针对一个仓库生成。\n\n" +
    "手动放置的 `.axon/wiki/*.md` 也会被列在这里。",
  );
  return item;
}

// ─── Wiki 任务视图 ──────────────────────────────────────────────────────────

/**
 * Wiki 任务视图 —— 历次生成的状态与排障线索。
 *
 * ── 上栏为什么只放任务，不放「生成结果」入口 ──
 * 内容就在下面一栏，一个十几条的列表不需要「跳过去」——那只是一次没有信息量的点击。
 * 上栏留给真正需要独立空间的东西：生成历史。
 *
 * ⚠️ 这些状态此前只写进 .state.json，用户完全看不到。于是「上次生成断在哪」
 * 「哪一页没成」「还剩几页要续跑」——最该被看见的排障线索一直藏着。
 */
export class WikiTasksTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private jobs: WikiJob[] = [];

  refresh(jobs: WikiJob[]): void {
    this.jobs = jobs;
    this._onDidChange.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    // 直接列出历次作业，不再套一层「Wiki 任务」分组 ——
    // 上栏只有这一类内容，多一层折叠只是多一次点击。
    return this.jobs.length > 0 ? this.jobs.map((j) => toJobItem(j)) : [emptyTaskItem()];
  }
}

/**
 * 单个作业 → 树节点。
 *
 * 状态用图标 + 文案双重表达 —— 只靠图标时，分不清「已完成」与「已中断」
 * 这两件后果完全不同的事（后者还差页数、需要续跑）。
 */
function toJobItem(job: WikiJob): vscode.TreeItem {
  const total = job.planned.length;
  const done = job.done.length;
  const item = new vscode.TreeItem(`${basename(job.workspace)} ｜ ${done}/${total} 页`, vscode.TreeItemCollapsibleState.None);
  // contextValue 决定右键菜单里出现哪些项；running 态没有删除项（见 package.json 的 when 条件）
  item.contextValue = job.status === "running" ? "wikiJobRunning" : "wikiJob";
  (item as unknown as { wikiJobId?: string }).wikiJobId = job.id;
  const [icon, text] = JOB_STATUS_DISPLAY[job.status] ?? ["circle-outline", job.status];
  item.iconPath = new vscode.ThemeIcon(icon);
  item.description = text;
  const tip = new vscode.MarkdownString();
  tip.appendMarkdown(`**${basename(job.workspace)}**\n\n`);
  tip.appendMarkdown(`状态：${text}\n\n`);
  tip.appendMarkdown(`进度：${done}/${total} 页\n\n`);
  if (job.model) tip.appendMarkdown(`模型：\`${job.model}\`\n\n`);
  tip.appendMarkdown(`开始：${formatJobTime(job.startedAt)}\n\n`);
  if (job.finishedAt) tip.appendMarkdown(`结束：${formatJobTime(job.finishedAt)}\n\n`);
  if (job.error) tip.appendMarkdown(`⚠️ ${job.error}\n\n`);
  // 还没生成的页面单独列出：这是「续跑还剩什么」的直接答案
  const pending = job.planned.filter((s) => !job.done.includes(s));
  if (pending.length > 0 && job.status !== "done") {
    tip.appendMarkdown(`未完成：\n`);
    for (const s of pending) tip.appendMarkdown(`- ${s}\n`);
  }
  item.tooltip = tip;
  return item;
}

/** 空状态：没有生成记录时，说明这里将来会出现什么 */
function emptyTaskItem(): vscode.TreeItem {
  const item = new vscode.TreeItem("暂无生成记录", vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon("history");
  item.tooltip = new vscode.MarkdownString(
    "每次生成 Wiki 都会在这里留一条记录，含状态、进度与未完成的页面。\n\n点标题栏的生成按钮开始第一次。",
  );
  return item;
}

/** 作业状态 → 图标 + 文案。中断态刻意写明「可续跑」，否则用户会以为这次白跑了。 */
const JOB_STATUS_DISPLAY: Record<string, [string, string]> = {
  running: ["sync~spin", "进行中"],
  done: ["check", "已完成"],
  interrupted: ["debug-pause", "已中断（可续跑）"],
  failed: ["warning", "有页面失败"],
};

/** ISO 时间 → 本地可读。作业时间戳是排障线索，显示成原始 ISO 没人愿意读。 */
function formatJobTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 注册所有管理面板 TreeView 并返回 provider 实例（供 extension.ts 后续刷新数据）。
 */
export function registerTreeViews(context: vscode.ExtensionContext) {
  const relayTree = new RelayTreeProvider();
  const wikiTasksTree = new WikiTasksTreeProvider();
  const wikiTree = new WikiTreeProvider();
  const skillsTree = new SkillsTreeProvider();
  const providerTree = new ProviderTreeProvider();
  const powersTree = new PowersTreeProvider();
  const customSkillsTree = new CustomSkillsTreeProvider();
  const mcpTree = new McpTreeProvider();

  // Wiki 面板拆成两个视图：任务（上）+ 页面（下）。
  // 上栏只承载「历次生成的状态与排障」，下栏是「内容本身（按分类分组）」——
  // 两者意图不同（低频管理 vs 高频浏览），混在一起时页面一多就把管理信息顶出视野。
  const wikiTasksView = vscode.window.createTreeView("axon.wiki", { treeDataProvider: wikiTasksTree, showCollapseAll: false });
  // 「生成结果」视图单独持有：badge（待复核页数）与 message（生成进度）都挂在它上面
  const wikiView = vscode.window.createTreeView("axon.wiki.pages", { treeDataProvider: wikiTree, showCollapseAll: false });

  context.subscriptions.push(
    vscode.window.createTreeView("axon.relay", { treeDataProvider: relayTree, showCollapseAll: false }),
    wikiTasksView,
    wikiView,
    vscode.window.createTreeView("axon.skills", { treeDataProvider: skillsTree, showCollapseAll: false }),
    vscode.window.createTreeView("axon.powers", { treeDataProvider: powersTree, showCollapseAll: false }),
    vscode.window.createTreeView("axon.provider", { treeDataProvider: providerTree, showCollapseAll: false }),
    vscode.window.createTreeView("axon.mcp", { treeDataProvider: mcpTree, showCollapseAll: false }),
    vscode.window.createTreeView("axon.customSkills", { treeDataProvider: customSkillsTree }),
  );

  return { relayTree, wikiTasksTree, wikiTree, wikiView, skillsTree, providerTree, powersTree, customSkillsTree, mcpTree };
}
