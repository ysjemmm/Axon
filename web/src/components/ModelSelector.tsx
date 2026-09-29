/**
 * 模型选择器组件 - 两级菜单：一级 provider，点击展开二级模型列表（同时只展开一个）
 *
 * 数据驱动：从 /api/providers 拉取内置 + 自定义 provider 及其模型（实时刷新）。
 * 打开下拉时会重新拉取，配置改动即时反映。
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Settings, Image as ImageIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { getProviders, type ProviderModelInfo, type ResolvedProviderInfo } from "@/lib/apiClient";

export interface ModelOption {
  id: string;
  name: string;
  contextWindow: number;
  description: string;
  free: boolean;
  vision: boolean;
  provider: string; // 对应后端的 provider key
  /** 分组标签（厂商/来源），用于下拉列表分组展示 */
  group: string;
  /**
   * 是否支持思考/推理。由后端解析后下发（模型声明优先、启发式兜底），
   * 前端只做展示，不自己判断——判定逻辑留在 core 一处，避免两边漂移。
   */
  thinking?: boolean;
  /** 由 Provider 配置的强度档位；未配置时不展示强度选择器 */
  effortLevels?: { label: string; value: string }[];
  /** 默认强度实际值；缺省表示关闭 */
  defaultEffort?: string;
}

/**
 * 曾经存在的 "auto" 伪模型 id —— 按任务自动挑模型的 Auto 已移除。
 *
 * 老用户的 localStorage 里可能还存着它。必须在读取处归一化掉：
 * 它不再对应任何真实模型，留着会让面板显示一个选不中的名字，
 * 并把 model="auto" 发给后端（后端会拿它当真实模型名去调接口，直接失败）。
 */
const LEGACY_AUTO_MODEL_ID = "auto";

/**
 * 归一化持久化的模型 id：已移除的 "auto" 视为"没存过"，返回 null。
 * 调用方据此视为未选择模型。
 */
export function normalizeStoredModelId(stored: string | null | undefined): string | null {
  if (!stored || stored === LEGACY_AUTO_MODEL_ID) return null;
  return stored;
}

// ── provider / 模型动态加载（从 /api/providers 拉取内置 + 自定义）──────────

/** 后端解析出的 provider（脱敏，含其模型与配置状态） */
let _providers: ResolvedProviderInfo[] = [];
let _loaded = false;
let _loading = false;
const _subs = new Set<() => void>();

function _notify(): void {
  for (const fn of _subs) fn();
}

/** 拉取最新 provider/模型（失败时保留空列表，提示用户配置 Provider） */
export async function refreshModels(): Promise<void> {
  if (_loading) return;
  _loading = true;
  try {
    const { providers } = await getProviders();
    _providers = providers;
    _loaded = true;
    _notify();
  } catch {
    /* 后端不可用时保持兜底 */
  } finally {
    _loading = false;
  }
}

function _toOption(providerName: string, group: string, m: ProviderModelInfo): ModelOption {
  return {
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
    description: m.description || "",
    free: !!m.free,
    vision: !!m.vision,
    provider: providerName,
    group,
    thinking: m.thinking,
    effortLevels: Array.isArray(m.effortLevels)
      ? m.effortLevels.filter((x) => typeof x?.label === "string" && typeof x?.value === "string" && x.label.trim() && x.value.trim())
      : undefined,
    defaultEffort: typeof m.defaultEffort === "string" ? m.defaultEffort : undefined,
  };
}

/** provider 分组（含未配置 provider）；内置在前、自定义在后。供两级菜单。 */
export interface ProviderGroup { name: string; label: string; builtin: boolean; configured: boolean; models: ModelOption[] }

export function getProviderGroups(): ProviderGroup[] {
  if (_providers.length === 0) return [];
  // 显示所有 provider（含未配置），未配置的模型的 disabledModels 由 UI 层处理
  const groups = _providers
    .map((p) => ({
      name: p.name,
      label: p.label || p.name,
      builtin: p.builtin,
      configured: p.configured,
      models: p.models.filter((m) => !m.disabled).map((m) => _toOption(p.name, p.label || p.name, m)),
    }));
  // 内置在前、自定义在后
  return [...groups.filter((g) => g.builtin), ...groups.filter((g) => !g.builtin)];
}

/** 全部可选模型（各 provider 未禁用模型） */
export function getModels(): ModelOption[] {
  return getProviderGroups().flatMap((g) => g.models);
}

/** 按 id 查模型 */
export function findModel(id: string): ModelOption | undefined {
  return getModels().find((m) => m.id === id);
}

/** 订阅 hook：挂载触发拉取，数据更新自动重渲染 */
function useProviderStore(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const rerender = () => setTick((n) => n + 1);
    const onHostMessage = (event: MessageEvent) => {
      if (event.data?.type === "providers_changed") void refreshModels();
    };
    _subs.add(rerender);
    window.addEventListener("message", onHostMessage);
    if (!_loaded) void refreshModels();
    return () => {
      _subs.delete(rerender);
      window.removeEventListener("message", onHostMessage);
    };
  }, []);
}

/** 全部模型 hook（供 ChatPanel 做 vision / disabled 判断） */
export function useModels(): ModelOption[] {
  useProviderStore();
  return getModels();
}

/** provider 分组 hook（供模型选择器两级菜单） */
export function useProviderGroups(): ProviderGroup[] {
  useProviderStore();
  return getProviderGroups();
}

/** 打开 VS Code 侧边栏 Provider 配置面板 */
function openProviderPanel() {
  const vscode = (window as any).__axonVSCode;
  if (vscode) {
    vscode.postMessage({ type: "open_provider" });
  }
}

interface ModelSelectorProps {
  value: string;
  /**
   * 当前选中模型所属的 provider（可选）。多个 provider 下存在同名模型时，
   * 仅靠 value（模型 id）无法区分具体是哪一个，必须由外部会话状态显式传入，
   * 否则组件重新挂载后（如 IDE 重启、面板重渲染）会丢失记忆，退化为随机匹配
   * 第一个同名模型，导致显示/勾选与实际使用的 provider 不一致。
   */
  provider?: string;
  onChange: (modelId: string, providerName?: string) => void;
  disabledModels?: string[];
  /** 整个选择器禁用（如压缩期间） */
  disabled?: boolean;
  disabledTooltip?: string;
}

interface EffortSelectorProps {
  levels: { label: string; value: string }[];
  value: string | null;
  defaultValue?: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}

/**
 * 独立的思考强度选择器，显示在模型选择器右侧。
 *
 * 默认关闭；选项完全来自当前模型 Provider 配置的 effortLevels，不猜厂商、不做档位映射。
 * UI 显示 label，请求与消息气泡使用实际 value（如 high / xhigh）。
 */
export function EffortSelector({ levels, value, defaultValue, onChange, disabled = false }: EffortSelectorProps) {
  const [open, setOpen] = useState(false);
  if (levels.length === 0) return null;
  const current = levels.find((x) => x.value === value);

  return (
    <Popover open={open} onOpenChange={(next) => { if (!disabled) setOpen(next); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex h-7 items-center px-0.5 text-xs font-medium text-muted-foreground/75 transition-colors hover:text-muted-foreground data-[state=open]:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
          title={current ? `思考强度：${current.label}（${current.value}）` : "思考强度：关闭"}
        >
          <span>{current?.label || "关闭"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={4} className="w-[220px] p-2 rounded-xl ring-1 ring-border/70 shadow-xl">
        <div className="px-2 pb-2 text-[11px] leading-4 text-muted-foreground/75">
          思考强度越高，回答越全面，但耗时和用量也会增加。
        </div>
        <div className="space-y-1">
          <button
            onClick={() => { onChange(null); setOpen(false); }}
            className={`flex items-center w-full h-7 gap-1.5 px-2 rounded-lg text-xs text-left transition-colors ${value === null ? "bg-primary/[0.08] text-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted/70"}`}
          >
            <span className="flex-1">关闭</span>
            <Check className={`w-3 h-3 text-primary ${value === null ? "" : "invisible"}`} />
          </button>
        {levels.map((level) => (
          <button
            key={level.value}
            onClick={() => { onChange(level.value); setOpen(false); }}
            className={`flex items-center w-full h-7 gap-1.5 px-2 rounded-lg text-xs text-left transition-colors ${value === level.value ? "bg-primary/[0.08] text-foreground font-medium" : "text-foreground/85 hover:text-foreground hover:bg-muted/70"}`}
          >
            <span className="min-w-0 flex-1 truncate">{level.label}</span>
            {defaultValue === level.value && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] font-normal text-muted-foreground">默认</span>
            )}
            <span className="text-[9px] font-mono text-muted-foreground/55">{level.value}</span>
            <Check className={`w-3 h-3 text-primary ${value === level.value ? "" : "invisible"}`} />
          </button>
        ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** 把上下文窗口格式化为紧凑标记（1M / 256K）；无窗口信息返回空串 */
function formatContextWindow(contextWindow: number): string {
  if (contextWindow <= 0) return "";
  if (contextWindow >= 1_000_000) return `${(contextWindow / 1_000_000).toFixed(0)}M`;
  return `${(contextWindow / 1000).toFixed(0)}K`;
}

/** 细滚动条：默认隐形，hover 时浮现。弹层与模型列表共用 */
const THIN_SCROLL =
  "[&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent " +
  "[&::-webkit-scrollbar-track]:bg-transparent hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/25 " +
  "[scrollbar-width:thin] [scrollbar-color:transparent_transparent] hover:[scrollbar-color:rgba(128,128,128,0.25)_transparent]";

/** 弹层外壳 */
const PANEL_CLS = `w-[264px] max-h-[70vh] overflow-y-auto p-1.5 gap-0 rounded-xl ring-1 ring-border/70 shadow-xl ${THIN_SCROLL}`;

/** 展开后的模型列表：缩进 16px，让模型名与组名文字左对齐（组名前有 12px 箭头 + 间距） */
const MODEL_LIST_CLS = `pl-4 pb-1 max-h-[232px] overflow-y-auto ${THIN_SCROLL}`;

/** 底部操作行（深度思考 / 配置 Provider）：与模型行同高，次级字号 */
const FOOTER_ROW_CLS =
  "flex items-center gap-2 w-full h-8 px-2 rounded-md text-[12.5px] text-muted-foreground " +
  "hover:text-foreground hover:bg-muted/60 transition-colors";

/** 分隔线 */
function Divider() {
  return <div className="h-px mx-1 my-1.5 bg-border/60" />;
}

/**
 * provider 分组行（一级，可展开）。
 *
 * 视觉上是"小标题"而不是"选项"：字号比模型名小一档、中等字重、次级色，
 * 这样一眼就能分出层级——早先组名和模型名都是 13px 半粗，挤在一起分不清谁是谁。
 */
function ProviderHeader({ label, count, expanded, configured = true, onToggle }: {
  label: string;
  count: number;
  expanded: boolean;
  configured?: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
      className={`flex items-center gap-1.5 h-7 pl-1.5 pr-2 rounded-md text-[12px] cursor-pointer select-none transition-colors ${expanded ? "text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"}`}
    >
      <ChevronRight className={`w-3 h-3 shrink-0 opacity-60 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`} />
      <span className="font-medium truncate flex-1 min-w-0">{label}</span>
      {configured
        ? <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/50">{count}</span>
        : <span className="shrink-0 px-1.5 rounded-full text-[10px] leading-4 bg-amber-500/10 text-amber-600 dark:text-amber-400">未配置</span>}
    </div>
  );
}

/**
 * 单个模型行（菜单项）——单行紧凑布局。
 *
 * 一行放下：模型名 + 多模态图标 + 上下文窗口 + 选中对勾。
 * 描述不再单独占一行，移到原生 title：中转站类 provider 的模型普遍没有描述，
 * 为它留一行等于给每个模型白付一行高度（截图里 7 个模型就撑满了整个弹层）。
 *
 * 选中态用"浅底 + 右侧对勾"：对勾位置在未选中行也占位（invisible），
 * 所以上下文窗口那一列在所有行里都是右对齐的一条竖线，扫读时不跳。
 */
function ModelRow({ model, selected, disabled, disabledHint, onPick }: { model: ModelOption; selected: boolean; disabled: boolean; disabledHint?: string; onPick: () => void }) {
  const win = formatContextWindow(model.contextWindow);
  // hover 提示：把被折叠掉的信息（描述/多模态/窗口）都并进来，紧凑不等于丢信息
  const title = [model.name, model.description, model.vision ? "多模态" : "", win].filter(Boolean).join(" · ");
  const btn = (
    <button
      data-selected={selected ? "true" : undefined}
      disabled={disabled}
      onClick={onPick}
      title={title}
      className={`flex items-center w-full h-8 gap-2 px-2 rounded-md text-[13px] text-left transition-colors ${selected ? "bg-primary/[0.08] text-foreground" : "text-foreground/85 hover:bg-muted/70 hover:text-foreground"} disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent`}
    >
      <span className={`truncate min-w-0 flex-1 ${selected ? "font-medium" : ""}`}>{model.name}</span>
      {model.vision && <ImageIcon className="w-3 h-3 shrink-0 text-muted-foreground/50" aria-label="多模态" />}
      {win && <span className="shrink-0 min-w-[26px] text-right text-[11px] tabular-nums text-muted-foreground/60">{win}</span>}
      <Check className={`w-3.5 h-3.5 shrink-0 text-primary ${selected ? "" : "invisible"}`} aria-hidden={!selected} />
    </button>
  );
  if (disabled && disabledHint) {
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block">{btn}</span>
          </TooltipTrigger>
          <TooltipContent side="right" align="center" sideOffset={8}>
            <p className="text-xs">{disabledHint}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  return btn;
}

export function ModelSelector({ value, provider, onChange, disabledModels = [], disabled = false, disabledTooltip }: ModelSelectorProps) {
  const groups = useProviderGroups();
  const [open, setOpen] = useState(false);
  // 当前展开的 provider；打开时默认展开当前所选模型所属 provider
  const [expanded, setExpanded] = useState<string | null>(null);
  // 记住最后选择的 provider，同名模型优先匹配它；初始值取外部传入的会话 provider，
  // 避免组件重新挂载（IDE 重启/面板重渲染）后丢失记忆而误配到同名模型的第一个 provider
  const [lastProvider, setLastProvider] = useState<string | null>(provider ?? null);
  // 外部 provider 变化时（如会话加载完成后才拿到值、或父组件切换了会话）同步跟随
  useEffect(() => {
    if (provider) setLastProvider(provider);
  }, [provider]);

  // 展开 provider 时自动滚动到当前选中模型
  const scrollRefs = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    if (!expanded) return;
    // Radix Popover 有 ~150ms 入场动画，容器尺寸稳定后才能滚。
    const timer = setTimeout(() => {
      const el = scrollRefs.current[expanded];
      if (!el) return;
      const selected = el.querySelector('[data-selected="true"]') as HTMLElement | null;
      if (selected && el.scrollHeight > el.clientHeight) {
        el.scrollTop = selected.offsetTop - el.clientHeight / 3;
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [expanded]);

  /** 按 value 找模型：优先 lastProvider，回退到任意匹配 */
  const allModels = getModels();
  const current = lastProvider
    ? allModels.find((m) => m.id === value && m.provider === lastProvider) ?? allModels.find((m) => m.id === value)
    : allModels.find((m) => m.id === value);

  const onOpenChange = (next: boolean) => {
    if (disabled) return;
    setOpen(next);
    if (next) {
      void refreshModels(); // 打开即拉最新，配置改动即时反映
      setExpanded(current?.provider ?? null);
    }
  };

  const pick = (id: string, providerName?: string) => { if (providerName) setLastProvider(providerName); onChange(id, providerName); setOpen(false); };

  const trigger = (
    <button
      type="button"
      className={`inline-flex h-7 min-w-0 items-center px-1 text-xs font-medium text-foreground transition-colors hover:text-foreground/75 data-[state=open]:text-foreground/75 ${disabled ? "cursor-not-allowed opacity-30" : ""}`}
      onClick={() => { if (!disabled) setOpen(!open); }}
    >
      <span className="truncate max-w-[160px]">{current?.name || value || "选择模型"}</span>
    </button>
  );

  if (disabled && disabledTooltip) {
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            {trigger}
          </TooltipTrigger>
          <TooltipContent side="top" align="start">
            <p className="text-xs">{disabledTooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className={PANEL_CLS}
      >
        {groups.length === 0 ? (
          <button onClick={openProviderPanel} className={FOOTER_ROW_CLS}>
            <Settings className="w-3.5 h-3.5 shrink-0 opacity-70" />
            配置自定义 Provider
          </button>
        ) : <>
        {/* provider 一级 + 点击内联展开二级模型（同时只展开一个） */}
        {/* side="top" 向上弹出时，底部离按钮最近。将当前选中的 provider 排到最后（最靠近按钮）以减少误触 */}
        {[...groups].sort((a, b) => {
          const aCurrent = current && a.name === current.provider ? 1 : 0;
          const bCurrent = current && b.name === current.provider ? 1 : 0;
          return aCurrent - bCurrent;
        }).map((g) => {
          const isExpanded = expanded === g.name;
          return (
            <div key={g.name}>
              <ProviderHeader
                label={g.label}
                count={g.models.length}
                expanded={isExpanded}
                configured={g.configured}
                onToggle={() => setExpanded(isExpanded ? null : g.name)}
              />
              {isExpanded && (
                <div ref={(el) => { scrollRefs.current[g.name] = el; }} className={MODEL_LIST_CLS}>
                  {g.models.map((m) => (
                    <ModelRow
                      key={m.id}
                      model={m}
                      selected={m.id === current?.id && m.provider === current?.provider}
                      disabled={!g.configured || disabledModels.includes(m.id)}
                      disabledHint={!g.configured ? "请先配置 API Key" : undefined}
                      onPick={() => { if (g.configured) pick(m.id, m.provider); }}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* 底部操作栏 */}
        <Divider />
        <button onClick={openProviderPanel} className={FOOTER_ROW_CLS}>
          <Settings className="w-3.5 h-3.5 shrink-0 opacity-70" />
          配置自定义 Provider
        </button>
        </>}
      </PopoverContent>
    </Popover>
  );
}

/**
 * 识图兜底模型选择器——两级菜单（provider 分组 + 点击内联展开模型，同时只展开一个），
 * 结构与 ModelSelector 完全一致，仅过滤出支持图片（vision === true）的模型。
 * 顶部多一个「不启用」空态行；识图兜底只存模型 id，靠后端反查 provider。
 */
export function VisionFallbackSelector({ value, onChange }: { value: string | null; onChange: (modelId: string | null) => void }) {
  const groups = useProviderGroups();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // 当前选中的模型（跨 provider 按 id 匹配）
  const allModels = getModels();
  const current = allModels.find((m) => m.id === value && m.vision);

  // 展开 provider 时自动滚动到当前选中模型
  const scrollRefs = useRef<Record<string, HTMLDivElement | null>>({});
  useEffect(() => {
    if (!expanded) return;
    const timer = setTimeout(() => {
      const el = scrollRefs.current[expanded];
      if (!el) return;
      const selected = el.querySelector('[data-selected="true"]') as HTMLElement | null;
      if (selected && el.scrollHeight > el.clientHeight) {
        el.scrollTop = selected.offsetTop - el.clientHeight / 3;
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [expanded]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      void refreshModels();
      setExpanded(current?.provider ?? null);
    }
  };

  // 只保留已配置 provider 下的 vision 模型；provider 内若 vision 模型全空则不显示该组
  const visionGroups = groups
    .filter((g) => g.configured)
    .map((g) => ({ ...g, models: g.models.filter((m) => m.vision) }))
    .filter((g) => g.models.length > 0);

  const trigger = (
    <button
      type="button"
      onClick={() => { if (!open) setOpen(true); else setOpen(false); }}
      className="inline-flex items-center h-7 gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 data-[state=open]:bg-muted/60 transition-colors"
    >
      <span className={`truncate max-w-[180px] ${current ? "text-foreground" : ""}`}>{current?.name || "不启用（留空）"}</span>
      <ChevronDown className={`w-3 h-3 shrink-0 opacity-60 transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
    </button>
  );

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className={PANEL_CLS}
      >
        {/* 「不启用」空态行：与模型行同构（同高、同样的对勾位），固定在顶部 */}
        <button
          data-selected={value === null ? "true" : undefined}
          onClick={() => { onChange(null); setOpen(false); }}
          className={`flex items-center w-full h-8 gap-2 px-2 rounded-md text-[13px] text-left transition-colors ${value === null ? "bg-primary/[0.08] text-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted/70"}`}
        >
          <span className="truncate flex-1 min-w-0">不启用（留空）</span>
          <Check className={`w-3.5 h-3.5 shrink-0 text-primary ${value === null ? "" : "invisible"}`} />
        </button>
        <Divider />

        {/* provider 一级 + 点击内联展开二级模型（同时只展开一个） */}
        {[...visionGroups].sort((a, b) => {
          const aCurrent = current && a.name === current.provider ? 1 : 0;
          const bCurrent = current && b.name === current.provider ? 1 : 0;
          return aCurrent - bCurrent;
        }).map((g) => {
          const isExpanded = expanded === g.name;
          return (
            <div key={g.name}>
              <ProviderHeader
                label={g.label}
                count={g.models.length}
                expanded={isExpanded}
                onToggle={() => setExpanded(isExpanded ? null : g.name)}
              />
              {isExpanded && (
                <div ref={(el) => { scrollRefs.current[g.name] = el; }} className={MODEL_LIST_CLS}>
                  {g.models.map((m) => (
                    <ModelRow
                      key={m.id}
                      model={m}
                      selected={m.id === current?.id && m.provider === current?.provider}
                      disabled={false}
                      onPick={() => { onChange(m.id); setOpen(false); }}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {visionGroups.length === 0 && (
          <div className="px-2 py-2 text-[12.5px] text-muted-foreground/60">没有已配置的支持图片的模型</div>
        )}
      </PopoverContent>
    </Popover>
  );
}
