/**
 * MarketplaceStudio —— Marketplace 源管理器（编辑器 Tab WebView，view=marketplace）
 *
 * 管理 ~/.axon/settings/marketplaces.json（用户级全局配置，Skill 与 Power 共用同一份源列表）：
 *   - 可视化增删源（名称 / URL / 备注）
 *   - JSON 编辑（高级用户/批量配置场景）
 *
 * 与 ProviderStudio / McpStudio 同属"全局配置管理"类页面，独立编辑器 Tab 打开，
 * 不再嵌在 Skill 的浏览安装弹窗里——源本身是全局配置，不该跟着某次安装操作临时冒出来。
 */

import { useState, useEffect, useCallback } from "react";
import { Store, Plus, Trash2, Loader2, FileJson, LayoutList, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  listMarketplaceSources,
  addMarketplaceSource,
  removeMarketplaceSource,
  getMarketplaceRawConfig,
  saveMarketplaceRawConfig,
  type MarketplaceSource,
} from "@/lib/apiClient";

type Tab = "visual" | "json";

export function MarketplaceStudio() {
  const [tab, setTab] = useState<Tab>("visual");
  const [sources, setSources] = useState<MarketplaceSource[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { sources: list } = await listMarketplaceSources();
      setSources(list);
    } catch (e) {
      console.warn("加载源列表失败", e);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-5 pt-4 pb-3 border-b border-border">
        <div className="flex items-center gap-2 mb-1">
          <Store className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium">Marketplace 源管理</span>
        </div>
        <div className="text-[11px] text-muted-foreground">
          用户级全局配置：~/.axon/settings/marketplaces.json（Skill 与 Power 从仓库安装时共用此处的源列表）
        </div>
      </div>

      {/* tab 切换 */}
      <div className="flex gap-1 px-4 pt-2 border-b border-border shrink-0">
        <TabBtn active={tab === "visual"} onClick={() => setTab("visual")} icon={<LayoutList className="w-3.5 h-3.5" />} label="源列表" />
        <TabBtn active={tab === "json"} onClick={() => setTab("json")} icon={<FileJson className="w-3.5 h-3.5" />} label="JSON 编辑" />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {tab === "visual" && <VisualTab sources={sources} loading={loading} onChanged={load} />}
        {tab === "json" && <JsonTab onSaved={load} />}
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${active ? "bg-muted font-medium" : "hover:bg-muted/50 text-muted-foreground"}`}
    >
      {icon}
      {label}
    </button>
  );
}

/** 源列表 tab：可视化增删源 */
function VisualTab({ sources, loading, onChanged }: { sources: MarketplaceSource[]; loading: boolean; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [removingName, setRemovingName] = useState("");

  const handleAdd = async () => {
    if (!name.trim() || !url.trim()) { setError("名称和 URL 必填"); return; }
    setSaving(true);
    setError("");
    try {
      await addMarketplaceSource({ name: name.trim(), url: url.trim(), description: description.trim() || undefined });
      setName(""); setUrl(""); setDescription("");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
    setSaving(false);
  };

  const handleRemove = async (sourceName: string) => {
    setRemovingName(sourceName);
    try {
      await removeMarketplaceSource(sourceName);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
    setRemovingName("");
  };

  return (
    <div className="flex flex-col gap-4">
      {/* 已有源列表 */}
      <div className="space-y-1.5">
        {loading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" /></div>
        ) : sources.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground py-6 border border-dashed border-border rounded-lg">
            暂无源，在下方添加一个
          </div>
        ) : (
          sources.map((s) => (
            <div key={s.name} className="flex items-center gap-3 px-3 py-2 rounded-md border border-border">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{s.name}</div>
                <div className="text-xs text-muted-foreground truncate">{s.url}</div>
                {s.description && <div className="text-xs text-muted-foreground/70 truncate mt-0.5">{s.description}</div>}
              </div>
              <button
                onClick={() => handleRemove(s.name)}
                disabled={removingName === s.name}
                className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive shrink-0"
              >
                {removingName === s.name ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              </button>
            </div>
          ))
        )}
      </div>

      {/* 新增源表单 */}
      <div className="border-t border-border pt-3 space-y-2">
        <div className="text-xs font-medium text-muted-foreground">添加新源</div>
        <Input placeholder="源名称（如 团队内部仓库）" value={name} onChange={(e) => setName(e.target.value)} />
        <Input placeholder="源根 URL（如 https://internal.company.com/skills-repo）" value={url} onChange={(e) => setUrl(e.target.value)} />
        <Input placeholder="备注说明（可选）" value={description} onChange={(e) => setDescription(e.target.value)} />
        {error && <div className="text-xs text-destructive">{error}</div>}
        <Button size="sm" onClick={handleAdd} disabled={saving} className="w-full sm:w-auto">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Plus className="w-3.5 h-3.5 mr-1.5" />}
          添加源
        </Button>
        <div className="text-[11px] text-muted-foreground leading-relaxed">
          远程仓库需在根路径提供 <code className="px-1 py-0.5 rounded bg-muted">index.json</code>，
          格式：<code className="px-1 py-0.5 rounded bg-muted">{"{ skills: [{name, description, path}], powers: [...] }"}</code>，
          path 为相对源 URL 的 SKILL.md / POWER.md 路径。
        </div>
      </div>
    </div>
  );
}

/** JSON 编辑 tab：直接编辑 marketplaces.json 原始内容 */
function JsonTab({ onSaved }: { onSaved: () => void }) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { content: raw } = await getMarketplaceRawConfig();
        setContent(raw);
      } catch (e) {
        setError((e as Error).message);
      }
      setLoading(false);
    })();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      await saveMarketplaceRawConfig(content);
      setSaved(true);
      onSaved();
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError((e as Error).message);
    }
    setSaving(false);
  };

  if (loading) {
    return <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  }

  return (
    <div className="flex flex-col gap-2 h-full">
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        className="flex-1 min-h-[300px] font-mono text-xs p-3 rounded-md border border-border bg-muted/30 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
        spellCheck={false}
      />
      {error && <div className="text-xs text-destructive shrink-0">{error}</div>}
      <div className="flex justify-end shrink-0">
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : saved ? <Check className="w-3.5 h-3.5 mr-1.5" /> : null}
          {saved ? "已保存" : "保存"}
        </Button>
      </div>
    </div>
  );
}
