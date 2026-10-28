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
import { Loader2, Cloud, Plus, Trash2, Save, KeyRound, ChevronRight, ChevronDown, CornerDownLeft, Pencil, Ban, RotateCcw, Download, ArrowUpToLine, ArrowDownToLine, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VisionFallbackSelector } from "@/components/ModelSelector";
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
  moveCustomProvider,
  getVisionFallbackModel,
  setVisionFallbackModel,
  type ProviderLevel,
  type ResolvedProviderInfo,
  type ProviderModelInfo,
  type ProbedModelInfo,
} from "@/lib/apiClient";
import { QuotaConfigPanel, QuotaOverviewCard } from "@/components/QuotaPanels";
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
  const [, setSavingVision] = useState(false);
  const [loading, setLoading] = useState(true);
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
  // Provider 管理暂时只开放用户级配置。缺少 customLevel 的旧运行时载荷同样按用户级展示。
  const customs = providers.filter((p) => !p.builtin && (
    p.customLevel === "user" || p.customLevel === undefined
  ));
  const wsArg = undefined;

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* 顶部标题区：标题与操作按钮同一行；层级/写入目标压成一行更小更淡的说明 */}
      <div className="px-5 pt-4 pb-2.5 border-b border-border sticky top-0 bg-background z-10">
        <div className="flex items-center gap-2">
          <Cloud className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium text-foreground">Provider 配置</span>
          {isInVSCode() && (
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => openProviderConfigInEditor(level, wsArg)}>
              在编辑器中打开
            </Button>
          )}
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          用户级（全局） · 写入目标：<code className="font-mono">~/.axon/settings/providers.json</code>
        </div>
      </div>

      {/* 用量总览：所有启用了用量查询的 Provider */}
      <div className="px-5 pt-4">
        <QuotaOverviewCard workspace={wsArg} version={quotaVersion} />
      </div>

      {/* 识图兜底模型 */}
      <div className="px-5 pt-4">
        <div className="px-3 py-2.5 rounded-lg border border-border bg-muted/20">
          <div className="flex items-center gap-2 mb-1">
            <Eye className="w-4 h-4 text-primary" />
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
        <div className="space-y-3">
          {builtins.map((p) => (
            <BuiltinCard key={p.name} provider={p} level={level} workspace={wsArg} onChanged={refreshAndNotify} />
          ))}
        </div>
      </div>

      {/* 自定义 provider */}
      <div className="px-5 pt-4 pb-6">
        <div className="text-xs font-medium text-muted-foreground mb-2">自定义 Provider</div>
        <div className="space-y-3 mb-3">
          {customs.length === 0 && (
            <div className="text-sm text-muted-foreground py-3 text-center border border-dashed border-border rounded-lg">
              暂无自定义 Provider，下方添加一个 OpenAI 兼容端点。
            </div>
          )}
          {customs.map((p) => (
            <CustomCard key={p.name} provider={p} level={level} workspace={wsArg} onChanged={refreshAndNotify} />
          ))}
        </div>
        <AddCustomForm level={level} workspace={wsArg} onChanged={refreshAndNotify} />
      </div>
    </div>
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
    <div className={`rounded-lg border bg-muted/20 transition-colors ${expanded ? "border-primary/50" : "border-border"}`}>
      {/* 标题行（与自定义卡片同构）：chevron + 图标 + 名称/徽标一行，端点等次要信息一行 */}
      <div className="group flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "收起模型列表" : "展开模型列表"}
          className="shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <ChevronRight className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
        <Cloud className={`w-4 h-4 shrink-0 ${provider.configured ? "text-primary" : "text-muted-foreground"}`} />
        <div className="min-w-0 flex-1 cursor-pointer" onClick={() => setExpanded((v) => !v)}>
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium truncate">{provider.label}</span>
            <Tag variant={provider.configured ? "primary" : "muted"}>{provider.configured ? "已配置" : "未配置"}</Tag>
            {provider.locked && <Tag variant="outline" title="该 provider 仅允许修改 API Key">仅可改 Key</Tag>}
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {provider.baseUrl || "默认 Base URL"} · {provider.models.length} 模型 · {provider.protocol}
          </div>
        </div>
      </div>
      <div className="px-3 pb-3 pt-0.5 space-y-2">
        {/* 「保存 / 更新」为一组尺寸一致的主/次按钮，与输入框同高，避免失衡感 */}
        <div className="flex items-center gap-2">
          <Input
            type="password"
            placeholder={provider.configured ? "已配置（留空保留，输入则覆盖）" : "输入 API Key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="h-8 text-sm flex-1"
          />
          <Button size="sm" className="h-8" onClick={saveKey} disabled={savingKey || !apiKey.trim()}>
            {savingKey ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}保存
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Input
            placeholder="Base URL（留空使用默认）"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            className="h-8 text-sm flex-1"
          />
          <Button size="sm" variant="outline" className="h-8" onClick={saveBaseUrl} disabled={savingUrl || !baseUrl.trim()}>
            {savingUrl ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}更新
          </Button>
        </div>
        {errorMessage && <div className="text-xs text-destructive">{errorMessage}</div>}
      </div>
      {expanded && (
        <div className="px-3 pb-3 pt-2 border-t border-border/60">
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

  // 环境变量来源：它不在 providers.json 里，编辑/降级/模型管理都会写错地方或直接报错，
  // 只有"从 ~/.axon/.env 移除"这条路径对它有效。
  const isEnvSource = provider.source === "env";

  const remove = async () => {
    setDeleting(true);
    setErrorMessage("");
    try {
      if (isEnvSource) {
        const res = await removeEnvProvider(provider.name, workspace);
        // 若它同时由 VS Code 设置提供，改 .env 是删不掉的——如实说明该去哪删
        if (res.fromSettings) {
          setErrorMessage("已从 ~/.axon/.env 移除；但它仍由 VS Code 设置（axon.providers / axon.env）提供，请到设置里删除后重载窗口。");
        }
      } else {
        await removeCustomProvider(level, provider.name, workspace);
      }
      setConfirmDelete(false);
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
    /* 展开中的 provider 给一个【常驻】的淡蓝边框：它是"我正在看哪个 provider"的持续标记，
       不能靠 :focus 那种"点别处就消失"的短暂命中。收起时回中性边框，transition-colors 负责过渡。 */
    <div className={`rounded-lg border bg-muted/20 transition-colors ${expanded ? "border-primary/50" : "border-border"}`}>
      <div className="group flex items-center gap-2 px-3 py-2">
        <button onClick={() => { setExpanded((v) => !v); setConfirmDelete(false); }} className="shrink-0 text-muted-foreground hover:text-foreground">
          <ChevronRight className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
        <Cloud className={`w-4 h-4 shrink-0 ${provider.configured ? "text-primary" : "text-muted-foreground"}`} />
        <div className="min-w-0 flex-1 cursor-pointer" onClick={() => { setExpanded((v) => !v); setConfirmDelete(false); }}>
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium truncate">{provider.label || provider.name}</span>
            {!provider.configured && <Tag>未配置</Tag>}
            {isEnvSource && (
              <Tag variant="outline" title="来自环境变量（~/.axon/.env），不在 providers.json 中">环境变量</Tag>
            )}
          </div>
          <div className="text-xs text-muted-foreground truncate">{provider.baseUrl} · {provider.models.length} 模型 · {provider.protocol}</div>
        </div>
        {/* env 来源没有 providers.json 条目，编辑会凭空造一条新记录，故不提供 */}
        {!isEnvSource && (
          <button
            onClick={() => { setExpanded(true); startEditing(); }}
            className="shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
            title="编辑 provider"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={handleDeleteClick}
          className={`shrink-0 p-1 rounded transition-all flex items-center whitespace-nowrap ${confirmDelete ? "bg-destructive/10 text-destructive opacity-100 px-1.5" : "opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive hover:bg-muted"}`}
          title={confirmDelete ? "再次点击确认删除" : "删除 provider"}
          disabled={deleting}
        >
          {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5 shrink-0" />}
          {confirmDelete && <span className="ml-1 text-[11px] font-medium">确认删除</span>}
        </button>
      </div>
      {expanded && (
        <div className="px-3 pb-3 pt-2 border-t border-border/60">
          {editing ? (
            <div className="space-y-2 mb-3">
              <div className="text-xs font-medium text-muted-foreground mb-1">编辑 Provider 信息</div>
              <Input placeholder="展示名" value={editLabel} onChange={(e) => setEditLabel(e.target.value)} className="h-8 text-sm" />
              <Input placeholder="Base URL" value={editBaseUrl} onChange={(e) => setEditBaseUrl(e.target.value)} className="h-8 text-sm" />
              <Input type="password" placeholder="API Key（留空保持不变）" value={editApiKey} onChange={(e) => setEditApiKey(e.target.value)} className="h-8 text-sm" />
              {errorMessage && <div className="text-xs text-destructive">{errorMessage}</div>}
              <div className="flex gap-2">
                <Button size="sm" className="h-8" onClick={saveEdit} disabled={saving || !editBaseUrl.trim()}>
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Save className="w-3.5 h-3.5 mr-1" />}保存
                </Button>
                <Button size="sm" variant="outline" className="h-8" onClick={cancelEditing}>取消</Button>
              </div>
            </div>
          ) : (
            isEnvSource ? (
              <div className="text-[11px] text-muted-foreground mb-3">
                来源：环境变量（<code className="px-1 rounded bg-muted">~/.axon/.env</code>）。它不在 providers.json 中，
                因此不能在此编辑或降级；用右上角删除按钮可从环境变量里移除。
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
            )
          )}
          {!editing && errorMessage && <div className="mb-3 text-xs text-destructive">{errorMessage}</div>}
          {/* env 来源没有 providers.json 条目，模型/额度写入会直接报"provider 不存在"，故不展示 */}
          {!isEnvSource && (
            <>
              <ModelManager models={provider.models} editable onSave={saveModels} providerName={provider.name} level={level} workspace={workspace} />
              <QuotaConfigPanel provider={provider} level={level} workspace={workspace} onChanged={onChanged} />
            </>
          )}
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
    // 同一 provider 内 model id 唯一：既要跳过已有模型，也要挡住端点自己返回的重复 id
    // （后端写入时同样会校验，先在这里收敛，避免整批导入被拒）。
    const taken = new Set(models.map((m) => m.id));
    const added: ProviderModelInfo[] = [];
    for (const p of picks) {
      if (taken.has(p.id)) continue;
      taken.add(p.id);
      added.push({
        id: p.id,
        name: p.name || p.id,
        // 端点没返回窗口时的兜底：取 1M。
        // 依据：当前主流型号普遍 ≥1M（GPT-6 1.05M / Claude 1M / Gemini 1.048M / DeepSeek 1M /
        // Qwen 3.7-3.8 1M / MiMo 1M），1M 是"更常见的那一边"。
        // 代价要清楚：真 128K 的模型会因此迟迟不触发压缩而撞端点超限——但那条路是显性失败，
        // 且有 force_compact_session + "上下文超出窗口限制"卡片兜底；
        // 反过来把兜底设小，会在真 1M 模型上静默提前压缩、砍掉用户历史，用户根本不会察觉。
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
    <div className="space-y-1">
      {models.length === 0 && editing !== "new" && (
        <div className="text-xs text-muted-foreground py-2 text-center">暂无模型</div>
      )}
      {models.map((m, i) =>
        editing === i ? (
          <ModelForm key={i} initial={m} existingIds={models.filter((_, idx) => idx !== i).map((mm) => mm.id)} onSave={(mm) => saveOne(mm, i)} onCancel={() => setEditing(null)} />
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
        <ModelForm existingIds={models.map((mm) => mm.id)} onSave={(mm) => saveOne(mm, "new")} onCancel={() => setEditing(null)} />
      )}
      {probed && <ImportPanel probed={probed} existingIds={models.map((m) => m.id)} onApply={applyImport} onCancel={() => setProbed(null)} />}
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

/** 单行模型展示（含禁用态样式与悬浮操作） */
function ModelRow({ model, editable, confirmDelete, onToggle, onEdit, onDelete }: { model: ProviderModelInfo; editable: boolean; confirmDelete?: boolean; onToggle: () => void; onEdit: () => void; onDelete: () => void }) {
  const win = model.contextWindow >= 1000000 ? `${(model.contextWindow / 1000000).toFixed(0)}M` : `${(model.contextWindow / 1000).toFixed(0)}K`;
  return (
    <div className={`group/m flex items-center gap-2 px-2 py-1 rounded ${model.disabled ? "opacity-50" : ""}`}>
      <div className="min-w-0 flex-1">
        <span className={`text-xs font-medium ${model.disabled ? "line-through" : ""}`}>{model.name || model.id}</span>
        {model.vendor && <Tag className="ml-1">{model.vendor}</Tag>}
        {model.protocol && <Tag variant="outline" className="ml-1">{model.protocol}</Tag>}
        {model.vision && <Tag variant="primary" className="ml-1">多模态</Tag>}
        {model.thinking && <Tag variant="outline" className="ml-1">思考</Tag>}
        {model.cacheControl && <Tag className="ml-1">缓存</Tag>}
        {model.effortLevels && model.effortLevels.length > 0 && <Tag variant="outline" className="ml-1">强度 {model.effortLevels.length}</Tag>}
        {model.disabled && <Tag className="ml-1">已禁用</Tag>}
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
          <button onClick={onDelete} title={confirmDelete ? "再次点击确认删除" : "删除"} className={`p-1 rounded transition-all flex items-center whitespace-nowrap ${confirmDelete ? "bg-destructive/10 text-destructive px-1" : "text-muted-foreground hover:text-destructive hover:bg-muted"}`}>
            <Trash2 className="w-3 h-3 shrink-0" />
            {confirmDelete && <span className="ml-0.5 text-[10px] font-medium">确认</span>}
          </button>
        </div>
      )}
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
        <Button size="sm" className="h-8" onClick={submit} disabled={!name.trim() || !baseUrl.trim()}><Save className="w-3.5 h-3.5" />保存</Button>
        <Button size="sm" variant="outline" className="h-8" onClick={reset}>取消</Button>
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
          <ModelForm key={i} initial={m} existingIds={models.filter((_, idx) => idx !== i).map((mm) => mm.id)} onSave={(mm) => { save(mm, i); setEditing(null); }} onCancel={() => setEditing(null)} />
        ) : (
          <div key={i} className="flex items-center gap-2 px-2 py-1 rounded group/m">
            <span className="text-xs font-medium flex-1 truncate">{m.name || m.id}</span>
            <span className="text-[10px] text-muted-foreground font-mono">{m.id} · {m.contextWindow >= 1000 ? `${(m.contextWindow / 1000).toFixed(0)}K` : m.contextWindow}</span>
            {m.vision && <Tag variant="primary">多模态</Tag>}
            <div className="flex items-center gap-0.5 opacity-0 group-hover/m:opacity-100 transition-opacity">
              <button onClick={() => setEditing(i)} className="p-1 rounded text-muted-foreground hover:text-foreground"><Pencil className="w-3 h-3" /></button>
              <button onClick={() => del(i)} className="p-1 rounded text-muted-foreground hover:text-red-500"><Trash2 className="w-3 h-3" /></button>
            </div>
          </div>
        ),
      )}
      {editing === "new" ? (
        <ModelForm existingIds={models.map((mm) => mm.id)} onSave={(mm) => { save(mm, "new"); setEditing(null); }} onCancel={() => setEditing(null)} />
      ) : (
        <button onClick={() => setEditing("new")} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mt-1">
          <Plus className="w-3.5 h-3.5" />添加模型
        </button>
      )}
    </div>
  );
}
