/**
 * ProviderStudio —— 全局 Provider 配置管理器（编辑器 Tab WebView，view=providers）
 *
 * 管理 .axon/settings/providers.json：
 *   - 内置 provider（zhipu）：只暴露 API Key 输入
 *   - 自定义 provider：name / baseUrl / apiKey / 协议 / 模型，可增删
 *   - 写入层级：用户级（全局）/ 工作区级（仅当前项目）
 *
 * 解析合并（内置目录 + 自定义 + env）由 core 的 ProviderRegistry 完成，写后即时注入运行时。
 */

import { useState, useEffect, useCallback } from "react";
import { Loader2, Cloud, Plus, Trash2, Save, KeyRound, ChevronRight, Pencil, Ban, RotateCcw, Download, Globe, ArrowUpToLine, ArrowDownToLine, Eye, WalletCards, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VisionFallbackSelector } from "@/components/ModelSelector";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  getProviders,
  setBuiltinProviderKey,
  setBuiltinProviderBaseUrl,
  setBuiltinProviderModels,
  addCustomProvider,
  removeCustomProvider,
  setCustomProviderModels,
  probeProviderModels,
  openProviderConfigInEditor,
  moveCustomProvider,
  getVisionFallbackModel,
  setVisionFallbackModel,
  type ProviderLevel,
  type ResolvedProviderInfo,
  type ProviderModelInfo,
  type ProbedModelInfo,
  type ProviderQuotaConfig,
  type ProviderQuotaResult,
  setProviderQuota,
  testProviderQuota,
  setProviderQuotaTokens,
  getProviderQuotaTokenStatus,
} from "@/lib/apiClient";

function isInVSCode(): boolean {
  return typeof window !== "undefined" && !!(window as any).__axonVSCode;
}

interface ProviderStudioProps {
  /** 当前工作区路径（空则只能写用户级） */
  workspace: string;
}

export function ProviderStudio({ workspace }: ProviderStudioProps) {
  const [level, setLevel] = useState<ProviderLevel>("user");
  const [providers, setProviders] = useState<ResolvedProviderInfo[]>([]);
  const [visionFallbackModel, setVisionFallbackModelState] = useState<string | null>(null);
  const [savingVision, setSavingVision] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { providers: list } = await getProviders(workspace || undefined);
      setProviders(list);
      const { model } = await getVisionFallbackModel(workspace || undefined);
      setVisionFallbackModelState(model);
    } catch (e) {
      console.warn("加载 provider 失败", e);
    }
    setLoading(false);
  }, [workspace]);

  // 增量刷新：只更新数据，不触发 loading 占位，避免组件树卸载导致展开状态丢失。
  const refresh = useCallback(async () => {
    try {
      const { providers: list } = await getProviders(workspace || undefined);
      setProviders(list);
      const { model } = await getVisionFallbackModel(workspace || undefined);
      setVisionFallbackModelState(model);
    } catch (e) {
      console.warn("刷新 provider 失败", e);
    }
  }, [workspace]);

  useEffect(() => { load(); }, [load]);

  const saveVisionFallback = async (modelId: string | null) => {
    setSavingVision(true);
    try {
      await setVisionFallbackModel(modelId, level, workspace || undefined);
      setVisionFallbackModelState(modelId);
    } catch (e) {
      console.warn("保存识图兜底模型失败", e);
    }
    setSavingVision(false);
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  }

  const builtins = providers.filter((p) => p.builtin);
  const customs = providers.filter((p) => !p.builtin && p.customLevel === level);
  const wsArg = workspace || undefined;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-5 pt-4 pb-2 border-b border-border sticky top-0 bg-background z-10">
        <div className="flex items-center gap-2 mb-3">
          <Cloud className="w-4 h-4 text-blue-500" />
          <span className="text-sm font-medium">Provider 配置</span>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            <LevelButton active={level === "user"} onClick={() => setLevel("user")} label="用户级（全局）" />
            <LevelButton active={level === "workspace"} onClick={() => setLevel("workspace")} label="工作区级" disabled={!workspace} />
          </div>
          {isInVSCode() && (
            <Button size="sm" variant="outline" onClick={() => openProviderConfigInEditor(level, wsArg)}>
              在编辑器中打开
            </Button>
          )}
        </div>
        <div className="text-[11px] text-muted-foreground mt-2">
          写入目标：{level === "user" ? "~/.axon/settings/providers.json" : "<工作区>/.axon/settings/providers.json"}
        </div>
      </div>

      {/* 识图兜底模型 */}
      <div className="px-5 pt-4">
        <div className="px-3 py-2.5 rounded-lg border border-border bg-muted/20">
          <div className="flex items-center gap-2 mb-1">
            <Eye className="w-4 h-4 text-violet-500" />
            <span className="text-sm font-medium">识图兜底模型</span>
          </div>
          <p className="text-[11px] text-muted-foreground mb-2">
            主模型不支持图片时，用该模型把图片转成文字描述再喂给主模型。留空 = 不启用识图兜底。
          </p>
          <VisionFallbackSelector value={visionFallbackModel} onChange={saveVisionFallback} />
        </div>
      </div>

      {/* 内置 provider */}
      <div className="px-5 pt-4">
        <div className="text-xs font-medium text-muted-foreground mb-2">内置 Provider</div>
        <div className="space-y-2">
          {builtins.map((p) => (
            <BuiltinCard key={p.name} provider={p} level={level} workspace={wsArg} onChanged={refresh} />
          ))}
        </div>
      </div>

      {/* 自定义 provider */}
      <div className="px-5 pt-5 pb-6">
        <div className="text-xs font-medium text-muted-foreground mb-2">自定义 Provider</div>
        <div className="space-y-2 mb-3">
          {customs.length === 0 && (
            <div className="text-sm text-muted-foreground py-3 text-center border border-dashed border-border rounded-lg">
              暂无自定义 Provider，下方添加一个 OpenAI 兼容端点。
            </div>
          )}
          {customs.map((p) => (
            <CustomCard key={p.name} provider={p} level={level} workspace={wsArg} onChanged={refresh} />
          ))}
        </div>
        <AddCustomForm level={level} workspace={wsArg} onChanged={refresh} />
      </div>
    </div>
  );
}

function LevelButton({ active, onClick, label, disabled }: { active: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 text-xs rounded-md transition-colors ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"} disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {label}
    </button>
  );
}

/** 内置 provider 卡片：API Key + Base URL 可编辑，模型列表只读 */
function BuiltinCard({ provider, level, workspace, onChanged }: { provider: ResolvedProviderInfo; level: ProviderLevel; workspace?: string; onChanged: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl || "");
  const [savingKey, setSavingKey] = useState(false);
  const [savingUrl, setSavingUrl] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const saveKey = async () => {
    setSavingKey(true);
    setErrorMessage("");
    try {
      await setBuiltinProviderKey(level, provider.name, apiKey, workspace);
      setApiKey("");
      onChanged();
    } catch (e) {
      setErrorMessage(`保存失败: ${(e as Error).message}`);
    }
    setSavingKey(false);
  };

  const saveBaseUrl = async () => {
    setSavingUrl(true);
    setErrorMessage("");
    try {
      await setBuiltinProviderBaseUrl(level, provider.name, baseUrl.trim(), workspace);
      onChanged();
    } catch (e) {
      setErrorMessage(`保存失败: ${(e as Error).message}`);
    }
    setSavingUrl(false);
  };

  return (
    <div className="px-3 py-2.5 rounded-lg border border-border bg-muted/20">
      <div className="flex items-center gap-2 mb-2">
        <Cloud className={`w-4 h-4 ${provider.configured ? "text-blue-500" : "text-muted-foreground"}`} />
        <span className="text-sm font-medium">{provider.label}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${provider.configured ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" : "bg-muted text-muted-foreground"}`}>
          {provider.configured ? "已配置" : "未配置"}
        </span>
        {provider.locked && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">仅可改 Key</span>}
        <button onClick={() => setExpanded((v) => !v)} className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground">
          <ChevronRight className={`w-3 h-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
          {provider.models.length} 模型 · {provider.protocol}
        </button>
      </div>
      <div className="flex gap-2 mb-2">
        <Input
          type="password"
          placeholder={provider.configured ? "已配置（留空保留，输入则覆盖）" : "输入 API Key"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="h-8 text-sm flex-1"
        />
        <Button size="sm" onClick={saveKey} disabled={savingKey || !apiKey.trim()}>
          {savingKey ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}保存
        </Button>
      </div>
      <div className="flex gap-2">
        <Input
          placeholder="Base URL（留空使用默认）"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          className="h-8 text-sm flex-1"
        />
        <Button size="sm" variant="outline" onClick={saveBaseUrl} disabled={savingUrl || !baseUrl.trim()}>
          {savingUrl ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}更新
        </Button>
      </div>
      {errorMessage && <div className="mt-2 text-xs text-red-600 dark:text-red-400">{errorMessage}</div>}
      {expanded && (
        <div className="mt-2 pt-2 border-t border-border/60">
          <ModelManager
            models={provider.models}
            editable={true}
            providerName={provider.name}
            level={level}
            workspace={workspace}
            onSave={async (models) => {
              try {
                await setBuiltinProviderModels(level, provider.name, models, workspace);
                onChanged();
              } catch (e) {
                setErrorMessage(`保存模型失败: ${(e as Error).message}`);
              }
            }}
          />
          <QuotaConfigPanel provider={provider} level={level} workspace={workspace} onChanged={onChanged} />
        </div>
      )}
    </div>
  );
}

/** 自定义 provider 卡片：展示 + 删除 + 模型增删改禁用 */
function CustomCard({ provider, level, workspace, onChanged }: { provider: ResolvedProviderInfo; level: ProviderLevel; workspace?: string; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [moving, setMoving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editLabel, setEditLabel] = useState(provider.label || "");
  const [editBaseUrl, setEditBaseUrl] = useState(provider.baseUrl || "");
  const [editApiKey, setEditApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const remove = async () => {
    setDeleting(true);
    setErrorMessage("");
    try {
      await removeCustomProvider(level, provider.name, workspace);
      onChanged();
    } catch (e) {
      setErrorMessage(`删除失败: ${(e as Error).message}`);
      setConfirmDelete(false);
    }
    setDeleting(false);
  };

  const handleDeleteClick = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 4000); // 4 秒后自动取消
      return;
    }
    remove();
  };

  const startEditing = () => {
    setEditLabel(provider.label || "");
    setEditBaseUrl(provider.baseUrl || "");
    setEditApiKey("");
    setEditing(true);
    setErrorMessage("");
  };

  const cancelEditing = () => {
    setEditing(false);
    setErrorMessage("");
  };

  const saveEdit = async () => {
    if (!editBaseUrl.trim()) {
      setErrorMessage("Base URL 必填");
      return;
    }
    setSaving(true);
    setErrorMessage("");
    try {
      // addCustomProvider 是 upsert：同名 key 直接覆盖整个 entry
      await addCustomProvider(level, provider.name, {
        label: editLabel.trim() || provider.name,
        baseUrl: editBaseUrl.trim(),
        // API Key 为空时不传（保留原值由后端 merge 处理）
        ...(editApiKey.trim() ? { apiKey: editApiKey.trim() } : {}),
        models: provider.models,
      }, workspace);
      setEditing(false);
      onChanged();
    } catch (e) {
      setErrorMessage(`保存失败: ${(e as Error).message}`);
    }
    setSaving(false);
  };

  const saveModels = async (models: ProviderModelInfo[]) => {
    setErrorMessage("");
    try {
      await setCustomProviderModels(level, provider.name, models, workspace);
      onChanged();
    } catch (e) {
      setErrorMessage(`保存模型失败: ${(e as Error).message}`);
    }
  };

  const targetLevel: ProviderLevel = level === "workspace" ? "user" : "workspace";
  const canMove = level === "user" ? !!workspace : true;
  const moveLabel = level === "workspace" ? "提升为用户级" : "降级为工作区级";

  const move = async () => {
    if (!canMove) return;
    setMoving(true);
    setErrorMessage("");
    try {
      await moveCustomProvider(level, targetLevel, provider.name, workspace);
      onChanged();
    } catch (e) {
      setErrorMessage(`迁移失败: ${(e as Error).message}`);
    }
    setMoving(false);
  };

  return (
    <div className="rounded-lg border border-border bg-muted/20">
      <div className="group flex items-center gap-2 px-3 py-2">
        <button onClick={() => { setExpanded((v) => !v); setConfirmDelete(false); }} className="shrink-0 text-muted-foreground hover:text-foreground">
          <ChevronRight className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
        <Cloud className={`w-4 h-4 shrink-0 ${provider.configured ? "text-blue-500" : "text-muted-foreground"}`} />
        <div className="min-w-0 flex-1 cursor-pointer" onClick={() => { setExpanded((v) => !v); setConfirmDelete(false); }}>
          <div className="text-sm font-medium truncate">{provider.label || provider.name}</div>
          <div className="text-xs text-muted-foreground truncate">{provider.baseUrl} · {provider.models.length} 模型 · {provider.protocol}</div>
        </div>
        {!provider.configured && <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">未配置</span>}
        <button
          onClick={() => { setExpanded(true); startEditing(); }}
          className="shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
          title="编辑 provider"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleDeleteClick}
          className={`shrink-0 p-1 rounded transition-all flex items-center whitespace-nowrap ${confirmDelete ? "bg-red-100 dark:bg-red-900/30 text-red-600 opacity-100 px-1.5" : "opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 hover:bg-muted"}`}
          title={confirmDelete ? "再次点击确认删除" : "删除 provider"}
          disabled={deleting}
        >
          {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5 shrink-0" />}
          {confirmDelete && <span className="ml-1 text-[11px] font-medium">确认删除</span>}
        </button>
      </div>
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border/60">
          {editing ? (
            <div className="space-y-2 mb-3">
              <div className="text-xs font-medium text-muted-foreground mb-1">编辑 Provider 信息</div>
              <Input placeholder="展示名" value={editLabel} onChange={(e) => setEditLabel(e.target.value)} className="h-8 text-sm" />
              <Input placeholder="Base URL" value={editBaseUrl} onChange={(e) => setEditBaseUrl(e.target.value)} className="h-8 text-sm" />
              <Input type="password" placeholder="API Key（留空保持不变）" value={editApiKey} onChange={(e) => setEditApiKey(e.target.value)} className="h-8 text-sm" />
              {errorMessage && <div className="text-xs text-red-600 dark:text-red-400">{errorMessage}</div>}
              <div className="flex gap-2">
                <Button size="sm" onClick={saveEdit} disabled={saving || !editBaseUrl.trim()}>
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Save className="w-3.5 h-3.5 mr-1" />}保存
                </Button>
                <Button size="sm" variant="ghost" onClick={cancelEditing}>取消</Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="text-[11px] text-muted-foreground">
                当前层级：{level === "user" ? "用户级（全局）" : "工作区级"}
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="outline" onClick={startEditing}>
                  <Pencil className="w-3.5 h-3.5 mr-1" />编辑
                </Button>
                <Button size="sm" variant="outline" onClick={move} disabled={moving || !canMove}>
                  {moving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : level === "workspace" ? <ArrowUpToLine className="w-3.5 h-3.5 mr-1" /> : <ArrowDownToLine className="w-3.5 h-3.5 mr-1" />}
                  {moveLabel}
                </Button>
              </div>
            </div>
          )}
          {!editing && errorMessage && <div className="mb-3 text-xs text-red-600 dark:text-red-400">{errorMessage}</div>}
          <ModelManager models={provider.models} editable onSave={saveModels} providerName={provider.name} level={level} workspace={workspace} />
          <QuotaConfigPanel provider={provider} level={level} workspace={workspace} onChanged={onChanged} />
        </div>
      )}
    </div>
  );
}

const quotaTemplate = (provider: ResolvedProviderInfo): ProviderQuotaConfig => ({
  enabled: true,
  url: "{{origin}}/user/api/usage",
  method: "GET",
  headers: { authorization: "Bearer {{apiKey}}", accept: "application/json" },
  fields: { used: "$.totalCredits", total: "$.creditLimit" },
});

const subscriptionQuotaTemplate: ProviderQuotaConfig = {
  enabled: true,
  url: "{{origin}}/api/subscription",
  method: "GET",
  headers: { accept: "application/json" },
  auth: { header: "authorization", prefix: "Bearer " },
  fields: {
    used: "$.data.subscriptions[0].subscription.amount_used",
    total: "$.data.subscriptions[0].subscription.amount_total",
    resetAt: "$.data.subscriptions[0].subscription.next_reset_time",
  },
  scale: 500000,
  unit: "$",
};

/** 声明式额度规则编辑器：请求只由扩展宿主发起，网页从不接触 API Key。 */
function QuotaConfigPanel({ provider, level, workspace, onChanged }: {
  provider: ResolvedProviderInfo;
  level: ProviderLevel;
  workspace?: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(provider.quota || quotaTemplate(provider), null, 2));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ProviderQuotaResult | null>(null);
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [cookie, setCookie] = useState("");
  const [savingTokens, setSavingTokens] = useState(false);
  const [credentialSaved, setCredentialSaved] = useState("");
  const [credentialStatus, setCredentialStatus] = useState<{ hasAccessToken: boolean; hasRefreshToken: boolean; hasCookie: boolean } | null>(null);

  const quotaAuth = (() => {
    try {
      const config = JSON.parse(text) as ProviderQuotaConfig;
      return config.auth;
    } catch { return undefined; }
  })();

  useEffect(() => {
    if (!open || !quotaAuth?.cookieHeader) return;
    void getProviderQuotaTokenStatus(provider.name, workspace)
      .then(setCredentialStatus)
      .catch(() => setCredentialStatus(null));
  }, [open, provider.name, workspace, quotaAuth?.cookieHeader]);

  const parse = (): ProviderQuotaConfig | null => {
    try {
      const value = JSON.parse(text) as ProviderQuotaConfig;
      if (!value || typeof value !== "object") throw new Error("配置必须是 JSON 对象");
      return value;
    } catch (e) {
      setError(`JSON 格式无效：${(e as Error).message}`);
      return null;
    }
  };

  const save = async () => {
    const quota = parse();
    if (!quota) return;
    setSaving(true);
    setError("");
    try {
      await setProviderQuota(level, provider.name, quota, workspace);
      onChanged();
    } catch (e) { setError(`保存失败：${(e as Error).message}`); }
    setSaving(false);
  };

  const test = async () => {
    const quota = parse();
    if (!quota) return;
    setTesting(true);
    setError("");
    setResult(null);
    try { setResult(await testProviderQuota(provider.name, quota, workspace)); }
    catch (e) { setError(`查询失败：${(e as Error).message}`); }
    setTesting(false);
  };

  const saveTokens = async () => {
    if (!accessToken.trim() && !refreshToken.trim() && !cookie.trim()) return;
    setSavingTokens(true);
    setError("");
    setCredentialSaved("");
    try {
      await setProviderQuotaTokens(provider.name, {
        accessToken: accessToken.trim() || undefined,
        refreshToken: refreshToken.trim() || undefined,
        cookie: cookie.trim() || undefined,
      }, workspace);
      setAccessToken("");
      setRefreshToken("");
      setCookie("");
      setCredentialSaved("凭证已安全保存");
      setCredentialStatus(await getProviderQuotaTokenStatus(provider.name, workspace));
    } catch (e) { setError(`保存令牌失败：${(e as Error).message}`); }
    setSavingTokens(false);
  };

  const enableCookieAuth = () => {
    const quota = parse();
    if (!quota) return;
    setText(JSON.stringify({
      ...quota,
      auth: { ...quota.auth, cookieHeader: quota.auth?.cookieHeader || "cookie" },
    }, null, 2));
    setError("");
  };

  return (
    <div className="mt-3 pt-2 border-t border-border/60">
      <button onClick={() => setOpen((value) => !value)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <WalletCards className="w-3.5 h-3.5" />额度查询 {provider.quota?.enabled ? "已启用" : "配置"}
        <ChevronRight className={`w-3 h-3 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="rounded-md border border-border/70 bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground space-y-1">
            <p>支持 <code>{"{{origin}}"}</code>、<code>{"{{baseUrl}}"}</code>、<code>{"{{apiKey}}"}</code>；响应字段只支持 <code>$.data.balance</code> 这类路径。<code>scale</code> 可将余额、已用和总额统一除以换算系数；<code>resetAt</code> 支持 Unix 秒或毫秒时间戳。密钥仅在本地扩展进程中替换。</p>
            <p><strong className="text-foreground">使用同一把 API Key：</strong>请求头填 <code>authorization: Bearer {"{{apiKey}}"}</code>，不需要下面的额度 Token。</p>
            <p><strong className="text-foreground">使用独立额度 Token：</strong>在规则填写 <code>auth.header</code>（例如 <code>authorization</code>）与 <code>auth.prefix</code>（例如 <code>Bearer </code>）后，下面会出现“额度 Bearer Token”输入框；它安全保存，不会写进规则 JSON。</p>
            <p><strong className="text-foreground">Cookie 查询：</strong>规则填 <code>auth.cookieHeader: "cookie"</code> 后，会显示独立 Cookie 输入框；可单独使用，也可与 Bearer Token 组合。</p>
            <p><strong className="text-foreground">自动刷新：</strong>仅配置 <code>auth.refresh</code> 时才需要额外填写 refresh token。</p>
          </div>
          {!quotaAuth?.cookieHeader && <Button size="sm" variant="outline" onClick={enableCookieAuth}>
            <KeyRound className="w-3.5 h-3.5 mr-1" />使用 Cookie 凭证
          </Button>}
          {(quotaAuth?.header || quotaAuth?.cookieHeader) && <div className="space-y-2">
            {quotaAuth.header && <div className="space-y-1">
              <label className="text-xs font-medium">额度 Bearer Token</label>
              <Input type="password" placeholder="粘贴独立额度 Token；留空保持不变" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} className="h-8 text-xs" />
            </div>}
            {quotaAuth.cookieHeader && <div className="space-y-1">
              <label className="text-xs font-medium">额度 Cookie</label>
              <Input type="password" placeholder="粘贴完整 Cookie，例如 session=...; token=...；留空保持不变" value={cookie} onChange={(event) => setCookie(event.target.value)} className="h-8 text-xs" />
              <span className={`text-[11px] ${credentialStatus?.hasCookie ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}>
                {credentialStatus?.hasCookie ? "Cookie 已安全保存" : "Cookie 尚未保存"}
              </span>
            </div>}
            {quotaAuth.refresh && <div className="space-y-1">
              <label className="text-xs font-medium">刷新令牌</label>
              <Input type="password" placeholder="粘贴 refresh token；留空保持不变" value={refreshToken} onChange={(event) => setRefreshToken(event.target.value)} className="h-8 text-xs" />
            </div>}
            <Button size="sm" variant="outline" onClick={saveTokens} disabled={savingTokens || (!accessToken.trim() && !refreshToken.trim() && !cookie.trim())}>
              {savingTokens ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <KeyRound className="w-3.5 h-3.5 mr-1" />}{quotaAuth.cookieHeader && !quotaAuth.header && !quotaAuth.refresh ? "保存 Cookie" : "保存凭证"}
            </Button>
            {credentialSaved && <p className="text-[11px] text-green-600 dark:text-green-400">{credentialSaved}</p>}
          </div>}
          <textarea value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} className="w-full min-h-44 rounded-md border border-input bg-background px-2 py-1.5 font-mono text-[11px] leading-5" />
          <div className="flex gap-2">
            <Button size="sm" onClick={save} disabled={saving}>{saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Save className="w-3.5 h-3.5 mr-1" />}保存规则</Button>
            <Button size="sm" variant="outline" onClick={test} disabled={testing || (!provider.configured && !quotaAuth?.header)}>{testing ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Play className="w-3.5 h-3.5 mr-1" />}测试查询</Button>
            <Button size="sm" variant="ghost" onClick={() => { setText(JSON.stringify(quotaTemplate(provider), null, 2)); setResult(null); setError(""); }}>恢复模板</Button>
            <Button size="sm" variant="ghost" onClick={() => { setText(JSON.stringify(subscriptionQuotaTemplate, null, 2)); setResult(null); setError(""); }}>订阅额度模板</Button>
          </div>
          {!provider.configured && !quotaAuth?.header && <p className="text-[11px] text-amber-600 dark:text-amber-400">需先保存 Provider API Key 才能测试查询。</p>}
          {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
          {result && <div className="rounded-md bg-muted/50 px-2 py-1.5 text-[11px] space-y-1"><p>查询结果：{result.balance !== undefined ? `余额 ${result.balance}` : ""}{result.used !== undefined ? ` 已用 ${result.used}` : ""}{result.total !== undefined ? ` / ${result.total}` : ""}{result.unit ? ` ${result.unit}` : ""}{result.resetAt ? ` · 下次重置 ${new Date(result.resetAt).toLocaleString()}` : ""}</p><details><summary className="cursor-pointer text-muted-foreground">查看脱敏响应预览</summary><pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap">{result.responsePreview}</pre></details></div>}
        </div>
      )}
    </div>
  );
}

/**
 * 模型列表管理器：内置 provider 只读展示；自定义 provider 可增/删/改/禁用，并支持从端点批量导入。
 * 任何变更都在数组上算好后整存（onSave），由后端覆盖该 provider 的 models 字段。
 */
function ModelManager({ models, editable, onSave, providerName, level, workspace }: {
  models: ProviderModelInfo[];
  editable?: boolean;
  onSave?: (models: ProviderModelInfo[]) => void;
  providerName?: string;
  level?: ProviderLevel;
  workspace?: string;
}) {
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [probed, setProbed] = useState<ProbedModelInfo[] | null>(null);

  const [confirmDeleteIdx, setConfirmDeleteIdx] = useState<number | null>(null);

  const commit = (next: ProviderModelInfo[]) => { onSave?.(next); setEditing(null); setConfirmDeleteIdx(null); };
  const toggle = (i: number) => commit(models.map((m, idx) => (idx === i ? { ...m, disabled: !m.disabled } : m)));
  const del = (i: number) => {
    if (confirmDeleteIdx !== i) { setConfirmDeleteIdx(i); setTimeout(() => setConfirmDeleteIdx(null), 4000); return; }
    setConfirmDeleteIdx(null);
    commit(models.filter((_, idx) => idx !== i));
  };
  const saveOne = (model: ProviderModelInfo, idx: number | "new") =>
    commit(idx === "new" ? [...models, model] : models.map((m, i) => (i === idx ? model : m)));

  const runImport = async () => {
    if (!providerName) return;
    setImporting(true);
    try {
      const { models: list } = await probeProviderModels({ name: providerName, level, workspace });
      setProbed(list);
    } catch (e) {
      alert(`拉取失败: ${(e as Error).message}`);
    }
    setImporting(false);
  };

  const applyImport = (picks: ProbedModelInfo[]) => {
    const existing = new Set(models.map((m) => m.id));
    const added: ProviderModelInfo[] = picks
      .filter((p) => !existing.has(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name || p.id,
        contextWindow: p.contextWindow ?? 128000,
        vision: p.vision ?? false,
        protocol: p.protocol,
        vendor: p.vendor,
      }));
    setProbed(null);
    if (added.length > 0) onSave?.([...models, ...added]);
  };

  return (
    <div className="space-y-1">
      {models.length === 0 && editing !== "new" && (
        <div className="text-xs text-muted-foreground py-2 text-center">暂无模型</div>
      )}
      {models.map((m, i) =>
        editing === i ? (
          <ModelForm key={i} initial={m} onSave={(mm) => saveOne(mm, i)} onCancel={() => setEditing(null)} />
        ) : (
          <ModelRow
            key={i}
            model={m}
            editable={!!editable}
            confirmDelete={confirmDeleteIdx === i}
            onToggle={() => toggle(i)}
            onEdit={() => setEditing(i)}
            onDelete={() => del(i)}
          />
        ),
      )}
      {editable && editing !== "new" && (
        <div className="flex items-center gap-3 mt-1">
          <button onClick={() => setEditing("new")} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <Plus className="w-3.5 h-3.5" />添加模型
          </button>
          {providerName && (
            <button onClick={runImport} disabled={importing} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
              {importing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}从端点导入
            </button>
          )}
        </div>
      )}
      {editable && editing === "new" && (
        <ModelForm onSave={(mm) => saveOne(mm, "new")} onCancel={() => setEditing(null)} />
      )}
      {probed && <ImportPanel probed={probed} existingIds={models.map((m) => m.id)} onApply={applyImport} onCancel={() => setProbed(null)} />}
    </div>
  );
}

/** 端点导入结果选择面板 */
function ImportPanel({ probed, existingIds, onApply, onCancel }: { probed: ProbedModelInfo[]; existingIds: string[]; onApply: (picks: ProbedModelInfo[]) => void; onCancel: () => void }) {
  const existing = new Set(existingIds);
  const selectable = probed.filter((p) => !existing.has(p.id));
  const [picked, setPicked] = useState<Set<string>>(new Set(selectable.map((p) => p.id)));

  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return (
    <div className="mt-2 p-2 rounded-md border border-border bg-background">
      <div className="text-xs font-medium mb-1.5">拉取到 {probed.length} 个模型（已存在的已跳过），勾选导入：</div>
      <div className="max-h-48 overflow-y-auto space-y-0.5">
        {selectable.length === 0 && <div className="text-xs text-muted-foreground py-1">没有新模型可导入</div>}
        {selectable.map((p) => (
          <label key={p.id} className="flex items-center gap-2 px-1 py-1 rounded hover:bg-muted/50 cursor-pointer text-xs">
            <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} className="w-3 h-3 accent-primary" />
            <span className="font-mono truncate flex-1">{p.id}</span>
            {p.vision === true && <span className="text-[9px] px-1 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">多模态</span>}
            <span className="text-[10px] text-muted-foreground">{p.contextWindow ? `${(p.contextWindow / 1000).toFixed(0)}K` : "窗口未知·默认128K"}</span>
          </label>
        ))}
      </div>
      <div className="text-[10px] text-muted-foreground mt-1.5">端点未返回多模态/窗口的，按"不支持/128K"默认导入，可在列表里再编辑。</div>
      <div className="flex gap-2 mt-2">
        <Button size="sm" onClick={() => onApply(selectable.filter((p) => picked.has(p.id)))} disabled={picked.size === 0}>导入 {picked.size} 个</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>取消</Button>
      </div>
    </div>
  );
}

/** 单行模型展示（含禁用态样式与悬浮操作） */
function ModelRow({ model, editable, confirmDelete, onToggle, onEdit, onDelete }: { model: ProviderModelInfo; editable: boolean; confirmDelete?: boolean; onToggle: () => void; onEdit: () => void; onDelete: () => void }) {
  const win = model.contextWindow >= 1000000 ? `${(model.contextWindow / 1000000).toFixed(0)}M` : `${(model.contextWindow / 1000).toFixed(0)}K`;
  return (
    <div className={`group/m flex items-center gap-2 px-2 py-1 rounded ${model.disabled ? "opacity-50" : ""}`}>
      <div className="min-w-0 flex-1">
        <span className={`text-xs font-medium ${model.disabled ? "line-through" : ""}`}>{model.name || model.id}</span>
        {model.vendor && <span className="ml-1 text-[9px] px-1 rounded bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">{model.vendor}</span>}
        {model.protocol && <span className="ml-1 text-[9px] px-1 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">{model.protocol}</span>}
        {model.vision && <span className="ml-1 text-[9px] px-1 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">多模态</span>}
        {model.thinking && <span className="ml-1 text-[9px] px-1 rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">思考</span>}
        {model.cacheControl && <span className="ml-1 text-[9px] px-1 rounded bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">缓存</span>}
        {model.disabled && <span className="ml-1 text-[9px] px-1 rounded bg-muted text-muted-foreground">已禁用</span>}
        <span className="ml-1.5 text-[10px] text-muted-foreground font-mono">{model.id} · {win}</span>
      </div>
      {editable && (
        <div className="flex items-center gap-0.5 opacity-0 group-hover/m:opacity-100 transition-opacity">
          <button onClick={onToggle} title={model.disabled ? "启用" : "禁用"} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted">
            {model.disabled ? <RotateCcw className="w-3 h-3" /> : <Ban className="w-3 h-3" />}
          </button>
          <button onClick={onEdit} title="编辑" className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted">
            <Pencil className="w-3 h-3" />
          </button>
          <button onClick={onDelete} title={confirmDelete ? "再次点击确认删除" : "删除"} className={`p-1 rounded transition-all flex items-center whitespace-nowrap ${confirmDelete ? "bg-red-100 dark:bg-red-900/30 text-red-600 px-1" : "text-muted-foreground hover:text-red-500 hover:bg-muted"}`}>
            <Trash2 className="w-3 h-3 shrink-0" />
            {confirmDelete && <span className="ml-0.5 text-[10px] font-medium">确认</span>}
          </button>
        </div>
      )}
    </div>
  );
}

/** 模型新增/编辑表单 */
function ModelForm({ initial, onSave, onCancel }: { initial?: ProviderModelInfo; onSave: (m: ProviderModelInfo) => void; onCancel: () => void }) {
  const [id, setId] = useState(initial?.id || "");
  const [name, setName] = useState(initial?.name || "");
  const [win, setWin] = useState(String(initial?.contextWindow || 128000));
  const [vision, setVision] = useState(!!initial?.vision);
  const [vendor, setVendor] = useState(initial?.vendor || "");
  const [protocol, setProtocol] = useState<"chat" | "responses" | "anthropic">(initial?.protocol || "chat");
  const [cacheControl, setCacheControl] = useState(!!initial?.cacheControl);

  const vendorOptions = [
    { id: "openai", label: "OpenAI" },
    { id: "anthropic", label: "Anthropic" },
    { id: "qwen", label: "Qwen" },
    { id: "zhipu", label: "Zhipu" },
    { id: "ollama", label: "Ollama" },
  ];

  // 选择厂商 = Anthropic 时不自动切协议：多数中转站把 Claude 包装成 OpenAI 兼容格式，
  // 走 chat 协议即可，只有该端点【只】提供原生 Anthropic Messages API 时才需要手动
  // 把下方协议切到 Anthropic（该端点没有 /v1/chat/completions，会 404）。

  const submit = () => {
    if (!id.trim()) return;
    const contextWindow = /^\d+$/.test(win.trim()) ? parseInt(win.trim(), 10) : 128000;
    onSave({ id: id.trim(), name: name.trim() || id.trim(), contextWindow, vision, cacheControl: cacheControl || undefined, protocol, vendor: vendor || undefined, disabled: initial?.disabled });
  };

  return (
    <div className="p-2 rounded-md border border-border bg-background space-y-1.5 my-1">
      <Input placeholder="模型 id（发给 API 的那个，如 gpt-4o）" value={id} onChange={(e) => setId(e.target.value)} className="h-7 text-xs" />
      <div className="flex items-center gap-2">
        <Input placeholder="显示名（可选）" value={name} onChange={(e) => setName(e.target.value)} className="h-7 text-xs flex-1" />
        <Select value={vendor} onValueChange={setVendor}>
          <SelectTrigger className="h-7 text-xs w-[130px]">
            <SelectValue placeholder="厂商" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>厂商</SelectLabel>
              {vendorOptions.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  <Globe className="w-3 h-3 mr-1" />
                  {v.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Input placeholder="上下文窗口" value={win} onChange={(e) => setWin(e.target.value)} className="h-7 text-xs w-32" />
        <LevelButton active={protocol === "chat"} onClick={() => setProtocol("chat")} label="Chat" />
        <LevelButton active={protocol === "responses"} onClick={() => setProtocol("responses")} label="Responses" />
        <LevelButton active={protocol === "anthropic"} onClick={() => setProtocol("anthropic")} label="Anthropic" />
        <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} className="w-3 h-3 accent-primary" />
          多模态
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={cacheControl} onChange={(e) => setCacheControl(e.target.checked)} className="w-3 h-3 accent-primary" />
          缓存
        </label>
        <div className="ml-auto flex gap-1">
          <Button size="sm" onClick={submit} disabled={!id.trim()}>保存</Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>取消</Button>
        </div>
      </div>
      <div className="text-[10px] text-muted-foreground">
        上下文窗口与多模态以该 provider 官方文档为准；可用上方"从端点导入"自动带出（若端点返回）。
        {protocol === "anthropic" && (
          <span className="text-amber-600"> 注意：Anthropic 协议会调用 {"{baseUrl}"}/messages（原生 Messages API），仅当该端点【只】提供这个接口、没有 OpenAI 兼容的 /chat/completions 时才需要选它——多数中转站选 Chat 即可。</span>
        )}
      </div>
    </div>
  );
}

/** 添加自定义 provider 表单 */
function AddCustomForm({ level, workspace, onChanged }: { level: ProviderLevel; workspace?: string; onChanged: () => void }) {
  const [show, setShow] = useState(false);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ProviderModelInfo[]>([]);

  const reset = () => { setName(""); setLabel(""); setBaseUrl(""); setApiKey(""); setModels([]); setShow(false); };

  const submit = async () => {
    if (!name.trim() || !baseUrl.trim()) return;
    try {
      await addCustomProvider(level, name.trim(), {
        label: label.trim() || name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        models,
      }, workspace);
      reset();
      onChanged();
    } catch (e) {
      alert(`添加失败: ${(e as Error).message}`);
    }
  };

  if (!show) {
    return <Button size="sm" variant="outline" onClick={() => setShow(true)}><Plus className="w-3.5 h-3.5" />添加自定义 Provider</Button>;
  }

  return (
    <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-2">
      <Input placeholder="provider 名（唯一标识，如 my-openai）" value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-sm" />
      <Input placeholder="展示名（可选，如 我的 OpenAI）" value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 text-sm" />
      <Input placeholder="Base URL，如 https://api.openai.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="h-8 text-sm" />
      <Input type="password" placeholder="API Key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="h-8 text-sm" />
      <div className="border-t border-border/60 pt-2">
        <div className="text-[11px] font-medium text-muted-foreground mb-1">模型列表</div>
        <ModelEditor models={models} onChange={setModels} />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={!name.trim() || !baseUrl.trim()}><Save className="w-3.5 h-3.5" />保存</Button>
        <Button size="sm" variant="ghost" onClick={reset}>取消</Button>
      </div>
    </div>
  );
}

/** 轻量模型列表编辑（用于新增 provider 时逐个添加模型） */
function ModelEditor({ models, onChange }: { models: ProviderModelInfo[]; onChange: (mm: ProviderModelInfo[]) => void }) {
  const [editing, setEditing] = useState<number | "new" | null>(null);

  const del = (i: number) => onChange(models.filter((_, idx) => idx !== i));
  const save = (m: ProviderModelInfo, idx: number | "new") =>
    onChange(idx === "new" ? [...models, m] : models.map((prev, i) => (i === idx ? m : prev)));

  return (
    <div className="space-y-1">
      {models.map((m, i) =>
        editing === i ? (
          <ModelForm key={i} initial={m} onSave={(mm) => { save(mm, i); setEditing(null); }} onCancel={() => setEditing(null)} />
        ) : (
          <div key={i} className="flex items-center gap-2 px-2 py-1 rounded group/m">
            <span className="text-xs font-medium flex-1 truncate">{m.name || m.id}</span>
            <span className="text-[10px] text-muted-foreground font-mono">{m.id} · {m.contextWindow >= 1000 ? `${(m.contextWindow / 1000).toFixed(0)}K` : m.contextWindow}</span>
            {m.vision && <span className="text-[9px] px-1 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">多模态</span>}
            <div className="flex items-center gap-0.5 opacity-0 group-hover/m:opacity-100 transition-opacity">
              <button onClick={() => setEditing(i)} className="p-1 rounded text-muted-foreground hover:text-foreground"><Pencil className="w-3 h-3" /></button>
              <button onClick={() => del(i)} className="p-1 rounded text-muted-foreground hover:text-red-500"><Trash2 className="w-3 h-3" /></button>
            </div>
          </div>
        ),
      )}
      {editing === "new" ? (
        <ModelForm onSave={(mm) => { save(mm, "new"); setEditing(null); }} onCancel={() => setEditing(null)} />
      ) : (
        <button onClick={() => setEditing("new")} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-1">
          <Plus className="w-3.5 h-3.5" />添加模型
        </button>
      )}
    </div>
  );
}
