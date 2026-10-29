/**
 * 连接器存储。
 *
 * 配置和密钥分两个文件：
 *   · ~/.axon/settings/connectors.json —— 用了哪个模板、叫什么、是否启用、非密钥字段
 *   · ~/.axon/secrets/connectors.json  —— 令牌 / 授权码 / 连接串（尽量设成仅本人可读）
 * 分开是为了让设置文件可以放心地打开、备份、贴给别人看，而不会顺带泄露密钥。
 * 两者都只在用户目录：连接器跟人走，不进任何工作区（仓库里的配置拿不到这些密钥）。
 *
 * 密钥永远不回传前端：前端只拿到「这个字段已保存」，修改时留空表示不变。
 */

import { dirname, join } from "node:path";
import type { HostFileSystem } from "../host/index.js";
import type { McpServerSpec } from "../mcp/types.js";
import { getConnectorTemplate, isSecretField, type ConnectorTemplate } from "./catalog.js";

export interface ConnectorRecord {
  id: string;
  templateId: string;
  name: string;
  enabled: boolean;
  /** 非密钥字段 */
  values: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

/** 给前端的视图：密钥只给「已保存」标记 */
export interface ConnectorView extends ConnectorRecord {
  savedSecrets: string[];
}

export interface ConnectorDraft {
  id?: string;
  templateId: string;
  name?: string;
  enabled?: boolean;
  values?: Record<string, string>;
  /** 只传用户这次填了的密钥；空字符串 = 不修改 */
  secrets?: Record<string, string>;
}

type SecretFile = Record<string, Record<string, string>>;

const MAX_CONNECTORS = 50;

export function connectorConfigPath(homeDir: string): string {
  return join(homeDir, ".axon", "settings", "connectors.json");
}

export function connectorSecretsPath(homeDir: string): string {
  return join(homeDir, ".axon", "secrets", "connectors.json");
}

async function readJson<T>(fs: HostFileSystem, path: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.read(path);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** 密钥文件尽量设成仅本人可读（宿主都跑在 Node 上；失败不影响功能） */
async function restrictPermissions(path: string): Promise<void> {
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(dirname(path), 0o700).catch(() => undefined);
    await chmod(path, 0o600);
  } catch { /* Windows 或非 Node 环境：忽略 */ }
}

/** 合并默认值 + 非密钥字段 + 密钥，得到 build 用的完整取值 */
function mergedValues(template: ConnectorTemplate, record: Pick<ConnectorRecord, "values">, secrets: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of template.fields) {
    const raw = isSecretField(field) ? secrets[field.key] : record.values[field.key];
    out[field.key] = (raw ?? field.default ?? "").toString();
  }
  return out;
}

/** 必填字段是否齐全；不齐的连接器不连接（返回缺失的字段名） */
export function missingFields(template: ConnectorTemplate, values: Record<string, string>): string[] {
  return template.fields.filter((f) => f.required && !values[f.key]?.trim()).map((f) => f.label);
}

/** 编译成 MCP server 规格 */
export function buildConnectorSpec(record: ConnectorRecord, secrets: Record<string, string>): McpServerSpec | null {
  const template = getConnectorTemplate(record.templateId);
  if (!template) return null;
  const values = mergedValues(template, record, secrets);
  if (missingFields(template, values).length > 0) return null;
  return { id: `connector:${record.id}`, name: record.name, source: "connector", ...template.build(values, { id: record.id }), disabled: !record.enabled };
}

/** 运行时用：所有启用且字段齐全的连接器 → MCP server 规格 */
export async function resolveConnectorSpecs(fs: HostFileSystem, homeDir: string, includeDisabled = false): Promise<McpServerSpec[]> {
  const config = await readJson<{ connectors?: ConnectorRecord[] }>(fs, connectorConfigPath(homeDir), {});
  const records = Array.isArray(config.connectors) ? config.connectors : [];
  if (records.length === 0) return [];
  const secrets = await readJson<SecretFile>(fs, connectorSecretsPath(homeDir), {});
  const specs: McpServerSpec[] = [];
  for (const record of records) {
    if (!record.enabled && !includeDisabled) continue;
    const spec = buildConnectorSpec(record, secrets[record.id] ?? {});
    if (spec) specs.push(spec);
  }
  return specs;
}

export class ConnectorStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly fs: HostFileSystem, private readonly homeDir: string) {}

  private async load(): Promise<{ records: ConnectorRecord[]; secrets: SecretFile }> {
    const config = await readJson<{ connectors?: ConnectorRecord[] }>(this.fs, connectorConfigPath(this.homeDir), {});
    const secrets = await readJson<SecretFile>(this.fs, connectorSecretsPath(this.homeDir), {});
    return { records: Array.isArray(config.connectors) ? config.connectors : [], secrets };
  }

  private async persist(records: ConnectorRecord[], secrets: SecretFile): Promise<void> {
    // 保留同文件里的其它设置（apps 等）
    const config = await readJson<Record<string, unknown>>(this.fs, connectorConfigPath(this.homeDir), {});
    await this.fs.write(connectorConfigPath(this.homeDir), JSON.stringify({ ...config, connectors: records }, null, 2));
    const secretsPath = connectorSecretsPath(this.homeDir);
    await this.fs.write(secretsPath, JSON.stringify(secrets, null, 2));
    await restrictPermissions(secretsPath);
  }

  /** 串行化读改写：连点保存不会互相覆盖 */
  private mutate<T>(fn: (records: ConnectorRecord[], secrets: SecretFile) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const { records, secrets } = await this.load();
      const result = fn(records, secrets);
      await this.persist(records, secrets);
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** 连接器的全局设置（目前只有 GitHub OAuth App 的 Client ID）；环境变量 AXON_GITHUB_CLIENT_ID 优先 */
  async appSettings(): Promise<{ githubClientId: string; githubClientIdFromEnv: boolean }> {
    const env = (typeof process !== "undefined" ? process.env.AXON_GITHUB_CLIENT_ID : "") || "";
    const config = await readJson<{ apps?: { githubClientId?: string } }>(this.fs, connectorConfigPath(this.homeDir), {});
    return { githubClientId: env || config.apps?.githubClientId || "", githubClientIdFromEnv: !!env };
  }

  setAppSettings(patch: { githubClientId?: string }): Promise<void> {
    const run = this.chain.then(async () => {
      const config = await readJson<Record<string, unknown>>(this.fs, connectorConfigPath(this.homeDir), {});
      const apps = { ...((config.apps as Record<string, unknown>) ?? {}), ...(patch.githubClientId !== undefined ? { githubClientId: patch.githubClientId.trim() } : {}) };
      await this.fs.write(connectorConfigPath(this.homeDir), JSON.stringify({ ...config, apps }, null, 2));
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async list(): Promise<ConnectorView[]> {
    const { records, secrets } = await this.load();
    return records.map((r) => ({ ...r, savedSecrets: Object.keys(secrets[r.id] ?? {}).filter((k) => secrets[r.id][k]) }));
  }

  /** 读出完整规格（测试连接用）；草稿里没填的密钥沿用已保存的 */
  async specFor(draft: ConnectorDraft): Promise<McpServerSpec> {
    const template = getConnectorTemplate(draft.templateId);
    if (!template) throw new Error(`未知的连接器类型：${draft.templateId}`);
    const { secrets } = await this.load();
    const saved = draft.id ? secrets[draft.id] ?? {} : {};
    const merged = { ...saved, ...Object.fromEntries(Object.entries(draft.secrets ?? {}).filter(([, v]) => v)) };
    const values = mergedValues(template, { values: draft.values ?? {} }, merged);
    const missing = missingFields(template, values);
    if (missing.length) throw new Error(`还没填：${missing.join("、")}`);
    return { id: `connector-probe:${draft.id ?? template.id}`, name: draft.name || template.name, source: "connector", ...template.build(values, { id: draft.id ?? template.id }) };
  }

  save(draft: ConnectorDraft, now = Date.now()): Promise<ConnectorView> {
    const template = getConnectorTemplate(draft.templateId);
    if (!template) return Promise.reject(new Error(`未知的连接器类型：${draft.templateId}`));
    return this.mutate((records, secrets) => {
      const existing = draft.id ? records.find((r) => r.id === draft.id) : undefined;
      if (!existing && records.length >= MAX_CONNECTORS) throw new Error(`连接器最多 ${MAX_CONNECTORS} 个`);
      const values: Record<string, string> = {};
      const secretPatch: Record<string, string> = {};
      for (const field of template.fields) {
        if (isSecretField(field)) {
          const v = draft.secrets?.[field.key];
          if (typeof v === "string" && v !== "") secretPatch[field.key] = v;
        } else {
          const v = draft.values?.[field.key];
          if (typeof v === "string") values[field.key] = v.trim();
        }
      }
      const id = existing?.id ?? `${template.id}-${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const record: ConnectorRecord = {
        id,
        templateId: template.id,
        name: (draft.name || "").trim().slice(0, 40) || existing?.name || template.name,
        enabled: draft.enabled ?? existing?.enabled ?? true,
        values,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing) records[records.indexOf(existing)] = record;
      else records.push(record);
      secrets[id] = { ...(secrets[id] ?? {}), ...secretPatch };
      const missing = missingFields(template, mergedValues(template, record, secrets[id]));
      if (missing.length) throw new Error(`还没填：${missing.join("、")}`);
      return { ...record, savedSecrets: Object.keys(secrets[id]).filter((k) => secrets[id][k]) };
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    return this.mutate((records) => {
      const record = records.find((r) => r.id === id);
      if (record) { record.enabled = enabled; record.updatedAt = Date.now(); }
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate((records, secrets) => {
      const index = records.findIndex((r) => r.id === id);
      if (index >= 0) records.splice(index, 1);
      delete secrets[id];
    });
  }
}
