/**
 * 工作区级 .axon 配置协议。
 *
 * Axon 自有的项目级配置协议，不读取其它 Agent 产品的配置：
 * - 指令：.axon/AXON.md 或根目录 AXON.md
 * - 规则：`.axon/rules/` 下的 Markdown 文件
 * - 工作区记忆：`.axon/memory/` 下的 Markdown 文件（总注入上限 25KB）
 * - 设置：.axon/settings.json + settings.local.json（本模块只读取并合并，不擅自执行未知键）
 * - 用户级：~/.axon/ 下对应文件；工作区配置覆盖用户配置
 *
 * 所有文件访问走 AgentHost.fs，因此 Node、VS Code、远程工作区都使用同一套逻辑。
 */

import { join } from "node:path";
import type { AgentHost } from "../host/index.js";

const MAX_FILE_CHARS = 25 * 1024;
const MAX_MEMORY_CHARS = 25 * 1024;
const MAX_RULE_FILES = 80;

export interface WorkspaceAxonSettings {
  [key: string]: unknown;
}

export interface WorkspaceAxonConfig {
  /** 已合并、带来源标题的 Prompt；空串表示没有工作区级指令/规则/记忆。 */
  prompt: string;
  /** 共享设置与本地设置的浅层合并结果，供后续宿主能力消费。 */
  settings: WorkspaceAxonSettings;
  /** 实际读取过的配置文件，便于诊断与后续 UI 展示。 */
  files: string[];
}

interface TextPart {
  path: string;
  label: string;
  content: string;
}

function normalizeText(content: string, limit = MAX_FILE_CHARS): string {
  return content.replace(/\r\n/g, "\n").trim().slice(0, limit).trim();
}

async function readText(host: AgentHost, path: string): Promise<string | null> {
  try {
    const raw = await host.fs.read(path);
    if (!raw) return null;
    const text = normalizeText(raw);
    return text || null;
  } catch {
    return null;
  }
}

async function readJson(host: AgentHost, path: string): Promise<WorkspaceAxonSettings> {
  const raw = await readText(host, path);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as WorkspaceAxonSettings : {};
  } catch {
    return {};
  }
}

async function collectMarkdown(host: AgentHost, root: string, maxFiles: number): Promise<TextPart[]> {
  const result: TextPart[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (result.length >= maxFiles) return;
    let children;
    try {
      children = await host.fs.readdir(dir);
    } catch {
      return;
    }
    for (const child of children) {
      if (result.length >= maxFiles) return;
      if (child.isDir) {
        await walk(child.path);
      } else if (child.isFile && /\.md$/i.test(child.name)) {
        const content = await readText(host, child.path);
        if (content) result.push({ path: child.path, label: child.path, content });
      }
    }
  };
  await walk(root);
  return result;
}

async function ensureDir(host: AgentHost, path: string): Promise<void> {
  try {
    await host.fs.mkdirp(path);
  } catch {
    // 工作区可能是只读远程 FS；配置加载不能阻塞正常会话。
  }
}

/**
 * 确保工作区拥有 .axon 基础目录。
 * 只创建目录，不写模板文件，避免打开一个仓库就产生不可预期的配置内容。
 */
export async function ensureWorkspaceAxonDirs(host: AgentHost, workspace: string): Promise<void> {
  const root = join(workspace, ".axon");
  await Promise.all([
    ensureDir(host, root),
    ensureDir(host, join(root, "rules")),
    ensureDir(host, join(root, "skills")),
    ensureDir(host, join(root, "agents")),
    ensureDir(host, join(root, "memory")),
    ensureDir(host, join(root, "settings")),
  ]);
}

export interface WorkspaceAxonInitializationResult {
  workspace: string;
  created: string[];
  existing: string[];
}

/** 一个工作区的 .axon 现状，只读探测结果（不创建目录、不写文件）。 */
export interface WorkspaceAxonStatus {
  workspace: string;
  /** 是否已有 .axon/AXON.md（判定"已启用"的主依据） */
  hasAxonMd: boolean;
  /** 是否有 .axon/AXON.local.md 个人覆盖 */
  hasLocalOverride: boolean;
  /** 是否有 .axon/settings.json */
  hasSettings: boolean;
  /** 各类配置的数量（Markdown 文件数 / 技能目录数） */
  rules: number;
  memory: number;
  skills: number;
  agents: number;
}

/** 统计目录下的条目数；目录不存在时返回 0（探测必须永不抛错）。 */
async function countEntries(host: AgentHost, dir: string, filter: (name: string, isDir: boolean) => boolean): Promise<number> {
  try {
    const children = await host.fs.readdir(dir);
    return children.filter((child) => filter(child.name, child.isDir)).length;
  } catch {
    return 0;
  }
}

/**
 * 只读探测单个工作区的 .axon 状态。
 *
 * 刻意不调用 ensureWorkspaceAxonDirs：探测是"看一眼现状"，不能因为用户点开状态列表
 * 就在仓库里建出目录。工作区也可能是只读的远程文件系统。
 */
export async function inspectWorkspaceAxon(host: AgentHost, workspace: string): Promise<WorkspaceAxonStatus> {
  const root = join(workspace, ".axon");
  const [axonMd, localOverride, settings] = await Promise.all([
    host.fs.read(join(root, "AXON.md")).catch(() => null),
    host.fs.read(join(root, "AXON.local.md")).catch(() => null),
    host.fs.read(join(root, "settings.json")).catch(() => null),
  ]);
  const [rules, memory, skills, agents] = await Promise.all([
    countEntries(host, join(root, "rules"), (name, isDir) => !isDir && /\.md$/i.test(name)),
    countEntries(host, join(root, "memory"), (name, isDir) => !isDir && /\.md$/i.test(name)),
    countEntries(host, join(root, "skills"), (_name, isDir) => isDir),
    countEntries(host, join(root, "agents"), (name) => /\.md$/i.test(name)),
  ]);
  return {
    workspace,
    hasAxonMd: !!axonMd,
    hasLocalOverride: !!localOverride,
    hasSettings: !!settings,
    rules,
    memory,
    skills,
    agents,
  };
}

/** 批量探测：多工作区场景一次给出全部状态，供界面列表展示。 */
export async function inspectWorkspacesAxon(host: AgentHost, workspaces: string[]): Promise<WorkspaceAxonStatus[]> {
  return Promise.all(workspaces.map((workspace) => inspectWorkspaceAxon(host, workspace)));
}

const DEFAULT_AXON_MD = `# Axon 工作区说明

## 项目概览

<!-- 请补充这个工作区的架构、构建命令和长期开发约定。 -->

## 开发约定

- 重要的长期规则写入本文件或 ".axon/rules/"。
- 个人本机配置写入 ".axon/AXON.local.md"，不要提交。
- 工作区长期知识按主题写入 ".axon/memory/"。
`;

const DEFAULT_AXON_SETTINGS = JSON.stringify({
  version: 1,
  memory: { enabled: true, maxInjectedChars: 25600 },
  workspaceConfig: { loadRules: true },
}, null, 2) + "\n";

/**
 * 用户明确确认后初始化一个工作区。只补缺失文件，不覆盖已有 AXON.md/settings.json。
 * 这条路径才允许写入工作区；普通打开、切换和聊天过程不会创建 .axon 文件。
 */
export async function initializeWorkspaceAxon(host: AgentHost, workspace: string, axonContent?: string): Promise<WorkspaceAxonInitializationResult> {
  await ensureWorkspaceAxonDirs(host, workspace);
  const root = join(workspace, ".axon");
  const candidates = [
    { path: join(root, "AXON.md"), content: axonContent?.trim() || DEFAULT_AXON_MD },
    { path: join(root, "settings.json"), content: DEFAULT_AXON_SETTINGS },
  ];
  const created: string[] = [];
  const existing: string[] = [];
  for (const candidate of candidates) {
    const current = await host.fs.read(candidate.path).catch(() => null);
    if (current !== null) {
      existing.push(candidate.path);
      continue;
    }
    await host.fs.write(candidate.path, candidate.content);
    created.push(candidate.path);
  }
  return { workspace, created, existing };
}

function pushUnique(parts: TextPart[], seen: Set<string>, part: TextPart): void {
  if (seen.has(part.path)) return;
  seen.add(part.path);
  parts.push(part);
}

async function loadRootInstructions(host: AgentHost, root: string, label: string, parts: TextPart[], seen: Set<string>, files: string[]): Promise<void> {
  // 只读取 Axon 自己的 AXON.md 文件，其它 Agent 产品的配置不属于 Axon 协议。
  const candidates = [
    join(root, ".axon", "AXON.md"),
    join(root, ".axon", "AXON.local.md"),
    join(root, "AXON.md"),
    join(root, "AXON.local.md"),
  ];
  for (const path of candidates) {
    const content = await readText(host, path);
    if (!content) continue;
    pushUnique(parts, seen, { path, label: `${label} · ${path}`, content });
    files.push(path);
  }
}

async function loadRules(host: AgentHost, root: string, label: string, parts: TextPart[], seen: Set<string>, files: string[]): Promise<void> {
  const roots = [join(root, ".axon", "rules")];
  for (const rulesRoot of roots) {
    const rules = await collectMarkdown(host, rulesRoot, MAX_RULE_FILES);
    for (const rule of rules) {
      if (seen.has(rule.path)) continue;
      seen.add(rule.path);
      parts.push({ ...rule, label: `${label} · 规则 · ${rule.path}` });
      files.push(rule.path);
    }
  }
}

async function loadMemory(host: AgentHost, root: string, label: string, parts: TextPart[], seen: Set<string>, files: string[]): Promise<void> {
  const roots = [join(root, ".axon", "memory")];
  let used = 0;
  for (const memoryRoot of roots) {
    const memories = await collectMarkdown(host, memoryRoot, MAX_RULE_FILES);
    for (const memory of memories) {
      if (used >= MAX_MEMORY_CHARS || seen.has(memory.path)) continue;
      const content = memory.content.slice(0, MAX_MEMORY_CHARS - used).trim();
      if (!content) continue;
      seen.add(memory.path);
      parts.push({ path: memory.path, label: `${label} · 记忆 · ${memory.path}`, content });
      files.push(memory.path);
      used += content.length;
    }
  }
}

function mergeSettings(target: WorkspaceAxonSettings, source: WorkspaceAxonSettings): void {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object" && !Array.isArray(target[key])) {
      target[key] = { ...(target[key] as object), ...(value as object) };
    } else {
      target[key] = value;
    }
  }
}

function formatPrompt(parts: TextPart[]): string {
  if (parts.length === 0) return "";
  return [
    "【工作区 .axon 配置】以下内容是当前工作区已确认的项目指令、路径规则和长期知识。",
    "按其中的约束工作；它们是上下文，不是用户消息，不要在回复里复述配置正文。",
    "",
    ...parts.map((part) => `### ${part.label}\n${part.content}`),
  ].join("\n\n");
}

/** 加载用户级 + 多工作区级 .axon 配置；顺序是用户 → 工作区列表顺序 → 本地设置。 */
export async function loadWorkspaceAxonConfig(
  host: AgentHost,
  workspaces: string[],
  homeDir: string,
): Promise<WorkspaceAxonConfig> {
  const parts: TextPart[] = [];
  const seen = new Set<string>();
  const files: string[] = [];
  const settings: WorkspaceAxonSettings = {};

  if (homeDir) {
    const userLabel = "用户级 .axon";
    await loadRootInstructions(host, homeDir, userLabel, parts, seen, files);
    await loadRules(host, homeDir, userLabel, parts, seen, files);
    await loadMemory(host, homeDir, userLabel, parts, seen, files);
    mergeSettings(settings, await readJson(host, join(homeDir, ".axon", "settings.json")));
    mergeSettings(settings, await readJson(host, join(homeDir, ".axon", "settings.local.json")));
  }

  for (const workspace of workspaces) {
    const label = `工作区 ${workspace}`;
    await loadRootInstructions(host, workspace, label, parts, seen, files);
    await loadRules(host, workspace, label, parts, seen, files);
    await loadMemory(host, workspace, label, parts, seen, files);
    mergeSettings(settings, await readJson(host, join(workspace, ".axon", "settings.json")));
    mergeSettings(settings, await readJson(host, join(workspace, ".axon", "settings.local.json")));
  }

  const shouldLoadRules = settings.workspaceConfig && typeof settings.workspaceConfig === "object"
    ? (settings.workspaceConfig as Record<string, unknown>).loadRules !== false
    : true;
  const memorySettings = settings.memory && typeof settings.memory === "object"
    ? settings.memory as Record<string, unknown>
    : {};
  const loadMemoryEnabled = memorySettings.enabled !== false;
  const filtered = parts.filter((part) => {
    if (!shouldLoadRules && part.label.includes("· 规则 ·")) return false;
    if (!loadMemoryEnabled && part.label.includes("· 记忆 ·")) return false;
    return true;
  });
  const maxInjectedChars = typeof memorySettings.maxInjectedChars === "number"
    ? Math.max(1_000, Math.min(100_000, memorySettings.maxInjectedChars))
    : MAX_MEMORY_CHARS;
  const prompt = formatPrompt(filtered).slice(0, maxInjectedChars);
  return { prompt, settings, files };
}
