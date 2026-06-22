/**
 * RequestRouter —— webview 形态下 REST 请求的服务端（对称于 server 的 Express 路由）
 *
 * 浏览器形态里 web UI 通过 HTTP 调 server 的 REST 接口；webview 形态没有 HTTP server，
 * UI 改用 postMessage 发 { __axonReq, id, method, path, body }，由本路由解析 path
 * 调对应能力（storage / browser / RelayStore 等），把结果用 { __axonRes, id, ok, data }
 * 回传。路径与返回结构与 server Express 路由保持一致，使前端 apiClient 零改动复用。
 */

import * as vscode from "vscode";
import { homedir } from "node:os";
import { RelayStore, ProviderRegistry, refreshProviders, probeProviderModels, RESERVED_PROVIDER_NAMES, type SessionStorage, type ResolvedProvider, type ProviderConfigFile, type ProviderModel, type RawProviderEntry } from "@axon/core";
import { createVSCodeAgentHost } from "@axon/host-vscode";

export interface RouterDeps {
  storage: SessionStorage;
  isValidDir: (p: string) => Promise<boolean>;
  browse: (path?: string) => Promise<unknown>;
  defaultWorkspace: string;
}

/** 解析 path 与 query */
function parsePath(rawPath: string): { path: string; query: URLSearchParams } {
  const qIndex = rawPath.indexOf("?");
  if (qIndex === -1) return { path: rawPath, query: new URLSearchParams() };
  return { path: rawPath.slice(0, qIndex), query: new URLSearchParams(rawPath.slice(qIndex + 1)) };
}

export class RequestRouter {
  constructor(private deps: RouterDeps) {}

  /**
   * 处理一个 REST 请求，返回响应数据；抛错表示请求失败（由调用方转 ok:false）。
   */
  async handle(method: string, rawPath: string, body: unknown): Promise<unknown> {
    const { path, query } = parsePath(rawPath);
    const d = this.deps;

    // ── Health ──
    if (path === "/health") {
      return { status: "ok", defaultWorkspace: d.defaultWorkspace };
    }

    // ── 目录浏览 ──
    if (path === "/api/fs/list") {
      return d.browse(query.get("path") || undefined);
    }
    if (path === "/api/fs/validate") {
      const p = query.get("path") || "";
      return { valid: p ? await d.isValidDir(p) : false };
    }

    // ── 会话 ──
    if (path === "/api/sessions" && method === "GET") {
      return { sessions: await d.storage.listSessions() };
    }
    const sessionIdMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionIdMatch) {
      const id = decodeURIComponent(sessionIdMatch[1]);
      if (method === "GET") {
        const s = await d.storage.getSession(id);
        if (!s) throw new Error("会话不存在");
        return s;
      }
      if (method === "DELETE") {
        await d.storage.deleteSession(id);
        return { ok: true };
      }
      if (method === "PATCH") {
        await d.storage.updateSession(id, (body || {}) as Record<string, never>);
        return { ok: true };
      }
    }

    // ── 工作区组（阶段 2 暂返回空，后续接 VS Code settings）──
    if (path === "/api/workspace-groups" && method === "GET") {
      return { groups: [] };
    }

    // ── Skills（列出可用 skill，供 Power 选择关联使用）──
    if (path === "/api/skills" && method === "GET") {
      try {
        const { SkillRegistry } = await import("@axon/core");
        const registry = new SkillRegistry([d.defaultWorkspace], createVSCodeAgentHost(), homedir());
        const metas = await registry.discover();
        return { skills: metas.map((m) => ({ name: m.name, description: m.description, source: m.source, disabled: m.disabled, dir: m.dir, skillFile: m.skillFile })) };
      } catch {
        return { skills: [] };
      }
    }
    // 读取 skill 目录下文件
    const skillFileMatch = path.match(/^\/api\/skills\/([^/]+)\/file$/);
    if (skillFileMatch && method === "GET") {
      const skillName = decodeURIComponent(skillFileMatch[1]);
      const relPath = query.get("path") || "SKILL.md";
      try {
        const { SkillRegistry } = await import("@axon/core");
        const { join } = await import("node:path");
        const { readFile } = await import("node:fs/promises");
        const registry = new SkillRegistry([d.defaultWorkspace], createVSCodeAgentHost(), homedir());
        const metas = await registry.discover();
        const meta = metas.find((m) => m.name === skillName);
        if (!meta || !meta.dir) throw new Error("skill 不存在");
        const content = await readFile(join(meta.dir, relPath), "utf-8");
        return { path: relPath, content };
      } catch (err) {
        throw new Error(`无法读取 skill 文件: ${(err as Error).message}`);
      }
    }

    // ── Relay ──
    if (path === "/api/relays" && method === "GET") {
      const ws = query.get("workspace") || d.defaultWorkspace;
      const store = new RelayStore(ws, createVSCodeAgentHost());
      return { relays: await store.list() };
    }
    const relayIdMatch = path.match(/^\/api\/relays\/([^/]+)$/);
    if (relayIdMatch) {
      const id = decodeURIComponent(relayIdMatch[1]);
      const ws = query.get("workspace") || d.defaultWorkspace;
      const store = new RelayStore(ws, createVSCodeAgentHost());
      if (method === "GET") {
        const relay = await store.get(id);
        if (!relay) throw new Error("relay 不存在");
        return relay;
      }
      if (method === "DELETE") {
        await store.remove(id);
        return { ok: true };
      }
    }
    const relayTaskMatch = path.match(/^\/api\/relays\/([^/]+)\/tasks\/([^/]+)$/);
    if (relayTaskMatch && method === "PATCH") {
      const id = decodeURIComponent(relayTaskMatch[1]);
      const taskId = decodeURIComponent(relayTaskMatch[2]);
      const ws = query.get("workspace") || d.defaultWorkspace;
      const status = (body as { status?: string } | undefined)?.status;
      if (!status || !["pending", "in_progress", "completed"].includes(status)) {
        throw new Error("status 非法");
      }
      const store = new RelayStore(ws, createVSCodeAgentHost());
      const relay = await store.setTaskStatus(id, taskId, status as "pending" | "in_progress" | "completed");
      if (!relay) throw new Error("relay 不存在");
      return relay;
    }

    // ── Powers ──
    if (path === "/api/powers" && method === "GET") {
      const ws = query.get("workspace") || d.defaultWorkspace;
      const { PowerRegistry } = await import("@axon/core");
      const registry = new PowerRegistry([ws], createVSCodeAgentHost(), homedir());
      return { powers: await registry.discover() };
    }
    const powerNameMatch = path.match(/^\/api\/powers\/([^/]+)$/);
    if (powerNameMatch) {
      const name = decodeURIComponent(powerNameMatch[1]);
      const ws = query.get("workspace") || d.defaultWorkspace;
      const { PowerRegistry } = await import("@axon/core");
      const registry = new PowerRegistry([ws], createVSCodeAgentHost(), homedir());
      if (method === "GET") {
        const power = await registry.load(name);
        if (!power) throw new Error("power 不存在");
        return power;
      }
      if (method === "DELETE") {
        const { rm } = await import("node:fs/promises");
        const metas = await registry.discover();
        const meta = metas.find((m) => m.name === name);
        if (!meta) throw new Error("power 不存在");
        await rm(meta.dir, { recursive: true, force: true });
        return { ok: true };
      }
    }
    const powerToggleMatch = path.match(/^\/api\/powers\/([^/]+)\/toggle$/);
    if (powerToggleMatch && method === "PATCH") {
      const name = decodeURIComponent(powerToggleMatch[1]);
      const ws = query.get("workspace") || d.defaultWorkspace;
      const enabled = !!(body as { enabled?: boolean } | undefined)?.enabled;
      const { PowerRegistry } = await import("@axon/core");
      const { writeFile, rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const registry = new PowerRegistry([ws], createVSCodeAgentHost(), homedir());
      const metas = await registry.discover();
      const meta = metas.find((m) => m.name === name);
      if (!meta) throw new Error("power 不存在");
      const markerPath = join(meta.dir, ".disabled");
      if (!enabled) {
        await writeFile(markerPath, "", "utf-8");
      } else {
        await rm(markerPath, { force: true });
      }
      return { ok: true, name, enabled };
    }
    const powerMcpMatch = path.match(/^\/api\/powers\/([^/]+)\/mcp$/);
    if (powerMcpMatch && method === "PUT") {
      const name = decodeURIComponent(powerMcpMatch[1]);
      const ws = query.get("workspace") || d.defaultWorkspace;
      const config = (body as { config?: unknown } | undefined)?.config;
      const { PowerRegistry } = await import("@axon/core");
      const { writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const registry = new PowerRegistry([ws], createVSCodeAgentHost(), homedir());
      const metas = await registry.discover();
      const meta = metas.find((m) => m.name === name);
      if (!meta) throw new Error("power 不存在");
      await writeFile(join(meta.dir, "mcp.json"), JSON.stringify(config, null, 2), "utf-8");
      return { ok: true };
    }

    // Power 内 Skill CRUD
    const powerSkillsMatch = path.match(/^\/api\/powers\/([^/]+)\/skills$/);
    if (powerSkillsMatch && method === "POST") {
      const powerName = decodeURIComponent(powerSkillsMatch[1]);
      const ws = query.get("workspace") || d.defaultWorkspace;
      const { skillName, description } = (body || {}) as { skillName?: string; description?: string };
      if (!skillName) throw new Error("skillName 必填");
      const { PowerRegistry } = await import("@axon/core");
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const registry = new PowerRegistry([ws], createVSCodeAgentHost(), homedir());
      const metas = await registry.discover();
      const meta = metas.find((m) => m.name === powerName);
      if (!meta) throw new Error("power 不存在");
      const slug = skillName.trim().toLowerCase().replace(/\s+/g, "-");
      const skillDir = join(meta.dir, "skills", slug);
      await mkdir(skillDir, { recursive: true });
      const desc = description || `Power ${powerName} 提供的 ${slug} 能力`;
      const template = `---\nname: ${slug}\ndescription: ${desc}\n---\n\n# ${slug}\n\n## 执行步骤\n\n1. 待补充\n`;
      await writeFile(join(skillDir, "SKILL.md"), template, "utf-8");
      return { ok: true, dir: skillDir };
    }
    const powerSkillDeleteMatch = path.match(/^\/api\/powers\/([^/]+)\/skills\/([^/]+)$/);
    if (powerSkillDeleteMatch && method === "DELETE") {
      const powerName = decodeURIComponent(powerSkillDeleteMatch[1]);
      const skillName = decodeURIComponent(powerSkillDeleteMatch[2]);
      const ws = query.get("workspace") || d.defaultWorkspace;
      const { PowerRegistry } = await import("@axon/core");
      const { rm } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const registry = new PowerRegistry([ws], createVSCodeAgentHost(), homedir());
      const metas = await registry.discover();
      const meta = metas.find((m) => m.name === powerName);
      if (!meta) throw new Error("power 不存在");
      await rm(join(meta.dir, "skills", skillName), { recursive: true, force: true });
      return { ok: true };
    }
    const powerSkillContentMatch = path.match(/^\/api\/powers\/([^/]+)\/skills\/([^/]+)\/content$/);
    if (powerSkillContentMatch && method === "PUT") {
      const powerName = decodeURIComponent(powerSkillContentMatch[1]);
      const skillName = decodeURIComponent(powerSkillContentMatch[2]);
      const ws = query.get("workspace") || d.defaultWorkspace;
      const content = (body as { content?: string } | undefined)?.content || "";
      const { PowerRegistry } = await import("@axon/core");
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const registry = new PowerRegistry([ws], createVSCodeAgentHost(), homedir());
      const metas = await registry.discover();
      const meta = metas.find((m) => m.name === powerName);
      if (!meta) throw new Error("power 不存在");
      const skillDir = join(meta.dir, "skills", skillName);
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), content, "utf-8");
      return { ok: true };
    }

    // Power 内 MCP Server CRUD
    const powerMcpServersMatch = path.match(/^\/api\/powers\/([^/]+)\/mcp-servers$/);
    if (powerMcpServersMatch && method === "POST") {
      const powerName = decodeURIComponent(powerMcpServersMatch[1]);
      const ws = query.get("workspace") || d.defaultWorkspace;
      const { serverName, server } = (body || {}) as { serverName?: string; server?: { command: string; args?: string[] } };
      if (!serverName || !server?.command) throw new Error("serverName 和 server.command 必填");
      const { PowerRegistry } = await import("@axon/core");
      const { readFile, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const registry = new PowerRegistry([ws], createVSCodeAgentHost(), homedir());
      const metas = await registry.discover();
      const meta = metas.find((m) => m.name === powerName);
      if (!meta) throw new Error("power 不存在");
      const mcpPath = join(meta.dir, "mcp.json");
      let config: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
      try { config = JSON.parse(await readFile(mcpPath, "utf-8")); } catch { /* 空配置 */ }
      config.mcpServers[serverName] = server;
      await writeFile(mcpPath, JSON.stringify(config, null, 2), "utf-8");
      return { ok: true };
    }
    const powerMcpServerDeleteMatch = path.match(/^\/api\/powers\/([^/]+)\/mcp-servers\/([^/]+)$/);
    if (powerMcpServerDeleteMatch && method === "DELETE") {
      const powerName = decodeURIComponent(powerMcpServerDeleteMatch[1]);
      const serverName = decodeURIComponent(powerMcpServerDeleteMatch[2]);
      const ws = query.get("workspace") || d.defaultWorkspace;
      const { PowerRegistry } = await import("@axon/core");
      const { readFile, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const registry = new PowerRegistry([ws], createVSCodeAgentHost(), homedir());
      const metas = await registry.discover();
      const meta = metas.find((m) => m.name === powerName);
      if (!meta) throw new Error("power 不存在");
      const mcpPath = join(meta.dir, "mcp.json");
      let config: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
      try { config = JSON.parse(await readFile(mcpPath, "utf-8")); } catch { return { ok: true }; }
      delete config.mcpServers[serverName];
      await writeFile(mcpPath, JSON.stringify(config, null, 2), "utf-8");
      return { ok: true };
    }

    // ── 独立 MCP 配置（.axon/settings/mcp.json）──
    if (path === "/api/mcp" && method === "GET") {
      const ws = query.get("workspace") || d.defaultWorkspace;
      const { McpRegistry, PowerRegistry } = await import("@axon/core");
      const host = createVSCodeAgentHost();
      const pr = new PowerRegistry([ws], host, homedir());
      const reg = new McpRegistry([ws], host, homedir(), pr);
      // 直接读用户级 + 工作区级文件（不经过 McpConfigService——那是 server 侧的）
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const readConfig = async (p: string) => {
        try { return JSON.parse(await readFile(p, "utf-8")); } catch { return { mcpServers: {} }; }
      };
      const user = await readConfig(join(homedir(), ".axon", "settings", "mcp.json"));
      const workspace = await readConfig(join(ws, ".axon", "settings", "mcp.json"));
      return { user: { mcpServers: user.mcpServers || {} }, workspace: { mcpServers: workspace.mcpServers || {} } };
    }

    // ── 打开文件 Tab（webview 请求宿主用原生编辑器打开文件）──
    if (path === "/api/open-file" && method === "POST") {
      const filePath = (body as { path?: string } | undefined)?.path;
      if (!filePath) throw new Error("path 必填");
      const { existsSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      const { mkdir, writeFile } = await import("node:fs/promises");
      // 文件不存在时自动创建空 JSON 模板（mcp.json 场景）
      if (!existsSync(filePath)) {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, '{\n  "mcpServers": {}\n}\n', "utf-8");
      }
      await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: false });
      return { ok: true };
    }

    // ── 打开 MCP 配置文件（由后端解析真实路径，免去前端拼 homedir）──
    if (path === "/api/open-mcp-config" && method === "POST") {
      const { level: lv, workspace: ws } = (body || {}) as { level?: string; workspace?: string };
      const { join } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const { mkdir, writeFile } = await import("node:fs/promises");
      const configPath = lv === "workspace" && ws
        ? join(ws, ".axon", "settings", "mcp.json")
        : join(homedir(), ".axon", "settings", "mcp.json");
      const { dirname } = await import("node:path");
      if (!existsSync(configPath)) {
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, '{\n  "mcpServers": {}\n}\n', "utf-8");
      }
      await vscode.window.showTextDocument(vscode.Uri.file(configPath), { preview: false });
      return { ok: true };
    }

    // ── Provider 配置（.axon/settings/providers.json）──
    if (path === "/api/providers" && method === "GET") {
      const ws = query.get("workspace") || d.defaultWorkspace;
      const resolved = await resolveProviders(ws);
      return { providers: resolved.map(maskProvider), models: flattenProviderModels(resolved) };
    }
    if (path === "/api/providers/config" && method === "GET") {
      const ws = query.get("workspace") || undefined;
      return {
        user: await readProviderConfig("user"),
        workspace: ws ? await readProviderConfig("workspace", ws) : { providers: {}, builtinApiKeys: {} },
      };
    }
    const providerLevelMatch = path.match(/^\/api\/providers\/(user|workspace)$/);
    if (providerLevelMatch && method === "PUT") {
      const level = providerLevelMatch[1] as "user" | "workspace";
      const ws = query.get("workspace") || d.defaultWorkspace;
      await writeProviderConfig(level, (body as { config?: ProviderConfigFile } | undefined)?.config || {}, ws);
      await resolveProviders(ws);
      return { ok: true };
    }
    const providerCustomMatch = path.match(/^\/api\/providers\/(user|workspace)\/custom$/);
    if (providerCustomMatch && method === "POST") {
      const level = providerCustomMatch[1] as "user" | "workspace";
      const ws = query.get("workspace") || d.defaultWorkspace;
      const { name, entry } = (body || {}) as { name?: string; entry?: RawProviderEntry };
      await addCustomProvider(level, name || "", entry || {}, ws);
      await resolveProviders(ws);
      return { ok: true };
    }
    const providerDeleteMatch = path.match(/^\/api\/providers\/(user|workspace)\/custom\/([^/]+)$/);
    if (providerDeleteMatch && method === "DELETE") {
      const level = providerDeleteMatch[1] as "user" | "workspace";
      const ws = query.get("workspace") || d.defaultWorkspace;
      await removeCustomProvider(level, decodeURIComponent(providerDeleteMatch[2]), ws);
      await resolveProviders(ws);
      return { ok: true };
    }
    const providerModelsMatch = path.match(/^\/api\/providers\/(user|workspace)\/custom\/([^/]+)\/models$/);
    if (providerModelsMatch && method === "PUT") {
      const level = providerModelsMatch[1] as "user" | "workspace";
      const ws = query.get("workspace") || d.defaultWorkspace;
      const models = (body as { models?: ProviderModel[] } | undefined)?.models || [];
      await setCustomProviderModels(level, decodeURIComponent(providerModelsMatch[2]), models, ws);
      await resolveProviders(ws);
      return { ok: true };
    }
    if (path === "/api/providers/move" && method === "POST") {
      const { fromLevel, toLevel, name } = (body || {}) as { fromLevel?: string; toLevel?: string; name?: string };
      if (!fromLevel || !toLevel) throw new Error("fromLevel 和 toLevel 不能为空");
      if (!(fromLevel === "user" || fromLevel === "workspace")) throw new Error(`非法的 fromLevel：${fromLevel}`);
      if (!(toLevel === "user" || toLevel === "workspace")) throw new Error(`非法的 toLevel：${toLevel}`);
      const ws = query.get("workspace") || d.defaultWorkspace;
      await moveCustomProvider(fromLevel, toLevel, name || "", ws);
      await resolveProviders(ws);
      return { ok: true };
    }
    if (path === "/api/providers/probe-models" && method === "POST") {
      const { baseUrl, apiKey, name, level, workspace } = (body || {}) as { baseUrl?: string; apiKey?: string; name?: string; level?: string; workspace?: string };
      let url = (baseUrl || "").trim();
      let key = (apiKey || "").trim();
      if (!url && name) {
        const cfg = await readProviderConfig(level === "workspace" ? "workspace" : "user", workspace);
        const entry = (cfg.providers || {})[name] as RawProviderEntry | undefined;
        if (!entry) throw new Error(`provider 不存在：${name}`);
        url = (entry.baseUrl || "").trim();
        key = (entry.apiKey || "").trim();
      }
      return { models: await probeProviderModels(url, key) };
    }
    const providerKeyMatch = path.match(/^\/api\/providers\/(user|workspace)\/builtin-key$/);
    if (providerKeyMatch && method === "PUT") {
      const level = providerKeyMatch[1] as "user" | "workspace";
      const ws = query.get("workspace") || d.defaultWorkspace;
      const { name, apiKey } = (body || {}) as { name?: string; apiKey?: string };
      await setBuiltinProviderKey(level, name || "", apiKey || "", ws);
      await resolveProviders(ws);
      return { ok: true };
    }
    if (path === "/api/open-provider-config" && method === "POST") {
      const { level: lv, workspace: ws } = (body || {}) as { level?: string; workspace?: string };
      const configPath = providerConfigPath(lv === "workspace" ? "workspace" : "user", ws);
      const { existsSync } = await import("node:fs");
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      if (!existsSync(configPath)) {
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, '{\n  "providers": {},\n  "builtinApiKeys": {}\n}\n', "utf-8");
      }
      await vscode.window.showTextDocument(vscode.Uri.file(configPath), { preview: false });
      return { ok: true };
    }

    throw new Error(`未实现的接口: ${method} ${path}`);
  }
}

/** 基于 vscode.workspace.fs 的目录浏览（供 RequestRouter 注入），与 server fsBrowser 返回结构一致 */
export async function vscodeBrowse(path?: string): Promise<unknown> {
  const isWindows = process.platform === "win32";
  const { join, parse, sep } = await import("node:path");

  async function listSubDirs(dirPath: string): Promise<{ name: string; path: string }[]> {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
    const dirs: { name: string; path: string }[] = [];
    for (const [name, type] of entries) {
      if ((type & vscode.FileType.Directory) === 0) continue;
      if (name.startsWith("$")) continue;
      dirs.push({ name, path: join(dirPath, name) });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    return dirs;
  }

  if (!path) {
    if (isWindows) {
      const drives: { name: string; path: string }[] = [];
      for (let c = 67; c <= 90; c++) {
        const letter = String.fromCharCode(c);
        const root = `${letter}:${sep}`;
        try {
          await vscode.workspace.fs.readDirectory(vscode.Uri.file(root));
          drives.push({ name: `${letter}:`, path: root });
        } catch { /* skip */ }
      }
      return { current: "", parent: null, isRoot: true, entries: drives };
    }
    return { current: "/", parent: null, isRoot: false, entries: await listSubDirs("/") };
  }

  const entries = await listSubDirs(path);
  let parent: string | null;
  const parsed = parse(path);
  if (parsed.dir === path || parsed.root === path) parent = isWindows ? "" : null;
  else parent = parsed.dir;
  return { current: path, parent, isRoot: false, entries };
}


// ─── Provider 配置文件操作（providers.json）─────────────────────────────────
// 扩展形态内联实现（对称于 server 的 ProviderConfigService），文件 CRUD 用 node:fs。

/** 解析某 level 的 providers.json 路径 */
function providerConfigPath(level: "user" | "workspace", workspace?: string): string {
  const { join } = require("node:path") as typeof import("node:path");
  if (level === "workspace") {
    if (!workspace) throw new Error("工作区级配置需要 workspace 参数");
    return join(workspace, ".axon", "settings", "providers.json");
  }
  return join(homedir(), ".axon", "settings", "providers.json");
}

/** 读某 level 的 providers.json（不存在/损坏返回空配置） */
async function readProviderConfig(level: "user" | "workspace", workspace?: string): Promise<ProviderConfigFile> {
  const { readFile } = await import("node:fs/promises");
  try {
    const parsed = JSON.parse(await readFile(providerConfigPath(level, workspace), "utf-8")) as ProviderConfigFile;
    return { providers: parsed.providers || {}, builtinApiKeys: parsed.builtinApiKeys || {} };
  } catch {
    return { providers: {}, builtinApiKeys: {} };
  }
}

/** 覆盖写某 level 的 providers.json */
async function writeProviderConfig(level: "user" | "workspace", config: ProviderConfigFile, workspace?: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const normalized: ProviderConfigFile = { providers: config.providers || {}, builtinApiKeys: config.builtinApiKeys || {} };
  const p = providerConfigPath(level, workspace);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(normalized, null, 2), "utf-8");
}

/** 新增/覆盖自定义 provider */
async function addCustomProvider(level: "user" | "workspace", name: string, entry: RawProviderEntry, workspace?: string): Promise<void> {
  const key = name.trim();
  if (!key) throw new Error("provider 名称不能为空");
  if (RESERVED_PROVIDER_NAMES.includes(key)) throw new Error(`「${key}」是内置 provider 的保留名，不能自定义`);
  if (!entry.baseUrl?.trim()) throw new Error("baseUrl 必填");
  const config = await readProviderConfig(level, workspace);
  config.providers = config.providers || {};
  config.providers[key] = entry;
  await writeProviderConfig(level, config, workspace);
}

/** 删除自定义 provider */
async function removeCustomProvider(level: "user" | "workspace", name: string, workspace?: string): Promise<void> {
  const config = await readProviderConfig(level, workspace);
  if (!config.providers || !(name in config.providers)) throw new Error(`provider 不存在：${name}`);
  delete config.providers[name];
  await writeProviderConfig(level, config, workspace);
}

/** 在用户级 / 工作区级之间迁移自定义 provider（迁移后源层级删除） */
async function moveCustomProvider(
  fromLevel: "user" | "workspace",
  toLevel: "user" | "workspace",
  name: string,
  workspace?: string,
): Promise<void> {
  if (fromLevel === toLevel) throw new Error("源层级与目标层级相同，无需迁移");
  if (RESERVED_PROVIDER_NAMES.includes(name)) throw new Error(`「${name}」是内置 provider，不能迁移`);

  const fromConfig = await readProviderConfig(fromLevel, workspace);
  const entry = (fromConfig.providers || {})[name] as RawProviderEntry | undefined;
  if (!entry) throw new Error(`provider 不存在：${name}`);

  const toConfig = await readProviderConfig(toLevel, workspace);
  toConfig.providers = toConfig.providers || {};
  toConfig.providers[name] = entry;

  delete fromConfig.providers![name];

  await writeProviderConfig(toLevel, toConfig, workspace);
  await writeProviderConfig(fromLevel, fromConfig, workspace);
}

/** 设置内置 provider 的 apiKey 覆盖 */
async function setBuiltinProviderKey(level: "user" | "workspace", name: string, apiKey: string, workspace?: string): Promise<void> {
  if (!RESERVED_PROVIDER_NAMES.includes(name)) throw new Error(`「${name}」不是内置 provider`);
  const config = await readProviderConfig(level, workspace);
  config.builtinApiKeys = config.builtinApiKeys || {};
  if (apiKey.trim()) config.builtinApiKeys[name] = apiKey.trim();
  else delete config.builtinApiKeys[name];
  await writeProviderConfig(level, config, workspace);
}

/** 覆盖某自定义 provider 的模型数组（增/删/改/禁用整存；apiKey 等其它字段保留） */
async function setCustomProviderModels(level: "user" | "workspace", name: string, models: ProviderModel[], workspace?: string): Promise<void> {
  if (RESERVED_PROVIDER_NAMES.includes(name)) throw new Error(`「${name}」是内置 provider，模型不可修改`);
  const config = await readProviderConfig(level, workspace);
  const entry = (config.providers || {})[name] as RawProviderEntry | undefined;
  if (!entry) throw new Error(`provider 不存在：${name}`);
  entry.models = Array.isArray(models) ? models : [];
  await writeProviderConfig(level, config, workspace);
}

/** 用注册表解析并注入 core 运行时，返回解析结果 */
async function resolveProviders(workspace: string): Promise<ResolvedProvider[]> {
  const registry = new ProviderRegistry([workspace], createVSCodeAgentHost(), homedir());
  return refreshProviders(registry);
}

/** 去掉 apiKey 的脱敏 provider */
function maskProvider(p: ResolvedProvider) {
  const { apiKey: _omit, ...rest } = p;
  return rest;
}

/** 摊平成前端选择器用的扁平模型列表（仅含已配置 provider 的、未禁用的模型） */
function flattenProviderModels(providers: ResolvedProvider[]) {
  return providers
    .filter((p) => p.configured)
    .flatMap((p) =>
      p.models
        .filter((m) => !m.disabled)
        .map((m) => ({
          id: m.id, name: m.name, contextWindow: m.contextWindow, vision: !!m.vision,
          description: m.description || "", group: m.group || p.label, free: !!m.free,
          provider: p.name, builtin: p.builtin, tier: m.tier || "balanced",
        })),
    );
}
