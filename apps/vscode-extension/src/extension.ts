/**
 * Axon VS Code 扩展入口（进程内 IDE 形态）
 *
 * 架构对称于 server：
 *   - server：WsChannel + SessionHub + NodeAgentHost，前端经 ws 连接
 *   - 扩展：  VSCodeChannel + SessionHub + VSCodeAgentHost，前端是侧栏 webview
 *
 * Agent 内核（@axon/core）跑在 Extension Host 进程内，import 直连、无网络、无中间 server。
 *
 * provider 配置时序：providers 已惰性化（首次 getClient 时才读 process.env），
 * 因此 loadProviderEnv() 只需在"用户发第一条消息"之前执行即可——activate 里调一次足矣。
 */

import * as vscode from "vscode";
import { homedir } from "node:os";
import { join } from "node:path";
import { SessionHub, type ControlCommand, type WorkspaceGroup, webSearch, webFetch } from "@axon/core";
import { createVSCodeAgentHost, VSCodeCommandTrustStore } from "@axon/host-vscode";
import { JsonFileStorage, createNodeMcpCapability } from "@axon/host-node";
import { loadProviderEnv } from "./loadEnv.js";
import { VSCodeChannel } from "./vscodeChannel.js";
import { AxonViewProvider } from "./viewProvider.js";
import { RequestRouter, vscodeBrowse } from "./requestRouter.js";
import { registerTreeViews } from "./treeViews.js";
import { registerAxonStatusBar } from "./statusBar.js";
import { openOrFocusPanel } from "./panelManager.js";
import { registerGitBlameAnnotation } from "./gitBlameAnnotation.js";
import { registerInlineCompletion } from "./inlineCompletion.js";
import { registerAskAxonCodeAction } from "./codeActionProvider.js";

/** 批量导入结果（单条） */
interface ImportResult {
  name: string;
  ok: boolean;
  error?: string;
}

/** 带源目录绝对路径的 QuickPick 选项 */
interface DirPickItem extends vscode.QuickPickItem {
  dir: string;
}

/**
 * 扫描父目录下所有「含指定标记文件」的直接子目录，返回可勾选的 QuickPick 选项（默认全部勾选）。
 * @param markerFile 子目录需包含的标记文件，如 "SKILL.md" / "POWER.md"
 */
async function scanChildDirsWithMarker(parentDir: string, markerFile: string): Promise<DirPickItem[]> {
  const path = require("path");
  const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(parentDir));
  const items: DirPickItem[] = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.Directory) continue;
    const dir = path.join(parentDir, name);
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(path.join(dir, markerFile)));
      items.push({ label: name, description: dir, picked: true, dir });
    } catch { /* 无标记文件，跳过 */ }
  }
  return items;
}

/**
 * 让用户批量选择要导入的源目录，返回选中目录的绝对路径列表（取消返回 undefined）。
 * 提供两种方式：
 *  1. 浏览目录（文件对话框中可按住 Ctrl 多选文件夹）
 *  2. 从父目录勾选（选一个父目录，列出其下所有含标记文件的子目录，逐个勾选）
 */
async function pickImportSourceDirs(label: string, markerFile: string): Promise<string[] | undefined> {
  const modeBrowse = "浏览并选择目录（可按住 Ctrl 多选）";
  const modeParent = "从父目录勾选（列出后逐个勾选，推荐）";
  const mode = await vscode.window.showQuickPick([modeBrowse, modeParent], { placeHolder: `${label} 导入方式` });
  if (!mode) return undefined;

  if (mode === modeBrowse) {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: `选择 ${label} 目录`,
      title: `选择要导入的 ${label} 目录（按住 Ctrl 可多选，每个应含 ${markerFile}）`,
    });
    return uris && uris.length > 0 ? uris.map((u) => u.fsPath) : undefined;
  }

  const parentUris = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "选择父目录",
    title: `选择包含多个 ${label} 的父目录`,
  });
  if (!parentUris || parentUris.length === 0) return undefined;
  const items = await scanChildDirsWithMarker(parentUris[0].fsPath, markerFile);
  if (items.length === 0) {
    vscode.window.showWarningMessage(`所选目录下没有找到任何含 ${markerFile} 的子目录。`);
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: `勾选要导入的 ${label}（默认全选，共 ${items.length} 个）`,
  });
  return picked && picked.length > 0 ? picked.map((p) => p.dir) : undefined;
}

/** 判断两个路径是否指向同一位置（Windows 下大小写不敏感）。 */
function isSamePath(a: string, b: string): boolean {
  const path = require("path");
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * 检测目标根目录下，哪些待导入源目录的名称已存在（按目录名判断文件系统冲突）。
 * 源目录本身就在目标位置（源 == 目标）时不计为冲突。
 */
async function findNameConflicts(baseDir: string, sourceDirs: string[]): Promise<Set<string>> {
  const path = require("path");
  const conflicts = new Set<string>();
  for (const src of sourceDirs) {
    const name = path.basename(src);
    const target = path.join(baseDir, name);
    if (isSamePath(src, target)) continue;
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(target));
      conflicts.add(name);
    } catch { /* 目标不存在，无冲突 */ }
  }
  return conflicts;
}

/** 导入重名策略：覆盖 或 跳过。 */
type OverwriteStrategy = "overwrite" | "skip";

/**
 * 重名时询问用户处理策略（对标 Kiro/Claude：默认以覆盖为主，但给用户确认机会）。
 * 无重名时直接返回 "overwrite"（不打扰用户）；用户取消返回 undefined。
 */
async function resolveOverwriteStrategy(label: string, conflictCount: number): Promise<OverwriteStrategy | undefined> {
  if (conflictCount === 0) return "overwrite";
  const overwrite = `覆盖（${conflictCount} 个同名将被替换）`;
  const skip = "跳过同名，只导入新的";
  const pick = await vscode.window.showWarningMessage(
    `检测到 ${conflictCount} 个同名 ${label} 已存在，如何处理？`,
    { modal: true },
    overwrite,
    skip,
  );
  if (pick === overwrite) return "overwrite";
  if (pick === skip) return "skip";
  return undefined; // 取消
}

/**
 * 将一批源目录复制到目标根目录下，按重名策略处理冲突项。
 *  - overwrite：先删除旧目录再复制，确保干净替换（避免旧文件残留）
 *  - skip：跳过冲突项，记入结果
 */
async function copyDirsInto(
  baseDir: string,
  sourceDirs: string[],
  options: { conflicts: Set<string>; strategy: OverwriteStrategy },
): Promise<ImportResult[]> {
  const path = require("path");
  const results: ImportResult[] = [];
  for (const sourceDir of sourceDirs) {
    const name = path.basename(sourceDir);
    const targetPath = path.join(baseDir, name);
    const targetUri = vscode.Uri.file(targetPath);
    // 源与目标是同一目录：已在目标位置，无需导入（避免删源导致复制失败）
    if (isSamePath(sourceDir, targetPath)) {
      results.push({ name, ok: false, error: "已在目标位置，无需导入" });
      continue;
    }
    const isConflict = options.conflicts.has(name);
    if (isConflict && options.strategy === "skip") {
      results.push({ name, ok: false, error: "已存在，已跳过" });
      continue;
    }
    try {
      if (isConflict) {
        await vscode.workspace.fs.delete(targetUri, { recursive: true });
      }
      await vscode.workspace.fs.copy(vscode.Uri.file(sourceDir), targetUri, { overwrite: true });
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: (err as Error).message });
    }
  }
  return results;
}

/** 批量删除目录，返回成功数与失败描述列表。 */
async function deleteDirs(dirs: string[]): Promise<{ ok: number; failed: string[] }> {
  let ok = 0;
  const failed: string[] = [];
  for (const dir of dirs) {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(dir), { recursive: true });
      ok++;
    } catch (err) {
      failed.push((err as Error).message);
    }
  }
  return { ok, failed };
}

/** 统一弹出批量导入的成功/失败提示。 */
function reportImportResults(label: string, results: ImportResult[]): void {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  if (ok.length > 0) {
    vscode.window.showInformationMessage(`已导入 ${ok.length} 个 ${label}：${ok.map((r) => r.name).join("、")}`);
  }
  if (failed.length > 0) {
    vscode.window.showErrorMessage(`${failed.length} 个 ${label} 导入失败：${failed.map((r) => `${r.name}(${r.error})`).join("、")}`);
  }
}

/**
 * 从两种 Skill 树节点解析出删除所需的目标信息，统一两个 SKILLS 视图的删除入口：
 *  - CustomSkillsTreeProvider 的 SkillDirNode：自身带 dirPath / name / source
 *  - SkillsTreeProvider 的 SimpleItem：信息在 command.arguments[0]（含 skillFile，取其所在目录）
 */
function resolveSkillDeleteTarget(node: unknown): { dirPath?: string; name?: string; source?: string } {
  const path = require("path");
  if (!node || typeof node !== "object") return {};
  const n = node as { dirPath?: string; name?: string; source?: string; command?: { arguments?: unknown[] } };
  if (typeof n.dirPath === "string" && n.dirPath) {
    return { dirPath: n.dirPath, name: n.name, source: n.source };
  }
  const arg = n.command?.arguments?.[0] as { name?: string; source?: string; skillFile?: string } | undefined;
  if (arg && typeof arg === "object") {
    const dirPath = typeof arg.skillFile === "string" && arg.skillFile ? path.dirname(arg.skillFile) : undefined;
    return { dirPath, name: arg.name, source: arg.source };
  }
  return {};
}

export function activate(context: vscode.ExtensionContext): void {
  // 1) 加载 provider 环境变量（providers 惰性化，首次 getClient 前写入 process.env 即可）
  const { providerCount, sources } = loadProviderEnv();
  console.log(`[axon] provider 配置加载：识别到 ${providerCount} 个 provider，来源 [${sources.join(", ") || "无"}]`);

  const storage = new JsonFileStorage();
  const channel = new VSCodeChannel();

  // 默认工作区：取第一个工作区文件夹，没有则用用户主目录
  const defaultWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || homedir();
  // 所有工作区文件夹（多根工作区场景）
  const allWorkspaces = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [defaultWorkspace];

  const isValidDir = async (p: string): Promise<boolean> => {
    try {
      const st = await vscode.workspace.fs.stat(vscode.Uri.file(p));
      return (st.type & vscode.FileType.Directory) !== 0;
    } catch {
      return false;
    }
  };

  const hub = new SessionHub({
    storage,
    channel,
    createHost: () => createVSCodeAgentHost(),
    isValidDir,
    resolveWorkspaceGroup: async (_groupId: string): Promise<WorkspaceGroup | null> => null,
    defaultWorkspace,
    workspaces: allWorkspaces,
    homeDir: homedir(),
    web: { search: webSearch, fetch: webFetch },
    mcp: createNodeMcpCapability(),
    // 命令信任白名单：读写 `axon.trustedCommands` 配置（弹窗授权与设置管理共用同一份数据）
    commandTrust: new VSCodeCommandTrustStore(),
  });

  // REST 请求路由（webview 形态下替代 Express）
  const router = new RequestRouter({
    storage,
    isValidDir,
    browse: vscodeBrowse,
    defaultWorkspace,
  });

  const provider = new AxonViewProvider(
    context,
    channel,
    async (cmd: ControlCommand) => {
      try {
        await hub.dispatch(cmd);
      } catch (err) {
        const error = err as Error;
        if (error.name === "AbortError" || error.message?.includes("aborted")) {
          if (cmd.type === "user_message") {
            await hub.persistOnCancel(cmd);
          } else {
            channel.emit({ type: "stream_end", elapsed: 0, tokens: 0 });
          }
          return;
        }
        channel.emit({ type: "error", content: error.message });
      }
    },
    router,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AxonViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // 监听工作区变化：添加/移除文件夹时同步给 Agent Session
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const folders = vscode.workspace.workspaceFolders;
      if (folders && folders.length > 0) {
        const workspaces = folders.map((f) => f.uri.fsPath);
        // 同步 hub 的 deps.workspaces（让后续 load_session 也能读到最新列表）
        (hub as any).deps.workspaces = workspaces;
        // 通过 dispatch set_workspace 更新当前内存 session 的工作区列表
        hub.dispatch({ type: "set_workspace", workspace: workspaces[0], workspaces } as any).catch(() => { });
        // 同步通知 webview 更新工作区信息
        provider.postToWebview({ type: "workspace_set", workspace: workspaces[0], workspaces });
      }
    }),
    // 监听配置变化：axon.trustedCommands 改变时实时同步到正在运行的会话
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("axon.trustedCommands")) {
        hub.reloadTrustedCommands();
      }
    }),
    vscode.commands.registerCommand("axon.newSession", () => provider.postToWebview({ type: "command:new_session" })),
    vscode.commands.registerCommand("axon.focusChat", () => {
      // 先确保辅助侧栏可见，再聚焦 Axon chat view
      vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
      vscode.commands.executeCommand("axon.chat.focus");
    }),
    // 终端选区 → 添加到 Axon 对话（由 workbench 终端浮动按钮触发）
    vscode.commands.registerCommand("axon.addTerminalSelectionToChat", async (payload?: { text?: string; lineCount?: number; terminalName?: string }) => {
      if (!payload || typeof payload.text !== "string" || !payload.text.trim()) return;
      const lineCount = typeof payload.lineCount === "number" ? payload.lineCount : payload.text.replace(/\n$/, "").split("\n").length;
      const terminalName = payload.terminalName || "终端";
      await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
      await vscode.commands.executeCommand("axon.chat.focus");
      provider.postToWebview({
        type: "add_context",
        source: "terminal",
        label: `${terminalName} · ${lineCount} 行`,
        text: payload.text,
      });
    }),
    // 主动感知问题 → 添加到 Axon 对话（由状态栏主动感知指示器触发）
    vscode.commands.registerCommand("axon.addProactiveAwarenessToChat", async (payload?: { summary?: string; details?: string }) => {
      const summary = payload?.summary?.trim() || "检测到一些问题";
      const details = payload?.details?.trim() || "";
      await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
      await vscode.commands.executeCommand("axon.chat.focus");
      provider.postToWebview({
        type: "add_context",
        source: "terminal",
        label: summary,
        text: details ? `${summary}\n\n${details}\n\n请帮我分析并解决这些问题。` : `${summary}\n\n请帮我分析并解决这些问题。`,
      });
    }),
    // 编辑器代码选区 → 添加到 Axon 对话（由 workbench 编辑器浮动按钮触发）
    vscode.commands.registerCommand("axon.addEditorSelectionToChat", async (payload?: { text?: string; fileName?: string; startLine?: number; startColumn?: number; endLine?: number; endColumn?: number }) => {
      if (!payload || typeof payload.text !== "string" || !payload.text.trim()) return;
      const name = payload.fileName || "选区";
      const sl = payload.startLine ?? 0;
      const sc = payload.startColumn ?? 0;
      const el = payload.endLine ?? sl;
      const ec = payload.endColumn ?? sc;
      await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
      await vscode.commands.executeCommand("axon.chat.focus");
      provider.postToWebview({
        type: "add_context",
        source: "editor",
        label: `${name} ${sl}:${sc}-${el}:${ec}`,
        text: payload.text,
      });
    }),
    vscode.commands.registerCommand("axon.openRelay", (relayId: string) => {
      // 点击 Relay 树节点：在编辑器 Tab 打开 Relay 详情面板
      const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
      openOrFocusPanel({
        id: `relay-${relayId}`,
        title: `Relay: ${relayId}`,
        query: `view=relay&id=${encodeURIComponent(relayId)}&workspace=${encodeURIComponent(workspace)}`,
        extensionUri: context.extensionUri,
        router,
        icon: "media/relay.svg",
      });
    }),
    vscode.commands.registerCommand("axon.deleteRelay", async (item: vscode.TreeItem) => {
      // 右键删除 Relay
      const relayId = item.command?.arguments?.[0] as string | undefined;
      if (!relayId) return;
      const confirm = await vscode.window.showWarningMessage(
        `确定删除 Relay「${item.label}」？正在执行的任务会被中断，文档与进度将一并移除。此操作不可撤销。`,
        { modal: true },
        "删除",
      );
      if (confirm !== "删除") return;
      try {
        // 通过 SessionHub dispatch 走 session 层删除：会取消正在运行的子 Agent，让 AI 感知
        await hub.dispatch({ type: "delete_relay", relayId, workspace: defaultWorkspace } as any);
        // 刷新树（relay_deleted 事件也会触发刷新，这里兜底）
        const { RelayStore } = await import("@axon/core");
        const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
        const store = new RelayStore(defaultWorkspace, createHost());
        const relays = await store.list();
        relayTree.refresh(relays.map((r) => ({ id: r.id, title: r.title, phase: r.phase })));
      } catch (err) {
        vscode.window.showErrorMessage(`删除失败：${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("axon.openSkill", async (arg?: { name?: string; source?: string; skillFile?: string; create?: boolean }) => {
      // builtin skill：无实体文件，正文在内存常量里。提示用户这是内置 skill
      if (arg && arg.source === "builtin") {
        vscode.window.showInformationMessage(
          `「${arg.name}」是 Axon 内置 Skill（方法论包），无需编辑文件，AI 会在合适场景自动使用。`,
        );
        return;
      }
      // global/workspace skill：有实体 SKILL.md 文件，直接打开
      if (arg && arg.skillFile) {
        try {
          await vscode.window.showTextDocument(vscode.Uri.file(arg.skillFile), { preview: true });
          return;
        } catch {
          vscode.window.showWarningMessage(`无法打开 Skill 文件：${arg.skillFile}`);
          return;
        }
      }
      // 新建/兜底：reveal 或创建 .axon/skills 目录
      const skillDirs = [
        vscode.Uri.joinPath(vscode.Uri.file(defaultWorkspace), ".axon", "skills"),
        vscode.Uri.joinPath(vscode.Uri.file(homedir()), ".axon", "skills"),
      ];
      for (const dir of skillDirs) {
        try {
          const stat = await vscode.workspace.fs.stat(dir);
          if (stat.type === vscode.FileType.Directory) {
            await vscode.commands.executeCommand("revealInExplorer", dir);
            return;
          }
        } catch { /* 不存在，继续 */ }
      }
      const action = await vscode.window.showInformationMessage(
        "暂无自定义 Skill。要在当前工作区创建 Skills 目录吗？",
        "创建",
        "取消",
      );
      if (action === "创建") {
        const dir = vscode.Uri.joinPath(vscode.Uri.file(defaultWorkspace), ".axon", "skills");
        await vscode.workspace.fs.createDirectory(dir);
        await vscode.commands.executeCommand("revealInExplorer", dir);
      }
    }),
  );

  // 左侧管理面板 TreeView（Relay / Skills / Powers / Provider）
  const { relayTree, skillsTree, providerTree, powersTree, customSkillsTree, mcpTree } = registerTreeViews(context);

  // Skill 树刷新辅助
  const refreshSkillTree = async () => {
    try {
      const { SkillRegistry, globalSkillsDir, workspaceSkillsDir } = await import("@axon/core");
      const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
      const registry = new SkillRegistry([defaultWorkspace], createHost(), homedir());
      const skills = await registry.discover();
      skillsTree.refresh(skills.map((s) => ({ name: s.name, source: s.source, disabled: s.disabled, skillFile: s.skillFile })));
      customSkillsTree.refresh(
        skills.map((s) => ({ name: s.name, source: s.source, disabled: s.disabled, skillFile: s.skillFile, dir: s.dir })),
        workspaceSkillsDir(defaultWorkspace),
        globalSkillsDir(homedir()),
      );
    } catch { /* 忽略 */ }
  };

  // Skill CRUD 命令
  context.subscriptions.push(
    vscode.commands.registerCommand("axon.skill.toggle", async (item?: vscode.TreeItem) => {
      if (!item || !item.command?.arguments?.[0]) return;
      const arg = item.command.arguments[0] as { name: string; source: string; disabled?: boolean };
      if (arg.source === "builtin") {
        vscode.window.showInformationMessage("内置 Skill 不能禁用。如需替换，可在工作区或全局创建一个同名 skill 覆盖它。");
        return;
      }
      const { SkillRegistry } = await import("@axon/core");
      const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
      const registry = new SkillRegistry([defaultWorkspace], createHost(), homedir());
      const metas = await registry.discover();
      const meta = metas.find((m) => m.name === arg.name);
      if (!meta) return;
      const path = require("path");
      const { writeFile, rm } = require("fs/promises");
      const markerPath = path.join(meta.dir, ".disabled");
      const willDisable = !arg.disabled; // 当前状态取反
      try {
        if (willDisable) {
          await writeFile(markerPath, "", "utf-8");
        } else {
          await rm(markerPath, { force: true });
        }
        await refreshSkillTree();
        vscode.window.showInformationMessage(`Skill「${arg.name}」已${willDisable ? "禁用" : "启用"}`);
      } catch (err) {
        vscode.window.showErrorMessage(`操作失败：${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("axon.skill.create", async (node?: unknown) => {
      // 判断在哪个组创建：如果从右键菜单触发，node 可能是 SkillGroupNode
      const choices = ["项目 Skill（当前工作区）", "全局 Skill（用户级）"];
      let choice: string | undefined;
      if (node && typeof node === "object" && "source" in node) {
        choice = (node as { source: string }).source === "workspace" ? choices[0] : choices[1];
      } else {
        choice = await vscode.window.showQuickPick(choices, { placeHolder: "创建到哪里？" });
      }
      if (!choice) return;
      const isProject = choice === choices[0];
      const name = await vscode.window.showInputBox({ prompt: "Skill 名称（英文、短横线分隔）", placeHolder: "my-skill" });
      if (!name || !name.trim()) return;
      const slugName = name.trim().toLowerCase().replace(/\s+/g, "-");
      const { globalSkillsDir, workspaceSkillsDir } = await import("@axon/core");
      const baseDir = isProject ? workspaceSkillsDir(defaultWorkspace) : globalSkillsDir(homedir());
      const path = require("path");
      const skillDir = path.join(baseDir, slugName);
      const skillFile = path.join(skillDir, "SKILL.md");
      // 创建目录和模板 SKILL.md
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(skillDir));
      const template = `---\nname: ${slugName}\ndescription: 描述这个 skill 的用途和触发场景\n---\n\n# ${slugName}\n\n在这里编写 skill 的执行步骤和方法论。\n`;
      await vscode.workspace.fs.writeFile(vscode.Uri.file(skillFile), new TextEncoder().encode(template));
      await refreshSkillTree();
      await vscode.window.showTextDocument(vscode.Uri.file(skillFile));
    }),
    vscode.commands.registerCommand("axon.skill.delete", async (node?: unknown) => {
      // 兼容两个 SKILLS 视图：CustomSkills 的目录节点 与 Skills 面板的列表项
      const { dirPath, name: rawName, source } = resolveSkillDeleteTarget(node);
      if (source === "builtin") {
        vscode.window.showInformationMessage("内置 Skill 不能删除。如需替换，可在工作区或全局创建一个同名 skill 覆盖它。");
        return;
      }
      if (!dirPath) return;
      const name = rawName || require("path").basename(dirPath);
      const confirm = await vscode.window.showWarningMessage(
        `确定删除 Skill「${name}」？整个目录（含 scripts、references 等）将被移除。此操作不可撤销。`,
        { modal: true },
        "删除",
      );
      if (confirm !== "删除") return;
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(dirPath), { recursive: true });
        await refreshSkillTree();
      } catch (err) {
        vscode.window.showErrorMessage(`删除失败：${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("axon.skill.deleteBatch", async () => {
      // 批量删除 Skill：列出所有可删除（非内置）Skill，勾选后一并删除
      const { SkillRegistry } = await import("@axon/core");
      const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
      const registry = new SkillRegistry([defaultWorkspace], createHost(), homedir());
      const skills = (await registry.discover()).filter((s) => s.source !== "builtin" && s.dir);
      if (skills.length === 0) {
        vscode.window.showInformationMessage("没有可删除的 Skill（内置 Skill 不可删除）。");
        return;
      }
      const items: DirPickItem[] = skills.map((s) => ({
        label: s.name,
        description: s.source === "workspace" ? "项目" : "全局",
        detail: s.dir,
        dir: s.dir,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: `勾选要删除的 Skill（可多选，共 ${items.length} 个）`,
      });
      if (!picked || picked.length === 0) return;
      const confirm = await vscode.window.showWarningMessage(
        `确定删除选中的 ${picked.length} 个 Skill？整个目录将被移除，此操作不可撤销。`,
        { modal: true },
        "删除",
      );
      if (confirm !== "删除") return;
      const { ok, failed } = await deleteDirs(picked.map((p) => p.dir));
      await refreshSkillTree();
      if (ok > 0) vscode.window.showInformationMessage(`已删除 ${ok} 个 Skill`);
      if (failed.length > 0) vscode.window.showErrorMessage(`${failed.length} 个删除失败：${failed.join("、")}`);
    }),
    vscode.commands.registerCommand("axon.skill.rename", async (node?: unknown) => {
      if (!node || typeof node !== "object" || !("dirPath" in node)) return;
      const dirPath = (node as { dirPath: string }).dirPath;
      const path = require("path");
      const oldName = path.basename(dirPath);
      const newName = await vscode.window.showInputBox({ prompt: "新名称", value: oldName });
      if (!newName || newName.trim() === oldName) return;
      const slugName = newName.trim().toLowerCase().replace(/\s+/g, "-");
      const newDir = path.join(path.dirname(dirPath), slugName);
      try {
        await vscode.workspace.fs.rename(vscode.Uri.file(dirPath), vscode.Uri.file(newDir));
        await refreshSkillTree();
      } catch (err) {
        vscode.window.showErrorMessage(`重命名失败：${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("axon.skill.import", async (node?: unknown) => {
      // 批量导入 Skill：支持「浏览多选目录」或「从父目录勾选」两种方式
      const choices = ["导入到项目", "导入到全局"];
      let choice: string | undefined;
      if (node && typeof node === "object" && "source" in node) {
        choice = (node as { source: string }).source === "workspace" ? choices[0] : choices[1];
      } else {
        choice = await vscode.window.showQuickPick(choices, { placeHolder: "导入到哪里？" });
      }
      if (!choice) return;
      const isProject = choice === choices[0];
      const sourceDirs = await pickImportSourceDirs("Skill", "SKILL.md");
      if (!sourceDirs) return;
      const { globalSkillsDir, workspaceSkillsDir } = await import("@axon/core");
      const baseDir = isProject ? workspaceSkillsDir(defaultWorkspace) : globalSkillsDir(homedir());
      const conflicts = await findNameConflicts(baseDir, sourceDirs);
      const strategy = await resolveOverwriteStrategy("Skill", conflicts.size);
      if (!strategy) return;
      const results = await copyDirsInto(baseDir, sourceDirs, { conflicts, strategy });
      await refreshSkillTree();
      reportImportResults("Skill", results);
    }),
  );

  // Power 树刷新辅助
  const refreshPowerTree = async () => {
    try {
      const { PowerRegistry } = await import("@axon/core");
      const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
      const registry = new PowerRegistry([defaultWorkspace], createHost(), homedir());
      const powers = await registry.discover();
      powersTree.refresh(powers.map((p) => ({
        name: p.name,
        displayName: p.displayName,
        source: p.source,
        enabled: p.enabled,
        mcpServerCount: p.mcpServerCount,
        skillCount: p.skillCount,
        dir: p.dir,
      })));
    } catch { /* 忽略 */ }
  };

  // Power CRUD 命令
  context.subscriptions.push(
    vscode.commands.registerCommand("axon.openPower", async (arg?: { name?: string; source?: string; dir?: string; enabled?: boolean }) => {
      if (!arg || !arg.name) return;
      const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
      openOrFocusPanel({
        id: `power-${arg.name}`,
        title: `Power: ${arg.name}`,
        query: `view=powers&name=${encodeURIComponent(arg.name)}&workspace=${encodeURIComponent(workspace)}`,
        extensionUri: context.extensionUri,
        router,
        icon: "media/powers.svg",
      });
    }),
    vscode.commands.registerCommand("axon.openMcp", async () => {
      const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
      openOrFocusPanel({
        id: "mcp-manager",
        title: "MCP 服务器",
        query: `view=mcp&workspace=${encodeURIComponent(workspace)}`,
        extensionUri: context.extensionUri,
        router,
        icon: "media/powers.svg",
      });
    }),
    vscode.commands.registerCommand("axon.power.create", async () => {
      const choices = ["项目 Power（当前工作区）", "全局 Power（用户级）"];
      const choice = await vscode.window.showQuickPick(choices, { placeHolder: "创建到哪里？" });
      if (!choice) return;
      const isProject = choice === choices[0];
      const name = await vscode.window.showInputBox({ prompt: "Power 名称（英文、短横线分隔）", placeHolder: "my-power" });
      if (!name || !name.trim()) return;
      const slugName = name.trim().toLowerCase().replace(/\s+/g, "-");
      // 重名校验
      const { PowerRegistry, globalPowersDir, workspacePowersDir } = await import("@axon/core");
      const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
      const registry = new PowerRegistry([defaultWorkspace], createHost(), homedir());
      const existing = await registry.discover();
      if (existing.some((p) => p.name === slugName)) {
        vscode.window.showErrorMessage(`Power「${slugName}」已存在，不能重复创建。`);
        return;
      }
      const path = require("path");
      const baseDir = isProject ? workspacePowersDir(defaultWorkspace) : globalPowersDir(homedir());
      const powerDir = path.join(baseDir, slugName);
      const powerFile = path.join(powerDir, "POWER.md");
      // 创建目录和模板 POWER.md
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(powerDir));
      const template = [
        "---",
        `name: ${slugName}`,
        `display_name: ${slugName}`,
        "description: 描述这个 Power 提供的能力",
        "keywords: [keyword1, keyword2]",
        "---",
        "",
        `# ${slugName}`,
        "",
        "## 概述",
        "",
        "在这里描述这个 Power 的用途、提供的工具和工作流。",
        "",
        "## 使用方式",
        "",
        "描述如何激活和使用此 Power。",
        "",
      ].join("\n");
      await vscode.workspace.fs.writeFile(vscode.Uri.file(powerFile), new TextEncoder().encode(template));
      await refreshPowerTree();
      await vscode.window.showTextDocument(vscode.Uri.file(powerFile));
    }),
    vscode.commands.registerCommand("axon.power.delete", async (item?: vscode.TreeItem) => {
      if (!item || !item.command?.arguments?.[0]) return;
      const arg = item.command.arguments[0] as { name: string; dir: string };
      const confirm = await vscode.window.showWarningMessage(
        `确定删除 Power「${arg.name}」？整个目录将被移除，此操作不可撤销。`,
        { modal: true },
        "删除",
      );
      if (confirm !== "删除") return;
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(arg.dir), { recursive: true });
        await refreshPowerTree();
      } catch (err) {
        vscode.window.showErrorMessage(`删除失败：${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("axon.power.toggle", async (item?: vscode.TreeItem) => {
      if (!item || !item.command?.arguments?.[0]) return;
      const arg = item.command.arguments[0] as { name: string; dir: string; enabled: boolean };
      const path = require("path");
      const markerPath = path.join(arg.dir, ".disabled");
      try {
        if (arg.enabled) {
          // 当前启用 → 禁用
          await vscode.workspace.fs.writeFile(vscode.Uri.file(markerPath), new Uint8Array());
        } else {
          // 当前禁用 → 启用
          await vscode.workspace.fs.delete(vscode.Uri.file(markerPath));
        }
        await refreshPowerTree();
      } catch (err) {
        vscode.window.showErrorMessage(`操作失败：${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("axon.power.import", async () => {
      // 批量导入 Power：支持「浏览多选目录」或「从父目录勾选」两种方式
      const choices = ["导入到项目", "导入到全局"];
      const choice = await vscode.window.showQuickPick(choices, { placeHolder: "导入到哪里？" });
      if (!choice) return;
      const isProject = choice === choices[0];
      const sourceDirs = await pickImportSourceDirs("Power", "POWER.md");
      if (!sourceDirs) return;
      const { globalPowersDir, workspacePowersDir } = await import("@axon/core");
      const baseDir = isProject ? workspacePowersDir(defaultWorkspace) : globalPowersDir(homedir());
      const conflicts = await findNameConflicts(baseDir, sourceDirs);
      const strategy = await resolveOverwriteStrategy("Power", conflicts.size);
      if (!strategy) return;
      const results = await copyDirsInto(baseDir, sourceDirs, { conflicts, strategy });
      await refreshPowerTree();
      reportImportResults("Power", results);
    }),
    vscode.commands.registerCommand("axon.power.importSkills", async (item?: vscode.TreeItem) => {
      // 向已有 Power 批量导入 Skills：支持「浏览多选目录」或「从父目录勾选」
      if (!item || !item.command?.arguments?.[0]) return;
      const arg = item.command.arguments[0] as { name: string; dir: string };
      const sourceDirs = await pickImportSourceDirs("Skill", "SKILL.md");
      if (!sourceDirs) return;
      const path = require("path");
      const skillsDir = path.join(arg.dir, "skills");
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(skillsDir));
      const conflicts = await findNameConflicts(skillsDir, sourceDirs);
      const strategy = await resolveOverwriteStrategy("Skill", conflicts.size);
      if (!strategy) return;
      const results = await copyDirsInto(skillsDir, sourceDirs, { conflicts, strategy });
      await refreshPowerTree();
      reportImportResults("Skill", results);
    }),
    vscode.commands.registerCommand("axon.power.importSteering", async (item?: vscode.TreeItem) => {
      // 向已有 Power 批量导入 Steering 文件
      if (!item || !item.command?.arguments?.[0]) return;
      const arg = item.command.arguments[0] as { name: string; dir: string };
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: "选择 Steering 文件（可多选）",
        title: `向 Power「${arg.name}」批量导入 Steering 文件（.md）`,
        filters: { "Markdown 文件": ["md"] },
      });
      if (!uris || uris.length === 0) return;
      const path = require("path");
      const steeringDir = path.join(arg.dir, "steering");
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(steeringDir));
      const results: { name: string; ok: boolean; error?: string }[] = [];
      for (const uri of uris) {
        const sourceFile = uri.fsPath;
        const fileName = path.basename(sourceFile);
        const targetFile = path.join(steeringDir, fileName);
        try {
          await vscode.workspace.fs.copy(vscode.Uri.file(sourceFile), vscode.Uri.file(targetFile), { overwrite: false });
          results.push({ name: fileName, ok: true });
        } catch (err) {
          results.push({ name: fileName, ok: false, error: (err as Error).message });
        }
      }
      await refreshPowerTree();
      const succeeded = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      if (succeeded.length > 0) {
        vscode.window.showInformationMessage(`已向 Power「${arg.name}」导入 ${succeeded.length} 个 Steering 文件`);
      }
      if (failed.length > 0) {
        vscode.window.showErrorMessage(`${failed.length} 个文件导入失败：${failed.map((r) => `${r.name}(${r.error})`).join("、")}`);
      }
    }),
  );

  // 底部状态栏 Axon 入口（点击打开右侧 AI 对话栏）
  registerAxonStatusBar(context);

  // 编辑器行号右键菜单：使用 Git 追溯注解（对标 IDEA Annotate）
  registerGitBlameAnnotation(context);

  // 内联代码补全（替代已删除的 copilot 扩展的 InlineCompletionItemProvider）
  registerInlineCompletion(context);

  // Quick Fix → "Ask Axon"：让 AI 一键修复诊断问题
  registerAskAxonCodeAction(context, provider);

  // 监听 Agent 事件：relay_updated / relay_deleted 时刷新左侧 Relay 树
  channel.onEmit(async (event: any) => {
    if (event.type === "relay_updated" || event.type === "relay_deleted") {
      try {
        const { RelayStore } = await import("@axon/core");
        const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
        const relayStore = new RelayStore(defaultWorkspace, createHost());
        const relays = await relayStore.list();
        relayTree.refresh(relays.map((r) => ({ id: r.id, title: r.title, phase: r.phase })));
      } catch { /* 忽略 */ }
    }
  });

  // 初始加载管理面板数据
  (async () => {
    try {
      // Provider 列表（解析内置目录 + providers.json，并注入 core 运行时）
      await refreshProviderTree();

      // Relay 列表
      const { RelayStore } = await import("@axon/core");
      const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
      const relayStore = new RelayStore(defaultWorkspace, createHost());
      const relays = await relayStore.list();
      relayTree.refresh(relays.map((r) => ({ id: r.id, title: r.title, phase: r.phase })));

      // Skills 列表
      const { SkillRegistry } = await import("@axon/core");
      const { createVSCodeAgentHost: createHost2 } = await import("@axon/host-vscode");
      const registry = new SkillRegistry([defaultWorkspace], createHost2(), homedir());
      const skills = await registry.discover();
      skillsTree.refresh(skills.map((s) => ({ name: s.name, source: s.source, disabled: s.disabled, skillFile: s.skillFile })));
      const { globalSkillsDir, workspaceSkillsDir } = await import("@axon/core");
      customSkillsTree.refresh(
        skills.map((s) => ({ name: s.name, source: s.source, disabled: s.disabled, skillFile: s.skillFile, dir: s.dir })),
        workspaceSkillsDir(defaultWorkspace),
        globalSkillsDir(homedir()),
      );

      // Powers 列表
      const { PowerRegistry } = await import("@axon/core");
      const { createVSCodeAgentHost: createHost3 } = await import("@axon/host-vscode");
      const powerRegistry = new PowerRegistry([defaultWorkspace], createHost3(), homedir());
      const powers = await powerRegistry.discover();
      powersTree.refresh(powers.map((p) => ({
        name: p.name,
        displayName: p.displayName,
        source: p.source,
        enabled: p.enabled,
        mcpServerCount: p.mcpServerCount,
        skillCount: p.skillCount,
        dir: p.dir,
      })));

      // MCP 列表（三来源合并：用户级 + 工作区级 + Power 内嵌）
      const { McpRegistry } = await import("@axon/core");
      const mcpRegistry = new McpRegistry([defaultWorkspace], createHost3(), homedir(), powerRegistry);
      const mcpSpecs = await mcpRegistry.resolve(true);
      mcpTree.refresh(mcpSpecs.map((s) => ({ name: s.name, source: s.source, disabled: !!s.disabled })));
    } catch (err) {
      console.warn("[axon] 管理面板初始数据加载失败（忽略）:", (err as Error).message);
    }
  })();

  // MCP 树刷新辅助（配置文件变化 / 手动刷新时调用）
  const refreshMcpTree = async () => {
    try {
      const { McpRegistry, PowerRegistry } = await import("@axon/core");
      const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
      const host = createHost();
      const pr = new PowerRegistry([defaultWorkspace], host, homedir());
      const reg = new McpRegistry([defaultWorkspace], host, homedir(), pr);
      const specs = await reg.resolve(true);
      mcpTree.refresh(specs.map((s) => ({ name: s.name, source: s.source, disabled: !!s.disabled })));
    } catch { /* 忽略 */ }
  };

  // 监听 mcp.json 文件变化（用户级 + 工作区级），自动刷新 MCP 树
  const mcpWatcher = vscode.workspace.createFileSystemWatcher("**/.axon/settings/mcp.json");
  mcpWatcher.onDidChange(refreshMcpTree);
  mcpWatcher.onDidCreate(refreshMcpTree);
  mcpWatcher.onDidDelete(refreshMcpTree);
  context.subscriptions.push(mcpWatcher);

  // 手动刷新命令（树标题栏刷新按钮用）
  context.subscriptions.push(
    vscode.commands.registerCommand("axon.mcp.refresh", refreshMcpTree),
    vscode.commands.registerCommand("axon.mcp.delete", async (item?: vscode.TreeItem) => {
      if (!item) return;
      const name = (item as any).serverName || (typeof item.label === "string" ? item.label : "");
      const source = (item as any).source || "user";
      if (!name) return;
      const confirm = await vscode.window.showWarningMessage(
        `确定删除 MCP 服务器「${name}」？`, { modal: true }, "删除",
      );
      if (confirm !== "删除") return;
      try {
        const level = source === "workspace" ? "workspace" : "user";
        const { readFile, writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const configPath = level === "workspace"
          ? join(defaultWorkspace, ".axon", "settings", "mcp.json")
          : join(homedir(), ".axon", "settings", "mcp.json");
        let config: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
        try { config = JSON.parse(await readFile(configPath, "utf-8")); } catch { /* 空 */ }
        delete config.mcpServers[name];
        await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
        await refreshMcpTree();
        vscode.window.showInformationMessage(`已删除 MCP 服务器「${name}」`);
      } catch (err) {
        vscode.window.showErrorMessage(`删除失败：${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("axon.mcp.deleteAll", async () => {
      // 批量删除：列出所有已配的 server 让用户多选要删的
      const { McpRegistry, PowerRegistry } = await import("@axon/core");
      const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
      const host = createHost();
      const pr = new PowerRegistry([defaultWorkspace], host, homedir());
      const reg = new McpRegistry([defaultWorkspace], host, homedir(), pr);
      const specs = await reg.resolve(true);
      if (specs.length === 0) { vscode.window.showInformationMessage("暂无 MCP 服务器可删除"); return; }
      const picks = await vscode.window.showQuickPick(
        specs.map((s) => ({ label: s.name, description: s.source, picked: false })),
        { placeHolder: "选择要删除的 MCP 服务器（可多选）", canPickMany: true },
      );
      if (!picks || picks.length === 0) return;
      const { readFile, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      for (const pick of picks) {
        const level = pick.description === "workspace" ? "workspace" : "user";
        const configPath = level === "workspace"
          ? join(defaultWorkspace, ".axon", "settings", "mcp.json")
          : join(homedir(), ".axon", "settings", "mcp.json");
        try {
          let config: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
          try { config = JSON.parse(await readFile(configPath, "utf-8")); } catch { /* 空 */ }
          delete config.mcpServers[pick.label];
          await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
        } catch { /* 单条失败跳过 */ }
      }
      await refreshMcpTree();
      vscode.window.showInformationMessage(`已删除 ${picks.length} 个 MCP 服务器`);
    }),
    vscode.commands.registerCommand("axon.mcp.toggle", async (item?: vscode.TreeItem) => {
      if (!item) return;
      const name = (item as any).serverName || (typeof item.label === "string" ? item.label : "");
      const source = (item as any).source || "user";
      if (!name) return;
      const level = source === "workspace" ? "workspace" : "user";
      const { readFile, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const configPath = level === "workspace"
        ? join(defaultWorkspace, ".axon", "settings", "mcp.json")
        : join(homedir(), ".axon", "settings", "mcp.json");
      try {
        let config: { mcpServers: Record<string, any> } = { mcpServers: {} };
        try { config = JSON.parse(await readFile(configPath, "utf-8")); } catch { /* 空 */ }
        const server = config.mcpServers[name];
        if (!server) { vscode.window.showWarningMessage(`未找到 MCP 服务器「${name}」`); return; }
        const wasDisabled = !!server.disabled;
        if (wasDisabled) { delete server.disabled; } else { server.disabled = true; }
        await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
        await refreshMcpTree();
        vscode.window.showInformationMessage(`MCP 服务器「${name}」已${wasDisabled ? "启用" : "禁用"}`);
      } catch (err) {
        vscode.window.showErrorMessage(`操作失败：${(err as Error).message}`);
      }
    }),
  );

  // ── Provider 树刷新 + 配置监听 + CRUD 命令 ──────────────────────────────
  // 用 function 声明以便被上面的"初始加载 IIFE"提前调用（函数声明会提升）。
  async function refreshProviderTree(): Promise<void> {
    try {
      const { ProviderRegistry, refreshProviders } = await import("@axon/core");
      const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
      const registry = new ProviderRegistry([defaultWorkspace], createHost(), homedir());
      const resolved = await refreshProviders(registry);
      providerTree.refresh(resolved.map((p) => ({
        name: p.name, label: p.label, builtin: p.builtin, locked: p.locked,
        configured: p.configured, modelCount: p.models.length,
      })));
    } catch (err) {
      console.warn("[axon] provider 树刷新失败:", (err as Error).message);
    }
  }

  // 用户级 providers.json 路径助手（树发起的增删改默认写用户级，工作区级由 Studio 管理）
  const userProvidersJson = () => join(homedir(), ".axon", "settings", "providers.json");
  const readProvidersJson = async (): Promise<{ providers: Record<string, unknown>; builtinApiKeys: Record<string, string> }> => {
    const { readFile } = await import("node:fs/promises");
    try {
      const p = JSON.parse(await readFile(userProvidersJson(), "utf-8"));
      return { providers: p.providers || {}, builtinApiKeys: p.builtinApiKeys || {} };
    } catch { return { providers: {}, builtinApiKeys: {} }; }
  };
  const writeProvidersJson = async (cfg: { providers: Record<string, unknown>; builtinApiKeys: Record<string, string> }): Promise<void> => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(userProvidersJson()), { recursive: true });
    await writeFile(userProvidersJson(), JSON.stringify(cfg, null, 2), "utf-8");
  };

  const providersWatcher = vscode.workspace.createFileSystemWatcher("**/.axon/settings/providers.json");
  providersWatcher.onDidChange(refreshProviderTree);
  providersWatcher.onDidCreate(refreshProviderTree);
  providersWatcher.onDidDelete(refreshProviderTree);
  context.subscriptions.push(providersWatcher);

  context.subscriptions.push(
    vscode.commands.registerCommand("axon.openProvider", async () => {
      const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
      openOrFocusPanel({
        id: "provider-manager",
        title: "Provider 配置",
        query: `view=providers&workspace=${encodeURIComponent(workspace)}`,
        extensionUri: context.extensionUri,
        router,
        icon: "media/powers.svg",
      });
    }),
    vscode.commands.registerCommand("axon.provider.refresh", refreshProviderTree),
    vscode.commands.registerCommand("axon.provider.setKey", async (item?: vscode.TreeItem) => {
      const info = (item as any)?.info as { name?: string; label?: string } | undefined;
      if (!info?.name) return;
      const apiKey = await vscode.window.showInputBox({
        prompt: `设置「${info.label || info.name}」的 API Key`,
        password: true,
        placeHolder: "留空则清除已保存的 Key",
        ignoreFocusOut: true,
      });
      if (apiKey === undefined) return; // 用户取消
      try {
        const cfg = await readProvidersJson();
        if (apiKey.trim()) cfg.builtinApiKeys[info.name] = apiKey.trim();
        else delete cfg.builtinApiKeys[info.name];
        await writeProvidersJson(cfg);
        await refreshProviderTree();
        vscode.window.showInformationMessage(`已更新「${info.label || info.name}」的 API Key`);
      } catch (err) {
        vscode.window.showErrorMessage(`保存失败：${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("axon.provider.delete", async (item?: vscode.TreeItem) => {
      const info = (item as any)?.info as { name?: string; label?: string; builtin?: boolean } | undefined;
      if (!info?.name || info.builtin) return;
      const confirm = await vscode.window.showWarningMessage(
        `确定删除自定义 provider「${info.label || info.name}」？`, { modal: true }, "删除",
      );
      if (confirm !== "删除") return;
      try {
        const cfg = await readProvidersJson();
        delete cfg.providers[info.name];
        await writeProvidersJson(cfg);
        await refreshProviderTree();
        vscode.window.showInformationMessage(`已删除 provider「${info.label || info.name}」`);
      } catch (err) {
        vscode.window.showErrorMessage(`删除失败：${(err as Error).message}`);
      }
    }),
  );

  console.log("[axon] 扩展已激活（进程内 Agent 内核）");
}

export function deactivate(): void {
  /* 资源由 context.subscriptions 自动释放 */
}
