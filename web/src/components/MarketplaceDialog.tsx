/**
 * Marketplace 对话框 —— 从已配置的远程源浏览并安装 Skill / Power
 *
 * 源的增删改查已迁移到独立的 MarketplaceStudio 页面（用户级全局配置，类似 Provider/MCP 管理）。
 * 这个弹窗只负责"选源 → 浏览条目 → 一键安装"，没有配置任何源时引导跳转到源管理页面。
 *
 * 面向场景：团队内部有自建 Skill/Power 仓库，通过配置源地址，成员可浏览并一键安装，
 * 不需要手动复制粘贴 SKILL.md/POWER.md 内容。
 */

import { useState, useEffect, useCallback } from "react";
import { Store, Loader2, Download, RefreshCw, Check, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  listMarketplaceSources,
  fetchMarketplaceItems,
  installMarketplaceItem,
  type MarketplaceSource,
  type MarketplaceItem,
} from "@/lib/apiClient";

interface MarketplaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前工作区路径（安装到项目级时使用；不传则只能装全局） */
  workspace?: string;
  /** 安装成功后回调（供 Studio 刷新列表） */
  onInstalled?: () => void;
}

/** 打开 VS Code 侧边栏 Marketplace 源管理页面（独立编辑器 Tab） */
function openMarketplaceManager(): void {
  const vscode = (window as any).__axonVSCode;
  if (vscode) vscode.postMessage({ type: "open_marketplace_manager" });
}

export function MarketplaceDialog({ open, onOpenChange, workspace, onInstalled }: MarketplaceDialogProps) {
  const [sources, setSources] = useState<MarketplaceSource[]>([]);
  const [loadingSources, setLoadingSources] = useState(false);

  const loadSources = useCallback(async () => {
    setLoadingSources(true);
    try {
      const { sources: list } = await listMarketplaceSources();
      setSources(list);
    } catch (e) {
      console.warn("加载源列表失败", e);
    }
    setLoadingSources(false);
  }, []);

  useEffect(() => { if (open) loadSources(); }, [open, loadSources]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2 pr-6">
            <span className="flex items-center gap-2">
              <Store className="w-4 h-4 text-primary" />
              从仓库安装（Skill / Power）
            </span>
            <Button size="sm" variant="outline" onClick={openMarketplaceManager}>
              <Settings className="w-3.5 h-3.5 mr-1.5" />
              管理源
            </Button>
          </DialogTitle>
        </DialogHeader>

        <BrowseTab
          sources={sources}
          loadingSources={loadingSources}
          workspace={workspace}
          onInstalled={onInstalled}
        />
      </DialogContent>
    </Dialog>
  );
}

/** 浏览安装：选源 → 列条目 → 安装 */
function BrowseTab({ sources, loadingSources, workspace, onInstalled }: {
  sources: MarketplaceSource[];
  loadingSources: boolean;
  workspace?: string;
  onInstalled?: () => void;
}) {
  const [selectedSource, setSelectedSource] = useState<string>("");
  const [items, setItems] = useState<MarketplaceItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [itemsError, setItemsError] = useState("");
  const [installingPath, setInstallingPath] = useState<string>("");
  const [installedPaths, setInstalledPaths] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<"global" | "workspace">("global");

  useEffect(() => {
    if (sources.length > 0 && !selectedSource) setSelectedSource(sources[0].name);
  }, [sources, selectedSource]);

  const loadItems = useCallback(async (sourceName: string) => {
    if (!sourceName) return;
    setLoadingItems(true);
    setItemsError("");
    setInstalledPaths(new Set());
    try {
      const { items: list } = await fetchMarketplaceItems(sourceName);
      setItems(list);
    } catch (e) {
      setItemsError((e as Error).message);
      setItems([]);
    }
    setLoadingItems(false);
  }, []);

  useEffect(() => { if (selectedSource) loadItems(selectedSource); }, [selectedSource, loadItems]);

  const handleInstall = async (item: MarketplaceItem) => {
    setInstallingPath(item.path);
    try {
      await installMarketplaceItem(item.sourceName, item.path, item.kind, scope === "workspace" ? workspace : undefined);
      setInstalledPaths((prev) => new Set(prev).add(item.path));
      onInstalled?.();
    } catch (e) {
      setItemsError((e as Error).message);
    }
    setInstallingPath("");
  };

  if (loadingSources) {
    return <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  }

  if (sources.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 text-center text-sm text-muted-foreground py-16">
        还没有配置任何源，先添加一个团队仓库地址。
        <Button size="sm" variant="outline" onClick={openMarketplaceManager}>
          <Settings className="w-3.5 h-3.5 mr-1.5" />
          去管理源
        </Button>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 shrink-0">
        <select
          value={selectedSource}
          onChange={(e) => setSelectedSource(e.target.value)}
          className="h-8 px-2 rounded-md border border-border bg-background text-sm flex-1"
        >
          {sources.map((s) => (
            <option key={s.name} value={s.name}>{s.name}</option>
          ))}
        </select>
        <div className="flex gap-3 items-center text-xs shrink-0">
          <label className="flex items-center gap-1 cursor-pointer">
            <input type="radio" checked={scope === "global"} onChange={() => setScope("global")} className="accent-primary" />
            全局
          </label>
          <label className={`flex items-center gap-1 ${workspace ? "cursor-pointer" : "opacity-40 cursor-not-allowed"}`}>
            <input type="radio" checked={scope === "workspace"} onChange={() => workspace && setScope("workspace")} disabled={!workspace} className="accent-primary" />
            当前工作区
          </label>
        </div>
        <Button size="sm" variant="outline" onClick={() => loadItems(selectedSource)} disabled={loadingItems}>
          <RefreshCw className={`w-3.5 h-3.5 ${loadingItems ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {itemsError && (
        <div className="text-xs text-destructive bg-destructive/10 rounded-md px-3 py-2 shrink-0">{itemsError}</div>
      )}

      {loadingItems ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin" /></div>
      ) : items.length === 0 ? (
        <div className="text-center text-sm text-muted-foreground py-12">该源暂无可安装条目（或 index.json 为空）</div>
      ) : (
        <div className="space-y-1.5">
          {items.map((item) => {
            const installed = installedPaths.has(item.path);
            const installing = installingPath === item.path;
            return (
              <div key={`${item.kind}-${item.path}`} className="flex items-center gap-3 px-3 py-2 rounded-md border border-border hover:bg-muted/40 transition-colors">
                <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${item.kind === "skill" ? "bg-violet-500/10 text-violet-600 dark:text-violet-400" : "bg-sky-500/10 text-sky-600 dark:text-sky-400"}`}>
                  {item.kind === "skill" ? "Skill" : "Power"}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{item.name}</div>
                  {item.description && <div className="text-xs text-muted-foreground truncate">{item.description}</div>}
                </div>
                <Button
                  size="sm"
                  variant={installed ? "ghost" : "outline"}
                  disabled={installing || installed}
                  onClick={() => handleInstall(item)}
                  className="shrink-0"
                >
                  {installing ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : installed ? (
                    <><Check className="w-3.5 h-3.5 mr-1" />已安装</>
                  ) : (
                    <><Download className="w-3.5 h-3.5 mr-1" />安装</>
                  )}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
