import type { ResolvedProvider } from "@axon/core";
import type * as vscode from "vscode";

export interface QuotaQueryConfig {
  enabled?: boolean;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  auth?: {
    header?: string;
    prefix?: string;
    cookieHeader?: string;
    refreshBeforeSeconds?: number;
    refresh?: {
      url: string;
      method?: "GET" | "POST";
      headers?: Record<string, string>;
      query?: Record<string, string>;
      body?: unknown;
      accessTokenPath: string;
      refreshTokenPath?: string;
      expiresInPath?: string;
      expiresAtPath?: string;
    };
  };
  fields: {
    balance?: string;
    used?: string;
    total?: string;
    unit?: string;
    expiresAt?: string;
  };
}

export interface QuotaQueryResult {
  balance?: number;
  used?: number;
  total?: number;
  unit?: string;
  expiresAt?: string;
  resetAt?: number;
  updatedAt: number;
  responsePreview: string;
}

export interface QuotaTokenStore {
  getAccessToken(): Promise<{ value: string; expiresAt?: number } | undefined>;
  setAccessToken(value: string, expiresAt?: number): Promise<void>;
  getRefreshToken(): Promise<string | undefined>;
  setRefreshToken(value: string): Promise<void>;
  getCookie(): Promise<string | undefined>;
  setCookie(value: string): Promise<void>;
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;
const PATH_PATTERN = /^\$(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/;

type Tokens = { accessToken?: string; refreshToken?: string; cookie?: string };

/** 从完整 Cookie 请求头中读取指定键值，兼容 URL 编码的会话标识。 */
function cookieValue(cookie: string | undefined, key: string): string {
  if (!cookie) return "";
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${key}=`));
  if (!match) return "";
  const value = match.slice(key.length + 1);
  try { return decodeURIComponent(value); } catch { return value; }
}

function replaceVariables(value: string, provider: ResolvedProvider, tokens: Tokens = {}): string {
  const origin = new URL(provider.baseUrl).origin;
  return value
    .replaceAll("{{apiKey}}", provider.apiKey)
    .replaceAll("{{accessToken}}", tokens.accessToken || "")
    .replaceAll("{{refreshToken}}", tokens.refreshToken || "")
    .replaceAll("{{cookie}}", tokens.cookie || "")
    .replace(/\{\{cookie\.([^{}\s]+)\}\}/g, (_match, key: string) => cookieValue(tokens.cookie, key))
    .replaceAll("{{baseUrl}}", provider.baseUrl)
    .replaceAll("{{origin}}", origin);
}

function replaceInValue(value: unknown, provider: ResolvedProvider, tokens: Tokens): unknown {
  if (typeof value === "string") return replaceVariables(value, provider, tokens);
  if (Array.isArray(value)) return value.map((item) => replaceInValue(item, provider, tokens));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceInValue(item, provider, tokens)]));
  return value;
}

function extractPath(payload: unknown, path?: string): unknown {
  if (!path) return undefined;
  if (!PATH_PATTERN.test(path)) throw new Error(`字段路径不合法：${path}`);
  let current: unknown = payload;
  for (const token of path.match(/\.[A-Za-z_$][\w$]*|\[\d+\]/g) || []) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    const key = token.startsWith(".") ? token.slice(1) : Number(token.slice(1, -1));
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function numberField(payload: unknown, path?: string): number | undefined {
  const value = extractPath(payload, path);
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error(`字段 ${path} 不是有效数字`);
  return number;
}

function stringField(payload: unknown, path?: string): string | undefined {
  const value = extractPath(payload, path);
  return value === undefined || value === null ? undefined : String(value);
}

function timestampField(payload: unknown, path?: string): number | undefined {
  const value = numberField(payload, path);
  if (value === undefined || value === 0) return undefined;
  const milliseconds = value < 100_000_000_000 ? value * 1000 : value;
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

function redactPreview(text: string, apiKey: string, tokens: Tokens = {}): string {
  let redacted = text;
  for (const secret of [apiKey, tokens.accessToken, tokens.refreshToken, tokens.cookie]) {
    if (secret) redacted = redacted.replaceAll(secret, "***");
  }
  return redacted.length > 2_000 ? `${redacted.slice(0, 2_000)}…` : redacted;
}

function validatePath(path: string | undefined, label: string): void {
  if (path && !PATH_PATTERN.test(path)) throw new Error(`${label}字段路径不合法：${path}`);
}

export function validateQuotaQuery(config: QuotaQueryConfig): void {
  if (!config.url?.trim()) throw new Error("额度查询地址不能为空");
  if (!config.url.includes("{{baseUrl}}") && !config.url.includes("{{origin}}")) {
    const protocol = new URL(config.url).protocol;
    if (protocol !== "https:" && protocol !== "http:") throw new Error("额度查询地址仅支持 HTTP 或 HTTPS");
  }
  if (config.method && config.method !== "GET" && config.method !== "POST") throw new Error("额度查询仅支持 GET 或 POST");
  if (config.scale !== undefined && (!Number.isFinite(config.scale) || config.scale <= 0)) throw new Error("额度换算系数必须是大于 0 的数字");
  if (!config.fields || typeof config.fields !== "object") throw new Error("请至少配置一个响应字段");
  Object.values(config.fields).forEach((path) => validatePath(path, ""));
  const refresh = config.auth?.refresh;
  if (refresh) {
    if (!refresh.url?.trim() || !refresh.accessTokenPath) throw new Error("刷新接口地址和访问令牌字段不能为空");
    if (refresh.method && refresh.method !== "GET" && refresh.method !== "POST") throw new Error("刷新接口仅支持 GET 或 POST");
    [refresh.accessTokenPath, refresh.refreshTokenPath, refresh.expiresInPath, refresh.expiresAtPath].forEach((path) => validatePath(path, "刷新响应"));
  }
}

async function requestJson(url: URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error("额度查询超时（10 秒）");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshAccessToken(provider: ResolvedProvider, config: QuotaQueryConfig, store: QuotaTokenStore): Promise<string> {
  const refresh = config.auth?.refresh;
  if (!refresh) throw new Error("额度访问令牌已失效，未配置刷新接口");
  const refreshToken = await store.getRefreshToken();
  const cookie = await store.getCookie();
  if (!refreshToken && !cookie) throw new Error("额度访问令牌已失效，请保存 refreshToken 或 Cookie");
  const tokens = { refreshToken, cookie };
  const url = new URL(replaceVariables(refresh.url, provider, tokens));
  const headers = Object.fromEntries(Object.entries(refresh.headers || {}).map(([key, value]) => [key, replaceVariables(value, provider, tokens)]));
  if (config.auth?.cookieHeader && tokens.cookie && !Object.keys(headers).some((key) => key.toLowerCase() === config.auth!.cookieHeader!.toLowerCase())) {
    headers[config.auth.cookieHeader] = tokens.cookie;
  }
  for (const [key, value] of Object.entries(refresh.query || {})) url.searchParams.set(key, replaceVariables(value, provider, tokens));
  const method = refresh.method || "POST";
  const body = method === "POST" && refresh.body !== undefined ? JSON.stringify(replaceInValue(refresh.body, provider, tokens)) : undefined;
  if (body && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  const response = await requestJson(url, { method, headers, body });
  const text = await response.text();
  if (!response.ok) throw new Error(`刷新令牌失败：HTTP ${response.status}${text ? `：${redactPreview(text, provider.apiKey, tokens)}` : ""}`);
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw new Error("刷新接口未返回 JSON 响应"); }
  const accessToken = stringField(payload, refresh.accessTokenPath);
  if (!accessToken) throw new Error("刷新接口未返回访问令牌");
  const expiresIn = numberField(payload, refresh.expiresInPath);
  const expiresAtRaw = numberField(payload, refresh.expiresAtPath);
  const expiresAtText = expiresAtRaw === undefined ? stringField(payload, refresh.expiresAtPath) : undefined;
  const expiresAt = expiresIn !== undefined
    ? Date.now() + expiresIn * 1000
    : expiresAtRaw !== undefined
      ? (expiresAtRaw < 100_000_000_000 ? expiresAtRaw * 1000 : expiresAtRaw)
      : (expiresAtText ? Date.parse(expiresAtText) : undefined);
  await store.setAccessToken(accessToken, expiresAt && Number.isFinite(expiresAt) ? expiresAt : undefined);
  const rotatedRefreshToken = stringField(payload, refresh.refreshTokenPath);
  if (rotatedRefreshToken) await store.setRefreshToken(rotatedRefreshToken);
  return accessToken;
}

export async function queryProviderQuota(provider: ResolvedProvider, config: QuotaQueryConfig, store?: QuotaTokenStore): Promise<QuotaQueryResult> {
  if (!provider.apiKey && !config.auth?.header && !config.auth?.cookieHeader) throw new Error("Provider 未配置 API Key、独立额度 Token 或 Cookie");
  validateQuotaQuery(config);
  let accessToken = store ? await store.getAccessToken() : undefined;
  const refreshBeforeMs = Math.max(0, config.auth?.refreshBeforeSeconds || 0) * 1000;
  if (store && config.auth?.refresh && (!accessToken || (accessToken.expiresAt !== undefined && accessToken.expiresAt - Date.now() <= refreshBeforeMs))) {
    accessToken = { value: await refreshAccessToken(provider, config, store) };
  }
  if (config.auth?.header && !accessToken?.value) throw new Error("请先保存额度 Bearer Token");
  const sendQuotaRequest = async (): Promise<Response> => {
    const tokens = { accessToken: accessToken?.value, refreshToken: store ? await store.getRefreshToken() : undefined, cookie: store ? await store.getCookie() : undefined };
    const url = new URL(replaceVariables(config.url.trim(), provider, tokens));
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("额度查询地址仅支持 HTTP 或 HTTPS");
    for (const [key, value] of Object.entries(config.query || {})) url.searchParams.set(key, replaceVariables(value, provider, tokens));
    const headers = Object.fromEntries(Object.entries(config.headers || {}).map(([key, value]) => [key, replaceVariables(value, provider, tokens)]));
    if (config.auth?.header && accessToken?.value) headers[config.auth.header] = `${config.auth.prefix || "Bearer "}${accessToken.value}`;
    if (config.auth?.cookieHeader) {
      const cookie = tokens.cookie;
      if (!cookie) throw new Error("请先保存额度 Cookie");
      headers[config.auth.cookieHeader] = cookie;
    }
    const method = config.method || "GET";
    const body = method === "POST" && config.body !== undefined ? JSON.stringify(replaceInValue(config.body, provider, tokens)) : undefined;
    if (body && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
    return requestJson(url, { method, headers, body });
  };
  let response = await sendQuotaRequest();
  if ((response.status === 401 || response.status === 403) && store && config.auth?.refresh) {
    accessToken = { value: await refreshAccessToken(provider, config, store) };
    response = await sendQuotaRequest();
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("额度响应超过 64KB 限制");
  if (!response.ok) throw new Error(`HTTP ${response.status}：${redactPreview(text, provider.apiKey)}`);
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw new Error("额度接口未返回 JSON 响应"); }
  const scale = config.scale || 1;
  const normalize = (value: number | undefined) => value === undefined ? undefined : value / scale;
  return {
    balance: normalize(numberField(payload, config.fields.balance)),
    used: normalize(numberField(payload, config.fields.used)),
    total: normalize(numberField(payload, config.fields.total)),
    unit: stringField(payload, config.fields.unit) || config.unit,
    expiresAt: stringField(payload, config.fields.expiresAt),
    resetAt: timestampField(payload, config.fields.resetAt),
    updatedAt: Date.now(),
    responsePreview: redactPreview(text, provider.apiKey),
  };
}

export function quotaTokenStore(secrets: vscode.SecretStorage, providerName: string): QuotaTokenStore {
  const prefix = `axon.providerQuota.${providerName}`;
  return {
    async getAccessToken() {
      const raw = await secrets.get(`${prefix}.accessToken`);
      if (!raw) return undefined;
      try { return JSON.parse(raw) as { value: string; expiresAt?: number }; } catch { return { value: raw }; }
    },
    setAccessToken: async (value, expiresAt) => secrets.store(`${prefix}.accessToken`, JSON.stringify({ value, expiresAt })),
    getRefreshToken: () => secrets.get(`${prefix}.refreshToken`),
    setRefreshToken: (value) => secrets.store(`${prefix}.refreshToken`, value),
    getCookie: () => secrets.get(`${prefix}.cookie`),
    setCookie: (value) => secrets.store(`${prefix}.cookie`, value),
  };
}
