/**
 * Provider 用量查询引擎：按规则依次发请求、从响应里提取指标。
 *
 * 安全约束：
 *   · 密钥（API Key、额度令牌、Cookie）只在这里替换进请求，从不返回给调用方；响应预览会把它们打码。
 *   · 规则来自工作区配置（provider.quotaTrusted === false）时，所有请求必须发往 provider baseUrl 的同一主机，
 *     防止别人仓库里的规则把用户保存的凭证带到别处。
 *   · 只支持受限 JSONPath（`$.a.b[0]`、`step:$.a`、`@.a`）与固定的模板变量，不执行脚本。
 */

import type {
  QuotaFieldRef,
  QuotaMetric,
  QuotaMetricRule,
  QuotaProvider,
  QuotaRequest,
  QuotaResult,
  QuotaRule,
  QuotaSecrets,
  QuotaStep,
} from "./types.js";

export type QuotaFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface QuotaRunOptions {
  secrets?: QuotaSecrets;
  fetch?: QuotaFetch;
  timeoutMs?: number;
  /** 当前时间（测试用） */
  now?: () => number;
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_EACH_ITEMS = 20;
const DEFAULT_TIMEOUT_MS = 10_000;
/** `$.a.b[0]`、`step:$.a`、`@.a`、`@`、`$` */
const PATH_PATTERN = /^(?:([A-Za-z_][\w-]*):)?([$@])((?:\.[A-Za-z_$][\w$-]*|\[\d+\])*)$/;
const SEGMENT_PATTERN = /\.[A-Za-z_$][\w$-]*|\[\d+\]/g;

interface Tokens { accessToken?: string; refreshToken?: string; cookie?: string }

// ── 路径 ──────────────────────────────────────────────────────────────────

export function isValidPath(path: string): boolean {
  return PATH_PATTERN.test(path);
}

function walk(root: unknown, segments: string): unknown {
  let current = root;
  for (const token of segments.match(SEGMENT_PATTERN) || []) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    const key = token.startsWith(".") ? token.slice(1) : Number(token.slice(1, -1));
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

interface PathScope { steps: Record<string, unknown>; defaultStep: string; item?: unknown }

function resolvePath(path: string, scope: PathScope): unknown {
  const match = PATH_PATTERN.exec(path.trim());
  if (!match) throw new Error(`字段路径不合法：${path}`);
  const [, stepId, rootSymbol, segments] = match;
  if (rootSymbol === "@") {
    if (scope.item === undefined) throw new Error(`路径 ${path} 只能用在 each 指标里`);
    return walk(scope.item, segments);
  }
  // 步骤不在结果里 = 可选步骤失败被跳过（引用不存在的步骤名在 validateQuotaRule 里就拦下了）
  return walk(scope.steps[stepId || scope.defaultStep], segments);
}

function toNumber(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(String(value).replace(/,/g, "").trim());
  if (!Number.isFinite(number)) throw new Error(`字段 ${path} 不是有效数字（取到 ${JSON.stringify(value).slice(0, 60)}）`);
  return number;
}

function toTimestamp(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "" || value === 0) return undefined;
  if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value))) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return n < 100_000_000_000 ? n * 1000 : n;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ── 模板变量 ──────────────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function cookieValue(cookie: string | undefined, key: string): string {
  if (!cookie) return "";
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${key}=`));
  if (!match) return "";
  const value = match.slice(key.length + 1);
  try { return decodeURIComponent(value); } catch { return value; }
}

interface TemplateContext { provider: QuotaProvider; rule: QuotaRule; tokens: Tokens; steps: Record<string, unknown>; now: number }

function fill(value: string, ctx: TemplateContext): string {
  const origin = safeOrigin(ctx.provider.baseUrl);
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, expr: string) => {
    switch (expr) {
      case "apiKey": return ctx.provider.apiKey;
      case "baseUrl": return ctx.provider.baseUrl.replace(/\/+$/, "");
      case "origin": return origin;
      case "accessToken": return ctx.tokens.accessToken || "";
      case "refreshToken": return ctx.tokens.refreshToken || "";
      case "cookie": return ctx.tokens.cookie || "";
      case "today": return formatDate(ctx.now);
      case "monthStart": { const d = new Date(ctx.now); return formatDate(new Date(d.getFullYear(), d.getMonth(), 1).getTime()); }
      case "yearStart": return `${new Date(ctx.now).getFullYear()}-01-01`;
    }
    if (expr.startsWith("cookie.")) return cookieValue(ctx.tokens.cookie, expr.slice(7));
    if (expr.startsWith("vars.")) return ctx.rule.vars?.[expr.slice(5)] ?? "";
    if (expr.startsWith("steps.")) {
      const [stepId, ...rest] = expr.slice(6).split(".");
      const found = walk(ctx.steps[stepId], rest.length ? `.${rest.join(".")}` : "");
      return found === undefined || found === null ? "" : String(found);
    }
    return whole;
  });
}

function fillDeep(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === "string") return fill(value, ctx);
  if (Array.isArray(value)) return value.map((item) => fillDeep(item, ctx));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, ctx)]));
  return value;
}

function safeOrigin(baseUrl: string): string {
  try { return new URL(baseUrl).origin; } catch { return ""; }
}

function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("***");
  }
  return out;
}

// ── 规则归一化与校验 ──────────────────────────────────────────────────────

/** 旧版单请求规则（url + fields）→ 新规则；已是新规则则原样返回 */
export function normalizeRule(rule: QuotaRule): QuotaRule & { steps: QuotaStep[]; metrics: QuotaMetricRule[] } {
  const steps: QuotaStep[] = rule.steps && rule.steps.length > 0
    ? rule.steps
    : rule.url
      ? [{ id: "main", url: rule.url, method: rule.method, headers: rule.headers, query: rule.query, body: rule.body }]
      : [];
  let metrics = rule.metrics || [];
  if (metrics.length === 0 && rule.fields) {
    const f = rule.fields;
    metrics = [{
      label: "额度",
      kind: f.total || f.used ? "quota" : "balance",
      used: f.used,
      total: f.total,
      remaining: f.balance,
      resetAt: f.resetAt || f.expiresAt,
      unitPath: f.unit,
      unit: rule.unit,
      scale: rule.scale,
    }];
  }
  return { ...rule, steps, metrics };
}

function fieldPath(ref: QuotaFieldRef | undefined): string | undefined {
  return typeof ref === "string" ? ref : ref?.path;
}

export function validateQuotaRule(input: QuotaRule): void {
  const rule = normalizeRule(input);
  if (rule.steps.length === 0) throw new Error("额度规则至少需要一个请求（steps 或 url）");
  if (rule.steps.length > 5) throw new Error("额度规则最多 5 个请求步骤");
  if (rule.metrics.length === 0) throw new Error("额度规则至少需要一条指标（metrics 或 fields）");
  const ids = new Set<string>();
  for (const step of rule.steps) {
    if (!step.id || !/^[A-Za-z_][\w-]*$/.test(step.id)) throw new Error(`步骤名不合法：${step.id}`);
    if (ids.has(step.id)) throw new Error(`步骤名重复：${step.id}`);
    ids.add(step.id);
    if (!step.url?.trim()) throw new Error(`步骤「${step.id}」缺少请求地址`);
    if (step.method && step.method !== "GET" && step.method !== "POST") throw new Error(`步骤「${step.id}」只支持 GET 或 POST`);
  }
  const checkPath = (path: string | undefined, where: string) => {
    if (path && !isValidPath(path)) throw new Error(`${where}字段路径不合法：${path}`);
  };
  for (const m of rule.metrics) {
    const where = `指标「${m.label || m.labelPath || "?"}」`;
    const paths = [m.each, m.labelPath, m.percent, m.resetAt, m.unitPath, fieldPath(m.used), fieldPath(m.total), fieldPath(m.remaining)];
    paths.forEach((p) => checkPath(p, where));
    for (const p of paths) {
      const stepId = p && PATH_PATTERN.exec(p.trim())?.[1];
      if (stepId && !ids.has(stepId)) throw new Error(`${where}引用了不存在的步骤「${stepId}」：${p}`);
    }
    for (const ref of [m.used, m.total, m.remaining]) {
      const scale = typeof ref === "object" ? ref.scale : undefined;
      if (scale !== undefined && (!Number.isFinite(scale) || scale <= 0)) throw new Error(`${where}的换算系数必须大于 0`);
    }
    if (m.scale !== undefined && (!Number.isFinite(m.scale) || m.scale <= 0)) throw new Error(`${where}的换算系数必须大于 0`);
  }
  const refresh = rule.auth?.refresh;
  if (refresh) {
    if (!refresh.url?.trim() || !refresh.accessTokenPath) throw new Error("刷新接口地址和访问令牌字段不能为空");
    [refresh.accessTokenPath, refresh.refreshTokenPath, refresh.expiresInPath, refresh.expiresAtPath].forEach((p) => checkPath(p, "刷新响应"));
  }
}

// ── 请求 ──────────────────────────────────────────────────────────────────

interface Runner {
  provider: QuotaProvider;
  rule: QuotaRule;
  fetch: QuotaFetch;
  timeoutMs: number;
  now: number;
  secretsList: () => (string | undefined)[];
}

function checkUrl(url: URL, provider: QuotaProvider): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`额度请求只支持 HTTP / HTTPS：${url.protocol}`);
  if (provider.quotaTrusted === false) {
    let baseHost = "";
    try { baseHost = new URL(provider.baseUrl).host; } catch { /* 下面统一报错 */ }
    if (!baseHost || url.host !== baseHost) {
      throw new Error(`这条额度规则来自工作区配置，只允许请求 ${baseHost || "provider 自己的地址"}（规则请求的是 ${url.host}）。如确需跨域名，请把规则保存到用户级配置。`);
    }
  }
}

async function send(runner: Runner, request: QuotaRequest, ctx: TemplateContext, extraHeaders: Record<string, string>): Promise<{ status: number; ok: boolean; text: string }> {
  const url = new URL(fill(request.url.trim(), ctx));
  checkUrl(url, runner.provider);
  for (const [key, value] of Object.entries(request.query || {})) url.searchParams.set(key, fill(value, ctx));
  const headers: Record<string, string> = { accept: "application/json" };
  for (const [key, value] of Object.entries(request.headers || {})) headers[key.toLowerCase()] = fill(value, ctx);
  // 独立额度令牌 / Cookie 优先于规则里写的同名请求头（与旧版行为一致）
  for (const [key, value] of Object.entries(extraHeaders)) headers[key.toLowerCase()] = value;
  const method = request.method || "GET";
  let body: string | undefined;
  if (method === "POST" && request.body !== undefined) {
    body = typeof request.body === "string" ? fill(request.body, ctx) : JSON.stringify(fillDeep(request.body, ctx));
    if (!("content-type" in headers)) headers["content-type"] = "application/json";
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runner.timeoutMs);
  try {
    const response = await runner.fetch(url.toString(), { method, headers, body, signal: controller.signal });
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error(`响应超过 ${MAX_RESPONSE_BYTES / 1024}KB 限制`);
    return { status: response.status, ok: response.ok, text };
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error(`请求 ${url.host} 超时（${runner.timeoutMs / 1000} 秒）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string, what: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error(`${what}没有返回 JSON`); }
}

async function refreshAccessToken(runner: Runner, secrets: QuotaSecrets, tokens: Tokens): Promise<string> {
  const refresh = runner.rule.auth?.refresh;
  if (!refresh) throw new Error("额度访问令牌已失效，且规则没有配置刷新接口");
  if (!tokens.refreshToken && !tokens.cookie) throw new Error("额度访问令牌已失效，请保存 refresh token 或 Cookie");
  const ctx: TemplateContext = { provider: runner.provider, rule: runner.rule, tokens, steps: {}, now: runner.now };
  const extra: Record<string, string> = {};
  if (runner.rule.auth?.cookieHeader && tokens.cookie) extra[runner.rule.auth.cookieHeader] = tokens.cookie;
  const response = await send(runner, { ...refresh, method: refresh.method || "POST" }, ctx, extra);
  if (!response.ok) throw new Error(`刷新令牌失败：HTTP ${response.status} ${redact(response.text, runner.secretsList()).slice(0, 300)}`);
  const payload = parseJson(response.text, "刷新接口");
  const scope: PathScope = { steps: { main: payload }, defaultStep: "main" };
  const accessToken = resolvePath(refresh.accessTokenPath, scope);
  if (typeof accessToken !== "string" || !accessToken) throw new Error("刷新接口没有返回访问令牌");
  const expiresIn = refresh.expiresInPath ? toNumber(resolvePath(refresh.expiresInPath, scope), refresh.expiresInPath) : undefined;
  const expiresAt = expiresIn !== undefined
    ? runner.now + expiresIn * 1000
    : refresh.expiresAtPath ? toTimestamp(resolvePath(refresh.expiresAtPath, scope)) : undefined;
  await secrets.setAccessToken(accessToken, expiresAt);
  const rotated = refresh.refreshTokenPath ? resolvePath(refresh.refreshTokenPath, scope) : undefined;
  if (typeof rotated === "string" && rotated) await secrets.setRefreshToken(rotated);
  return accessToken;
}

// ── 指标提取 ──────────────────────────────────────────────────────────────

function readField(ref: QuotaFieldRef | undefined, scope: PathScope, metricScale: number): number | undefined {
  if (!ref) return undefined;
  const path = fieldPath(ref)!;
  const value = toNumber(resolvePath(path, scope), path);
  if (value === undefined) return undefined;
  const scale = (typeof ref === "object" && ref.scale) || metricScale;
  return value / scale;
}

function round(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value * 10_000) / 10_000;
}

function buildMetric(rule: QuotaMetricRule, scope: PathScope, fallbackLabel: string): QuotaMetric | null {
  const scale = rule.scale || 1;
  let used = readField(rule.used, scope, scale);
  let total = readField(rule.total, scope, scale);
  let remaining = readField(rule.remaining, scope, scale);
  let percent = rule.percent ? toNumber(resolvePath(rule.percent, scope), rule.percent) : undefined;
  // 缺哪个补哪个：两个已知就能推出第三个
  if (remaining === undefined && total !== undefined && used !== undefined) remaining = total - used;
  if (used === undefined && total !== undefined && remaining !== undefined) used = total - remaining;
  if (total === undefined && used !== undefined && remaining !== undefined) total = used + remaining;
  if (percent === undefined && used !== undefined && total !== undefined && total > 0) percent = (used / total) * 100;
  if ([used, total, remaining, percent].every((v) => v === undefined)) return null;

  const rawLabel = rule.labelPath ? resolvePath(rule.labelPath, scope) : undefined;
  const labelKey = rawLabel === undefined || rawLabel === null ? "" : String(rawLabel);
  const label = (labelKey && rule.labelMap?.[labelKey]) || labelKey || rule.label || fallbackLabel;
  const unitRaw = rule.unitPath ? resolvePath(rule.unitPath, scope) : undefined;
  return {
    label,
    kind: rule.kind || (total !== undefined ? "quota" : "balance"),
    used: round(used),
    total: round(total),
    remaining: round(remaining),
    percent: percent === undefined ? undefined : Math.max(0, Math.min(100, Math.round(percent * 10) / 10)),
    unit: (unitRaw !== undefined && unitRaw !== null && unitRaw !== "" ? String(unitRaw) : undefined) || rule.unit,
    resetAt: rule.resetAt ? toTimestamp(resolvePath(rule.resetAt, scope)) : undefined,
  };
}

// ── 入口 ──────────────────────────────────────────────────────────────────

export async function runQuotaRule(provider: QuotaProvider, input: QuotaRule, options: QuotaRunOptions = {}): Promise<QuotaResult> {
  validateQuotaRule(input);
  const rule = normalizeRule(input);
  const secrets = options.secrets;
  const now = (options.now || Date.now)();
  const fetchImpl: QuotaFetch = options.fetch || ((url, init) => fetch(url, init));

  const tokens: Tokens = {
    refreshToken: secrets ? await secrets.getRefreshToken() : undefined,
    cookie: secrets ? await secrets.getCookie() : undefined,
  };
  let access = secrets ? await secrets.getAccessToken() : undefined;
  tokens.accessToken = access?.value;

  const runner: Runner = {
    provider,
    rule,
    fetch: fetchImpl,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    now,
    secretsList: () => [provider.apiKey, tokens.accessToken, tokens.refreshToken, tokens.cookie],
  };

  const auth = rule.auth;
  const refreshBeforeMs = Math.max(0, auth?.refreshBeforeSeconds || 0) * 1000;
  if (secrets && auth?.refresh && (!access || (access.expiresAt !== undefined && access.expiresAt - now <= refreshBeforeMs))) {
    tokens.accessToken = await refreshAccessToken(runner, secrets, tokens);
    access = { value: tokens.accessToken };
  }
  if (auth?.header && !tokens.accessToken) throw new Error("请先保存额度访问令牌");
  if (auth?.cookieHeader && !tokens.cookie) throw new Error("请先保存额度 Cookie");

  const authHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (auth?.header && tokens.accessToken) headers[auth.header] = `${auth.prefix ?? "Bearer "}${tokens.accessToken}`;
    if (auth?.cookieHeader && tokens.cookie) headers[auth.cookieHeader] = tokens.cookie;
    return headers;
  };

  const steps: Record<string, unknown> = {};
  const previews: string[] = [];
  let refreshed = false;
  for (const step of rule.steps) {
    const ctx: TemplateContext = { provider, rule, tokens, steps, now };
    try {
      let response = await send(runner, step, ctx, authHeaders());
      if ((response.status === 401 || response.status === 403) && secrets && auth?.refresh && !refreshed) {
        refreshed = true;
        tokens.accessToken = await refreshAccessToken(runner, secrets, tokens);
        response = await send(runner, step, ctx, authHeaders());
      }
      const preview = redact(response.text, runner.secretsList());
      previews.push(rule.steps.length > 1 ? `── ${step.id} (HTTP ${response.status}) ──\n${preview.slice(0, 1500)}` : preview.slice(0, 2000));
      if (!response.ok) throw new Error(`HTTP ${response.status}：${preview.slice(0, 300)}`);
      steps[step.id] = parseJson(response.text, `步骤「${step.id}」`);
    } catch (error) {
      if (step.optional) continue;
      throw new Error(rule.steps.length > 1 ? `步骤「${step.id}」失败：${(error as Error).message}` : (error as Error).message);
    }
  }

  const scope: PathScope = { steps, defaultStep: rule.steps[0].id };
  const metrics: QuotaMetric[] = [];
  rule.metrics.forEach((metricRule, index) => {
    const fallback = rule.metrics.length > 1 ? `额度 ${index + 1}` : "额度";
    if (metricRule.each) {
      const list = resolvePath(metricRule.each, scope);
      if (!Array.isArray(list)) return;
      list.slice(0, MAX_EACH_ITEMS).forEach((item, i) => {
        const metric = buildMetric(metricRule, { ...scope, item }, `${fallback}-${i + 1}`);
        if (metric) metrics.push(metric);
      });
      return;
    }
    const metric = buildMetric(metricRule, scope, fallback);
    if (metric) metrics.push(metric);
  });

  const responsePreview = previews.join("\n\n");
  if (metrics.length === 0) {
    throw new Error(`规则没有从响应里取到任何数值，请检查字段路径。响应预览：${responsePreview.slice(0, 400)}`);
  }
  const primary = metrics[0];
  return {
    metrics,
    updatedAt: now,
    responsePreview,
    balance: primary.remaining,
    used: primary.used,
    total: primary.total,
    unit: primary.unit,
    resetAt: primary.resetAt,
  };
}
