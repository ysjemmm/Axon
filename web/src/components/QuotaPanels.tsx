/**
 * Provider 用量：指标展示、用量总览、单个 Provider 的查询配置。
 *
 * 规则执行在宿主（core/quota），网页只拿到脱敏后的结果——API Key、面板令牌、Cookie 从不进网页。
 *
 * 配置的主路径是「自动识别」或「选一个模板」，绝大多数情况下用户不需要碰 JSON；
 * 内置模板覆盖不到的平台，再展开「高级」直接编辑规则（多步请求、数组展开、字段换算都在那里写）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Wand2, Save, Play, KeyRound, ChevronRight, WalletCards, Trash2, Power, Gauge, Coins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  type ProviderLevel,
  type ResolvedProviderInfo,
  type ProviderQuotaConfig,
  type ProviderQuotaResult,
  type QuotaMetric,
  type QuotaPresetInfo,
  type QuotaDetectResponse,
  type QuotaOverviewEntry,
  type ModelPrice,
  type ProviderPricing,
  setProviderPricing,
  setProviderQuota,
  testProviderQuota,
  setProviderQuotaTokens,
  clearProviderQuotaTokens,
  getProviderQuotaTokenStatus,
  listQuotaPresets,
  detectProviderQuota,
  getQuotaOverview,
} from "@/lib/apiClient";

// ── 指标展示 ──────────────────────────────────────────────────────────────

function fmt(value: number | undefined): string {
  if (value === undefined) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (abs >= 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function withUnit(value: number | undefined, unit?: string): string {
  if (value === undefined) return "—";
  if (unit === "$" || unit === "¥") return `${unit}${fmt(value)}`;
  return unit ? `${fmt(value)} ${unit}` : fmt(value);
}

function relativeTime(ms: number): string {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  const text = minutes < 60 ? `${Math.max(1, minutes)} 分钟` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} 小时` : `${Math.round(minutes / 1440)} 天`;
  return diff >= 0 ? `${text}后` : `${text}前`;
}

/** 一条指标：名称 + 主数值 + 进度条（有百分比时）+ 重置时间 */
function MetricRow({ metric }: { metric: QuotaMetric }) {
  const percent = metric.percent;
  const barColor = percent === undefined ? "" : percent >= 90 ? "bg-destructive" : percent >= 70 ? "bg-amber-500" : "bg-primary";
  const main = metric.total !== undefined
    ? `${withUnit(metric.used, metric.unit)} / ${withUnit(metric.total, metric.unit)}`
    : metric.remaining !== undefined
      ? `剩余 ${withUnit(metric.remaining, metric.unit)}`
      : metric.used !== undefined
        ? `已用 ${withUnit(metric.used, metric.unit)}`
        : percent !== undefined ? `已用 ${percent}%` : "—";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="text-foreground/80 truncate">{metric.label}</span>
        <span className="ml-auto shrink-0 tabular-nums text-foreground">{main}</span>
        {percent !== undefined && metric.total !== undefined && <span className="shrink-0 tabular-nums text-muted-foreground w-11 text-right">{percent}%</span>}
      </div>
      {percent !== undefined && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.max(1, Math.min(100, percent))}%` }} />
        </div>
      )}
      {(metric.resetAt || (metric.remaining !== undefined && (metric.total !== undefined || metric.used !== undefined))) && (
        <div className="flex gap-2 text-[11px] text-muted-foreground">
          {metric.remaining !== undefined && metric.total !== undefined && <span>剩余 {withUnit(metric.remaining, metric.unit)}</span>}
          {/* 余额类：主数值是剩余，这里补一句累计已用 */}
          {metric.remaining !== undefined && metric.total === undefined && metric.used !== undefined && <span>累计已用 {withUnit(metric.used, metric.unit)}</span>}
          {metric.resetAt && <span className="ml-auto" title={new Date(metric.resetAt).toLocaleString()}>{metric.resetAt > Date.now() ? `${relativeTime(metric.resetAt)}重置` : `已于 ${new Date(metric.resetAt).toLocaleString()} 重置`}</span>}
        </div>
      )}
    </div>
  );
}

export function QuotaMetricList({ metrics }: { metrics: QuotaMetric[] }) {
  return <div className="space-y-2.5">{metrics.map((m, i) => <MetricRow key={`${m.label}-${i}`} metric={m} />)}</div>;
}

// ── 用量总览 ──────────────────────────────────────────────────────────────

export function QuotaOverviewCard({ workspace, version }: { workspace?: string; version: number }) {
  const [entries, setEntries] = useState<QuotaOverviewEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true);
    try { setEntries((await getQuotaOverview(workspace, refresh)).entries); }
    catch { setEntries([]); }
    setLoading(false);
  }, [workspace]);

  // version 变化 = 有 Provider 的规则或凭证刚保存过
  useEffect(() => { void load(false); }, [load, version]);

  return (
    <div className="px-3 py-2.5 rounded-lg border border-border bg-muted/20">
      <div className="flex items-center gap-2 mb-2">
        <Gauge className="w-4 h-4 text-primary" />
        <span className="text-sm font-medium">用量总览</span>
        <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-xs" onClick={() => void load(true)} disabled={loading}>
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          <span className="ml-1">刷新</span>
        </Button>
      </div>
      {entries === null ? (
        <div className="py-2 text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />正在查询…</div>
      ) : entries.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">还没有 Provider 启用用量查询。展开下面任意 Provider，在「用量查询」里点「自动识别」或选一个模板。</p>
      ) : (
        <div className="divide-y divide-border/60">
          {entries.map((entry) => (
            <div key={entry.name} className="py-2 first:pt-0 last:pb-0">
              <div className="flex items-center gap-2 mb-1.5">
                <span className="text-xs font-medium">{entry.label}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{relativeTime(entry.updatedAt)}更新</span>
              </div>
              {entry.result ? <QuotaMetricList metrics={entry.result.metrics} /> : <p className="text-[11px] text-destructive break-all">{entry.error}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 单个 Provider 的用量查询配置 ──────────────────────────────────────────

type TokenStatus = { hasAccessToken: boolean; hasRefreshToken: boolean; hasCookie: boolean };

function parseRule(text: string): { rule?: ProviderQuotaConfig; error?: string } {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "规则必须是 JSON 对象" };
    return { rule: value as ProviderQuotaConfig };
  } catch (e) {
    return { error: `JSON 格式无效：${(e as Error).message}` };
  }
}

export function QuotaConfigPanel({ provider, level, workspace, onChanged, embedded = false }: {
  provider: ResolvedProviderInfo;
  level: ProviderLevel;
  workspace?: string;
  onChanged: () => void;
  /** 嵌在 Provider 卡片的标签页里：不要折叠标题，直接展开 */
  embedded?: boolean;
}) {
  const [open, setOpen] = useState(embedded);
  const [presets, setPresets] = useState<QuotaPresetInfo[]>([]);
  const [text, setText] = useState(() => (provider.quota ? JSON.stringify(provider.quota, null, 2) : ""));
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState<"" | "detect" | "test" | "save" | "tokens">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<ProviderQuotaResult | null>(null);
  const [detect, setDetect] = useState<QuotaDetectResponse | null>(null);
  const [tokens, setTokens] = useState({ accessToken: "", refreshToken: "", cookie: "" });
  const [tokenStatus, setTokenStatus] = useState<TokenStatus | null>(null);

  const { rule, error: parseError } = useMemo(() => (text.trim() ? parseRule(text) : {}), [text]);
  const preset = presets.find((p) => p.id === rule?.preset);
  const auth = rule?.auth;
  const enabled = !!provider.quota && provider.quota.enabled !== false;

  useEffect(() => {
    if (!open) return;
    void listQuotaPresets(provider.name, workspace).then((r) => setPresets(r.presets)).catch(() => setPresets([]));
    void getProviderQuotaTokenStatus(provider.name, workspace).then(setTokenStatus).catch(() => setTokenStatus(null));
  }, [open, provider.name, workspace]);

  const resetMessages = () => { setError(""); setNotice(""); };
  const setRule = (next: ProviderQuotaConfig) => setText(JSON.stringify(next, null, 2));

  const choosePreset = (id: string) => {
    const picked = presets.find((p) => p.id === id);
    if (!picked) return;
    resetMessages();
    setResult(null);
    setDetect(null);
    setRule({ ...picked.rule, enabled: true, preset: picked.id, ...(picked.vars?.length ? { vars: rule?.vars || {} } : {}) });
  };

  const runDetect = async () => {
    resetMessages();
    setResult(null);
    setBusy("detect");
    try {
      const res = await detectProviderQuota(provider.name, workspace);
      setDetect(res);
      if (res.rule && res.result) {
        setRule(res.rule);
        setResult(res.result);
        setNotice(`已识别为「${res.presetLabel}」，确认数值无误后点「保存并启用」。`);
      } else {
        setError("没有识别出来。可以在下面选一个模板手动填写凭证，或展开「高级」自己写规则。");
      }
    } catch (e) { setError(`识别失败：${(e as Error).message}`); }
    setBusy("");
  };

  const runTest = async () => {
    if (!rule) { setError(parseError || "请先选择模板或填写规则"); return; }
    resetMessages();
    setResult(null);
    setBusy("test");
    try { setResult(await testProviderQuota(provider.name, rule, workspace)); }
    catch (e) { setError(`查询失败：${(e as Error).message}`); }
    setBusy("");
  };

  const save = async (next: ProviderQuotaConfig | null, message: string) => {
    resetMessages();
    setBusy("save");
    try {
      await setProviderQuota(level, provider.name, next, workspace);
      setNotice(message);
      onChanged();
    } catch (e) { setError(`保存失败：${(e as Error).message}`); }
    setBusy("");
  };

  const saveTokens = async () => {
    resetMessages();
    setBusy("tokens");
    try {
      await setProviderQuotaTokens(provider.name, {
        accessToken: tokens.accessToken.trim() || undefined,
        refreshToken: tokens.refreshToken.trim() || undefined,
        cookie: tokens.cookie.trim() || undefined,
      }, workspace);
      setTokens({ accessToken: "", refreshToken: "", cookie: "" });
      setTokenStatus(await getProviderQuotaTokenStatus(provider.name, workspace));
      setNotice("凭证已保存到系统安全存储。");
    } catch (e) { setError(`保存凭证失败：${(e as Error).message}`); }
    setBusy("");
  };

  const clearTokens = async () => {
    resetMessages();
    try {
      await clearProviderQuotaTokens(provider.name, workspace);
      setTokenStatus(await getProviderQuotaTokenStatus(provider.name, workspace));
      setNotice("已清除保存的凭证。");
    } catch (e) { setError(`清除失败：${(e as Error).message}`); }
  };

  const needsToken = !!auth?.header;
  const needsCookie = !!auth?.cookieHeader;
  const needsRefresh = !!auth?.refresh;
  const hasTokenInput = !!(tokens.accessToken.trim() || tokens.refreshToken.trim() || tokens.cookie.trim());
  const statusLabel = enabled ? `已启用${provider.quota?.preset ? ` · ${presets.find((p) => p.id === provider.quota?.preset)?.label || provider.quota.preset}` : ""}` : provider.quota ? "已停用" : "未配置";

  return (
    <div className={embedded ? "" : "mt-3 pt-2 border-t border-border/60"}>
      {embedded ? (
        <div className="mb-3 text-[12px] text-muted-foreground">状态：{statusLabel}。配置后用量会显示在状态栏和页面顶部的用量总览里。</div>
      ) : (
        <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <WalletCards className="w-3.5 h-3.5" />用量查询 · {statusLabel}
          <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
      )}
      {open && (
        <div className={`${embedded ? "" : "mt-2 "}space-y-3`}>
          {/* 1. 选规则：自动识别 / 模板 */}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={runDetect} disabled={!!busy || !provider.configured} title={provider.configured ? "用现有 API Key 与已保存的凭证逐个尝试内置模板" : "需先保存 API Key"}>
              {busy === "detect" ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Wand2 className="w-3.5 h-3.5 mr-1" />}自动识别
            </Button>
            <Select value={rule?.preset && preset ? rule.preset : ""} onValueChange={choosePreset}>
              <SelectTrigger className="h-8 w-60 text-xs"><SelectValue placeholder="或选择一个模板…" /></SelectTrigger>
              <SelectContent>
                {presets.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="text-xs">
                    {p.label}{p.matched ? " · 推荐" : ""}{p.verified ? "" : " · 未验证"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {!provider.configured && <p className="text-[11px] text-muted-foreground">需先保存这个 Provider 的 API Key，才能自动识别或测试。</p>}
          {preset && (
            <p className="text-[11px] text-muted-foreground">
              {preset.description}{preset.verified ? "" : "（这个模板按公开资料编写，尚未用真实账号核对，请以测试结果为准）"}
            </p>
          )}
          {detect && !detect.rule && detect.attempts.length > 0 && (
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer">已尝试 {detect.attempts.length} 个模板</summary>
              <ul className="mt-1 space-y-0.5">{detect.attempts.map((a) => <li key={a.preset} className="break-all">· {a.label}：{a.error}</li>)}</ul>
            </details>
          )}

          {/* 2. 模板变量 */}
          {preset?.vars?.map((v) => (
            <div key={v.name} className="space-y-1">
              <label className="text-xs font-medium">{v.label}</label>
              <Input value={rule?.vars?.[v.name] || ""} placeholder={v.placeholder} className="h-8 text-xs"
                onChange={(e) => rule && setRule({ ...rule, vars: { ...(rule.vars || {}), [v.name]: e.target.value } })} />
            </div>
          ))}

          {/* 3. 凭证（只在规则需要时出现；保存到系统安全存储，不进规则） */}
          {(needsToken || needsCookie || needsRefresh) && (
            <div className="space-y-2 rounded-md border border-border/70 px-2.5 py-2">
              <div className="flex items-center gap-2 text-xs font-medium"><KeyRound className="w-3.5 h-3.5" />查询凭证
                <span className="ml-auto text-[11px] font-normal text-muted-foreground">
                  {[needsToken && (tokenStatus?.hasAccessToken ? "令牌已保存" : "令牌未保存"), needsCookie && (tokenStatus?.hasCookie ? "Cookie 已保存" : "Cookie 未保存"), needsRefresh && (tokenStatus?.hasRefreshToken ? "刷新令牌已保存" : "刷新令牌未保存")].filter(Boolean).join(" · ")}
                </span>
              </div>
              {needsToken && <Input type="password" placeholder="面板访问令牌（留空保持不变）" value={tokens.accessToken} onChange={(e) => setTokens({ ...tokens, accessToken: e.target.value })} className="h-8 text-xs" />}
              {needsCookie && <Input type="password" placeholder="完整 Cookie，例如 session=...（留空保持不变）" value={tokens.cookie} onChange={(e) => setTokens({ ...tokens, cookie: e.target.value })} className="h-8 text-xs" />}
              {needsRefresh && <Input type="password" placeholder="refresh token（留空保持不变）" value={tokens.refreshToken} onChange={(e) => setTokens({ ...tokens, refreshToken: e.target.value })} className="h-8 text-xs" />}
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={saveTokens} disabled={!!busy || !hasTokenInput}>
                  {busy === "tokens" ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Save className="w-3.5 h-3.5 mr-1" />}保存凭证
                </Button>
                {(tokenStatus?.hasAccessToken || tokenStatus?.hasCookie || tokenStatus?.hasRefreshToken) && (
                  <Button size="sm" variant="ghost" onClick={clearTokens} disabled={!!busy}>清除凭证</Button>
                )}
              </div>
            </div>
          )}

          {/* 4. 操作 */}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={runTest} disabled={!!busy || !rule}>
              {busy === "test" ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Play className="w-3.5 h-3.5 mr-1" />}测试查询
            </Button>
            <Button size="sm" onClick={() => rule && save({ ...rule, enabled: true }, "已保存并启用，用量总览和状态栏会显示它。")} disabled={!!busy || !rule}>
              {busy === "save" ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Save className="w-3.5 h-3.5 mr-1" />}保存并启用
            </Button>
            {enabled && (
              <Button size="sm" variant="ghost" onClick={() => provider.quota && save({ ...provider.quota, enabled: false }, "已停用，规则保留。")} disabled={!!busy}>
                <Power className="w-3.5 h-3.5 mr-1" />停用
              </Button>
            )}
            {provider.quota && (
              <Button size="sm" variant="ghost" onClick={() => { setText(""); setResult(null); void save(null, "已删除用量查询规则。"); }} disabled={!!busy}>
                <Trash2 className="w-3.5 h-3.5 mr-1" />删除规则
              </Button>
            )}
          </div>

          {error && <p className="text-xs text-destructive break-all">{error}</p>}
          {notice && <p className="text-xs text-primary">{notice}</p>}
          {result && (
            <div className="rounded-md bg-muted/40 px-2.5 py-2 space-y-2">
              <QuotaMetricList metrics={result.metrics} />
              <details className="text-[11px]">
                <summary className="cursor-pointer text-muted-foreground">查看脱敏响应</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all">{result.responsePreview}</pre>
              </details>
            </div>
          )}

          {/* 5. 高级：直接编辑规则 */}
          <div>
            <button onClick={() => setAdvanced((v) => !v)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
              <ChevronRight className={`w-3 h-3 transition-transform ${advanced ? "rotate-90" : ""}`} />高级：编辑规则 JSON
            </button>
            {advanced && (
              <div className="mt-1.5 space-y-1.5">
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  <code>steps</code> 是依次发出的请求（后一步可用 <code>{"{{steps.id.字段}}"}</code> 引用前一步结果）；<code>metrics</code> 从响应取数：
                  路径形如 <code>$.data.balance</code>、多步骤时 <code>步骤名:$.x</code>，<code>each</code> 展开数组后用 <code>@.x</code>。
                  已用 / 总额 / 剩余给两个即可推出第三个；<code>scale</code> 做单位换算。可用变量：<code>{"{{origin}}"}</code>、<code>{"{{baseUrl}}"}</code>、<code>{"{{apiKey}}"}</code>、<code>{"{{accessToken}}"}</code>、<code>{"{{cookie}}"}</code>、<code>{"{{vars.名称}}"}</code>、<code>{"{{today}}"}</code>。
                  面板令牌 / Cookie 用 <code>auth.header</code> / <code>auth.cookieHeader</code> 声明，值在上面的凭证框里保存。
                </p>
                <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder="选择模板后会自动填入"
                  className="w-full min-h-48 rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[11px] leading-5" />
                {parseError && <p className="text-[11px] text-destructive">{parseError}</p>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 计费单价 ──────────────────────────────────────────────────────────────

type PriceField = keyof ModelPrice;
type PriceDraft = Record<PriceField, string>;
const PRICE_FIELDS: { key: PriceField; label: string }[] = [
  { key: "input", label: "输入" },
  { key: "cacheRead", label: "缓存命中" },
  { key: "output", label: "输出" },
];
/** 「其他模型」那一行在草稿里的键，避开真实模型 id */
const DEFAULT_ROW = "\u0000default";

const toDraft = (price?: ModelPrice): PriceDraft => ({
  input: price?.input?.toString() ?? "",
  cacheRead: price?.cacheRead?.toString() ?? "",
  output: price?.output?.toString() ?? "",
});

function fromDraft(draft: PriceDraft | undefined): ModelPrice | undefined {
  if (!draft) return undefined;
  const out: ModelPrice = {};
  for (const { key } of PRICE_FIELDS) {
    const text = draft[key].trim();
    if (!text) continue;
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) throw new Error(`「${text}」不是有效的单价`);
    out[key] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * 计费单价：配置后回复底部显示估算花费（按端点实报的 token 数计算），不配置只显示 Token 数。
 * 单价按每 100 万 token 填写，和各家价目表的写法一致。
 */
export function PricingPanel({ provider, level, workspace, onChanged, embedded = false }: {
  provider: ResolvedProviderInfo;
  level: ProviderLevel;
  workspace?: string;
  onChanged: () => void;
  /** 嵌在 Provider 卡片的标签页里：不要折叠标题，直接展开 */
  embedded?: boolean;
}) {
  const pricing = provider.pricing;
  const [open, setOpen] = useState(embedded);
  const [currency, setCurrency] = useState(pricing?.currency ?? "¥");
  const [rows, setRows] = useState<Record<string, PriceDraft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // 每次展开都从当前配置重建草稿，避免保存后再打开看到旧值
  useEffect(() => {
    if (!open) return;
    const next: Record<string, PriceDraft> = { [DEFAULT_ROW]: toDraft(pricing?.default) };
    for (const m of provider.models) next[m.id] = toDraft(pricing?.models?.[m.id]);
    // 已配置但模型目录里已经没有的 id 也保留，免得保存时被悄悄删掉
    for (const [id, price] of Object.entries(pricing?.models ?? {})) if (!next[id]) next[id] = toDraft(price);
    setRows(next);
    setCurrency(pricing?.currency ?? "¥");
  }, [open, pricing, provider.models]);

  const configuredCount = Object.keys(pricing?.models ?? {}).length + (pricing?.default ? 1 : 0);
  const statusLabel = configuredCount ? `已配置 ${configuredCount} 项` : "未配置 · 只显示 Token 数";
  const nameOf = (id: string) => provider.models.find((m) => m.id === id)?.name || id;

  const save = async (next: ProviderPricing | null, message: string) => {
    setError(""); setNotice(""); setBusy(true);
    try {
      await setProviderPricing(level, provider.name, next, workspace);
      setNotice(message);
      onChanged();
    } catch (e) { setError(`保存失败：${(e as Error).message}`); }
    setBusy(false);
  };

  const submit = () => {
    let next: ProviderPricing;
    try {
      const models: Record<string, ModelPrice> = {};
      for (const [id, draft] of Object.entries(rows)) {
        if (id === DEFAULT_ROW) continue;
        const price = fromDraft(draft);
        if (price) models[id] = price;
      }
      const fallback = fromDraft(rows[DEFAULT_ROW]);
      next = { currency: currency.trim() || "¥", ...(fallback ? { default: fallback } : {}), ...(Object.keys(models).length ? { models } : {}) };
      if (!fallback && !Object.keys(models).length) { void save(null, "没有填写单价，回复底部只显示 Token 数。"); return; }
    } catch (e) { setError((e as Error).message); return; }
    void save(next, "已保存，之后的回复底部会显示估算花费。");
  };

  const ids = Object.keys(rows).filter((id) => id !== DEFAULT_ROW);

  return (
    <div className={embedded ? "" : "mt-3 pt-2 border-t border-border/60"}>
      {!embedded && (
        <button onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <Coins className="w-3.5 h-3.5" />计费单价 · {statusLabel}
          <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
        </button>
      )}
      {open && (
        <div className={`${embedded ? "" : "mt-2 "}space-y-2.5`}>
          <p className="text-[11px] text-muted-foreground">
            填了单价，回复底部按端点实际返回的 token 数估算本轮花费；不填只显示 Token 数。单价按每 100 万 token 填写，缓存命中不填时按输入价计算。
          </p>
          <div className="flex items-center gap-2">
            <label className="text-xs">货币符号</label>
            <Input value={currency} onChange={(e) => setCurrency(e.target.value)} className="h-7 w-16 text-xs" maxLength={8} />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[11px] text-muted-foreground">
                  <th className="py-1 pr-2 text-left font-normal">模型</th>
                  {PRICE_FIELDS.map((f) => <th key={f.key} className="py-1 px-1 text-left font-normal">{f.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {[...ids, DEFAULT_ROW].map((id) => (
                  <tr key={id}>
                    <td className="py-1 pr-2 max-w-[10rem] truncate" title={id === DEFAULT_ROW ? undefined : id}>
                      {id === DEFAULT_ROW ? <span className="text-muted-foreground">其他模型</span> : nameOf(id)}
                    </td>
                    {PRICE_FIELDS.map((f) => (
                      <td key={f.key} className="py-1 px-1">
                        <Input
                          inputMode="decimal"
                          value={rows[id]?.[f.key] ?? ""}
                          placeholder={f.key === "cacheRead" ? "同输入" : "—"}
                          onChange={(e) => setRows((prev) => ({ ...prev, [id]: { ...(prev[id] ?? toDraft()), [f.key]: e.target.value } }))}
                          className="h-7 w-20 text-xs"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={submit} disabled={busy}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Save className="w-3.5 h-3.5 mr-1" />}保存单价
            </Button>
            {pricing && (
              <Button size="sm" variant="ghost" onClick={() => void save(null, "已清除单价，回复底部只显示 Token 数。")} disabled={busy}>
                <Trash2 className="w-3.5 h-3.5 mr-1" />清除
              </Button>
            )}
          </div>
          {error && <p className="text-xs text-destructive break-all">{error}</p>}
          {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
        </div>
      )}
    </div>
  );
}
