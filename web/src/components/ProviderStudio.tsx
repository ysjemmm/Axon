/**
 * ProviderStudio —— 全局 Provider 配置管理器（编辑器 Tab WebView，view=providers）
 *
 * 管理 .axon/settings/providers.json：
 *   - 内置 provider：按目录权限展示配置项
 *   - 自定义 provider：name / baseUrl / apiKey / 协议 / 模型，可增删
 *   - 写入层级：用户级（全局）/ 工作区级（仅当前项目）
 *
 * 解析合并（内置目录 + 自定义 + env）由 core 的 ProviderRegistry 完成，写后即时注入运行时。
 */

import { useState, useEffect, useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Loader2, Cloud, Plus, Trash2, Save, KeyRound, ChevronDown, CornerDownLeft, Pencil, Ban, RotateCcw, Download, MoreHorizontal, Check, ExternalLink, Brain, Zap, Image as ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { VisionFallbackSelector } from "@/components/ModelSelector";
import { VoiceInputSettings } from "@/components/VoiceInputSettings";
import { isVSCode } from "@/lib/transport";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  getProviders,
  setBuiltinProviderKey,
  setBuiltinProviderBaseUrl,
  setBuiltinProviderModels,
  addCustomProvider,
  removeCustomProvider,
  removeEnvProvider,
  setCustomProviderModels,
  probeProviderModels,
  openProviderConfigInEditor,
  getVisionFallbackModel,
  setVisionFallbackModel,
  type ProviderLevel,
  type ResolvedProviderInfo,
  type ProviderModelInfo,
  type ProbedModelInfo,
  type ProviderProtocol,
} from "@/lib/apiClient";
import { PROVIDER_PRESETS, PRESET_REGIONS, builtinToModel, hostOf, presetForBaseUrl, presetModels, slugify, type PresetRegion, type ProviderPreset } from "@/lib/providerPresets";
import { PricingPanel, QuotaConfigPanel, QuotaOverviewCard } from "@/components/QuotaPanels";
import { BUILTIN_MODELS, protocolForVendor, type BuiltinModel, type BuiltinModelTag } from "@/lib/builtinModels";

function isInVSCode(): boolean {
  return typeof window !== "undefined" && !!(window as any).__axonVSCode;
}

/**
 * 同一 provider 下 model id 必须唯一（见 @axon/core 的 assertUniqueModelIds）。
 * web 是独立工程、引用不到 core，所以这里做一份等价的轻量判定：只给即时反馈用，
 * 真正的强制校验在后端写入时——重复提交会被服务端拒绝并报错。
 */
function isDuplicateModelId(id: string, otherIds: readonly string[]): boolean {
  const trimmed = id.trim();
  if (!trimmed) return false;
  return otherIds.some((other) => other.trim() === trimmed);
}

/** 统一小徽标：字号/圆角一致，颜色只用语义 token，保证跟随 VSCode 深浅主题 */
function Tag({ children, variant = "muted", title, className }: {
  children: ReactNode;
  variant?: "muted" | "primary" | "outline";
  title?: string;
  className?: string;
}) {
  const variants = {
    muted: "bg-muted text-muted-foreground",
    primary: "bg-primary/10 text-primary",
    outline: "border border-border text-muted-foreground",
  } as const;
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] ${variants[variant]} ${className ?? ""}`}
    >
      {children}
    </span>
  );
}

interface ProviderStudioProps {
  /** 保留参数以兼容独立页面路由；Provider 配置当前统一使用用户级。 */
  workspace: string;
}

export function ProviderStudio({ workspace }: ProviderStudioProps) {
  const level: ProviderLevel = "user";
  const [providers, setProviders] = useState<ResolvedProviderInfo[]>([]);
  const [visionFallbackModel, setVisionFallbackModelState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  /** 从别处（如语音输入的指引）打开添加面板时预选的厂商 */
  const [addPreset, setAddPreset] = useState<string | undefined>(undefined);
  /** Provider 配置（含用量规则 / 凭证）保存后递增，让用量总览重新取数 */
  const [quotaVersion, setQuotaVersion] = useState(0);

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

  /** 保存成功后刷新本页，并通知宿主让聊天侧栏立即刷新模型/强度配置。 */
  const refreshAndNotify = useCallback(async () => {
    await refresh();
    setQuotaVersion((v) => v + 1);
    const vscode = (window as any).__axonVSCode || (typeof (window as any).acquireVsCodeApi === "function" ? (window as any).acquireVsCodeApi() : null);
    vscode?.postMessage({ type: "providers_changed" });
  }, [refresh]);

  useEffect(() => { load(); }, [load]);

  const saveVisionFallback = async (modelId: string | null) => {
    try {
      await setVisionFallbackModel(modelId, level, workspace || undefined);
      setVisionFallbackModelState(modelId);
    } catch (e) {
      console.warn("保存识图兜底模型失败", e);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  }

  const builtins = providers.filter((p) => p.builtin);
  // Provider 管理暂时只开放用户级配置。缺少 customLevel 的旧运行时载荷同样按用户级展示。
  const customs = providers.filter((p) => !p.builtin && (
    p.customLevel === "user" || p.customLevel === undefined
  ));
  const wsArg = undefined;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="sticky top-0 z-10 border-b border-border bg-background/95 px-6 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-[860px] items-center gap-2">
          <Cloud className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">模型 Provider</span>
          <span className="hidden text-[11px] text-muted-foreground sm:inline">· 保存在 <code className="font-mono">~/.axon/settings/providers.json</code></span>
          {isInVSCode() && (
            <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" onClick={() => openProviderConfigInEditor(level, wsArg)}>
              在编辑器中打开
            </Button>
          )}
        </div>
      </div>

      <div className="mx-auto w-full max-w-[860px] space-y-7 px-6 py-5">
        <QuotaOverviewCard workspace={wsArg} version={quotaVersion} />

        <section>
          <SectionTitle title="我的 Provider" hint={customs.length ? `${customs.length} 个` : undefined}
            action={!adding && <Button size="sm" className="h-7 text-xs" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5" />添加 Provider</Button>} />
          {adding && (
            <AddProviderPanel
              level={level}
              workspace={wsArg}
              takenNames={providers.map((p) => p.name)}
              initialPresetId={addPreset}
              onDone={() => { setAdding(false); setAddPreset(undefined); void refreshAndNotify(); }}
              onCancel={() => { setAdding(false); setAddPreset(undefined); }}
            />
          )}
          <div className="space-y-2.5">
            {customs.length === 0 && !adding && (
              <button onClick={() => setAdding(true)} className="w-full rounded-xl border border-dashed border-border px-4 py-6 text-center text-[13px] text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground">
                还没有自己的 Provider。点这里从 DeepSeek、Kimi、通义千问、OpenAI 等厂商里选一个，或者接入中转站。
              </button>
            )}
            {customs.map((p) => (
              <ProviderCard key={p.name} provider={p} level={level} workspace={wsArg} onChanged={refreshAndNotify} />
            ))}
          </div>
        </section>

        {builtins.length > 0 && (
          <section>
            <SectionTitle title="内置 Provider" />
            <div className="space-y-2.5">
              {builtins.map((p) => (
                <ProviderCard key={p.name} provider={p} level={level} workspace={wsArg} onChanged={refreshAndNotify} />
              ))}
            </div>
          </section>
        )}

        <section>
          <SectionTitle title="识图兜底模型" />
          <div className="rounded-xl border border-border px-4 py-3">
            <p className="mb-2 text-[12px] text-muted-foreground">当前模型不支持图片时，先用这个模型把图片转成文字再交给它。留空表示不启用。</p>
            <VisionFallbackSelector value={visionFallbackModel} onChange={saveVisionFallback} />
          </div>
        </section>

        {/* 语音输入只在 IDE 里有：录音在扩展进程里做 */}
        {isVSCode && (
          <section>
            <SectionTitle title="语音输入" />
            <VoiceInputSettings
              providers={providers}
              onAddSiliconflow={() => {
                setAddPreset("siliconflow");
                setAdding(true);
                // 添加面板在页面顶部：滚过去
                requestAnimationFrame(() => document.querySelector("[data-add-provider]")?.scrollIntoView({ behavior: "smooth", block: "start" }));
              }}
            />
          </section>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <h2 className="text-[13px] font-medium text-foreground">{title}</h2>
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      {action && <div className="ml-auto">{action}</div>}
    </div>
  );
}

/** Provider 徽章：认得出厂商就用品牌色缩写，否则取名字首字 */
function ProviderBadge({ baseUrl, label, size = "md" }: { baseUrl: string; label: string; size?: "sm" | "md" }) {
  const preset = presetForBaseUrl(baseUrl);
  const badge = preset?.badge ?? { text: (label.trim()[0] || "?").toUpperCase(), className: "bg-muted text-foreground" };
  const box = size === "sm" ? "size-7 text-[10px]" : "size-9 text-[12px]";
  return <span className={`inline-flex ${box} shrink-0 items-center justify-center rounded-lg font-semibold ${badge.className}`}>{badge.text}</span>;
}

type CardTab = "models" | "connection" | "quota" | "pricing";

/** 一个 Provider：标题行（徽章 / 名称 / 主机 / 状态）+ 展开后分标签页：模型、连接、用量、计费 */
function ProviderCard({ provider, level, workspace, onChanged }: { provider: ResolvedProviderInfo; level: ProviderLevel; workspace?: string; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<CardTab>("models");
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const isBuiltin = provider.builtin;
  // 环境变量来源：不在 providers.json 里，编辑 / 模型 / 用量都会写错地方，只能从 .env 移除
  const isEnvSource = provider.source === "env";
  const enabledModels = provider.models.filter((m) => !m.disabled).length;
  const quotaOn = !!provider.quota && provider.quota.enabled !== false;

  const saveModels = async (models: ProviderModelInfo[]) => {
    setErrorMessage("");
    try {
      if (isBuiltin) await setBuiltinProviderModels(level, provider.name, models, workspace);
      else await setCustomProviderModels(level, provider.name, models, workspace);
      onChanged();
    } catch (e) {
      setErrorMessage(`保存模型失败: ${(e as Error).message}`);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setErrorMessage("");
    try {
      if (isEnvSource) {
        const res = await removeEnvProvider(provider.name, workspace);
        // 若它同时由 VS Code 设置提供，改 .env 是删不掉的——如实说明该去哪删
        if (res.fromSettings) setErrorMessage("已从 ~/.axon/.env 移除；但它仍由 VS Code 设置（axon.providers / axon.env）提供，请到设置里删除后重载窗口。");
      } else {
        await removeCustomProvider(level, provider.name, workspace);
      }
      onChanged();
    } catch (e) {
      setErrorMessage(`删除失败: ${(e as Error).message}`);
    }
    setDeleting(false);
    setConfirmDelete(false);
  };

  const tabs: { id: CardTab; label: string }[] = [
    { id: "models", label: `模型 ${provider.models.length}` },
    { id: "connection", label: "连接" },
    ...(!isEnvSource ? [{ id: "quota" as const, label: quotaOn ? "用量 · 已启用" : "用量" }] : []),
    ...(!isBuiltin && !isEnvSource ? [{ id: "pricing" as const, label: provider.pricing ? "计费 · 已配置" : "计费" }] : []),
  ];

  return (
    <div className={`rounded-xl border bg-background transition-colors ${expanded ? "border-primary/40 shadow-sm" : "border-border hover:border-foreground/20"}`}>
      <div className="flex items-center gap-3 px-4 py-3">
        <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => setExpanded((v) => !v)}>
          <ProviderBadge baseUrl={provider.baseUrl} label={provider.label || provider.name} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-[14px] font-medium text-foreground">{provider.label || provider.name}</span>
              <span className={`inline-flex shrink-0 items-center gap-1 text-[11px] ${provider.configured ? "text-emerald-600 dark:text-emerald-500" : "text-muted-foreground"}`}>
                <span className={`size-1.5 rounded-full ${provider.configured ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
                {provider.configured ? "已配置" : "未配置 Key"}
              </span>
              {isEnvSource && <Tag variant="outline" title="来自环境变量（~/.axon/.env），不在 providers.json 中">环境变量</Tag>}
              {provider.locked && <Tag variant="outline" title="该 provider 仅允许修改 API Key">仅可改 Key</Tag>}
            </span>
            <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
              {provider.baseUrl ? hostOf(provider.baseUrl) : "默认地址"} · {enabledModels === provider.models.length ? `${provider.models.length} 个模型` : `${enabledModels}/${provider.models.length} 个模型启用`}
            </span>
          </span>
          <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
        {!isBuiltin && (
          // 菜单走弹出层（挂到 body）：放在卡片里会被卡片和外层滚动容器裁掉
          <Popover open={menuOpen} onOpenChange={(o) => { setMenuOpen(o); if (!o) setConfirmDelete(false); }}>
            <PopoverTrigger asChild>
              <button className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="更多操作">
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-40 gap-0 p-0 py-1">
                {!isEnvSource && (
                  <button onClick={() => { setMenuOpen(false); setExpanded(true); setTab("connection"); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-muted/60">
                    <Pencil className="h-3.5 w-3.5" />编辑连接
                  </button>
                )}
                <button onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))} disabled={deleting}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-destructive hover:bg-destructive/10">
                  {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  {confirmDelete ? "再点一次确认删除" : isEnvSource ? "从环境变量移除" : "删除"}
                </button>
            </PopoverContent>
          </Popover>
        )}
      </div>

      {errorMessage && <div className="px-4 pb-2 text-[12px] text-destructive">{errorMessage}</div>}

      {expanded && (
        <div className="border-t border-border/70">
          <div className="flex gap-1 border-b border-border/70 px-3">
            {tabs.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`relative px-2.5 py-2 text-[12px] transition-colors ${tab === t.id ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                {t.label}
                {tab === t.id && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />}
              </button>
            ))}
          </div>
          <div className="px-4 py-3">
            {tab === "models" && (
              isEnvSource
                ? <p className="text-[12px] text-muted-foreground">来自环境变量（<code className="rounded bg-muted px-1">~/.axon/.env</code>）的 Provider 没有模型配置可编辑。</p>
                : <ModelManager models={provider.models} editable onSave={saveModels} providerName={provider.name} level={level} workspace={workspace} />
            )}
            {tab === "connection" && (isBuiltin
              ? <BuiltinConnection provider={provider} level={level} workspace={workspace} onChanged={onChanged} />
              : <CustomConnection provider={provider} level={level} workspace={workspace} onChanged={onChanged} />)}
            {tab === "quota" && <QuotaConfigPanel embedded provider={provider} level={level} workspace={workspace} onChanged={onChanged} />}
            {tab === "pricing" && <PricingPanel embedded provider={provider} level={level} workspace={workspace} onChanged={onChanged} />}
          </div>
        </div>
      )}
    </div>
  );
}

/** 表单里的一行：左标签右输入 */
function FieldRow({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-[96px_1fr] sm:items-center sm:gap-3">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <div className="min-w-0">
        {children}
        {hint && <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>}
      </div>
    </div>
  );
}

/** 内置 Provider 的连接：API Key + Base URL 各自保存 */
function BuiltinConnection({ provider, level, workspace, onChanged }: { provider: ResolvedProviderInfo; level: ProviderLevel; workspace?: string; onChanged: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl || "");
  const [busy, setBusy] = useState<"" | "key" | "url">("");
  const [message, setMessage] = useState("");

  const run = async (kind: "key" | "url", fn: () => Promise<unknown>, done: string) => {
    setBusy(kind); setMessage("");
    try { await fn(); setMessage(done); onChanged(); } catch (e) { setMessage(`保存失败: ${(e as Error).message}`); }
    setBusy("");
  };

  return (
    <div className="space-y-3">
      <FieldRow label="API Key">
        <div className="flex gap-2">
          <Input type="password" placeholder={provider.configured ? "已保存（留空保留，输入则覆盖）" : "输入 API Key"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="h-8 flex-1 text-sm" />
          <Button size="sm" className="h-8" disabled={!!busy || !apiKey.trim()} onClick={() => run("key", async () => { await setBuiltinProviderKey(level, provider.name, apiKey, workspace); setApiKey(""); }, "API Key 已保存")}>
            {busy === "key" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}保存
          </Button>
        </div>
      </FieldRow>
      {!provider.locked && (
        <FieldRow label="Base URL">
          <div className="flex gap-2">
            <Input placeholder="留空使用默认地址" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="h-8 flex-1 text-sm" />
            <Button size="sm" variant="outline" className="h-8" disabled={!!busy || !baseUrl.trim()} onClick={() => run("url", () => setBuiltinProviderBaseUrl(level, provider.name, baseUrl.trim(), workspace), "Base URL 已更新")}>
              {busy === "url" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}更新
            </Button>
          </div>
        </FieldRow>
      )}
      {message && <p className={`text-[12px] ${message.startsWith("保存失败") ? "text-destructive" : "text-muted-foreground"}`}>{message}</p>}
    </div>
  );
}

/** 自定义 Provider 的连接：名称 / 地址 / Key，一起保存 */
function CustomConnection({ provider, level, workspace, onChanged }: { provider: ResolvedProviderInfo; level: ProviderLevel; workspace?: string; onChanged: () => void }) {
  const [label, setLabel] = useState(provider.label || "");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl || "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const isEnvSource = provider.source === "env";
  const dirty = label !== (provider.label || "") || baseUrl !== (provider.baseUrl || "") || !!apiKey.trim();

  if (isEnvSource) {
    return (
      <div className="space-y-2 text-[12px] text-muted-foreground">
        <FieldRow label="Base URL"><code className="break-all font-mono text-foreground">{provider.baseUrl}</code></FieldRow>
        <p>这个 Provider 来自环境变量（<code className="rounded bg-muted px-1">~/.axon/.env</code>），不在 providers.json 里，不能在这里编辑。需要的话可以从右上角菜单移除，再用「添加 Provider」重新添加。</p>
      </div>
    );
  }

  const save = async () => {
    if (!baseUrl.trim()) { setMessage("Base URL 必填"); return; }
    setSaving(true); setMessage("");
    try {
      // addCustomProvider 是 upsert：同名 key 直接覆盖整个 entry；Key 为空时不传（后端保留原值）
      await addCustomProvider(level, provider.name, {
        label: label.trim() || provider.name,
        baseUrl: baseUrl.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        models: provider.models,
      }, workspace);
      setApiKey("");
      setMessage("已保存");
      onChanged();
    } catch (e) {
      setMessage(`保存失败: ${(e as Error).message}`);
    }
    setSaving(false);
  };

  return (
    <div className="space-y-3">
      <FieldRow label="名称"><Input value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 text-sm" /></FieldRow>
      <FieldRow label="Base URL"><Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="h-8 font-mono text-[12px]" /></FieldRow>
      <FieldRow label="API Key"><Input type="password" placeholder={provider.configured ? "已保存（留空保持不变）" : "输入 API Key"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="h-8 text-sm" /></FieldRow>
      <FieldRow label="标识" hint="配置文件里的 key，创建后不能修改"><code className="font-mono text-[12px] text-foreground">{provider.name}</code></FieldRow>
      <div className="flex items-center justify-end gap-2">
        {message && <span className={`mr-auto text-[12px] ${message === "已保存" ? "text-muted-foreground" : "text-destructive"}`}>{message}</span>}
        <Button size="sm" className="h-8" onClick={save} disabled={saving || !dirty}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}保存
        </Button>
      </div>
    </div>
  );
}

/**
 * 模型列表：表格式排版（模型 / 能力 / 上下文），操作悬浮出现。
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
  const [importError, setImportError] = useState("");
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
    setImportError("");
    try {
      const { models: list } = await probeProviderModels({ name: providerName, level, workspace });
      setProbed(list);
    } catch (e) {
      setImportError(`拉取失败：${(e as Error).message}`);
    }
    setImporting(false);
  };

  const applyImport = (picks: ProbedModelInfo[]) => {
    // 同一 provider 内 model id 唯一：既要跳过已有模型，也要挡住端点自己返回的重复 id
    const taken = new Set(models.map((m) => m.id));
    const added: ProviderModelInfo[] = [];
    for (const p of picks) {
      if (taken.has(p.id)) continue;
      taken.add(p.id);
      added.push({
        id: p.id,
        name: p.name || p.id,
        // 端点没返回窗口时兜底 1M：当前主流型号普遍 ≥1M；真 128K 的模型撞上限是显性失败，有强制压缩兜底，
        // 反过来把兜底设小会在真 1M 模型上静默提前压缩、砍掉历史。
        contextWindow: p.contextWindow ?? 1_000_000,
        vision: p.vision ?? false,
        protocol: p.protocol,
        vendor: p.vendor,
      });
    }
    setProbed(null);
    if (added.length > 0) onSave?.([...models, ...added]);
  };

  return (
    <div>
      {models.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-[1fr_auto_56px_72px] items-center gap-3 border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
            <span>模型</span><span>能力</span><span className="text-right">上下文</span><span />
          </div>
          {models.map((m, i) =>
            editing === i ? (
              <div key={i} className="border-b border-border/60 p-2 last:border-b-0">
                <ModelForm initial={m} existingIds={models.filter((_, idx) => idx !== i).map((mm) => mm.id)} onSave={(mm) => saveOne(mm, i)} onCancel={() => setEditing(null)} />
              </div>
            ) : (
              <ModelRow key={i} model={m} editable={!!editable} confirmDelete={confirmDeleteIdx === i} onToggle={() => toggle(i)} onEdit={() => setEditing(i)} onDelete={() => del(i)} />
            ),
          )}
        </div>
      )}
      {models.length === 0 && editing !== "new" && (
        <div className="rounded-lg border border-dashed border-border py-5 text-center text-[12px] text-muted-foreground">还没有模型。手动添加，或者从端点拉取。</div>
      )}
      {editable && editing === "new" && (
        <div className="mt-2"><ModelForm existingIds={models.map((mm) => mm.id)} onSave={(mm) => saveOne(mm, "new")} onCancel={() => setEditing(null)} /></div>
      )}
      {editable && editing !== "new" && (
        <div className="mt-2.5 flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setEditing("new")}><Plus className="h-3.5 w-3.5" />添加模型</Button>
          {providerName && (
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={runImport} disabled={importing}>
              {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}从端点拉取
            </Button>
          )}
          {importError && <span className="text-[12px] text-destructive">{importError}</span>}
        </div>
      )}
      {probed && <ImportPanel probed={probed} existingIds={models.map((m) => m.id)} onApply={applyImport} onCancel={() => setProbed(null)} />}
    </div>
  );
}

function formatWindow(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2).replace(/\.?0+$/, "")}M`;
  return `${Math.round(n / 1000)}K`;
}

/** 能力小图标：图像 / 思考（档位数）/ 缓存 / 非默认协议 */
function Capability({ on, icon, title }: { on: boolean; icon: ReactNode; title: string }) {
  return (
    <span title={title} className={`inline-flex size-5 items-center justify-center rounded ${on ? "bg-primary/10 text-primary" : "text-muted-foreground/25"}`}>
      {icon}
    </span>
  );
}

/** 单行模型（禁用态变淡，操作悬浮出现） */
function ModelRow({ model, editable, confirmDelete, onToggle, onEdit, onDelete }: { model: ProviderModelInfo; editable: boolean; confirmDelete?: boolean; onToggle: () => void; onEdit: () => void; onDelete: () => void }) {
  const efforts = model.effortLevels?.length ?? 0;
  const showId = model.name && model.name !== model.id;
  return (
    <div className="group/m grid grid-cols-[1fr_auto_56px_72px] items-center gap-3 border-b border-border/60 px-3 py-2 last:border-b-0 hover:bg-muted/30">
      <div className={`min-w-0 ${model.disabled ? "opacity-45" : ""}`}>
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-foreground">{model.name || model.id}</span>
          {model.protocol && model.protocol !== "chat" && <Tag variant="outline">{model.protocol === "responses" ? "Responses" : "Anthropic"}</Tag>}
          {model.disabled && <Tag>已停用</Tag>}
        </div>
        {showId && <div className="truncate font-mono text-[11px] text-muted-foreground">{model.id}</div>}
      </div>
      <div className={`flex items-center gap-0.5 ${model.disabled ? "opacity-45" : ""}`}>
        <Capability on={!!model.vision} icon={<ImageIcon className="h-3 w-3" />} title={model.vision ? "支持图片输入" : "不支持图片"} />
        <Capability on={!!model.thinking} icon={<Brain className="h-3 w-3" />} title={model.thinking ? `支持思考${efforts ? `，${efforts} 档强度` : ""}` : "不开启思考"} />
        <Capability on={!!model.cacheControl} icon={<Zap className="h-3 w-3" />} title={model.cacheControl ? "发送缓存标记（cache_control）" : "不发送缓存标记"} />
      </div>
      <span className={`text-right font-mono text-[12px] text-muted-foreground ${model.disabled ? "opacity-45" : ""}`}>{formatWindow(model.contextWindow)}</span>
      <div className="flex items-center justify-end gap-0.5">
        {editable && (
          <div className={`flex items-center gap-0.5 transition-opacity ${confirmDelete ? "opacity-100" : "opacity-0 group-hover/m:opacity-100 focus-within:opacity-100"}`}>
            <button onClick={onToggle} title={model.disabled ? "启用" : "停用（不出现在模型选择里）"} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
              {model.disabled ? <RotateCcw className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
            </button>
            <button onClick={onEdit} title="编辑" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil className="h-3.5 w-3.5" /></button>
            <button onClick={onDelete} title={confirmDelete ? "再次点击确认删除" : "删除"} className={`flex items-center rounded p-1 ${confirmDelete ? "bg-destructive/10 px-1.5 text-destructive" : "text-muted-foreground hover:bg-muted hover:text-destructive"}`}>
              <Trash2 className="h-3.5 w-3.5 shrink-0" />{confirmDelete && <span className="ml-0.5 text-[10px] font-medium">确认</span>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 端点导入结果选择面板 */
function ImportPanel({ probed, existingIds, onApply, onCancel }: { probed: ProbedModelInfo[]; existingIds: string[]; onApply: (picks: ProbedModelInfo[]) => void; onCancel: () => void }) {
  // 端点自身可能返回重复 id：按「已有 + 已收录」双集合去重，否则面板里会出现两条同 id 项，
  // 而且它们共用一个勾选状态（Set<string> 以 id 为键），勾一条会连带另一条。
  const taken = new Set(existingIds);
  const selectable = probed.filter((p) => {
    if (taken.has(p.id)) return false;
    taken.add(p.id);
    return true;
  });
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
            {p.vision === true && <Tag variant="primary">多模态</Tag>}
            <span className="text-[10px] text-muted-foreground">{p.contextWindow ? `${(p.contextWindow / 1000).toFixed(0)}K` : "窗口未知·默认128K"}</span>
          </label>
        ))}
      </div>
      <div className="text-[10px] text-muted-foreground mt-1.5">端点未返回多模态/窗口的，按"不支持/128K"默认导入，可在列表里再编辑。</div>
      <div className="flex gap-2 mt-2">
        <Button size="sm" onClick={() => onApply(selectable.filter((p) => picked.has(p.id)))} disabled={picked.size === 0}>导入 {picked.size} 个</Button>
        <Button size="sm" variant="outline" onClick={onCancel}>取消</Button>
      </div>
    </div>
  );
}

/**
 * 支持思考的模型默认带出的强度档位。
 *
 * 取 low / high / max 三档：OpenAI 系（reasoning_effort）与多数 OpenAI 兼容中转站都认
 * low/medium/high，max 是近两年高端推理型号（以及 Claude/GLM 一类中转包装）常见的加强档。
 * 这只是省掉手填的初值，任何一档对不上端点都可以在表单里直接改名/改值/删掉。
 */
const DEFAULT_EFFORT_LEVELS: readonly { label: string; value: string }[] = [
  { label: "Low", value: "low" },
  { label: "High", value: "high" },
  { label: "Max", value: "max" },
];

/**
 * 自动带出三档时默认选中的那一档。
 * 取 high 而不是 max：max 在不少端点上要么不认、要么明显更贵更慢，不适合当"什么都没配"时的落点。
 * 必须是 DEFAULT_EFFORT_LEVELS 里的某个 value，否则会被下方的回落逻辑判成无效档位而清成关闭。
 */
const DEFAULT_EFFORT_VALUE = "high";

/** 每次取一份新副本，避免多个表单共享同一批对象引用后互相串改 */
const cloneDefaultEffortLevels = () => DEFAULT_EFFORT_LEVELS.map((x) => ({ ...x }));

/** 是否仍是"一字未改的默认三档"——用来判断取消思考时能否安全清空 */
const isDefaultEffortLevels = (levels: readonly { label: string; value: string }[]) =>
  levels.length === DEFAULT_EFFORT_LEVELS.length &&
  levels.every((x, i) => x.label === DEFAULT_EFFORT_LEVELS[i].label && x.value === DEFAULT_EFFORT_LEVELS[i].value);

/** 能力标签的中文文案：只影响下拉框展示，不参与写入 */
const TAG_LABELS: Record<BuiltinModelTag, string> = {
  vision: "视觉",
  thinking: "思考",
};

/**
 * 模型 id 组合框：既能搜索/挑选内置业界模型，也允许自由输入任意自定义 id。
 * 内置清单只是建议（见 builtinModels.ts），与该 provider 实际支持无关，因此不限制输入。
 */
function ModelIdCombobox({ value, onChange, invalid, onCommitCustom, onPickBuiltin }: {
  value: string;
  onChange: (id: string) => void;
  /** 校验不通过（如同 provider 下 id 重复）时高亮边框 */
  invalid?: boolean;
  /** 点「使用当前输入」或无高亮时按 Enter：直接按当前输入提交 */
  onCommitCustom?: () => void;
  /**
   * 从内置清单选中一条时回调，携带整条 BuiltinModel。
   * 必须与 onChange 分开：onChange 只传 id 字符串（自定义输入也走它），
   * 而结构化字段（窗口 / 协议 / 缓存 / 多模态 / 厂商）只有内置条目才有。
   */
  onPickBuiltin?: (m: BuiltinModel) => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 大小写不敏感的子串匹配：模型 id、展示名、厂商任一命中即保留
  const query = value.trim().toLowerCase();
  const filtered = query
    ? BUILTIN_MODELS.filter((m) =>
        m.id.toLowerCase().includes(query) ||
        (m.label ?? "").toLowerCase().includes(query) ||
        m.vendor.toLowerCase().includes(query),
      )
    : BUILTIN_MODELS;

  // 输入内容一变就回到第一个候选，避免停留在旧下标上选错项
  useEffect(() => { setHighlight(0); }, [value]);
  // 键盘连续 ↑↓ 时把高亮项滚进可视区
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [highlight, open, filtered.length]);

  const hl = filtered.length > 0 ? Math.min(highlight, filtered.length - 1) : -1;

  const selectModel = (m: BuiltinModel) => {
    onChange(m.id);
    // 把整条内置数据交给上层预填结构化字段。预填只是省掉照文档手抄，选完仍可继续改。
    onPickBuiltin?.(m);
    setOpen(false);
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return; // 输入法组词过程中的按键不响应，避免误选
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (filtered.length === 0) return;
      setHighlight((h) => {
        const cur = h < filtered.length ? h : 0;
        return e.key === "ArrowDown" ? (cur + 1) % filtered.length : (cur - 1 + filtered.length) % filtered.length;
      });
    } else if (e.key === "Enter") {
      if (open && hl >= 0) {
        e.preventDefault();
        selectModel(filtered[hl]);
      } else if (onCommitCustom) {
        // 没有高亮候选时按自定义 id 提交，与底部「使用当前输入」行为一致
        e.preventDefault();
        onCommitCustom();
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        e.stopPropagation(); // 只关本下拉，不冒泡影响宿主（如 VSCode 快捷键）
        setOpen(false);
      }
    }
  };

  return (
    <div className="relative">
      <Input
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        placeholder="模型 id（发给 API 的那个，如 gpt-4o），可搜索下方清单"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={handleKeyDown}
        className={`h-8 text-sm pr-8 ${invalid ? "border-destructive focus-visible:ring-destructive/40" : ""}`}
      />
      <button
        type="button"
        tabIndex={-1}
        // 压掉默认 mousedown：输入框不丢焦点，列表不会在 click 生效前被 blur 关掉
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        title={open ? "收起候选" : "展开候选（内置业界模型）"}
        className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          ref={listRef}
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-md"
        >
          {/* 分组标题：候选项全部来自内置清单 */}
          <div className="px-2.5 py-1 text-[10px] font-medium text-muted-foreground">业界常用</div>
          {filtered.map((m, i) => (
            <button
              key={m.id}
              type="button"
              data-active={i === hl}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => selectModel(m)}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${i === hl ? "bg-muted/60" : ""}`}
            >
              <span className="min-w-0 flex-1">
                {/* 主文本是发给 API 的模型 id；次要文本是「厂商 · 能力标签」 */}
                <span className="block truncate font-mono text-xs text-foreground">{m.id}</span>
                <span className="block truncate text-[11px] text-muted-foreground/70">
                  {m.vendor}
                  {(m.tags ?? []).map((t) => ` · ${TAG_LABELS[t]}`).join("")}
                </span>
              </span>
              {m.label && <span className="shrink-0 text-[11px] text-muted-foreground">{m.label}</span>}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="px-2.5 py-1.5 text-xs text-muted-foreground">没有匹配的内置模型</div>
          )}
          {/* 底部固定行：候选里没有也允许直接用当前输入提交，兼容自定义中转站的任意 id */}
          <div className="mt-1 border-t border-border/40 pt-1">
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onCommitCustom?.()}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            >
              <CornerDownLeft className="w-3 h-3 shrink-0" />
              <span className="truncate">使用当前输入：{value.trim() || "（自定义 id）"}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 模型新增/编辑表单 */
function ProtocolButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-8 px-2.5 text-[11px] rounded-md transition-colors ${active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
    >
      {label}
    </button>
  );
}

function ModelForm({ initial, existingIds = [], onSave, onCancel }: { initial?: ProviderModelInfo; existingIds?: readonly string[]; onSave: (m: ProviderModelInfo) => void; onCancel: () => void }) {
  // 新建 vs 编辑必须分开：新建给一份"常见默认值"（厂商 OpenAI、缓存与思考默认勾上），
  // 编辑则严格反映该模型存下来的值——**不能因为"默认是勾上的"就把存量模型悄悄改成勾上**。
  // 缓存这项尤其要紧：端点不支持 cache_control 却收到它，会直接 400。
  const isNew = !initial;
  const thinkingDefault = isNew ? true : !!initial?.thinking;
  const [id, setId] = useState(initial?.id || "");
  const [name, setName] = useState(initial?.name || "");
  const [win, setWin] = useState(String(initial?.contextWindow || 1_000_000));
  const [vision, setVision] = useState(!!initial?.vision);
  const [protocol, setProtocol] = useState<"chat" | "responses" | "anthropic">(initial?.protocol || "chat");
  const [cacheControl, setCacheControl] = useState(isNew ? true : !!initial?.cacheControl);
  const [thinking, setThinking] = useState(thinkingDefault);
  // 每个模型自己声明可选档位：展示名可以是「高级 / Extra」，实际 value 原样发给端点（high / xhigh）。
  // 未配置时输入区不显示强度选择器。
  const [effortLevels, setEffortLevels] = useState<{ label: string; value: string }[]>(() => {
    const existing = (initial?.effortLevels || []).map((x) => ({ label: x.label, value: x.value }));
    if (existing.length > 0) return existing;
    // 思考开着 + 一档都没配 → 直接带出默认三档，省掉"每加一个模型都手填一遍强度"。
    // 只对新建生效：存量模型没配过档位是用户的既有选择，不在编辑时悄悄塞进去。
    return isNew && thinkingDefault ? cloneDefaultEffortLevels() : [];
  });
  // 新建且自动带出了三档时，默认强度一并落到 high——否则用户还得再点一次下拉才算配完。
  const [defaultEffort, setDefaultEffort] = useState(
    initial?.defaultEffort || (isNew && thinkingDefault ? DEFAULT_EFFORT_VALUE : "__off__"),
  );
  // 删除/改名了默认档位时立即回落到关闭，避免下拉显示一个已不存在的 value。
  useEffect(() => {
    if (defaultEffort === "__off__") return;
    if (!effortLevels.some((x) => x.value.trim() === defaultEffort)) setDefaultEffort("__off__");
  }, [effortLevels, defaultEffort]);

  /**
   * 「思考」勾选联动强度档位：
   * - 勾上且一档没配 → 补上默认三档；
   * - 取消勾选 → 只清掉"原封不动的默认三档"，用户手填/改过的档位一律保留
   *   （取消思考不该顺手销毁他填过的东西，重新勾上还能接着用）。
   */
  const toggleThinking = (next: boolean) => {
    setThinking(next);
    if (!next) {
      // 清掉默认三档后，默认强度会被上方的回落 effect 自动带回"关闭"，这里不用再管。
      if (isDefaultEffortLevels(effortLevels)) setEffortLevels([]);
      return;
    }
    if (effortLevels.length === 0) {
      setEffortLevels(cloneDefaultEffortLevels());
      setDefaultEffort(DEFAULT_EFFORT_VALUE);
    }
  };

  const trimmedId = id.trim();
  // 同一 provider 内 model id 唯一：与已有模型（编辑时不含自身）重名就不允许提交。
  // 后端写入时同样会拦（见 @axon/core 的 assertUniqueModelIds），这里只是省掉一次白跑的请求。
  const duplicateId = isDuplicateModelId(trimmedId, existingIds);

  /** 选中内置模型后预填结构化字段（窗口 / 协议 / 缓存 / 多模态） */
  const applyBuiltin = (m: BuiltinModel) => {
    if (m.label) setName(m.label);
    if (m.contextWindow) setWin(String(m.contextWindow));
    // 协议与内置清单同一套规则：Anthropic → anthropic，其余 → chat
    setProtocol(protocolForVendor(m.vendor));
    setCacheControl(!!m.cacheControl);
    setVision(!!m.tags?.includes("vision"));
    // 走同一套联动：内置清单标了 thinking 的，选中即带出默认三档。
    toggleThinking(!!m.tags?.includes("thinking"));
  };

  const submit = () => {
    if (!trimmedId || duplicateId) return;
    // 窗口填了非法值（非纯数字）时同样兜底 1M，与 applyImport 保持同一口径——
    // 两处兜底值不一致会比"值本身不理想"更糟：同一条数据经过不同入口会得到不同的分母。
    const contextWindow = /^\d+$/.test(win.trim()) ? parseInt(win.trim(), 10) : 1_000_000;
    const normalizedEfforts = effortLevels
      .map((x) => ({ label: x.label.trim(), value: x.value.trim() }))
      .filter((x) => x.label && x.value)
      .filter((x, i, arr) => arr.findIndex((y) => y.value === x.value) === i);
    onSave({
      id: trimmedId,
      name: name.trim() || trimmedId,
      contextWindow,
      vision,
      // 配了强度档位就必然表示该端点支持思考；自动开启，避免出现“下拉能选但请求不生效”的矛盾配置。
      thinking: (thinking || normalizedEfforts.length > 0) || undefined,
      effortLevels: normalizedEfforts.length > 0 ? normalizedEfforts : undefined,
      defaultEffort: normalizedEfforts.some((x) => x.value === defaultEffort) ? defaultEffort : undefined,
      cacheControl: cacheControl || undefined,
      protocol,
      disabled: initial?.disabled,
    });
  };

  return (
    <div className="p-2 rounded-md border border-border bg-background space-y-1.5 my-1">
      <ModelIdCombobox value={id} onChange={setId} invalid={duplicateId} onCommitCustom={submit} onPickBuiltin={applyBuiltin} />
      {duplicateId && (
        <div className="text-[10px] text-destructive">
          该 provider 下已存在模型 id「{trimmedId}」，同一个 provider 不能重复添加。
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input placeholder="显示名（可选）" value={name} onChange={(e) => setName(e.target.value)} className="h-8 text-sm flex-1" />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Input placeholder="上下文窗口" value={win} onChange={(e) => setWin(e.target.value)} className="h-8 text-sm w-32" />
        <ProtocolButton active={protocol === "chat"} onClick={() => setProtocol("chat")} label="Chat" />
        <ProtocolButton active={protocol === "responses"} onClick={() => setProtocol("responses")} label="Responses" />
        <ProtocolButton active={protocol === "anthropic"} onClick={() => setProtocol("anthropic")} label="Anthropic" />
        <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} className="w-3 h-3 accent-primary" />
          多模态
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={thinking} onChange={(e) => toggleThinking(e.target.checked)} className="w-3 h-3 accent-primary" />
          思考
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={cacheControl} onChange={(e) => setCacheControl(e.target.checked)} className="w-3 h-3 accent-primary" />
          缓存
        </label>
        <div className="ml-auto flex gap-1">
          <Button size="sm" className="h-8" onClick={submit} disabled={!trimmedId || duplicateId}>保存</Button>
          <Button size="sm" variant="outline" className="h-8" onClick={onCancel}>取消</Button>
        </div>
      </div>
      <div className="rounded-md border border-border/70 bg-muted/20 p-2 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-xs font-medium">思考强度档位</div>
            <div className="text-[10px] text-muted-foreground">左边是界面名称，右边是原样发给 API 的值。勾上「思考」会自动带出 low / high / max 三档，可自行增删改；留空则不显示强度选择器。</div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2 text-xs shrink-0"
            onClick={() => setEffortLevels((prev) => [...prev, { label: "", value: "" }])}
          >
            <Plus className="w-3 h-3 mr-1" />添加档位
          </Button>
        </div>
        {effortLevels.length > 0 && (
          <div className="space-y-1">
            {effortLevels.map((level, index) => (
              <div key={index} className="flex items-center gap-1.5">
                <Input
                  value={level.label}
                  onChange={(e) => setEffortLevels((prev) => prev.map((x, i) => i === index ? { ...x, label: e.target.value } : x))}
                  placeholder="展示名，如 高级"
                  className="h-7 text-xs flex-1"
                />
                <span className="text-muted-foreground/50">→</span>
                <Input
                  value={level.value}
                  onChange={(e) => setEffortLevels((prev) => prev.map((x, i) => i === index ? { ...x, value: e.target.value } : x))}
                  placeholder="实际值，如 high"
                  className="h-7 text-xs flex-1 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setEffortLevels((prev) => prev.filter((_, i) => i !== index))}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  title="删除档位"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            <div className="flex items-center gap-2 pt-1">
              <span className="text-[11px] text-muted-foreground shrink-0">默认强度</span>
              <Select value={defaultEffort} onValueChange={setDefaultEffort}>
                <SelectTrigger className="h-7 text-xs flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__off__">关闭</SelectItem>
                  {effortLevels
                    .filter((x) => x.label.trim() && x.value.trim())
                    .map((x) => <SelectItem key={x.value} value={x.value}>{x.label}（{x.value}）</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </div>
      <div className="text-[10px] text-muted-foreground">
        上下文窗口与多模态以该 provider 官方文档为准；可用上方"从端点导入"自动带出（若端点返回）。
        {protocol === "anthropic" && (
          <span className="text-foreground"> 注意：Anthropic 协议会调用 {"{baseUrl}"}/messages（原生 Messages API），仅当该端点【只】提供这个接口、没有 OpenAI 兼容的 /chat/completions 时才需要选它——多数中转站选 Chat 即可。</span>
        )}
      </div>
    </div>
  );
}

/**
 * 添加 Provider：先选厂商（地址 / 协议 / 认证 / 常用模型自动带出），再填 Key。
 * 选「中转站 / 其他」就是原来的手动填写。保存后还可以在「模型」页从端点拉取补全。
 */
function AddProviderPanel({ level, workspace, takenNames, initialPresetId, onDone, onCancel }: {
  level: ProviderLevel;
  workspace?: string;
  takenNames: string[];
  /** 打开时直接选中的预设 id */
  initialPresetId?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [preset, setPreset] = useState<ProviderPreset | null>(null);
  const [region, setRegion] = useState<PresetRegion>("cn");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [protocol, setProtocol] = useState<ProviderProtocol>("chat");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const choose = (p: ProviderPreset) => {
    setPreset(p);
    setLabel(p.id === "custom" ? "" : p.name.replace(/（.*）$/, ""));
    setBaseUrl(p.baseUrl);
    setProtocol(p.protocol);
    setApiKey("");
    setPicked(new Set(presetModels(p).map((m) => m.id)));
    setError("");
  };

  useEffect(() => {
    const p = initialPresetId ? PROVIDER_PRESETS.find((x) => x.id === initialPresetId) : undefined;
    if (p) choose(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPresetId]);

  const candidates = preset ? presetModels(preset) : [];
  const togglePick = (id: string) => setPicked((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const submit = async () => {
    if (!preset) return;
    if (!label.trim()) { setError("给这个 Provider 起个名字"); return; }
    if (!/^https?:\/\//i.test(baseUrl.trim())) { setError("Base URL 要以 http:// 或 https:// 开头"); return; }
    if (!apiKey.trim() && !preset.noKey) { setError("填一下 API Key"); return; }
    setSaving(true); setError("");
    try {
      const models = candidates.filter((m) => picked.has(m.id)).map(builtinToModel);
      await addCustomProvider(level, slugify(label, takenNames), {
        label: label.trim(),
        baseUrl: baseUrl.trim().replace(/\/+$/, ""),
        // 本地服务不校验 Key，但 OpenAI 兼容客户端要求非空
        apiKey: apiKey.trim() || (preset.noKey ? "local" : ""),
        ...(preset.apiKeyHeader ? { apiKeyHeader: preset.apiKeyHeader } : {}),
        protocol,
        models,
      }, workspace);
      onDone();
    } catch (e) {
      setError(`添加失败：${(e as Error).message}`);
    }
    setSaving(false);
  };

  return (
    <div data-add-provider className="mb-3 overflow-hidden rounded-xl border border-primary/40 bg-background shadow-sm">
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
        <span className="text-[13px] font-medium text-foreground">{preset ? `添加 ${preset.name}` : "选择厂商"}</span>
        <div className="flex items-center gap-1">
          {preset && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setPreset(null)}>重新选择</Button>}
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel}>取消</Button>
        </div>
      </div>

      {!preset ? (
        <div className="px-4 py-3">
          <div className="mb-3 flex gap-1">
            {PRESET_REGIONS.map((r) => (
              <button key={r.id} onClick={() => setRegion(r.id)}
                className={`rounded-full px-3 py-1 text-[12px] transition-colors ${region === r.id ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}>
                {r.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2">
            {PROVIDER_PRESETS.filter((p) => p.region === region).map((p) => (
              <button key={p.id} onClick={() => choose(p)} className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:border-foreground/25 hover:bg-muted/30">
                <span className={`inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold ${p.badge.className}`}>{p.badge.text}</span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-foreground">{p.name}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{p.baseUrl ? hostOf(p.baseUrl) : "自己填地址"}{presetModels(p).length ? ` · ${presetModels(p).length} 个常用模型` : ""}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-3 px-4 py-3">
          {preset.hint && <p className="rounded-lg bg-muted/40 px-3 py-2 text-[12px] text-foreground/85">{preset.hint}</p>}
          <FieldRow label="名称"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="如「公司中转站」" className="h-8 text-sm" /></FieldRow>
          <FieldRow label="Base URL"><Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://example.com/v1" className="h-8 font-mono text-[12px]" /></FieldRow>
          <FieldRow label="API Key" hint={preset.keyUrl ? <a href={preset.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">去 {preset.name.replace(/（.*）$/, "")} 控制台获取<ExternalLink className="h-3 w-3" /></a> : preset.noKey ? "本地服务不需要 Key，可以留空" : undefined}>
            <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={preset.noKey ? "可留空" : "sk-…"} className="h-8 text-sm" />
          </FieldRow>
          {preset.id === "custom" && (
            <FieldRow label="协议" hint="绝大多数中转站选 OpenAI 兼容；只提供 Anthropic 原生接口的才选 Anthropic">
              <div className="flex gap-1.5">
                <ProtocolButton active={protocol === "chat"} onClick={() => setProtocol("chat")} label="OpenAI 兼容" />
                <ProtocolButton active={protocol === "responses"} onClick={() => setProtocol("responses")} label="Responses" />
                <ProtocolButton active={protocol === "anthropic"} onClick={() => setProtocol("anthropic")} label="Anthropic" />
              </div>
            </FieldRow>
          )}
          <FieldRow label="模型" hint={candidates.length ? "保存后可以在「模型」页继续添加，或从端点拉取" : "保存后在「模型」页从端点拉取，或手动添加"}>
            {candidates.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {candidates.map((m) => (
                  <button key={m.id} type="button" onClick={() => togglePick(m.id)} title={m.id}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] transition-colors ${picked.has(m.id) ? "border-primary/40 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}>
                    {picked.has(m.id) ? <Check className="h-3 w-3 text-primary" /> : <Plus className="h-3 w-3" />}
                    {m.label || m.id}
                  </button>
                ))}
              </div>
            ) : <span className="text-[12px] text-muted-foreground">没有预置模型</span>}
          </FieldRow>
          <div className="flex items-center justify-end gap-2 pt-1">
            {error && <span className="mr-auto text-[12px] text-destructive">{error}</span>}
            <Button size="sm" className="h-8" onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}添加
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
