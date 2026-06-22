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
import { Loader2, Cloud, Plus, Trash2, Save, KeyRound, ChevronRight, Pencil, Ban, RotateCcw, Download, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  getProviders,
  setBuiltinProviderKey,
  addCustomProvider,
  removeCustomProvider,
  setCustomProviderModels,
  probeProviderModels,
  openProviderConfigInEditor,
  type ProviderLevel,
  type ResolvedProviderInfo,
  type ProviderModelInfo,
  type ProbedModelInfo,
  type ProviderProtocol,
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
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { providers: list } = await getProviders(workspace || undefined);
      setProviders(list);
    } catch (e) {
      console.warn("加载 provider 失败", e);
    }
    setLoading(false);
  }, [workspace]);

  useEffect(() => { load(); }, [load]);

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

      {/* 内置 provider */}
      <div className="px-5 pt-4">
        <div className="text-xs font-medium text-muted-foreground mb-2">内置 Provider</div>
        <div className="space-y-2">
          {builtins.map((p) => (
            <BuiltinCard key={p.name} provider={p} level={level} workspace={wsArg} onChanged={load} />
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
            <CustomCard key={p.name} provider={p} level={level} workspace={wsArg} onChanged={load} />
          ))}
        </div>
        <AddCustomForm level={level} workspace={wsArg} onChanged={load} />
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

/** 内置 provider 卡片：只暴露 API Key，模型列表只读 */
function BuiltinCard({ provider, level, workspace, onChanged }: { provider: ResolvedProviderInfo; level: ProviderLevel; workspace?: string; onChanged: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await setBuiltinProviderKey(level, provider.name, apiKey, workspace);
      setApiKey("");
      onChanged();
    } catch (e) {
      alert(`保存失败: ${(e as Error).message}`);
    }
    setSaving(false);
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
      <div className="flex gap-2">
        <Input
          type="password"
          placeholder={provider.configured ? "已配置（留空保留，输入则覆盖）" : "输入 API Key"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="h-8 text-sm flex-1"
        />
        <Button size="sm" onClick={save} disabled={saving || !apiKey.trim()}>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}保存
        </Button>
      </div>
      {expanded && (
        <div className="mt-2 pt-2 border-t border-border/60">
          <ModelManager models={provider.models} editable={false} />
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

  const remove = async () => {
    setDeleting(true);
    try {
      await removeCustomProvider(level, provider.name, workspace);
      onChanged();
    } catch (e) {
      alert(`删除失败: ${(e as Error).message}`);
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

  const saveModels = async (models: ProviderModelInfo[]) => {
    try {
      await setCustomProviderModels(level, provider.name, models, workspace);
      onChanged();
    } catch (e) {
      alert(`保存模型失败: ${(e as Error).message}`);
    }
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
          <ModelManager models={provider.models} editable onSave={saveModels} providerName={provider.name} level={level} workspace={workspace} />
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
  const [protocol, setProtocol] = useState<"chat" | "responses">(initial?.protocol || "chat");

  const vendorOptions = [
    { id: "openai", label: "OpenAI" },
    { id: "anthropic", label: "Anthropic" },
    { id: "qwen", label: "Qwen" },
    { id: "zhipu", label: "Zhipu" },
    { id: "ollama", label: "Ollama" },
  ];

  const submit = () => {
    if (!id.trim()) return;
    const contextWindow = /^\d+$/.test(win.trim()) ? parseInt(win.trim(), 10) : 128000;
    onSave({ id: id.trim(), name: name.trim() || id.trim(), contextWindow, vision, protocol, vendor: vendor || undefined, disabled: initial?.disabled });
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
        <label className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} className="w-3 h-3 accent-primary" />
          多模态
        </label>
        <div className="ml-auto flex gap-1">
          <Button size="sm" onClick={submit} disabled={!id.trim()}>保存</Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>取消</Button>
        </div>
      </div>
      <div className="text-[10px] text-muted-foreground">上下文窗口与多模态以该 provider 官方文档为准；可用上方"从端点导入"自动带出（若端点返回）。</div>
    </div>
  );
}

/** 把 "id | 显示名 | 窗口 | 多模态(y/n) | 厂商 | 协议" 多行文本解析为模型列表 */
function parseModels(text: string): ProviderModelInfo[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [id, name, win, visionFlag, vendor, protocol] = line.split(/[|,]/).map((s) => s.trim());
    const contextWindow = win && /^\d+$/.test(win) ? parseInt(win, 10) : 128000;
    const vision = visionFlag ? /^y|yes|true|1$/i.test(visionFlag) : false;
    const proto: ProviderProtocol | undefined = protocol === "responses" ? "responses" : (protocol === "chat" ? "chat" : undefined);
    return { id, name: name || id, contextWindow, vision, protocol: proto, vendor: vendor || undefined };
  }).filter((m) => m.id);
}

/** 添加自定义 provider 表单 */
function AddCustomForm({ level, workspace, onChanged }: { level: ProviderLevel; workspace?: string; onChanged: () => void }) {
  const [show, setShow] = useState(false);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelsText, setModelsText] = useState("");

  const reset = () => { setName(""); setLabel(""); setBaseUrl(""); setApiKey(""); setModelsText(""); setShow(false); };

  const submit = async () => {
    if (!name.trim() || !baseUrl.trim()) return;
    try {
      await addCustomProvider(level, name.trim(), {
        label: label.trim() || name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        models: parseModels(modelsText),
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
      <textarea
        placeholder={"模型，每行一个：模型id | 显示名 | 上下文窗口 | 多模态(y/n) | 厂商 | 协议\n例：gpt-4o | GPT-4o | 128000 | y | openai | chat\ngpt-4o-mini | GPT-4o Mini | 128000 | n | openai | chat"}
        value={modelsText}
        onChange={(e) => setModelsText(e.target.value)}
        rows={4}
        className="w-full text-xs font-mono bg-background border border-border rounded-md px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-primary/40"
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={submit} disabled={!name.trim() || !baseUrl.trim()}><Save className="w-3.5 h-3.5" />保存</Button>
        <Button size="sm" variant="ghost" onClick={reset}>取消</Button>
      </div>
    </div>
  );
}
