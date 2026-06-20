/**
 * Provider 注册表 —— 聚合"内置目录 + providers.json 自定义 + 纯 env provider"，
 * 产出归一化的 ResolvedProvider[]（零形态依赖，读文件走注入的 host.fs）。
 *
 * 来源与优先级（同名后者覆盖前者）：
 *   · 内置目录（esign / zhipu）：baseUrl/协议/模型固定，apiKey 由 env 或 providers.json.builtinApiKeys 注入
 *   · 用户级：  ~/.axon/settings/providers.json
 *   · 工作区级：<workspace>/.axon/settings/providers.json
 *   · 纯 env：  PROVIDER_<NAME>_API_KEY/_BASE_URL（无模型元数据，仅保证 getClient 可用，向后兼容）
 *
 * 镜像 McpRegistry 的结构与约定。只负责"读 + 归一化 + 合并"，不负责建 client（那是 providers.ts 的事）。
 */

import { join } from "node:path";
import type { AgentHost } from "./host/index.js";
import { BUILTIN_PROVIDERS, type BuiltinProviderDef } from "./providerCatalog.js";
import {
  RESERVED_PROVIDER_NAMES,
  type ProviderConfigFile,
  type RawProviderEntry,
  type ResolvedProvider,
} from "./providerTypes.js";

/** 用户级 provider 配置路径：~/.axon/settings/providers.json */
export function userProviderConfigPath(homeDir: string): string {
  return join(homeDir, ".axon", "settings", "providers.json");
}

/** 工作区级 provider 配置路径：<workspace>/.axon/settings/providers.json */
export function workspaceProviderConfigPath(workspace: string): string {
  return join(workspace, ".axon", "settings", "providers.json");
}

/** 读某 PROVIDER_<NAME>_API_KEY 对应的 key（NAME 为大写） */
function envApiKey(name: string): string {
  return (process.env[`PROVIDER_${name.toUpperCase()}_API_KEY`] || "").trim();
}

/** 读某 PROVIDER_<NAME>_BASE_URL */
function envBaseUrl(name: string): string {
  return (process.env[`PROVIDER_${name.toUpperCase()}_BASE_URL`] || "").trim();
}

export class ProviderRegistry {
  constructor(
    private workspaces: string[],
    private host: AgentHost,
    private homeDir: string,
  ) {}

  /** 更新工作区列表 */
  setWorkspaces(workspaces: string[]): void {
    this.workspaces = workspaces;
  }

  /** 解析出全部 provider（内置 + 自定义 + 纯 env），同名后者覆盖前者 */
  async resolve(): Promise<ResolvedProvider[]> {
    const file = await this.readMergedConfig();
    const byName = new Map<string, ResolvedProvider>();

    // 1) 内置目录（apiKey 由 builtinApiKeys 覆盖，否则取 env）
    for (const def of BUILTIN_PROVIDERS) {
      byName.set(def.name, this.fromBuiltin(def, file.builtinApiKeys?.[def.name]));
    }

    // 2) 自定义 provider（保留名不可占用）
    for (const [name, entry] of Object.entries(file.providers || {})) {
      if (RESERVED_PROVIDER_NAMES.includes(name)) continue;
      byName.set(name, this.fromCustom(name, entry));
    }

    // 3) 纯 env provider（既非内置也非自定义，向后兼容老配置）
    for (const name of this.envProviderNames()) {
      if (byName.has(name)) continue;
      byName.set(name, this.fromEnv(name));
    }

    return [...byName.values()];
  }

  /** 合并读取用户级 + 各工作区级 providers.json（providers/builtinApiKeys 同名后者覆盖前者） */
  private async readMergedConfig(): Promise<ProviderConfigFile> {
    const merged: ProviderConfigFile = { providers: {}, builtinApiKeys: {} };
    const apply = (cfg: ProviderConfigFile) => {
      Object.assign(merged.providers!, cfg.providers || {});
      Object.assign(merged.builtinApiKeys!, cfg.builtinApiKeys || {});
    };
    apply(await this.readFile(userProviderConfigPath(this.homeDir)));
    for (const ws of this.workspaces) {
      apply(await this.readFile(workspaceProviderConfigPath(ws)));
    }
    return merged;
  }

  /** 读单个 providers.json，文件不存在/损坏返回空配置 */
  private async readFile(path: string): Promise<ProviderConfigFile> {
    const raw = await this.host.fs.read(path);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as ProviderConfigFile;
    } catch {
      return {}; // 配置损坏不应炸掉解析
    }
  }

  /** 内置定义 → ResolvedProvider */
  private fromBuiltin(def: BuiltinProviderDef, keyOverride?: string): ResolvedProvider {
    const apiKey = (keyOverride || envApiKey(def.name)).trim();
    return {
      name: def.name,
      label: def.label,
      baseUrl: def.baseUrl,
      apiKey,
      apiKeyHeader: def.apiKeyHeader || "bearer",
      protocol: def.protocol,
      models: def.models,
      builtin: true,
      locked: def.locked,
      configured: !!apiKey,
      source: "builtin",
    };
  }

  /** providers.json 自定义条目 → ResolvedProvider */
  private fromCustom(name: string, entry: RawProviderEntry): ResolvedProvider {
    const apiKey = (entry.apiKey || "").trim();
    return {
      name,
      label: entry.label?.trim() || name,
      baseUrl: (entry.baseUrl || "").trim(),
      apiKey,
      apiKeyHeader: entry.apiKeyHeader || "bearer",
      protocol: entry.protocol === "responses" ? "responses" : "chat",
      models: Array.isArray(entry.models) ? entry.models : [],
      builtin: false,
      locked: false,
      configured: !!apiKey && !!entry.baseUrl,
      source: "custom",
    };
  }

  /** 纯 env provider → ResolvedProvider（无模型元数据） */
  private fromEnv(name: string): ResolvedProvider {
    const apiKey = envApiKey(name);
    return {
      name,
      label: name,
      baseUrl: envBaseUrl(name),
      apiKey,
      apiKeyHeader: "bearer",
      protocol: "chat",
      models: [],
      builtin: false,
      locked: false,
      configured: !!apiKey,
      source: "env",
    };
  }

  /** 扫描 env 里所有 PROVIDER_<NAME>_API_KEY 的小写 name */
  private envProviderNames(): string[] {
    return Object.keys(process.env)
      .map((k) => k.match(/^PROVIDER_(\w+)_API_KEY$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map((m) => m[1].toLowerCase());
  }
}

// ─── 端点模型探测（best-effort）────────────────────────────────────────────

/** 从端点 GET /models 探测到的单个模型（窗口/多模态可能为空，取决于 provider 是否返回） */
export interface ProbedModel {
  id: string;
  name?: string;
  contextWindow?: number;
  vision?: boolean;
}

/**
 * best-effort 从 OpenAI 兼容端点拉取模型列表：GET {baseUrl}/models。
 * 标准响应只有 id；OpenRouter 等扩展了 context_length / architecture.input_modalities 时一并解析。
 * 网络调用走全局 fetch（Node 18+ / 浏览器均有），15s 超时。
 */
export async function probeProviderModels(baseUrl: string, apiKey: string): Promise<ProbedModel[]> {
  if (!baseUrl.trim()) throw new Error("baseUrl 不能为空");
  const url = baseUrl.trim().replace(/\/+$/, "") + "/models";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {},
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const json: unknown = await res.json();
    const data = Array.isArray(json)
      ? json
      : Array.isArray((json as { data?: unknown[] })?.data)
        ? (json as { data: unknown[] }).data
        : [];
    return data.map(parseProbedModel).filter((m) => !!m.id);
  } catch (err) {
    const e = err as Error;
    throw new Error(e.name === "AbortError" ? "拉取超时（15s）" : `拉取模型失败：${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 把一条原始 model 记录归一化为 ProbedModel（兼容 OpenAI / OpenRouter 等字段差异） */
function parseProbedModel(raw: unknown): ProbedModel {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = String(r.id || r.model || r.name || "");
  const ctxRaw = r.context_length ?? r.context_window ?? r.max_context_length ?? r.max_tokens;
  const contextWindow = typeof ctxRaw === "number" && ctxRaw > 0 ? ctxRaw : undefined;
  const arch = (r.architecture && typeof r.architecture === "object" ? r.architecture : {}) as Record<string, unknown>;
  const mod = arch.input_modalities ?? arch.modality ?? r.modalities;
  let vision: boolean | undefined;
  if (Array.isArray(mod)) vision = mod.some((x) => String(x).includes("image"));
  else if (typeof mod === "string") vision = mod.includes("image");
  return { id, name: typeof r.name === "string" ? r.name : undefined, contextWindow, vision };
}
