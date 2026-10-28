/**
 * 用量查询的宿主侧适配：凭证安全存储 + 总览缓存。规则执行本身在 core（quota/engine.ts）。
 *
 * 凭证按「provider 名 + baseUrl 的 origin」保存：只按名字存的话，工作区配置里定义一个同名 provider、
 * 把 baseUrl 指到别处，就能拿到用户为原 provider 保存的面板令牌 / Cookie。
 */

import type * as vscode from "vscode";
import { runQuotaRule, type QuotaResult, type QuotaRule, type QuotaSecrets, type ResolvedProvider } from "@axon/core";

function originOf(baseUrl: string): string {
  try { return new URL(baseUrl).origin; } catch { return ""; }
}

/** 规则是否受信：工作区里定义的 provider、或额度规则来自工作区的内置 provider 不受信 */
export function isQuotaTrusted(provider: ResolvedProvider): boolean {
  if (provider.quotaTrusted !== undefined) return provider.quotaTrusted;
  return provider.customLevel !== "workspace";
}

export function quotaSecrets(secrets: vscode.SecretStorage, provider: ResolvedProvider): QuotaSecrets {
  const prefix = `axon.providerQuota.${provider.name}@${originOf(provider.baseUrl)}`;
  // 旧版只按 provider 名保存。受信的 provider 读到旧值时迁移到新键；不受信的不读，避免被同名配置借用。
  const legacyPrefix = `axon.providerQuota.${provider.name}`;
  const trusted = isQuotaTrusted(provider);
  const read = async (key: string): Promise<string | undefined> => {
    const value = await secrets.get(`${prefix}.${key}`);
    if (value !== undefined || !trusted) return value;
    const legacy = await secrets.get(`${legacyPrefix}.${key}`);
    if (legacy !== undefined) await secrets.store(`${prefix}.${key}`, legacy);
    return legacy;
  };
  return {
    async getAccessToken() {
      const raw = await read("accessToken");
      if (!raw) return undefined;
      try { return JSON.parse(raw) as { value: string; expiresAt?: number }; } catch { return { value: raw }; }
    },
    setAccessToken: async (value, expiresAt) => { await secrets.store(`${prefix}.accessToken`, JSON.stringify({ value, expiresAt })); },
    getRefreshToken: () => read("refreshToken"),
    setRefreshToken: async (value) => { await secrets.store(`${prefix}.refreshToken`, value); },
    getCookie: () => read("cookie"),
    setCookie: async (value) => { await secrets.store(`${prefix}.cookie`, value); },
  };
}

/** 清除某 provider 保存的全部额度凭证 */
export async function clearQuotaSecrets(secrets: vscode.SecretStorage, provider: ResolvedProvider): Promise<void> {
  const prefix = `axon.providerQuota.${provider.name}@${originOf(provider.baseUrl)}`;
  await Promise.all(["accessToken", "refreshToken", "cookie"].map((key) => secrets.delete(`${prefix}.${key}`)));
}

export function queryProvider(provider: ResolvedProvider, rule: QuotaRule, secrets: vscode.SecretStorage): Promise<QuotaResult> {
  return runQuotaRule({ ...provider, quotaTrusted: isQuotaTrusted(provider) }, rule, { secrets: quotaSecrets(secrets, provider) });
}

// ── 用量总览 ──────────────────────────────────────────────────────────────

export interface QuotaOverviewEntry {
  name: string;
  label: string;
  preset?: string;
  result?: QuotaResult;
  error?: string;
  updatedAt: number;
}

/** 总览缓存有效期：打开面板、切换模型都会读总览，没必要每次都打一遍各家接口 */
const OVERVIEW_TTL_MS = 3 * 60 * 1000;
const overviewCache = new Map<string, QuotaOverviewEntry & { key: string }>();

function cacheKey(provider: ResolvedProvider): string {
  return `${provider.baseUrl}\n${JSON.stringify(provider.quota)}`;
}

/** 所有启用了用量查询的 provider 并行查询；force=false 时三分钟内复用上次结果 */
export async function quotaOverview(providers: ResolvedProvider[], secrets: vscode.SecretStorage, force = false): Promise<QuotaOverviewEntry[]> {
  const enabled = providers.filter((p) => p.quota && p.quota.enabled !== false);
  const now = Date.now();
  return Promise.all(enabled.map(async (provider) => {
    const key = cacheKey(provider);
    const cached = overviewCache.get(provider.name);
    if (!force && cached && cached.key === key && now - cached.updatedAt < OVERVIEW_TTL_MS) {
      const { key: _key, ...entry } = cached;
      return entry;
    }
    const entry: QuotaOverviewEntry = { name: provider.name, label: provider.label, preset: provider.quota?.preset, updatedAt: Date.now() };
    try {
      entry.result = await queryProvider(provider, provider.quota!, secrets);
    } catch (error) {
      entry.error = (error as Error).message || "查询失败";
    }
    overviewCache.set(provider.name, { ...entry, key });
    return entry;
  }));
}

/** 规则或凭证变了：丢掉该 provider 的缓存 */
export function invalidateQuotaOverview(name?: string): void {
  if (name) overviewCache.delete(name);
  else overviewCache.clear();
}
