/**
 * RequestRouter —— webview 形态下 REST 请求的服务端（对称于 server 的 Express 路由）
 *
 * 浏览器形态里 web UI 通过 HTTP 调 server 的 REST 接口；webview 形态没有 HTTP server，
 * UI 改用 postMessage 发 { __axonReq, id, method, path, body }，由本路由解析 path
 * 调对应能力（storage / browser / RelayStore 等），把结果用 { __axonRes, id, ok, data }
 * 回传。路径与返回结构与 server Express 路由保持一致，使前端 apiClient 零改动复用。
 */

import { readJsonConfig, writeJsonConfig } from "./safeConfigFile.js";
import * as vscode from "vscode";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RelayStore, renameSessionTitle, ProviderRegistry, refreshProviders, probeProviderModels, RESERVED_PROVIDER_NAMES, assertUniqueModelIds, supportsThinking, providerEnvKeys, stripProviderEnvLines, type SessionStorage, type ResolvedProvider, type ProviderConfigFile, type ProviderModel, type RawProviderEntry, type ProviderQuotaConfig, normalizePricing, validateQuotaRule, presetsForBaseUrl, detectQuota } from "@axon/core";
import { createVSCodeAgentHost } from "@axon/host-vscode";
import { queryProvider, quotaSecrets, clearQuotaSecrets, quotaTokenStatus, saveQuotaTokens, quotaOverview, invalidateQuotaOverview } from "./quotaService.js";
import { createMarketplaceRegistry, persistSourcesToSettings } from "./marketplaceBridge.js";
import { listInputDevices, startRecording, stopRecording, takeLevels, transcribe } from "./voiceInput.js";

const execFileAsync = promisify(execFile);

export interface RouterDeps {
  storage: SessionStorage;
  secrets: vscode.SecretStorage;
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

/**
 * relay 的候选落盘根：请求指定的工作区（缺省用默认工作区）+ 主目录。
 * Agent 把 relay 写进会话工作区的 .axon/relays/，主目录下可能有历史遗留，故合并读取。
 */
function relayRoots(query: URLSearchParams, defaultWorkspace: string): string[] {
  const ws = query.get("workspace") || defaultWorkspace;
  return [ws, homedir()];
}

/**
 * 在 baseDir 内安全地解析相对路径：任何 `..` 逃逸都直接抛错。
 *
 * Power 的文件读写把用户给的相对路径直接拼到磁盘路径上，不做校验的话
 * 一句 `../../.ssh/id_rsa` 就能读写到能力包目录之外。与 skillUrlImport.ts
 * 里的同名工具同口径：解析后用 `startsWith(base + sep)` 判定边界。
 */
function safeJoinInside(baseDir: string, rel: string): string {
  const base = resolve(baseDir);
  const target = resolve(base, rel);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`路径越界：${rel}`);
  }
  return target;
}

/** 清理指定工作区中 axios 创建的 git 快照 ref */
async function cleanupSnapshotRefs(workspace: string): Promise<void> {
  try {
    const { stdout: out } = await execFileAsync("git", ["for-each-ref", "--format=%(refname:short)", "refs/axon/snapshots/"], { cwd: workspace, timeout: 5000, maxBuffer: 256 * 1024 });
    const refs = out.trim().split("\n").filter(Boolean);
    if (refs.length === 0) return;
    // 批量删除：git update-ref -d ref1 ref2 ...
    await execFileAsync("git", ["update-ref", "-d", ...refs], { cwd: workspace, timeout: 5000, maxBuffer: 256 * 1024 });
    console.debug(`[snapshot] cleanup: deleted ${refs.length} refs from ${workspace}`);
  } catch {
    // 清理失败不影响删除流程
  }
}

export class RequestRouter {
  constructor(private deps: RouterDeps) { }

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
        // 删除前读取 session 获取工作区路径，清理 git 快照 ref 和 relay 数据
        const s = await d.storage.getSession(id);
        if (s) {
          const wsList = s.workspaces?.length ? s.workspaces : (s.workspace ? [s.workspace] : []);
          for (const ws of wsList) {
            await cleanupSnapshotRefs(ws);
          }
          // 注：relay 独立于 session，删除会话不再连带删除 relay
        }
        await d.storage.deleteSession(id);
        return { ok: true };
      }
      if (method === "PATCH") {
        // 重命名：标题与其它会话去重，返回最终标题（可能带了「 (2)」序号），前端据此更新
        const { title, ...rest } = (body || {}) as Record<string, unknown>;
        if (Object.keys(rest).length > 0) await d.storage.updateSession(id, rest as Record<string, never>);
        const finalTitle = typeof title === "string" ? await renameSessionTitle(d.storage, id, title) : null;
        return { ok: true, ...(finalTitle ? { title: finalTitle } : {}) };
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
    // 某个 skill 目录的完整文件树（SkillStudio 文件管理视图用）。
    // 一个技能包不止 SKILL.md：scripts/、assets/、references/ 都要能看到。
    // 此前 VS Code 宿主只实现了 /file 单文件读取，这条路由缺失，文件树必定加载失败。
    const skillTreeMatch = path.match(/^\/api\/skills\/([^/]+)\/tree$/);
    if (skillTreeMatch && method === "GET") {
      const skillName = decodeURIComponent(skillTreeMatch[1]);
      const ws = query.get("workspace") || d.defaultWorkspace;
      try {
        const { SkillRegistry } = await import("@axon/core");
        const registry = new SkillRegistry([ws], createVSCodeAgentHost(), homedir());
        const meta = (await registry.discover()).find((m) => m.name === skillName);
        if (!meta || !meta.dir) throw new Error("skill 不存在或没有磁盘目录");

        const { readdir } = await import("node:fs/promises");
        const { join } = await import("node:path");
        interface TreeFileNode {
          name: string;
          path: string;
          type: "file" | "directory";
          children?: TreeFileNode[];
        }
        const walk = async (absDir: string, relDir: string, depth: number): Promise<TreeFileNode[]> => {
          if (depth > 6) return []; // 防深层目录把响应撑爆
          const entries = await readdir(absDir, { withFileTypes: true });
          const nodes: TreeFileNode[] = [];
          const sorted = entries
            .filter((entry) => !entry.name.startsWith("."))
            .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
          for (const entry of sorted) {
            const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              nodes.push({ name: entry.name, path: rel, type: "directory", children: await walk(join(absDir, entry.name), rel, depth + 1) });
            } else if (entry.isFile()) {
              nodes.push({ name: entry.name, path: rel, type: "file" });
            }
          }
          return nodes;
        };
        return { name: meta.name, dir: meta.dir, tree: await walk(meta.dir, "", 0) };
      } catch (err) {
        throw new Error(`无法读取 skill 文件树: ${(err as Error).message}`);
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

    // 删除整个 skill。
    // 这条路由此前缺失：SkillStudio 的删除按钮会打到 DELETE /api/skills/<name>，
    // 而 webview 形态只实现了 /api/skills 的 GET 与 /file 系列，于是删除必定失败
    // ——「删不掉」的另一半原因。补上它，并复用 core 的可删性判定。
    const skillDeleteMatch = path.match(/^\/api\/skills\/([^/]+)$/);
    if (skillDeleteMatch && method === "DELETE") {
      const skillName = decodeURIComponent(skillDeleteMatch[1]);
      const ws = query.get("workspace") || d.defaultWorkspace;
      const { SkillRegistry, PowerRegistry, skillDeleteRejection } = await import("@axon/core");
      const host = createVSCodeAgentHost();
      const powers = new PowerRegistry([ws], host, homedir());
      const registry = new SkillRegistry([ws], host, homedir(), () => powers.getActiveSkillDirs());
      const meta = (await registry.discover()).find((m) => m.name === skillName);
      if (!meta) throw new Error(`skill 不存在: ${skillName}`);
      const rejection = skillDeleteRejection(meta);
      if (rejection) throw new Error(rejection);
      const { rm } = await import("node:fs/promises");
      await rm(meta.dir, { recursive: true, force: true });
      return { ok: true };
    }

    // ── Relay ──
    if (path === "/api/relays" && method === "GET") {
      // 工作区 + 主目录合并读取（Agent 写在工作区，主目录可能有历史遗留）
      const store = new RelayStore(relayRoots(query, d.defaultWorkspace), createVSCodeAgentHost());
      return { relays: await store.list() };
    }
    const relayIdMatch = path.match(/^\/api\/relays\/([^/]+)$/);
    if (relayIdMatch) {
      const id = decodeURIComponent(relayIdMatch[1]);
      const store = new RelayStore(relayRoots(query, d.defaultWorkspace), createVSCodeAgentHost());
      if (method === "GET") {
        const relay = await store.get(id);
        if (!relay) throw new Error("relay 不存在");
        return relay;
      }
      if (method === "DELETE") {
        await store.remove(id);
        return { ok: true };
      }
      if (method === "PATCH") {
        const patch = body as { quality?: { mode?: string } } | undefined;
        const mode = patch?.quality?.mode;
        if (mode && (mode === "strict" || mode === "auto")) {
          const relay = await store.updateQuality(id, { mode });
          if (!relay) throw new Error("relay 不存在");
          return relay;
        }
        throw new Error("PATCH 仅支持 quality.mode 字段");
      }
    }
    const relayTaskMatch = path.match(/^\/api\/relays\/([^/]+)\/tasks\/([^/]+)$/);
    if (relayTaskMatch && method === "PATCH") {
      const id = decodeURIComponent(relayTaskMatch[1]);
      const taskId = decodeURIComponent(relayTaskMatch[2]);
      const status = (body as { status?: string } | undefined)?.status;
      if (!status || !["pending", "in_progress", "completed"].includes(status)) {
        throw new Error("status 非法");
      }
      const store = new RelayStore(relayRoots(query, d.defaultWorkspace), createVSCodeAgentHost());
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
        // 内置 power 在扩展包内，删了也会随升级回来；要隐藏请禁用它
        if (meta.source === "builtin") throw new Error("内置 Power 不可删除，如需隐藏请先禁用它");
        await rm(meta.dir, { recursive: true, force: true });
        return { ok: true };
      }
    }

    // Power 目录的完整文件树。
    //
    // Power 里通常不止 POWER.md 与 skills/：从 Claude 插件转换来的能力包还会带
    // styles/、core/、tools/、docs/ 这些资源目录，动辄上千个文件。没有这条路由，
    // 面板里只能看到「1 Skills」，用户会以为导入不完整（实际是面板没入口展示）。
    const powerTreeMatch = path.match(/^\/api\/powers\/([^/]+)\/tree$/);
    if (powerTreeMatch && method === "GET") {
      const name = decodeURIComponent(powerTreeMatch[1]);
      const ws = query.get("workspace") || d.defaultWorkspace;
      const { PowerRegistry } = await import("@axon/core");
      const registry = new PowerRegistry([ws], createVSCodeAgentHost(), homedir());
      const meta = (await registry.discover()).find((m) => m.name === name);
      if (!meta) throw new Error("power 不存在");
      const { readdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      interface TreeFileNode {
        name: string;
        path: string;
        type: "file" | "directory";
        children?: TreeFileNode[];
      }
      const walk = async (absDir: string, relDir: string, depth: number): Promise<TreeFileNode[]> => {
        if (depth > 6) return []; // 与 /api/skills/:name/tree 同口径：防深层目录把响应撑爆
        let entries: import("node:fs").Dirent[];
        try {
          entries = await readdir(absDir, { withFileTypes: true });
        } catch {
          return [];
        }
        const nodes: TreeFileNode[] = [];
        const sorted = entries
          .filter((entry) => !entry.name.startsWith("."))
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        for (const entry of sorted) {
          const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            nodes.push({ name: entry.name, path: rel, type: "directory", children: await walk(join(absDir, entry.name), rel, depth + 1) });
          } else if (entry.isFile()) {
            nodes.push({ name: entry.name, path: rel, type: "file" });
          }
        }
        return nodes;
      };
      return { name: meta.name, dir: meta.dir, tree: await walk(meta.dir, "", 0) };
    }

    // 读写 Power 目录下的单个文件（path 相对 power 根目录，"/" 分隔）
    const powerFileMatch = path.match(/^\/api\/powers\/([^/]+)\/file$/);
    if (powerFileMatch && (method === "GET" || method === "PUT")) {
      const name = decodeURIComponent(powerFileMatch[1]);
      const ws = query.get("workspace") || d.defaultWorkspace;
      const { PowerRegistry } = await import("@axon/core");
      const registry = new PowerRegistry([ws], createVSCodeAgentHost(), homedir());
      const meta = (await registry.discover()).find((m) => m.name === name);
      if (!meta) throw new Error("power 不存在");

      if (method === "GET") {
        const relPath = query.get("path") || "POWER.md";
        const abs = safeJoinInside(meta.dir, relPath);
        const { readFile } = await import("node:fs/promises");
        const content = await readFile(abs, "utf-8");
        return { path: relPath, content };
      }

      // PUT：写回。路径必须仍在 power 目录内（safeJoinInside 已挡 ../ 逃逸）。
      const { path: relPath, content } = (body || {}) as { path?: string; content?: string };
      if (!relPath) throw new Error("path 必填");
      const abs = safeJoinInside(meta.dir, relPath);
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content ?? "", "utf-8");
      return { ok: true, path: relPath };
    }

    const powerToggleMatch = path.match(/^\/api\/powers\/([^/]+)\/toggle$/);
    if (powerToggleMatch && method === "PATCH") {
      const name = decodeURIComponent(powerToggleMatch[1]);
      const ws = query.get("workspace") || d.defaultWorkspace;
      const enabled = !!(body as { enabled?: boolean } | undefined)?.enabled;
      const { PowerRegistry } = await import("@axon/core");
      const registry = new PowerRegistry([ws], createVSCodeAgentHost(), homedir());
      const metas = await registry.discover();
      const meta = metas.find((m) => m.name === name);
      if (!meta) throw new Error("power 不存在");
      // 交给 registry.setEnabled 分流：内置 power 写用户级启用名单，其余写自身目录的 .disabled
      await registry.setEnabled(meta, enabled);
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

    // ── Marketplace（Skill/Power 远程源）──
    if (path === "/api/marketplaces" && method === "GET") {
      const registry = await createMarketplaceRegistry();
      return { sources: await registry.listSources() };
    }
    if (path === "/api/marketplaces" && method === "POST") {
      const registry = await createMarketplaceRegistry();
      const source = (body || {}) as { name?: string; url?: string; description?: string };
      if (!source.name || !source.url) throw new Error("name 和 url 必填");
      await registry.addSource({ name: source.name, url: source.url, description: source.description });
      await persistSourcesToSettings(await registry.listSources());
      return { ok: true };
    }
    const marketplaceDeleteMatch = path.match(/^\/api\/marketplaces\/([^/]+)$/);
    if (marketplaceDeleteMatch && method === "DELETE") {
      const registry = await createMarketplaceRegistry();
      await registry.removeSource(decodeURIComponent(marketplaceDeleteMatch[1]));
      await persistSourcesToSettings(await registry.listSources());
      return { ok: true };
    }
    if (path === "/api/marketplaces/config/raw" && method === "GET") {
      const registry = await createMarketplaceRegistry();
      return { content: await registry.readRawConfig() };
    }
    if (path === "/api/marketplaces/config/raw" && method === "PUT") {
      const registry = await createMarketplaceRegistry();
      const content = (body as { content?: string } | undefined)?.content;
      if (typeof content !== "string") throw new Error("content 必须是字符串");
      await registry.writeRawConfig(content);
      await persistSourcesToSettings(await registry.listSources());
      return { ok: true };
    }
    const marketplaceItemsMatch = path.match(/^\/api\/marketplaces\/([^/]+)\/items$/);
    if (marketplaceItemsMatch && method === "GET") {
      const registry = await createMarketplaceRegistry();
      return { items: await registry.fetchItems(decodeURIComponent(marketplaceItemsMatch[1])) };
    }
    const marketplaceInstallMatch = path.match(/^\/api\/marketplaces\/([^/]+)\/install$/);
    if (marketplaceInstallMatch && method === "POST") {
      const sourceName = decodeURIComponent(marketplaceInstallMatch[1]);
      const { path: itemPath, kind, workspace } = (body || {}) as { path?: string; kind?: "skill" | "power"; workspace?: string };
      if (kind !== "skill" && kind !== "power") throw new Error("kind 必须是 skill 或 power");
      if (!itemPath) throw new Error("path 必填");
      const ws = workspace || d.defaultWorkspace;
      const { parseFrontmatter, parsePowerFrontmatter, globalSkillsDir, workspaceSkillsDir, globalPowersDir, workspacePowersDir } = await import("@axon/core");
      const { join } = await import("node:path");
      const { mkdir, writeFile } = await import("node:fs/promises");
      const registry = await createMarketplaceRegistry();
      const content = await registry.downloadItemContent(sourceName, itemPath);
      if (kind === "skill") {
        const { name } = parseFrontmatter(content);
        if (!name) throw new Error("SKILL.md 缺少 frontmatter 中的 name 字段");
        const baseDir = workspace ? workspaceSkillsDir(ws) : globalSkillsDir(homedir());
        const dir = join(baseDir, name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "SKILL.md"), content, "utf-8");
        return { ok: true, name, dir };
      } else {
        const { name } = parsePowerFrontmatter(content);
        if (!name) throw new Error("POWER.md 缺少 frontmatter 中的 name 字段");
        const baseDir = workspace ? workspacePowersDir(ws) : globalPowersDir(homedir());
        const dir = join(baseDir, name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "POWER.md"), content, "utf-8");
        return { ok: true, name, dir };
      }
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

    // ── 打开会话的记忆文件（~/.axon/sessions/<id>.json）──
    //
    // 记忆与会话同存一个 json 的 `memory` 字段，没有独立文件。所以这里做两件事：
    // ① 由宿主拼出真实路径（前端拿不到 homedir）；
    // ② 打开后把光标定位到 `"memory":` 那一行——否则用户面对的是一份几千行的会话档，
    //    得自己在里面翻。
    if (path === "/api/open-session-memory" && method === "POST") {
      const sessionId = (body as { sessionId?: string } | undefined)?.sessionId;
      if (!sessionId) throw new Error("sessionId 必填");
      // 会话 id 只会是 uuid / 时间戳这类字符；拦掉路径分隔符与 ..，
      // 免得 %2F..%2F 之类的输入把打开目标带到别处
      if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("sessionId 非法");
      const { join } = await import("node:path");
      const { existsSync } = await import("node:fs");
      const filePath = join(homedir(), ".axon", "sessions", `${sessionId}.json`);
      if (!existsSync(filePath)) throw new Error(`会话文件不存在：${filePath}`);

      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      // 找 `"memory":` 这一行（缩进后的顶层字段）。找不到说明这条会话还没沉淀过记忆。
      const lines = doc.getText().split("\n");
      const memoryLine = lines.findIndex((l) => /^\s*"memory"\s*:/.test(l));
      if (memoryLine >= 0) {
        const pos = new vscode.Position(memoryLine, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      } else {
        void vscode.window.showInformationMessage("这条会话还没有记忆内容，已打开它的会话文件。");
      }
      return { ok: true, path: filePath, hasMemory: memoryLine >= 0 };
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
    // 识图兜底模型：读（workspace 优先，回退 user）与写（指定 level）
    if (path === "/api/providers/vision-fallback" && method === "GET") {
      const ws = query.get("workspace") || undefined;
      const userCfg = await readProviderConfig("user");
      const wsCfg = ws ? await readProviderConfig("workspace", ws) : {};
      return { model: wsCfg.visionFallbackModel || userCfg.visionFallbackModel || null };
    }
    if (path === "/api/providers/vision-fallback" && method === "PUT") {
      const { model, level, workspace } = (body || {}) as { model?: string | null; level?: "user" | "workspace"; workspace?: string };
      const lv = level === "workspace" ? "workspace" : "user";
      const config = await readProviderConfig(lv, workspace);
      if (model) config.visionFallbackModel = model;
      else delete config.visionFallbackModel;
      await writeProviderConfig(lv, config, workspace);
      await resolveProviders(workspace || d.defaultWorkspace);
      return { ok: true };
    }
    // 语音输入：配置只存用户级；录音在扩展进程里做（webview 拿不到麦克风），识别复用 Provider 的地址和 Key
    if (path === "/api/voice/config" && method === "GET") {
      const cfg = (await readProviderConfig("user")).voiceInput;
      return { config: cfg ?? null, supported: true };
    }
    if (path === "/api/voice/config" && method === "PUT") {
      const { config: next } = (body || {}) as { config?: { provider?: string; model?: string; language?: string } | null };
      const config = await readProviderConfig("user");
      if (next?.provider && next.model?.trim()) {
        config.voiceInput = { provider: next.provider, model: next.model.trim(), ...(next.language?.trim() ? { language: next.language.trim() } : {}) };
      } else {
        delete config.voiceInput;
      }
      await writeProviderConfig("user", config);
      return { ok: true };
    }
    if (path === "/api/voice/devices" && method === "GET") {
      const [devices, config] = await Promise.all([listInputDevices().catch(() => []), readProviderConfig("user")]);
      return { devices, selected: config.voiceDevice ?? null };
    }
    if (path === "/api/voice/device" && method === "PUT") {
      const { device } = (body || {}) as { device?: { id?: string; name?: string } | null };
      const config = await readProviderConfig("user");
      if (device?.id && device.name) config.voiceDevice = { id: String(device.id), name: String(device.name) };
      else delete config.voiceDevice;
      await writeProviderConfig("user", config);
      return { ok: true };
    }
    if (path === "/api/voice/start" && method === "POST") {
      // monitor：设备菜单里试音，只看音量不识别，不要求先配好识别服务
      const { monitor } = (body || {}) as { monitor?: boolean };
      const config = await readProviderConfig("user");
      if (!monitor && !config.voiceInput) return { ok: false, needsConfig: true };
      await startRecording(config.voiceDevice ?? null);
      return { ok: true };
    }
    if (path === "/api/voice/levels" && method === "GET") {
      return takeLevels();
    }
    if (path === "/api/voice/stop" && method === "POST") {
      const { cancel } = (body || {}) as { cancel?: boolean };
      const wav = await stopRecording(!!cancel);
      if (!wav) return { text: "" };
      const cfg = (await readProviderConfig("user")).voiceInput;
      if (!cfg) return { ok: false, needsConfig: true };
      return { text: await transcribe(wav, cfg) };
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
    // 移除「纯环境变量来源」的 provider：摘它的真实来源 ~/.axon/.env，
    // 而不是 providers.json（那里根本没有它，走上面的 custom 删除必然报"不存在"）。
    const providerEnvDeleteMatch = path.match(/^\/api\/providers\/env\/([^/]+)$/);
    if (providerEnvDeleteMatch && method === "DELETE") {
      const name = decodeURIComponent(providerEnvDeleteMatch[1]).trim();
      if (!name) throw new Error("provider 名称不能为空");
      const { removed, file } = await removeProviderFromEnvFile(name);
      // 同步清掉进程内 env：core 每次 resolve 都读 process.env，
      // 这样当前窗口不必重启就能从列表消失（否则要等下次读 .env 才生效）。
      for (const k of providerEnvKeys(name)) delete process.env[k];
      // 若它同时由 VS Code 设置提供，改 .env 是删不掉的——如实上报，让前端能给出正确指引
      const upper = name.toUpperCase();
      const cfg = vscode.workspace.getConfiguration("axon");
      const envSetting = cfg.get<Record<string, string>>("env") || {};
      const providersSetting = cfg.get<Record<string, { apiKey?: string; baseUrl?: string }>>("providers") || {};
      const settingKeys = new Set(Object.keys(envSetting).map((k) => k.toUpperCase()));
      const fromSettings =
        settingKeys.has(`PROVIDER_${upper}_API_KEY`) ||
        settingKeys.has(`PROVIDER_${upper}_BASE_URL`) ||
        Object.keys(providersSetting).some((k) => k.toLowerCase() === name.toLowerCase());
      const ws = query.get("workspace") || d.defaultWorkspace;
      await resolveProviders(ws);
      return { ok: true, removed, file, fromSettings };
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
    // ── Provider 用量查询（规则执行在 core/quota；请求只在宿主发出，网页拿不到任何密钥）──
    const findProvider = async (name: string) => {
      const provider = (await resolveProviders(query.get("workspace") || d.defaultWorkspace)).find((item) => item.name === name);
      if (!provider) throw new Error(`provider 不存在：${name}`);
      return provider;
    };
    if (path === "/api/quota/overview" && method === "GET") {
      const providers = await resolveProviders(query.get("workspace") || d.defaultWorkspace);
      return { entries: await quotaOverview(providers, d.secrets, query.get("refresh") === "1") };
    }
    const providerQuotaMatch = path.match(/^\/api\/providers\/(user|workspace)\/([^/]+)\/quota$/);
    if (providerQuotaMatch && method === "PUT") {
      const level = providerQuotaMatch[1] as "user" | "workspace";
      const name = decodeURIComponent(providerQuotaMatch[2]);
      const quota = (body as { quota?: ProviderQuotaConfig | null } | undefined)?.quota;
      const config = await readProviderConfig(level, query.get("workspace") || d.defaultWorkspace);
      if (quota) validateQuotaRule(quota);
      if (RESERVED_PROVIDER_NAMES.includes(name)) {
        config.builtinQuota = config.builtinQuota || {};
        if (quota) config.builtinQuota[name] = quota;
        else delete config.builtinQuota[name];
      } else {
        const entry = config.providers?.[name];
        if (!entry) throw new Error(`provider 不存在：${name}`);
        if (quota) entry.quota = quota;
        else delete entry.quota;
      }
      await writeProviderConfig(level, config, query.get("workspace") || d.defaultWorkspace);
      invalidateQuotaOverview(name);
      return { ok: true };
    }
    // 计费单价：只用于回复底部的花费估算，不参与任何请求
    const providerPricingMatch = path.match(/^\/api\/providers\/(user|workspace)\/([^/]+)\/pricing$/);
    if (providerPricingMatch && method === "PUT") {
      const level = providerPricingMatch[1] as "user" | "workspace";
      const name = decodeURIComponent(providerPricingMatch[2]);
      if (RESERVED_PROVIDER_NAMES.includes(name)) throw new Error("官方 Provider 按 Credits 计费，不支持自定义单价");
      const pricing = normalizePricing((body as { pricing?: unknown } | undefined)?.pricing);
      const config = await readProviderConfig(level, query.get("workspace") || d.defaultWorkspace);
      const entry = config.providers?.[name];
      if (!entry) throw new Error(`provider 不存在：${name}`);
      if (pricing) entry.pricing = pricing;
      else delete entry.pricing;
      await writeProviderConfig(level, config, query.get("workspace") || d.defaultWorkspace);
      return { ok: true };
    }
    const providerQuotaPresetsMatch = path.match(/^\/api\/providers\/([^/]+)\/quota\/presets$/);
    if (providerQuotaPresetsMatch && method === "GET") {
      const provider = await findProvider(decodeURIComponent(providerQuotaPresetsMatch[1]));
      return { presets: presetsForBaseUrl(provider.baseUrl) };
    }
    const providerQuotaDetectMatch = path.match(/^\/api\/providers\/([^/]+)\/quota\/detect$/);
    if (providerQuotaDetectMatch && method === "POST") {
      const provider = await findProvider(decodeURIComponent(providerQuotaDetectMatch[1]));
      const detected = await detectQuota(provider, { secrets: quotaSecrets(d.secrets, provider) });
      return { presetId: detected.preset?.id, presetLabel: detected.preset?.label, rule: detected.rule, result: detected.result, attempts: detected.attempts };
    }
    const providerQuotaTestMatch = path.match(/^\/api\/providers\/([^/]+)\/quota\/test$/);
    if (providerQuotaTestMatch && method === "POST") {
      const provider = await findProvider(decodeURIComponent(providerQuotaTestMatch[1]));
      const quota = (body as { quota?: ProviderQuotaConfig } | undefined)?.quota;
      if (!quota) throw new Error("额度查询规则不能为空");
      return queryProvider(provider, quota, d.secrets);
    }
    const providerQuotaTokensMatch = path.match(/^\/api\/providers\/([^/]+)\/quota\/tokens$/);
    if (providerQuotaTokensMatch && method === "GET") {
      const provider = await findProvider(decodeURIComponent(providerQuotaTokensMatch[1]));
      return quotaTokenStatus(d.secrets, provider);
    }
    if (providerQuotaTokensMatch && method === "PUT") {
      const provider = await findProvider(decodeURIComponent(providerQuotaTokensMatch[1]));
      await saveQuotaTokens(d.secrets, provider, (body || {}) as { accessToken?: string; refreshToken?: string; cookie?: string });
      return { ok: true };
    }
    if (providerQuotaTokensMatch && method === "DELETE") {
      const provider = await findProvider(decodeURIComponent(providerQuotaTokensMatch[1]));
      await clearQuotaSecrets(d.secrets, provider);
      invalidateQuotaOverview(provider.name);
      return { ok: true };
    }
    const providerKeyMatch = path.match(/^\/api\/providers\/(user|workspace)\/builtin-key$/);
    if (providerKeyMatch && method === "PUT") {
      const level = providerKeyMatch[1] as "user" | "workspace";
      const ws = query.get("workspace") || d.defaultWorkspace;
      const { name, apiKey } = (body || {}) as { name?: string; apiKey?: string };
      await setBuiltinProviderKey(level, name || "", apiKey || "", ws);
      await resolveProviders(ws);
      if (name === "axon") {
        void vscode.commands.executeCommand("axon.usage.refresh");
      }
      return { ok: true };
    }
    const providerBaseUrlMatch = path.match(/^\/api\/providers\/(user|workspace)\/builtin-baseurl$/);
    if (providerBaseUrlMatch && method === "PUT") {
      const level = providerBaseUrlMatch[1] as "user" | "workspace";
      const ws = query.get("workspace") || d.defaultWorkspace;
      const { name, baseUrl } = (body || {}) as { name?: string; baseUrl?: string };
      await setBuiltinProviderBaseUrl(level, name || "", baseUrl || "", ws);
      await resolveProviders(ws);
      if (name === "axon") {
        void vscode.commands.executeCommand("axon.usage.refresh");
      }
      return { ok: true };
    }
    const providerBuiltinModelsMatch = path.match(/^\/api\/providers\/(user|workspace)\/builtin-models$/);
    if (providerBuiltinModelsMatch && method === "PUT") {
      const level = providerBuiltinModelsMatch[1] as "user" | "workspace";
      const ws = query.get("workspace") || d.defaultWorkspace;
      const { name, models } = (body || {}) as { name?: string; models?: ProviderModel[] };
      await setBuiltinProviderModels(level, name || "", models || [], ws);
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
  // 文件不存在 → 空配置；存在但损坏 → 抛错（不能当成空配置，否则下一次保存会把它整个覆盖掉）
  const parsed = await readJsonConfig<ProviderConfigFile>(providerConfigPath(level, workspace));
  if (!parsed) return { providers: {}, builtinApiKeys: {}, builtinBaseUrls: {}, builtinQuota: {} };
  {
    return {
      providers: parsed.providers || {},
      builtinApiKeys: parsed.builtinApiKeys || {},
      builtinBaseUrls: parsed.builtinBaseUrls || {},
      builtinModels: parsed.builtinModels || {},
      builtinQuota: parsed.builtinQuota || {},
      ...(parsed.visionFallbackModel ? { visionFallbackModel: parsed.visionFallbackModel } : {}),
      ...(parsed.voiceInput ? { voiceInput: parsed.voiceInput } : {}),
      ...(parsed.voiceDevice ? { voiceDevice: parsed.voiceDevice } : {}),
    };
  }
}

/** 覆盖写某 level 的 providers.json */
async function writeProviderConfig(level: "user" | "workspace", config: ProviderConfigFile, workspace?: string): Promise<void> {
  const normalized: ProviderConfigFile = {
    providers: config.providers || {},
    builtinApiKeys: config.builtinApiKeys || {},
    builtinBaseUrls: config.builtinBaseUrls || {},
    builtinModels: config.builtinModels || {},
    builtinQuota: config.builtinQuota || {},
    ...(config.visionFallbackModel ? { visionFallbackModel: config.visionFallbackModel } : {}),
    ...(config.voiceInput ? { voiceInput: config.voiceInput } : {}),
    ...(config.voiceDevice ? { voiceDevice: config.voiceDevice } : {}),
  };
  // 原子写 + 仅本人可读：文件里有 API Key
  await writeJsonConfig(providerConfigPath(level, workspace), normalized);
}

/** 新增/覆盖自定义 provider */
async function addCustomProvider(level: "user" | "workspace", name: string, entry: RawProviderEntry, workspace?: string): Promise<void> {
  const key = name.trim();
  if (!key) throw new Error("provider 名称不能为空");
  if (RESERVED_PROVIDER_NAMES.includes(key)) throw new Error(`「${key}」是内置 provider 的保留名，不能自定义`);
  if (!entry.baseUrl?.trim()) throw new Error("baseUrl 必填");
  assertUniqueModelIds(entry.models, key);
  const config = await readProviderConfig(level, workspace);
  config.providers = config.providers || {};
  const existing = config.providers[key];
  if (existing && typeof existing === "object") {
    // merge：已存在的字段只在新值非空时覆盖，apiKey 为空/未传则保留原值
    config.providers[key] = {
      ...existing,
      ...Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined && v !== "")),
    };
  } else {
    config.providers[key] = entry;
  }
  await writeProviderConfig(level, config, workspace);
}

/** 删除自定义 provider */
async function removeCustomProvider(level: "user" | "workspace", name: string, workspace?: string): Promise<void> {
  const config = await readProviderConfig(level, workspace);
  if (!config.providers || !(name in config.providers)) throw new Error(`provider 不存在：${name}`);
  delete config.providers[name];
  await writeProviderConfig(level, config, workspace);
}

/**
 * 从 ~/.axon/.env 摘掉某 provider 的配置行。
 *
 * 为什么必须单独一条路径：provider 有三个来源（内置 / providers.json 自定义 / 纯环境变量），
 * 面板把三类混在一起展示；而 env 来源的根本不在 providers.json 里，
 * 走 removeCustomProvider 只会报"provider 不存在"——用户看到的就是"删不掉、重启又回来"。
 * 要真正移除它，只能改它的真实来源。
 *
 * 逐行摘除而非重新序列化：保留用户的注释、空行与原有顺序，只删匹配的两行。
 */
async function removeProviderFromEnvFile(name: string): Promise<{ removed: string[]; file: string }> {
  const { readFile, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const file = join(homedir(), ".axon", ".env");
  let text: string;
  try {
    text = await readFile(file, "utf-8");
  } catch {
    return { removed: [], file }; // 文件不存在：无可摘除
  }
  // 摘行逻辑收敛在 core（纯函数、有单测、两种形态共用），这里只管读写文件
  const { text: next, removed } = stripProviderEnvLines(text, name);
  if (removed.length === 0) return { removed, file };
  await writeFile(file, next, "utf-8");
  return { removed, file };
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

/** 设置内置 provider 的 baseUrl 覆盖 */
async function setBuiltinProviderBaseUrl(level: "user" | "workspace", name: string, baseUrl: string, workspace?: string): Promise<void> {
  if (!RESERVED_PROVIDER_NAMES.includes(name)) throw new Error(`「${name}」不是内置 provider`);
  const config = await readProviderConfig(level, workspace);
  config.builtinBaseUrls = config.builtinBaseUrls || {};
  if (baseUrl.trim()) config.builtinBaseUrls[name] = baseUrl.trim();
  else delete config.builtinBaseUrls[name];
  await writeProviderConfig(level, config, workspace);
}

/** 覆盖某自定义 provider 的模型数组（增/删/改/禁用整存；apiKey 等其它字段保留） */
async function setCustomProviderModels(level: "user" | "workspace", name: string, models: ProviderModel[], workspace?: string): Promise<void> {
  if (RESERVED_PROVIDER_NAMES.includes(name)) throw new Error(`「${name}」是内置 provider，请用 builtin-models 接口`);
  assertUniqueModelIds(models, name);
  const config = await readProviderConfig(level, workspace);
  const entry = (config.providers || {})[name] as RawProviderEntry | undefined;
  if (!entry) throw new Error(`provider 不存在：${name}`);
  entry.models = Array.isArray(models) ? models : [];
  await writeProviderConfig(level, config, workspace);
}

/** 覆盖内置 provider 的模型数组（增/删整存；与 builtinApiKeys/builtinBaseUrls 同级持久化） */
async function setBuiltinProviderModels(level: "user" | "workspace", name: string, models: ProviderModel[], workspace?: string): Promise<void> {
  if (!RESERVED_PROVIDER_NAMES.includes(name)) throw new Error(`「${name}」不是内置 provider`);
  assertUniqueModelIds(models, name);
  const config = await readProviderConfig(level, workspace);
  config.builtinModels = config.builtinModels || {};
  if (Array.isArray(models) && models.length > 0) {
    config.builtinModels[name] = models;
  } else {
    delete config.builtinModels[name];
  }
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
          provider: p.name, builtin: p.builtin,
          // 下发**已解析**的思考能力（声明优先、启发式兜底），而不是原始声明：
          // web 是独立工程引用不到 @axon/core，判定逻辑只能留在后端一处，
          // 否则前端得照抄一份启发式，两边迟早不一致。
          thinking: supportsThinking(m.id, m.thinking),
          effortLevels: m.effortLevels,
          defaultEffort: m.defaultEffort,
        })),
    );
}

