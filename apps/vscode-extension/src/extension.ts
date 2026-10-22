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
import { join, basename } from "node:path";
import { SessionHub, type ControlCommand, type WorkspaceGroup, type CompactionUserConfig, type CreditBudgetUserConfig, webSearch, webFetch, setBuiltinPowersDir } from "@axon/core";
import { DEFAULT_COMPACTION_CONFIG, DEFAULT_CREDIT_BUDGET_CONFIG, DEFAULT_TRACE_CONFIG, type TraceConfig } from "@axon/core";
import { createVSCodeAgentHost, VSCodeCommandTrustStore } from "@axon/host-vscode";
import { JsonFileStorage, createNodeMcpCapability } from "@axon/host-node";
import { loadProviderEnv } from "./loadEnv.js";
import { VSCodeChannel } from "./vscodeChannel.js";
import { AxonViewProvider } from "./viewProvider.js";
import { RequestRouter, vscodeBrowse } from "./requestRouter.js";
import { registerTreeViews } from "./treeViews.js";
import { registerAxonStatusBar, registerAxonUsageStatusBar } from "./statusBar.js";
import { openOrFocusPanel, postToPanel } from "./panelManager.js";
import { registerGitBlameAnnotation } from "./gitBlameAnnotation.js";
import { registerInlineCompletion } from "./inlineCompletion.js";
import { registerAskAxonCodeAction } from "./codeActionProvider.js";
import { showDiagLog } from "./webviewWatchdog.js";

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
 * 读取 VS Code 设置中的滚动压缩配置（axon.compaction.*）。
 * 读取时机：会话创建时（注入初始值）+ 设置变更时（热更新）。
 */
function readCompactionConfig(): CompactionUserConfig {
  const cfg = vscode.workspace.getConfiguration("axon.compaction");
  return {
    enabled: cfg.get<boolean>("enabled", DEFAULT_COMPACTION_CONFIG.enabled),
    triggerTokens: cfg.get<number>("triggerTokens", DEFAULT_COMPACTION_CONFIG.triggerTokens),
    keepRecentMessages: cfg.get<number>("keepRecentMessages", DEFAULT_COMPACTION_CONFIG.keepRecentMessages),
    toolResultPruneChars: cfg.get<number>("toolResultPruneChars", DEFAULT_COMPACTION_CONFIG.toolResultPruneChars),
    toolResultKeepTurns: cfg.get<number>("toolResultKeepTurns", DEFAULT_COMPACTION_CONFIG.toolResultKeepTurns),
  };
}

/**
 * 读取 VS Code 设置中的 Credits 预算门配置（axon.creditBudget.*）。
 * 读取时机：会话创建时（注入初始值）+ 设置变更时（热更新）。
 */
function readCreditBudgetConfig(): CreditBudgetUserConfig {
  const cfg = vscode.workspace.getConfiguration("axon.creditBudget");
  return {
    enabled: cfg.get<boolean>("enabled", DEFAULT_CREDIT_BUDGET_CONFIG.enabled),
    warnAt: cfg.get<number>("warnAt", DEFAULT_CREDIT_BUDGET_CONFIG.warnAt),
    pauseAt: cfg.get<number>("pauseAt", DEFAULT_CREDIT_BUDGET_CONFIG.pauseAt),
  };
}

/**
 * 读取 VS Code 设置中的 trace 记录配置（axon.trace.*）。
 * 读取时机：会话创建时（注入初始值）+ 设置变更时（热更新）。
 *
 * 关于「开关 + 等级」：这里合并成一个四档枚举（off / summary / normal / full），off 即关闭。
 * 不拆成 enabled + level 两个设置 —— 那样会出现 "enabled=true 且 level=off" 这种
 * 说不清以谁为准的组合，而一个下拉本身就同时充当了开关。
 */
function readTraceConfig(): Partial<TraceConfig> {
  const cfg = vscode.workspace.getConfiguration("axon.trace");
  return {
    level: cfg.get<TraceConfig["level"]>("level", DEFAULT_TRACE_CONFIG.level),
    maxFileMB: cfg.get<number>("maxFileMB", DEFAULT_TRACE_CONFIG.maxFileMB),
    keepRecentFiles: cfg.get<number>("keepRecentFiles", DEFAULT_TRACE_CONFIG.keepRecentFiles),
  };
}

/**
 * 读取 VS Code 设置中的 Wiki 生成配置（axon.wiki.*）。
 *
 * ── 为什么放设置里、而不是 .axon/ 下 ──
 * `.axon/wiki/` 是要【随 git 提交、团队共享】的 —— 那是 wiki 的核心价值。
 * 而「用哪个 provider / 模型」是机器本地偏好：同事未必配了同一个 provider、未必有同名模型，
 * 写进共享物只会让 clone 下来的人看到一堆用不了的模型名。
 * 这与「mtime 快照不进 md、放被 gitignore 的 .state.json」是同一条判据：
 * **机器本地事实不进共享物**。
 *
 * ── 为什么它需要独立于会话的模型选择 ──
 * 侧栏按钮不属于任何对话面板，没有天然的「当前会话模型」；而它是本项目里最贵的单个操作
 * （多页 × 每页多轮工具调用）。最贵的操作，配置不该靠猜。
 */
function readWikiConfig(): { provider: string; model: string; maxPages: number } {
  const cfg = vscode.workspace.getConfiguration("axon.wiki");
  return {
    provider: cfg.get<string>("provider", "") || "",
    model: cfg.get<string>("model", "") || "",
    maxPages: cfg.get<number>("maxPages", 15),
  };
}

/**
 * 一句话描述本次生成将使用哪个模型（供选择框展示）。
 *
 * 必须让用户在选择目标工作区时就看到它：这是本功能最贵的一次操作，
 * 「花了大钱」这件事不该只在事后才发现。留空时如实写明是跟随会话，而不是假装已配置。
 */
function describeWikiModel(): string {
  const { provider, model } = readWikiConfig();
  if (!model) return "模型：跟随当前会话";
  return provider ? `模型：${provider} / ${model}` : `模型：${model}`;
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

  // 内置 Power 根目录：随扩展分发的只读目录（media/powers，构建时从源码拷入）。
  // 只在这里注入一次，core 用模块级存储接住（与 Provider 的启动期注入同一套路）。
  // 内置 Power 的启用状态不写这个目录——它只读、且升级覆盖后会丢；启用状态写用户级配置。
  setBuiltinPowersDir(vscode.Uri.joinPath(context.extensionUri, "media", "powers").fsPath);

  const storage = new JsonFileStorage();
  const channel = new VSCodeChannel();

  // 默认工作区：取第一个工作区文件夹，没有则用用户主目录
  const defaultWorkspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || homedir();
  // 所有工作区文件夹（多根工作区场景）
  const allWorkspaces = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) || [defaultWorkspace];

  /**
   * 列出所有 relay。
   *
   * Agent 创建 relay 时写入的是【会话工作区】的 .axon/relays/（见 AgentSession.relayStore），
   * 主目录 .axon/relays/ 下则可能有历史遗留产物。两个位置都作为根交给 RelayStore 合并读取，
   * 避免只认一个根导致左侧面板看不到 AI 刚创建的 relay。
   */
  async function listAllRelays(): Promise<Array<{ id: string; title: string; phase: string }>> {
    const { RelayStore } = await import("@axon/core");
    const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
    const store = new RelayStore([...allWorkspaces, homedir()], createHost());
    const relays = await store.list();
    return relays.map((r) => ({ id: r.id, title: r.title, phase: r.phase }));
  }

  /**
   * 刷新 Wiki 侧边栏：读页面列表 + 陈旧状态，并把「待复核页数」挂到视图徽标上。
   *
   * 徽标是这套设计的关键一环——页面一多，人不会主动翻列表去找 ⚠️；
   * 「有 N 页可能过时」必须有个常驻可见的位置提示，才有动力去刷新。
   *
   * 整个流程不调用 LLM（只读文件 + 比对 mtime），所以可以随便触发：启动时、文件变动时、
   * 手动刷新时都走它。真正花钱的是「重新生成页面」，那一步必须用户显式触发。
   *
   * 根取全部工作区：wiki 是 per-repo 的，多根场景下各自都可能有。
   */
  /** 选择框项：携带工作区绝对路径，选中后直接可用 */
  interface WikiTargetPick extends vscode.QuickPickItem {
    ws: string;
  }

  /**
   * 让用户显式选择「生成 Wiki 的目标工作区」。
   *
   * ── 为什么必须让用户选，而不是自动推定 ──
   * 早先按「活动编辑器所属工作区 → 主工作区」自动推定，实测立刻出问题：用户点了生成，
   * 提示「将生成到 d:\me\work-prds」—— 而他从未选择过这个工作区，只因恰好有个文件
   * 开在编辑器里。推定把「碰巧在看什么」当成了「想做什么」。
   *
   * 写操作的代价不可逆：往不相干的仓库写进一堆文件，而且它们会被提交。必须让用户拍板。
   * 这与 promptBuilder 里的【工作区聚焦】是两回事 —— 那个是软提示，用于搜索/读取这类
   * 可逆操作，猜错只是多翻几个文件；读可以猜，写不能猜。
   *
   * 单工作区时跳过选择：没有第二种可能，弹一个只有一个选项的框只是徒增点击。
   */
  async function pickWikiTargetWorkspace(): Promise<string | undefined> {
    if (allWorkspaces.length === 1) return allWorkspaces[0];

    const { WikiStore } = await import("@axon/core");
    const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
    const store = new WikiStore(allWorkspaces, createHost());

    // 带上「已有多少页 / 是否有未完成作业」：选工作区时这正是判断依据，用户不必先去列表里翻。
    // 探测失败不阻塞选择本身 —— 选择框的价值在于让用户拍板，不在于这些附加信息。
    const pages = await store.summary().catch(() => []);
    const countByWs = new Map<string, number>();
    for (const p of pages) countByWs.set(p.workspace, (countByWs.get(p.workspace) ?? 0) + 1);

    const items: WikiTargetPick[] = [];
    for (const ws of allWorkspaces) {
      const count = countByWs.get(ws) ?? 0;
      let resume = false;
      try {
        resume = (await store.getResumableJob(ws)) !== null;
      } catch { /* 单根探测失败不该阻塞整体选择 */ }
      const bits = [count > 0 ? `已有 ${count} 页` : "尚未生成"];
      if (resume) bits.push("有未完成的生成，选中即续跑");
      items.push({ label: basename(ws), description: ws, detail: bits.join(" ｜ "), ws });
    }

    const picked = await vscode.window.showQuickPick(items, {
      // 模型信息放标题而非每一行的 detail：17 个工作区重复同一句毫无意义，
      // 但它又必须显眼 —— 这是本功能最贵的一次操作，用户点确定前要知道用哪个模型。
      title: `选择生成 Wiki 的工作区  ｜  ${describeWikiModel()}`,
      placeHolder: "Wiki 是仓库级资产，一次只针对一个工作区生成",
      ignoreFocusOut: true,
    });
    return picked?.ws;
  }

  // ── Wiki 生成期的共享状态 ──────────────────────────────────────────────
  // 声明在两处使用点（生成命令、wiki_generation 事件处理）之前，
  // 避免出现「用了后面才声明的变量」这种要往前翻才读得懂的顺序。

  /**
   * Wiki 生成的进度落点 —— 自建的状态栏项：生成期间显示当前阶段，点击即取消。
   *
   * ── 为什么不用 withProgress 的进度通知 ──
   * VS Code 的进度通知不渲染关闭按钮（notificationsViewer 里只有非进度通知才加 close 动作），
   * 于是它一旦出现就一直在屏幕上，长任务期间用户唯一能让它消失的办法是点「取消」——
   * 而那会把整个生成停掉。等于逼人在「忍受遮挡」和「中止任务」之间二选一。
   *
   * ── 为什么也不走 ProgressLocation.Window ──
   * 公开 API 的 ProgressOptions 不含 command 字段（只有 workbench 内部的
   * IProgressWindowOptions 才有），扩展侧传不进去，于是它只会退化成一条静默通知，
   * 进度依旧藏着。自建状态栏项则 text 与 command 都能控制。
   */
  const wikiStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  wikiStatusItem.command = "axon.wiki.cancel";
  wikiStatusItem.tooltip = "点击取消本次 Wiki 生成";
  context.subscriptions.push(wikiStatusItem);

  /** 本次生成的目标工作区目录名（状态栏与面板提示都靠它标注归属） */
  let wikiTargetName = "";

  /**
   * 给结果通知补上「是哪个应用」。
   *
   * 长任务结束时用户多半已经切走、没盯着看，「生成完成，共 14 页」缺了主语就无从判断
   * 是哪个仓库的 —— 而这个面板管着所有工作区。过程期间不再需要它：那些进度已经直接
   * 挂在对应的应用节点上了（见 WikiTreeProvider.setGenerating）。
   */
  const wikiMsg = (text: string): string => (wikiTargetName ? `${wikiTargetName}：${text}` : text);

  /** 更新状态栏上的生成进度（固定带 spinner，一眼看出还在跑） */
  const setWikiProgress = (message: string): void => {
    const who = wikiTargetName ? `${wikiTargetName}：` : "";
    wikiStatusItem.text = `$(loading~spin) 生成 Wiki：${who}${message}`;
  };

  /**
   * 生成中标志，挡住重复点击。
   *
   * 根因层的守卫在 core（AgentSession.generateWiki）—— 那里才真正防住「两个并发生成互相破坏」。
   * 这里再挡一层是为了立刻给出可见提示：否则用户只会看到一个通知闪一下又消失，不知道发生了什么。
   */
  let wikiGenerating = false;

  async function refreshWikiTree(): Promise<number> {
    const { WikiStore } = await import("@axon/core");
    const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
    const store = new WikiStore(allWorkspaces, createHost());
    const pages = await store.summary();
    const staleCount = wikiTree.refresh(pages);
    wikiView.badge = staleCount > 0
      ? { value: staleCount, tooltip: `${staleCount} 个 Wiki 页面可能已过时` }
      : undefined;
    // 这里不再显示项目名：应用已经是树的最上层分组（见 treeViews 的 buildWikiTree），
    // 标题旁再写一遍只是重复。
    // 顺带刷新控制台的入口描述与任务列表：页数会变、作业状态会变（生成完 / 中断 / 失败）。
    // 两处数据同源（同一份 .state.json），分开取会读到不同快照，出现「入口说 13 页、
    // 列表里 14 个文件」这种对不上的情况。
    const jobs = await store.listJobs().catch(() => []);
    wikiTasksTree.refresh(jobs);
    return staleCount;
  }

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
    // 滚动压缩配置：读取 VS Code 设置（axon.compaction.*），默认关闭
    getCompactionConfig: () => readCompactionConfig(),
    // Credits 预算门配置：读取 VS Code 设置（axon.creditBudget.*），默认启用
    getCreditBudgetConfig: () => readCreditBudgetConfig(),
    // trace 记录配置：读取 VS Code 设置（axon.trace.*），默认 normal
    getTraceConfig: () => readTraceConfig(),
  });

  // REST 请求路由（webview 形态下替代 Express）
  const router = new RequestRouter({
    storage,
    secrets: context.secrets,
    isValidDir,
    browse: vscodeBrowse,
    defaultWorkspace,
  });

  let usageStatusBar: ReturnType<typeof registerAxonUsageStatusBar> | undefined;
  const provider = new AxonViewProvider(
    context,
    channel,
    async (cmd: ControlCommand) => {
      try {
        if (cmd.type === "set_active_provider") {
          await usageStatusBar?.setActiveProvider(cmd.provider);
          return;
        }
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
      if (e.affectsConfiguration("axon.compaction")) {
        hub.reloadCompactionConfig();
      }
      if (e.affectsConfiguration("axon.creditBudget")) {
        hub.reloadCreditBudgetConfig();
      }
      if (e.affectsConfiguration("axon.trace")) {
        hub.reloadTraceConfig();
      }
    })
  );

  // ── 编辑器选区一键操作 helper ───────────────────────────────────────────
  const quickAction = async (
      action: string,
      payload: { text?: string; fileName?: string; startLine?: number; startColumn?: number; endLine?: number; endColumn?: number } | undefined,
      axProvider: AxonViewProvider,
    ) => {
      const text = payload?.text?.trim();
      if (!text) {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
          vscode.window.showWarningMessage("请先在编辑器中选中一段代码");
          return;
        }
        const sel = editor.selection;
        const t = editor.document.getText(sel);
        if (!t.trim()) return;
        const name = require("path").basename(editor.document.fileName);
        await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
        await vscode.commands.executeCommand("axon.chat.focus");
        axProvider.postToWebview({
          type: "add_context",
          source: "editor",
          label: `${name} ${sel.start.line + 1}:${sel.start.character + 1}-${sel.end.line + 1}:${sel.end.character + 1}`,
          text: t,
          quickAction: action,
        });
        return;
      }
      const name = payload?.fileName || "选区";
      const sl = payload?.startLine ?? 0;
      const sc = payload?.startColumn ?? 0;
      const el = payload?.endLine ?? sl;
      const ec = payload?.endColumn ?? sc;
      await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
      await vscode.commands.executeCommand("axon.chat.focus");
      axProvider.postToWebview({
        type: "add_context",
        source: "editor",
        label: `${name} ${sl}:${sc}-${el}:${ec}`,
        text,
        quickAction: action,
      });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("axon.newSession", () => provider.postToWebview({ type: "command:new_session" })),
    vscode.commands.registerCommand("axon.chatMode", () => provider.postToWebview({ type: "set_mode", mode: "quest" })),
    vscode.commands.registerCommand("axon.codeMode", () => provider.postToWebview({ type: "set_mode", mode: "agent" })),
    vscode.commands.registerCommand("axon.coworkMode", () => provider.postToWebview({ type: "set_mode", mode: "cowork" })),
    // 打开诊断输出面板：界面卡灰后可在此查看记录（含卡死时刻与当时的操作）
    vscode.commands.registerCommand("axon.showDiagnostics", () => showDiagLog()),
    // 预览浮层的「在编辑器中打开」：overlay 在 workbench 侧，不直接碰文件系统，
    // 回调到这里用扩展已有的打开逻辑（路径解析 / 二进制判定都在扩展这边）
    vscode.commands.registerCommand("axon.openFileFromPreview", async (filePath?: string) => {
      if (!filePath) return;
      try {
        await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: true });
      } catch {
        // 二进制等无法以文本打开的文件：交给系统默认程序
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(filePath));
      }
    }),
    // Cowork 改动对比浮层的「恢复原稿」：overlay 在 workbench 侧不碰文件系统，
    // 回到这里用快照覆盖现文件（viewProvider 内部会再开预览确认 + 通知 webview）
    vscode.commands.registerCommand("axon.restoreCoworkSnapshot", async (filePath?: string, snapshotDir?: string) => {
      if (!filePath || !snapshotDir) return;
      await provider.restoreCoworkSnapshotFromOverlay(filePath, snapshotDir);
    }),
    vscode.commands.registerCommand("axon.focusChat", () => {
      // 先确保辅助侧栏可见，再聚焦 Axon chat view
      vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
      vscode.commands.executeCommand("axon.chat.focus");
    }),
    vscode.commands.registerCommand("axon.addResourceToChat", async (uri?: vscode.Uri) => {
      if (!uri) return;
      await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
      await vscode.commands.executeCommand("axon.chat.focus");
      await provider.addResourceContextFromCommand(uri);
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
    // ── 编辑器选区一键操作：解释 / 找 bug / 写测试 / 重构 ──────────────────
    vscode.commands.registerCommand("axon.quickExplain", async (payload?: { text?: string; fileName?: string; startLine?: number; startColumn?: number; endLine?: number; endColumn?: number }) => {
      await quickAction("explain", payload, provider);
    }),
    vscode.commands.registerCommand("axon.quickFindBug", async (payload?: { text?: string; fileName?: string; startLine?: number; startColumn?: number; endLine?: number; endColumn?: number }) => {
      await quickAction("findBug", payload, provider);
    }),
    vscode.commands.registerCommand("axon.quickTest", async (payload?: { text?: string; fileName?: string; startLine?: number; startColumn?: number; endLine?: number; endColumn?: number }) => {
      await quickAction("test", payload, provider);
    }),
    vscode.commands.registerCommand("axon.quickRefactor", async (payload?: { text?: string; fileName?: string; startLine?: number; startColumn?: number; endLine?: number; endColumn?: number }) => {
      await quickAction("refactor", payload, provider);
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
        const relays = await listAllRelays();
        relayTree.refresh(relays);
      } catch (err) {
        vscode.window.showErrorMessage(`删除失败：${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("axon.relay.refresh", async () => {
      try {
        const relays = await listAllRelays();
        relayTree.refresh(relays);
      } catch { /* ignore */ }
    }),
    vscode.commands.registerCommand("axon.wiki.generate", async () => {
      // 目标工作区由用户显式选择，不做任何推定（推定会把「碰巧在看什么」当成「想做什么」）。
      const target = await pickWikiTargetWorkspace();
      if (!target) return; // 用户取消
      // 挡重复点击：并发生成会互相破坏。根因层的守卫在 core（AgentSession.generateWiki），
      // 这里再挡一层是为了立刻给出可见提示 —— 否则用户只会看到一个通知闪一下又消失。
      if (wikiGenerating) {
        void vscode.window.showInformationMessage("已有 Wiki 生成在进行中，请等它结束或先取消。");
        return;
      }
      wikiGenerating = true;
      const { provider, model, maxPages } = readWikiConfig();
      // 生成是长任务（十几页 × 每页多次工具调用，可能跑几分钟）。
      //
      // 进度放在【状态栏】而不是弹窗通知里：进度通知没有关闭按钮（见 wikiStatusItem 的说明），
      // 长任务期间它一直占着屏幕，用户只能靠点「取消」让它消失 —— 而取消会中止整个生成。
      // 状态栏项既不挡视线，也不需要用户去关。
      //
      // 取消有两个入口，都与进度同处可见：
      //   ① 点状态栏那条进度（它带了 command）
      //   ② Wiki 面板标题栏的「取消」（仅生成期间出现，见 package.json 的 view/title）
      wikiTargetName = basename(target);
      setWikiProgress("正在勘察仓库、规划页面…");
      wikiStatusItem.show();
      // 让标题栏的「取消」按钮出现
      void vscode.commands.executeCommand("setContext", "axon.wikiGenerating", true);
      try {
        await hub.dispatch({ type: "wiki_generate", workspace: target, provider, model, maxPages } as any);
      } catch (err) {
        vscode.window.showErrorMessage(`生成 Wiki 失败：${(err as Error).message}`);
      } finally {
        // 无论成功/失败/取消都要收干净：残留的状态栏项会一直挂在状态栏上，
        // 应用节点上的 spinner 也会一直转下去 —— 那比不显示更糟，看上去像卡死了
        wikiTree.setGenerating(null);
        wikiStatusItem.hide();
        wikiTargetName = "";
        wikiGenerating = false;
        void vscode.commands.executeCommand("setContext", "axon.wikiGenerating", false);
      }
    }),
    vscode.commands.registerCommand("axon.wiki.cancel", async () => {
      // 取消 = 走会话取消：驱动层在每页之间检查中断信号，把作业记为 interrupted（可续跑）。
      // 已生成的页面全部保留，下次点击接着写剩下的，不必从头再来。
      if (!wikiGenerating) {
        void vscode.window.showInformationMessage("当前没有正在进行的 Wiki 生成。");
        return;
      }
      await hub.dispatch({ type: "cancel" } as any);
    }),
    vscode.commands.registerCommand("axon.wiki.pickModel", async () => {
      // 选 provider + 模型，写入设置（用户级）。
      // 单独做成命令、而不是每次生成前都问一遍：模型是低频且稳定的偏好，
      // 不该在每次生成时都打断用户一次。
      const { getResolvedProviders } = await import("@axon/core");
      const cur = readWikiConfig();

      /** 选择项携带 provider/model，选中后直接写设置 */
      type ModelPick = vscode.QuickPickItem & { provider?: string; model?: string };
      const items: ModelPick[] = [
        {
          label: "$(sync) 跟随当前会话模型",
          description: cur.model ? "" : "（当前）",
          detail: "Wiki 跑得少但要读懂代码，沿用你在对话里已选定的模型最稳妥。",
          provider: "",
          model: "",
        },
      ];
      for (const p of getResolvedProviders()) {
        if (!p.configured) continue; // 没配 key 的 provider 列出来只会让人白点一次
        for (const m of p.models) {
          if (m.disabled) continue;
          const isCur = cur.provider === p.name && cur.model === m.id;
          items.push({
            label: m.id,
            description: `${p.label || p.name}${isCur ? "  ← 当前" : ""}`,
            provider: p.name,
            model: m.id,
          });
        }
      }

      const picked = await vscode.window.showQuickPick(items, {
        title: "选择生成 Wiki 使用的模型",
        placeHolder: "只影响 Wiki 生成，不影响对话",
        ignoreFocusOut: true,
      });
      if (!picked) return;

      // 写用户级：这是机器本地偏好，不该跟着某个项目走
      const cfg = vscode.workspace.getConfiguration("axon.wiki");
      await cfg.update("provider", picked.provider ?? "", vscode.ConfigurationTarget.Global);
      await cfg.update("model", picked.model ?? "", vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        picked.model ? `Wiki 生成将使用 ${picked.provider} / ${picked.model}` : "Wiki 生成将跟随当前会话模型",
      );
    }),
    vscode.commands.registerCommand("axon.wiki.showResults", async () => {
      // 跳转到「生成结果」视图。优先聚焦该视图本体；个别版本不认 <viewId>.focus 时
      // 退回聚焦整个 Wiki 容器 —— 两条路都能让用户看到结果，比只留一条然后静默失败好。
      try {
        await vscode.commands.executeCommand("axon.wiki.pages.focus");
      } catch {
        await vscode.commands.executeCommand("workbench.view.extension.axon-wiki");
      }
      // 顺便刷新：用户点进来通常是想看最新的，而不是上次渲染时的快照
      await refreshWikiTree().catch(() => { /* 刷新失败不影响跳转本身 */ });
    }),
    vscode.commands.registerCommand("axon.wiki.deletePage", async (item?: vscode.TreeItem) => {
      const target = item as unknown as { wikiSlug?: string; wikiWorkspace?: string } | undefined;
      const slug = target?.wikiSlug;
      if (!slug) return;
      const label = typeof item?.label === "string" ? item.label : slug;
      // 明确写出「会删文件」以及「可从 git 恢复」：前者防止误以为只从列表移除，
      // 后者给出退路，免得用户以为一删就没救了而不敢动手。
      const confirm = await vscode.window.showWarningMessage(
        `确定删除 Wiki 页面「${label}」？\n\n` +
        `会从 ${basename(target?.wikiWorkspace || "")}/.axon/wiki/ 中移除该文件。\n` +
        `若该文件已提交到 git，可以从中恢复。`,
        { modal: true },
        "删除",
      );
      if (confirm !== "删除") return;
      try {
        const { WikiStore } = await import("@axon/core");
        const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
        const store = new WikiStore(allWorkspaces, createHost());
        if (await store.remove(slug)) {
          vscode.window.showInformationMessage(`已删除页面「${label}」`);
        } else {
          vscode.window.showWarningMessage(`未找到页面「${label}」，可能已被删除。`);
        }
        await refreshWikiTree().catch(() => { /* 树刷新失败不影响删除结果 */ });
      } catch (err) {
        vscode.window.showErrorMessage(`删除页面失败：${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("axon.wiki.deleteJob", async (item?: vscode.TreeItem) => {
      const jobId = (item as unknown as { wikiJobId?: string } | undefined)?.wikiJobId;
      if (!jobId) return;
      // 两个后果都必须先说清：① 不动页面（免得用户以为会连页面一起删）；
      // ② 中断的作业删掉就不能续跑了（那正是它存在的意义），这是真正不可逆的部分。
      const confirm = await vscode.window.showWarningMessage(
        `确定删除这条生成记录？（${jobId}）\n\n` +
        `只删记录，不会删除已生成的页面。\n` +
        `若这条是「已中断」的作业，删除后就不能再续跑了。`,
        { modal: true },
        "删除",
      );
      if (confirm !== "删除") return;
      try {
        const { WikiStore } = await import("@axon/core");
        const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
        const store = new WikiStore(allWorkspaces, createHost());
        if (await store.removeJob(jobId)) {
          vscode.window.showInformationMessage("已删除该记录");
        } else {
          vscode.window.showWarningMessage("未找到该记录，可能已被清理。");
        }
        await refreshWikiTree().catch(() => { /* 树刷新失败不影响删除结果 */ });
      } catch (err) {
        vscode.window.showErrorMessage(`删除记录失败：${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("axon.wiki.deleteWorkspace", async (item?: vscode.TreeItem) => {
      const ws = (item as unknown as { wikiWorkspace?: string } | undefined)?.wikiWorkspace;
      if (!ws) return;
      const name = basename(ws);
      try {
        const { WikiStore } = await import("@axon/core");
        const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
        const store = new WikiStore(allWorkspaces, createHost());
        // 先数清页数再确认：用户得知道这一下删掉的是多大一块，
        // 只说「确定删除吗」等于让人蒙着眼睛按按钮
        const pages = (await store.summary()).filter((p) => p.workspace === ws);
        if (pages.length === 0) {
          void vscode.window.showInformationMessage(`「${name}」下没有 Wiki 页面。`);
          return;
        }
        // 这是破坏面最大的一个删除（一次清掉整个应用的 Wiki），所以确认框给全三件事：
        // 删几个、删在哪里、还能不能救回来。第三条尤其不能省 ——
        // 没有退路时人会不敢动手，有退路（git）时才敢正常使用这个功能。
        const confirm = await vscode.window.showWarningMessage(
          `确定删除应用「${name}」的全部 ${pages.length} 个 Wiki 页面？\n\n` +
          `会移除 ${name}/.axon/wiki/ 下的 ${pages.length} 个文件，并清除该应用的生成记录（含可续跑状态）。\n` +
          `此操作在 Axon 内无法撤销；若这些文件已提交到 git，可以从 git 恢复。`,
          { modal: true },
          "删除",
        );
        if (confirm !== "删除") return;
        const removed = await store.removeWorkspace(ws);
        vscode.window.showInformationMessage(`已删除「${name}」的 ${removed} 个 Wiki 页面`);
        await refreshWikiTree().catch(() => { /* 树刷新失败不影响删除结果 */ });
      } catch (err) {
        vscode.window.showErrorMessage(`删除失败：${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("axon.wiki.refresh", async () => {
      try {
        await refreshWikiTree();
      } catch (err) {
        vscode.window.showErrorMessage(`刷新 Wiki 列表失败：${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("axon.wiki.openPage", async (pagePath?: string) => {
      if (!pagePath) return;
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(pagePath));
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (err) {
        vscode.window.showErrorMessage(`打开 Wiki 页面失败：${(err as Error).message}`);
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

  // 左侧管理面板 TreeView（Relay / Wiki / Skills / Powers / Provider）
  const { relayTree, wikiTasksTree, wikiTree, wikiView, skillsTree, providerTree, powersTree, customSkillsTree, mcpTree } = registerTreeViews(context);

  // Skill 树刷新辅助
  const refreshSkillTree = async () => {
    try {
      const { SkillRegistry, PowerRegistry, globalSkillsDir, workspaceSkillsDir } = await import("@axon/core");
      const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
      const host = createHost();
      const powers = new PowerRegistry([defaultWorkspace], host, homedir());
      // 注入 Power 捆绑的 skills：否则会出现「AI 能 use_skill 加载、用户在面板里却看不到」
      const registry = new SkillRegistry([defaultWorkspace], host, homedir(), () => powers.getActiveSkillDirs());
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
      const { SkillRegistry, PowerRegistry, isBuiltinPowerBundledSkill } = await import("@axon/core");
      const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
      const host = createHost();
      const powers = new PowerRegistry([defaultWorkspace], host, homedir());
      const registry = new SkillRegistry([defaultWorkspace], host, homedir(), () => powers.getActiveSkillDirs());
      const metas = await registry.discover();
      const meta = metas.find((m) => m.name === arg.name);
      if (!meta) return;
      // 内置 Power 捆绑的 skill 在只读产物目录里：禁不掉（写不进 .disabled），升级还会覆盖。
      // 要关闭只能整包禁用，要定制只能放同名 skill 覆盖——给出可操作的指引，而不是让它撞写文件错误。
      if (isBuiltinPowerBundledSkill(meta.source, meta.dir)) {
        vscode.window.showInformationMessage(
          "该 Skill 来自内置 Power 捆绑（只读目录），不能单独禁用。如需关闭，请在 Powers 面板禁用整个能力包；如需覆盖，可在工作区或全局创建一个同名 skill。",
        );
        return;
      }
      // 按后端当前状态取反，而不是用树条目的陈旧快照——否则连点两次会来回抵消
      const willDisable = !meta.disabled;
      try {
        // 交给 registry.setEnabled 分流：内置方法论写用户级禁用名单（它没有磁盘目录可放标记），
        // 其余仍写自身目录的 .disabled。
        await registry.setEnabled(meta, willDisable);
        await refreshSkillTree();
        vscode.window.showInformationMessage(`Skill「${arg.name}」已${willDisable ? "禁用" : "启用"}`);
      } catch (err) {
        vscode.window.showErrorMessage(`操作失败：${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("axon.skill.installFromMarketplace", async () => {
      const { MarketplaceRegistry } = await import("@axon/core");
      const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
      const registry = new MarketplaceRegistry(homedir(), createHost());
      const sources = await registry.listSources();
      if (sources.length === 0) {
        vscode.window.showInformationMessage("还没有配置任何 Marketplace 源，请先添加一个团队仓库地址。", "添加源")
          .then((choice) => { if (choice === "添加源") vscode.commands.executeCommand("axon.openMarketplaceManager"); });
        return;
      }
      const sourceChoice = await vscode.window.showQuickPick(
        sources.map((s) => ({ label: s.name, description: s.url, detail: s.description })),
        { placeHolder: "选择一个源" },
      );
      if (!sourceChoice) return;

      let items;
      try {
        items = await registry.fetchItems(sourceChoice.label);
      } catch (err) {
        vscode.window.showErrorMessage(`拉取源列表失败：${(err as Error).message}`);
        return;
      }
      const skillItems = items.filter((i) => i.kind === "skill");
      if (skillItems.length === 0) {
        vscode.window.showInformationMessage(`源「${sourceChoice.label}」暂无可安装的 Skill。`);
        return;
      }
      const itemChoice = await vscode.window.showQuickPick(
        skillItems.map((i) => ({ label: i.name, description: i.description, detail: i.path })),
        { placeHolder: "选择要安装的 Skill" },
      );
      if (!itemChoice) return;
      const selectedItem = skillItems.find((i) => i.name === itemChoice.label && i.path === itemChoice.detail);
      if (!selectedItem) return;

      const locationChoice = await vscode.window.showQuickPick(
        ["安装到项目", "安装到全局"],
        { placeHolder: "安装到哪里？" },
      );
      if (!locationChoice) return;
      const isProject = locationChoice === "安装到项目";

      try {
        const content = await registry.downloadItemContent(sourceChoice.label, selectedItem.path);
        const { parseFrontmatter, globalSkillsDir, workspaceSkillsDir } = await import("@axon/core");
        const { name } = parseFrontmatter(content);
        if (!name) throw new Error("SKILL.md 缺少 frontmatter 中的 name 字段");
        const baseDir = isProject ? workspaceSkillsDir(defaultWorkspace) : globalSkillsDir(homedir());
        const dir = require("path").join(baseDir, name);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
        await vscode.workspace.fs.writeFile(vscode.Uri.file(require("path").join(dir, "SKILL.md")), new TextEncoder().encode(content));
        await refreshSkillTree();
        vscode.window.showInformationMessage(`Skill「${name}」已安装。`);
      } catch (err) {
        vscode.window.showErrorMessage(`安装失败：${(err as Error).message}`);
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
    vscode.commands.registerCommand("axon.power.installFromMarketplace", async () => {
      const { MarketplaceRegistry } = await import("@axon/core");
      const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
      const registry = new MarketplaceRegistry(homedir(), createHost());
      const sources = await registry.listSources();
      if (sources.length === 0) {
        vscode.window.showInformationMessage("还没有配置任何 Marketplace 源，请先添加一个团队仓库地址。", "添加源")
          .then((choice) => { if (choice === "添加源") vscode.commands.executeCommand("axon.openMarketplaceManager"); });
        return;
      }
      const sourceChoice = await vscode.window.showQuickPick(
        sources.map((s) => ({ label: s.name, description: s.url, detail: s.description })),
        { placeHolder: "选择一个源" },
      );
      if (!sourceChoice) return;

      let items;
      try {
        items = await registry.fetchItems(sourceChoice.label);
      } catch (err) {
        vscode.window.showErrorMessage(`拉取源列表失败：${(err as Error).message}`);
        return;
      }
      const powerItems = items.filter((i) => i.kind === "power");
      if (powerItems.length === 0) {
        vscode.window.showInformationMessage(`源「${sourceChoice.label}」暂无可安装的 Power。`);
        return;
      }
      const itemChoice = await vscode.window.showQuickPick(
        powerItems.map((i) => ({ label: i.name, description: i.description, detail: i.path })),
        { placeHolder: "选择要安装的 Power" },
      );
      if (!itemChoice) return;
      const selectedItem = powerItems.find((i) => i.name === itemChoice.label && i.path === itemChoice.detail);
      if (!selectedItem) return;

      const locationChoice = await vscode.window.showQuickPick(
        ["安装到项目", "安装到全局"],
        { placeHolder: "安装到哪里？" },
      );
      if (!locationChoice) return;
      const isProject = locationChoice === "安装到项目";

      try {
        const content = await registry.downloadItemContent(sourceChoice.label, selectedItem.path);
        const { parsePowerFrontmatter, globalPowersDir, workspacePowersDir } = await import("@axon/core");
        const { name } = parsePowerFrontmatter(content);
        if (!name) throw new Error("POWER.md 缺少 frontmatter 中的 name 字段");
        const baseDir = isProject ? workspacePowersDir(defaultWorkspace) : globalPowersDir(homedir());
        const dir = require("path").join(baseDir, name);
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
        await vscode.workspace.fs.writeFile(vscode.Uri.file(require("path").join(dir, "POWER.md")), new TextEncoder().encode(content));
        await refreshPowerTree();
        vscode.window.showInformationMessage(`Power「${name}」已安装。`);
      } catch (err) {
        vscode.window.showErrorMessage(`安装失败：${(err as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("axon.openMarketplaceManager", () => {
      openOrFocusPanel({
        id: "marketplace-manager",
        title: "Marketplace 源管理",
        query: "view=marketplace",
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
      const arg = item.command.arguments[0] as { name: string };
      try {
        const { PowerRegistry } = await import("@axon/core");
        const { createVSCodeAgentHost: createHost } = await import("@axon/host-vscode");
        const registry = new PowerRegistry([defaultWorkspace], createHost(), homedir());
        // 重新 discover 而不是直接用树条目的 enabled：树可能已过期，按下时要按当前真实状态取反。
        const meta = (await registry.discover()).find((m) => m.name === arg.name);
        if (!meta) {
          vscode.window.showErrorMessage(`未找到 Power「${arg.name}」`);
          return;
        }
        // 交给 registry.setEnabled 分流：内置 power 写用户级启用名单，其余写自身目录的 .disabled。
        // 内置 power 位于扩展包内（media/powers），运行期只读、升级会覆盖，不能往里写标记文件。
        await registry.setEnabled(meta, !meta.enabled);
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
  // 底部状态栏 Credits 用量：独立按钮，priority=101，显示在 Axon(100) 左边。
  usageStatusBar = registerAxonUsageStatusBar(context, defaultWorkspace);
  context.subscriptions.push(vscode.commands.registerCommand("axon.usage.refresh", () => usageStatusBar.refresh()));

  // 编辑器行号右键菜单：使用 Git 追溯注解（对标 IDEA Annotate）
  registerGitBlameAnnotation(context);

  // 内联代码补全（替代已删除的 copilot 扩展的 InlineCompletionItemProvider）
  registerInlineCompletion(context);

  // Quick Fix → "Ask Axon"：让 AI 一键修复诊断问题
  registerAskAxonCodeAction(context, provider);

  // ── Wiki 生成进度 ────────────────────────────────────────────────────────
  //
  // 两条通道，都不弹窗、都不挡视线：
  //   ① 状态栏项 —— 带 spinner、显示当前阶段与页数，点击即取消（wikiStatusItem）
  //   ② Wiki 面板内的 message —— 打开该面板就能看到当前阶段
  //
  // 为什么不用「带取消按钮的进度通知」：那种通知没有关闭按钮
  // （notificationsViewer 里只有非进度通知才渲染 close），长任务期间它只能靠
  // 点「取消」消失 —— 而取消会中止整个生成。用户被逼着在「忍受遮挡」和「中止任务」
  // 之间二选一，这正是这条设计要避开的。
  // 不进聊天则是另一个理由：生成过程有几十步工具调用，灌进对话会把界面淹掉。
  // 共享状态（wikiStatusItem / wikiGenerating）声明在上方 refreshWikiTree 之前。
  // 监听 Agent 事件：relay_updated / relay_deleted 时刷新左侧 Relay 树
  channel.onEmit(async (event: any) => {
    if (event.type === "wiki_generation") {
      const e = event.event as { type: string; [k: string]: any };
      // 归属取自事件本身（每条 wiki_generation 都带 workspace），而不是生成命令里设的变量：
      // 这样无论由哪个入口发起生成，显示出的都是权威值。
      if (e.workspace) wikiTargetName = basename(e.workspace as string);
      // 进度直接挂在目标应用节点上（见 WikiTreeProvider.setGenerating），不再用视图顶部的
      // message：两者本来说的就是同一件事，而节点还能回答 message 答不了的
      // 「在生成【哪个】应用」—— 这个面板列着所有工作区，那才是用户最先要知道的。
      if (e.type === "planning") {
        // 规划阶段要通读仓库、可能几十秒，所以这里就必须亮出 spinner；
        // 否则从点按钮到第一页落盘之间毫无动静，用户会以为没生效。
        wikiTree.setGenerating({ workspace: e.workspace, done: 0, total: 0 });
        setWikiProgress("正在勘察仓库、规划页面…");
      } else if (e.type === "planned") {
        const n = (e.pages as unknown[]).length;
        wikiTree.setGenerating({ workspace: e.workspace, done: 0, total: n });
        setWikiProgress(`共 ${n} 页，开始生成…`);
      } else if (e.type === "page_saved") {
        wikiTree.setGenerating({ workspace: e.workspace, done: e.done, total: e.total, current: e.title });
        setWikiProgress(`${e.done}/${e.total}：${e.title}`);
      } else if (e.type === "page_failed") {
        // 单页失败不终止整体，但要让用户知道有一页没成。
        // 节点上的进度刻意不动：失败的页没有落盘，进度本就该停在那儿（明细见结束通知）。
        setWikiProgress(`${e.title} 未成功，继续…`);
      } else if (e.type === "finished") {
        // 收掉节点上的 spinner：残留会让它一直转下去，看着像卡住了
        wikiTree.setGenerating(null);
        // 结果提示同样带归属：长任务结束时用户多半没盯着看，
        // 不写清是哪个应用，「完成 14 页」就成了没有主语的一句话。
        const doneMsg = wikiMsg(e.message as string);
        // 用户主动取消既不是成功也不是失败 —— 弹黄色警告属于误报
        if (e.cancelled) vscode.window.showInformationMessage(doneMsg);
        else if (e.ok) vscode.window.showInformationMessage(doneMsg);
        else vscode.window.showWarningMessage(doneMsg);
        void refreshWikiTree().catch(() => { /* 刷新失败不影响结果提示 */ });
      }
      return;
    }
    if (event.type === "relay_updated" || event.type === "relay_deleted") {
      try {
        const relays = await listAllRelays();
        relayTree.refresh(relays);

        // 转发 relay 事件到已打开的 Relay Tab 面板，驱动自动刷新
        if (event.type === "relay_updated" && event.relay?.id) {
          postToPanel(`relay-${event.relay.id}`, { type: "relay_updated", relayId: event.relay.id });
        }
        if (event.type === "relay_deleted" && event.relayId) {
          postToPanel(`relay-${event.relayId}`, { type: "relay_deleted", relayId: event.relayId });
        }
      } catch { /* 忽略 */ }
    }
  });

  // 初始加载管理面板数据
  (async () => {
    try {
      // Provider 列表（解析内置目录 + providers.json，并注入 core 运行时）
      await refreshProviderTree();

      // Relay 列表
      const relays = await listAllRelays();
      relayTree.refresh(relays);

      // Wiki 列表（读 .axon/wiki/ + 判定陈旧，零 LLM 成本）
      await refreshWikiTree();

      // Skills 列表（注入 Power 捆绑的 skills，与 refreshSkillTree 保持一致）
      const { SkillRegistry, PowerRegistry, globalSkillsDir, workspaceSkillsDir } = await import("@axon/core");
      const { createVSCodeAgentHost: createHost2 } = await import("@axon/host-vscode");
      const host2 = createHost2();
      const powerRegistry = new PowerRegistry([defaultWorkspace], host2, homedir());
      const registry = new SkillRegistry([defaultWorkspace], host2, homedir(), () => powerRegistry.getActiveSkillDirs());
      const skills = await registry.discover();
      skillsTree.refresh(skills.map((s) => ({ name: s.name, source: s.source, disabled: s.disabled, skillFile: s.skillFile })));
      customSkillsTree.refresh(
        skills.map((s) => ({ name: s.name, source: s.source, disabled: s.disabled, skillFile: s.skillFile, dir: s.dir })),
        workspaceSkillsDir(defaultWorkspace),
        globalSkillsDir(homedir()),
      );

      // Powers 列表
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
      const mcpRegistry = new McpRegistry([defaultWorkspace], host2, homedir(), powerRegistry);
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

  // Wiki 页面变动时刷新侧边栏（手改 / 新增 / 删除 .md 都会被看到）。
  // 加 200ms 去抖：生成一页会先后写 .md 与 .state.json，不去抖会连触发两次刷新。
  // 检测本身不调 LLM，频繁触发无成本顾虑。
  let wikiRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleWikiRefresh = () => {
    if (wikiRefreshTimer) clearTimeout(wikiRefreshTimer);
    wikiRefreshTimer = setTimeout(() => {
      wikiRefreshTimer = undefined;
      void refreshWikiTree().catch(() => { /* 列表刷新失败不该影响主流程 */ });
    }, 200);
  };
  const wikiWatcher = vscode.workspace.createFileSystemWatcher("**/.axon/wiki/*");
  wikiWatcher.onDidChange(scheduleWikiRefresh);
  wikiWatcher.onDidCreate(scheduleWikiRefresh);
  wikiWatcher.onDidDelete(scheduleWikiRefresh);
  context.subscriptions.push(wikiWatcher, { dispose: () => { if (wikiRefreshTimer) clearTimeout(wikiRefreshTimer); } });


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
      void usageStatusBar.refresh();
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
        onProvidersChanged: () => {
          provider.postToWebview({ type: "providers_changed" });
          void refreshProviderTree();
        },
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

  // Axon: 首次启动自动打开 Axon 侧边栏，引导用户发现 Axon Agent
  const firstStartKey = "axon.firstStartDone";
  if (!context.globalState.get<boolean>(firstStartKey)) {
    context.globalState.update(firstStartKey, true);
    // 延迟执行，等 workbench 完全就绪后再聚焦
    setTimeout(() => {
      vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
      vscode.commands.executeCommand("axon.chat.focus");
      // 首次启动启用跟随系统主题（新用户体验更好，已有用户不受影响）
      try {
        vscode.workspace.getConfiguration().update("window.autoDetectColorScheme", true, vscode.ConfigurationTarget.Global);
      } catch { /* ignore */ }
    }, 1500);
  }
}

export function deactivate(): void {
  /* 资源由 context.subscriptions 自动释放 */
}
