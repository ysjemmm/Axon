/**
 * API Client - 统一封装所有后端 HTTP 请求
 *
 * 设计原则：
 * - 使用方只需调一个函数，不用关心 fetch/headers/错误处理
 * - 统一 JSON 解析 + 错误抛出（非 2xx 自动 throw）
 * - 所有接口集中定义，方便查找和维护
 */

import { apiRequest } from "./transport";

/** 统一请求封装：底层走 transport（浏览器=fetch / webview=postMessage），自动 JSON 解析 + 错误处理 */
async function request<T = unknown>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const method = (options?.method || "GET") as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  const body = options?.body ? JSON.parse(options.body as string) : undefined;
  return apiRequest<T>(method, path, body);
}

/** GET 请求简写 */
function get<T = unknown>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
}

/** POST 请求简写 */
function post<T = unknown>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
}

/** PUT 请求简写 */
function put<T = unknown>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined });
}

/** PATCH 请求简写 */
function patch<T = unknown>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined });
}

/** DELETE 请求简写 */
function del<T = unknown>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 接口定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// ── Health ──

export function checkHealth(): Promise<{ status: string; defaultWorkspace: string }> {
  return get("/health");
}

// ── Sessions ──

export interface SessionMeta {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export function listSessions(): Promise<{ sessions: SessionMeta[] }> {
  return get("/api/sessions");
}

export function deleteSession(id: string): Promise<{ ok: boolean }> {
  return del(`/api/sessions/${id}`);
}

/** 重命名会话标题 */
export function renameSession(id: string, title: string): Promise<{ ok: boolean }> {
  return patch(`/api/sessions/${id}`, { title });
}

// ── Workspace Groups ──

export interface WorkspaceGroup {
  id: string;
  name: string;
  paths: string[];
}

export function listWorkspaceGroups(): Promise<{ groups: WorkspaceGroup[] }> {
  return get("/api/workspace-groups");
}

export function createWorkspaceGroup(name: string, paths: string[]): Promise<WorkspaceGroup> {
  return post("/api/workspace-groups", { name, paths });
}

export function updateWorkspaceGroup(id: string, data: { name?: string; paths?: string[] }): Promise<WorkspaceGroup> {
  return put(`/api/workspace-groups/${id}`, data);
}

export function deleteWorkspaceGroup(id: string): Promise<{ ok: boolean }> {
  return del(`/api/workspace-groups/${id}`);
}

// ── File System Browse ──

export interface BrowseResult {
  current: string;
  parent: string | null;
  isRoot: boolean;
  entries: { name: string; path: string }[];
}

export function browseDirectory(path?: string): Promise<BrowseResult> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return get(`/api/fs/list${query}`);
}

export function validateDirectory(path: string): Promise<{ valid: boolean }> {
  return get(`/api/fs/validate?path=${encodeURIComponent(path)}`);
}

// ── Skills ──

export interface SkillInfo {
  name: string;
  description: string;
  source: "global" | "workspace" | "builtin";
  dir: string;
  disabled: boolean;
}

export function listSkills(): Promise<{ skills: SkillInfo[] }> {
  return get("/api/skills");
}

/** 启用/禁用 skill */
export function toggleSkill(name: string, disabled: boolean): Promise<{ ok: boolean; name: string; disabled: boolean }> {
  return patch(`/api/skills/${name}/toggle`, { disabled });
}

export function uploadSkill(content: string, workspace?: string): Promise<{ ok: boolean; name: string; dir: string }> {
  return post("/api/skills/upload", { content, workspace });
}

export function generateSkill(prompt: string, model?: string, provider?: string): Promise<{ ok: boolean; content: string }> {
  return post("/api/skills/generate", { prompt, model, provider });
}

export function deleteSkill(name: string): Promise<{ ok: boolean }> {
  return del(`/api/skills/${name}`);
}

// ── Skill 文件管理 ──

/** 文件树节点（path 为相对 skill 目录的 "/" 分隔路径） */
export interface SkillFileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: SkillFileNode[];
}

/** 构建 skill 文件相关接口的查询串（携带可选 workspace） */
function skillQuery(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/** 获取某个 skill 的完整文件树 */
export function getSkillTree(name: string, workspace?: string): Promise<{ name: string; dir: string; tree: SkillFileNode[] }> {
  return get(`/api/skills/${name}/tree${skillQuery({ workspace })}`);
}

/** 读取 skill 目录下指定文件内容 */
export function readSkillFile(name: string, path: string, workspace?: string): Promise<{ path: string; content: string }> {
  return get(`/api/skills/${name}/file${skillQuery({ path, workspace })}`);
}

/** 写入/更新 skill 目录下指定文件 */
export function writeSkillFile(name: string, path: string, content: string, workspace?: string): Promise<{ ok: boolean; path: string }> {
  return put(`/api/skills/${name}/file`, { path, content, workspace });
}

/** 新建文件或目录（path 以 "/" 结尾视为目录） */
export function createSkillFile(name: string, path: string, content = "", workspace?: string): Promise<{ ok: boolean; path: string }> {
  return post(`/api/skills/${name}/file`, { path, content, workspace });
}

/** 删除 skill 目录下指定文件或目录 */
export function deleteSkillFile(name: string, path: string, workspace?: string): Promise<{ ok: boolean; path: string }> {
  return del(`/api/skills/${name}/file${skillQuery({ path, workspace })}`);
}

// ── Relay 长任务工作流 ──

export type RelayPhase = "brainstorm" | "design" | "plan" | "executing" | "done";

export interface ReviewVerdict {
  passed: boolean;
  issues: { severity: "critical" | "major" | "minor"; description: string }[];
  summary: string;
}

export interface TaskReview {
  spec?: ReviewVerdict;
  quality?: ReviewVerdict;
  passed: boolean;
  reviewedAt: string;
}

export type TaskReviewStatus = "none" | "reviewing" | "passed" | "changes_requested";

export interface RelayTask {
  id: string;
  title: string;
  details?: string;
  status: "pending" | "in_progress" | "completed";
  deps?: string[];
  reviewStatus?: TaskReviewStatus;
  review?: TaskReview;
}

export interface RelayQualityConfig {
  tdd: boolean;
  review: boolean;
}

export interface RelaySummary {
  id: string;
  title: string;
  summary: string;
  phase: RelayPhase;
  taskTotal: number;
  taskDone: number;
  updatedAt: string;
}

export interface RelayData {
  id: string;
  title: string;
  summary: string;
  phase: RelayPhase;
  tasks: RelayTask[];
  approvals: Partial<Record<RelayPhase, boolean>>;
  quality?: RelayQualityConfig;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  requirements: string;
  design: string;
  plan: string;
}

/** 构建携带 workspace 的查询串 */
function relayQuery(workspace?: string): string {
  return workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
}

/** 列出某工作区下所有 relay 摘要 */
export function listRelays(workspace?: string): Promise<{ relays: RelaySummary[] }> {
  return get(`/api/relays${relayQuery(workspace)}`);
}

/** 获取单个 relay 完整数据 */
export function getRelay(id: string, workspace?: string): Promise<RelayData> {
  return get(`/api/relays/${id}${relayQuery(workspace)}`);
}

/** 更新单个任务状态 */
export function updateRelayTask(
  id: string,
  taskId: string,
  status: RelayTask["status"],
  workspace?: string,
): Promise<RelayData> {
  return patch(`/api/relays/${id}/tasks/${taskId}${relayQuery(workspace)}`, { status });
}

/** 删除 relay */
export function deleteRelay(id: string, workspace?: string): Promise<{ ok: boolean }> {
  return del(`/api/relays/${id}${relayQuery(workspace)}`);
}

// ── Powers 能力扩展包 ──

export interface PowerInfo {
  name: string;
  displayName: string;
  description: string;
  keywords: string[];
  source: "global" | "workspace";
  dir: string;
  powerFile: string;
  enabled: boolean;
  mcpServerCount: number;
  skillCount: number;
  hasSteering: boolean;
}

export interface PowerMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  autoApprove?: string[];
}

export interface PowerSkillMeta {
  name: string;
  description: string;
  dir: string;
}

export interface PowerDetail extends PowerInfo {
  body: string;
  mcpConfig: { mcpServers: Record<string, PowerMcpServer> } | null;
  skills: PowerSkillMeta[];
  steeringFiles: string[];
}

function powerQuery(workspace?: string): string {
  return workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
}

/** 列出所有 power */
export function listPowers(workspace?: string): Promise<{ powers: PowerInfo[] }> {
  return get(`/api/powers${powerQuery(workspace)}`);
}

/** 获取单个 power 完整信息 */
export function getPower(name: string, workspace?: string): Promise<PowerDetail> {
  return get(`/api/powers/${name}${powerQuery(workspace)}`);
}

/** 启用/禁用 power */
export function togglePower(name: string, enabled: boolean, workspace?: string): Promise<{ ok: boolean; name: string; enabled: boolean }> {
  return patch(`/api/powers/${name}/toggle${powerQuery(workspace)}`, { enabled });
}

/** 安装 power（上传 POWER.md） */
export function installPower(content: string, workspace?: string): Promise<{ ok: boolean; name: string; dir: string }> {
  return post("/api/powers/install", { content, workspace });
}

/** 删除 power */
export function deletePower(name: string, workspace?: string): Promise<{ ok: boolean }> {
  return del(`/api/powers/${name}${powerQuery(workspace)}`);
}

/** 读取 power 的 steering 文件 */
export function readPowerSteering(name: string, file: string, workspace?: string): Promise<{ file: string; content: string }> {
  return get(`/api/powers/${name}/steering/${file}${powerQuery(workspace)}`);
}

/** 保存 power 的 MCP 配置 */
export function savePowerMcpConfig(name: string, config: object, workspace?: string): Promise<{ ok: boolean }> {
  return put(`/api/powers/${name}/mcp${powerQuery(workspace)}`, { config });
}

/** 在 Power 内添加 Skill */
export function addPowerSkill(powerName: string, skillName: string, description?: string, workspace?: string): Promise<{ ok: boolean; dir: string }> {
  return post(`/api/powers/${powerName}/skills${powerQuery(workspace)}`, { skillName, description });
}

/** 从 Power 内删除 Skill */
export function removePowerSkill(powerName: string, skillName: string, workspace?: string): Promise<{ ok: boolean }> {
  return del(`/api/powers/${powerName}/skills/${skillName}${powerQuery(workspace)}`);
}

/** 覆盖写入 Power 内 Skill 的 SKILL.md 内容 */
export function savePowerSkillContent(powerName: string, skillName: string, content: string, workspace?: string): Promise<{ ok: boolean }> {
  return put(`/api/powers/${powerName}/skills/${skillName}/content${powerQuery(workspace)}`, { content });
}

/** 在 Power 内添加 MCP 服务器 */
export function addPowerMcpServer(powerName: string, serverName: string, server: { command: string; args?: string[] }, workspace?: string): Promise<{ ok: boolean }> {
  return post(`/api/powers/${powerName}/mcp-servers${powerQuery(workspace)}`, { serverName, server });
}

/** 从 Power 内删除 MCP 服务器 */
export function removePowerMcpServer(powerName: string, serverName: string, workspace?: string): Promise<{ ok: boolean }> {
  return del(`/api/powers/${powerName}/mcp-servers/${serverName}${powerQuery(workspace)}`);
}

// ── 独立 MCP 配置（.axon/settings/mcp.json，用户级/工作区级）────────────────

/** MCP 配置的 level：用户级（全局）/ 工作区级（仅当前项目） */
export type McpLevel = "user" | "workspace";

/** 单个 MCP server 原始配置（stdio 用 command/args/env；http 用 url/headers） */
export interface RawMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  autoApprove?: string[];
}

export interface RawMcpConfig {
  mcpServers: Record<string, RawMcpServer>;
}

function mcpQuery(workspace?: string): string {
  return workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
}

/** 一次拉取用户级 + 工作区级 MCP 配置 */
export function getMcpConfig(workspace?: string): Promise<{ user: RawMcpConfig; workspace: RawMcpConfig }> {
  return get(`/api/mcp${mcpQuery(workspace)}`);
}

/** 覆盖写入某 level 的完整 MCP 配置 */
export function saveMcpConfig(level: McpLevel, config: RawMcpConfig, workspace?: string): Promise<{ ok: boolean }> {
  return put(`/api/mcp/${level}${mcpQuery(workspace)}`, { config });
}

/** 新增一个 MCP server */
export function addMcpServer(level: McpLevel, serverName: string, server: RawMcpServer, workspace?: string): Promise<{ ok: boolean }> {
  return post(`/api/mcp/${level}/servers${mcpQuery(workspace)}`, { serverName, server });
}

/** 删除一个 MCP server */
export function removeMcpServer(level: McpLevel, serverName: string, workspace?: string): Promise<{ ok: boolean }> {
  return del(`/api/mcp/${level}/servers/${encodeURIComponent(serverName)}${mcpQuery(workspace)}`);
}

// ── 文件操作（VS Code webview 专用）────────────────────────────────────────

/** 请求 VS Code 宿主在原生编辑器 Tab 中打开文件（文件不存在会自动创建空模板） */
export function openFileInEditor(path: string): Promise<{ ok: boolean }> {
  return post("/api/open-file", { path });
}

/** 请求打开某 level 的 mcp.json（由后端解析真实路径，免去前端拼 homedir） */
export function openMcpConfigInEditor(level: McpLevel, workspace?: string): Promise<{ ok: boolean }> {
  return post("/api/open-mcp-config", { level, workspace });
}


// ── Provider 配置（.axon/settings/providers.json，用户级/工作区级）──────────

export type ProviderLevel = "user" | "workspace";
export type ProviderProtocol = "chat" | "responses";

/** 单个模型元数据 */
export interface ProviderModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  vision?: boolean;
  description?: string;
  /** 厂商（openai / anthropic / qwen / zhipu 等），后端据此做厂商兼容 */
  vendor?: string;
  group?: string;
  free?: boolean;
  disabled?: boolean;
  tier?: "fast" | "balanced" | "flagship";
}

/** 解析后的 provider（脱敏，无 apiKey），来自 GET /api/providers */
export interface ResolvedProviderInfo {
  name: string;
  label: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  models: ProviderModelInfo[];
  builtin: boolean;
  locked: boolean;
  configured: boolean;
  source: "builtin" | "custom" | "env";
}

/** 扁平模型（含 provider 归属），供模型选择器 */
export interface FlatModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  vision: boolean;
  description: string;
  group: string;
  free: boolean;
  provider: string;
  builtin: boolean;
  tier?: "fast" | "balanced" | "flagship";
}

/** providers.json 里单个自定义 provider 条目 */
export interface RawProviderEntry {
  label?: string;
  baseUrl?: string;
  apiKey?: string;
  /** 认证头格式：bearer（默认）= Authorization: Bearer / x-api-key（Anthropic 等） */
  apiKeyHeader?: string;
  protocol?: ProviderProtocol;
  models?: ProviderModelInfo[];
}

/** providers.json 文件结构 */
export interface ProviderConfigFile {
  providers?: Record<string, RawProviderEntry>;
  builtinApiKeys?: Record<string, string>;
}

function providerQuery(workspace?: string): string {
  return workspace ? `?workspace=${encodeURIComponent(workspace)}` : "";
}

/** 解析后的 provider 列表 + 扁平模型（脱敏） */
export function getProviders(workspace?: string): Promise<{ providers: ResolvedProviderInfo[]; models: FlatModelInfo[] }> {
  return get(`/api/providers${providerQuery(workspace)}`);
}

/** 原始 providers.json（用户级 + 工作区级），供高级编辑 */
export function getProviderConfig(workspace?: string): Promise<{ user: ProviderConfigFile; workspace: ProviderConfigFile }> {
  return get(`/api/providers/config${providerQuery(workspace)}`);
}

/** 覆盖写入某 level 的完整 providers.json */
export function saveProviderConfig(level: ProviderLevel, config: ProviderConfigFile, workspace?: string): Promise<{ ok: boolean }> {
  return put(`/api/providers/${level}${providerQuery(workspace)}`, { config });
}

/** 新增/覆盖一个自定义 provider */
export function addCustomProvider(level: ProviderLevel, name: string, entry: RawProviderEntry & { apiKeyHeader?: string }, workspace?: string): Promise<{ ok: boolean }> {
  return post(`/api/providers/${level}/custom${providerQuery(workspace)}`, { name, entry });
}

/** 删除一个自定义 provider */
export function removeCustomProvider(level: ProviderLevel, name: string, workspace?: string): Promise<{ ok: boolean }> {
  return del(`/api/providers/${level}/custom/${encodeURIComponent(name)}${providerQuery(workspace)}`);
}

/** 设置内置 provider（esign / zhipu）的 apiKey 覆盖（esign 仅此项可改） */
export function setBuiltinProviderKey(level: ProviderLevel, name: string, apiKey: string, workspace?: string): Promise<{ ok: boolean }> {
  return put(`/api/providers/${level}/builtin-key${providerQuery(workspace)}`, { name, apiKey });
}

/** 请求 VS Code 宿主在原生编辑器打开 providers.json */
export function openProviderConfigInEditor(level: ProviderLevel, workspace?: string): Promise<{ ok: boolean }> {
  return post("/api/open-provider-config", { level, workspace });
}

/** 覆盖某自定义 provider 的模型数组（增/删/改/禁用统一整存） */
export function setCustomProviderModels(level: ProviderLevel, name: string, models: ProviderModelInfo[], workspace?: string): Promise<{ ok: boolean }> {
  return put(`/api/providers/${level}/custom/${encodeURIComponent(name)}/models${providerQuery(workspace)}`, { models });
}

/** 端点探测到的模型（窗口/多模态可能为空，取决于 provider 是否返回） */
export interface ProbedModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  vision?: boolean;
  vendor?: string;
}

/**
 * best-effort 从端点拉取模型列表。
 * 传 baseUrl+apiKey（新建未保存时）或 name+level（已保存 provider，由后端取已存 key）。
 */
export function probeProviderModels(params: { baseUrl?: string; apiKey?: string; name?: string; level?: ProviderLevel; workspace?: string }): Promise<{ models: ProbedModelInfo[] }> {
  return post("/api/providers/probe-models", params);
}
