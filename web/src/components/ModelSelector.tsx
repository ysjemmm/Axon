/**
 * 模型选择器组件 - 两级菜单：一级 provider，点击展开二级模型列表（同时只展开一个）
 *
 * 数据驱动：从 /api/providers 拉取内置 + 自定义 provider 及其模型（实时刷新）。
 * 内置 MODELS 仅作离线兜底。打开下拉时会重新拉取，配置改动即时反映。
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Settings, Image as ImageIcon, Lightbulb, LightbulbOff } from "lucide-react";
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
}

/**
 * Provider 键名常量（必须与后端 @axon/core 的 ZHIPU_PROVIDER 保持一致）。
 * web 是独立工程、引用不到 @axon/core，故在此本地镜像一份，集中收口，
 * 避免 provider 字面量散落到每个模型条目里、改名时漏改。
 */
const PROVIDER_ZHIPU = "zhipu";

export const MODELS: ModelOption[] = [
  // ── 智谱 ──
  { id: "glm-4-flash", name: "GLM-4 Flash", contextWindow: 128000, description: "免费，快速响应", free: true, vision: false, provider: PROVIDER_ZHIPU, group: "智谱" },
  { id: "glm-4-flashx", name: "GLM-4 FlashX", contextWindow: 128000, description: "免费，极速推理", free: true, vision: false, provider: PROVIDER_ZHIPU, group: "智谱" },
];

/**
 * 默认模型 id。收口在此（而不是各面板各写一份字面量）：
 * 模型知识归 ModelSelector 所有，聊天面板与并行面板都从这里取同一个默认值。
 */
export const DEFAULT_MODEL_ID = "glm-4-flash";

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
 * 调用方据此回退到自己的默认值（通常是 DEFAULT_MODEL_ID）。
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

/** 内置 provider 的展示名兜底 */
const BUILTIN_LABELS: Record<string, string> = { [PROVIDER_ZHIPU]: "智谱" };

function _notify(): void {
  for (const fn of _subs) fn();
}

/** 拉取最新 provider/模型（失败静默，回退到内置 MODELS） */
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
  };
}

/** provider 分组（含未配置 provider）；内置在前、自定义在后。供两级菜单。 */
export interface ProviderGroup { name: string; label: string; builtin: boolean; configured: boolean; models: ModelOption[] }

export function getProviderGroups(): ProviderGroup[] {
  // 兜底：后端不可用时，从内置 MODELS 按 provider 分组
  if (_providers.length === 0) {
    const map = new Map<string, ModelOption[]>();
    for (const m of MODELS) {
      if (!map.has(m.provider)) map.set(m.provider, []);
      map.get(m.provider)!.push(m);
    }
    return [...map.entries()].map(([name, models]) => ({ name, label: BUILTIN_LABELS[name] || name, builtin: true, configured: true, models }));
  }
  // 显示所有 provider（含未配置），未配置的模型的 disabledModels 由 UI 层处理
  const groups = _providers
    .map((p) => ({
      name: p.name,
      label: p.label || BUILTIN_LABELS[p.name] || p.name,
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
    _subs.add(rerender);
    if (!_loaded) void refreshModels();
    return () => { _subs.delete(rerender); };
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
  /**
   * 深度思考开关的当前值。传入才渲染这一行；不传（如并行面板）则整块不出现。
   *
   * 放在模型选择器里而不是工具栏上：它是模型参数，不是会话参数，
   * 且默认开启——常态无需占据工具栏宽度，只在关闭时于触发器上留一个标记。
   */
  think?: boolean;
  onThinkChange?: (next: boolean) => void;
}

/** 把上下文窗口格式化为紧凑标记（1M / 256K）；无窗口信息返回空串 */
function formatContextWindow(contextWindow: number): string {
  if (contextWindow <= 0) return "";
  if (contextWindow >= 1_000_000) return `${(contextWindow / 1_000_000).toFixed(0)}M`;
  return `${(contextWindow / 1000).toFixed(0)}K`;
}

/**
 * 单个模型行（菜单项）——单行紧凑布局。
 *
 * 一行放下：选中指示条 + 模型名 + 多模态图标 + 上下文窗口。
 * 描述不再单独占一行，移到原生 title：中转站类 provider 的模型普遍没有描述，
 * 为它留一行等于给每个模型白付一行高度（截图里 7 个模型就撑满了整个弹层）。
 * 多模态也从"多模态"文字徽标换成图标，省下的横向空间留给模型名——
 * 名字才是选择依据，徽标只是限定词。
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
      className={`relative flex items-center w-full gap-1.5 py-1 pl-2.5 pr-2 rounded text-xs text-left transition-colors ${selected ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted/60"} disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      {/* 选中指示：左侧竖条。比右侧 Check 省一格横向空间，且在长列表里更容易扫到 */}
      {selected && <span className="absolute left-0 top-1/2 -translate-y-1/2 h-3.5 w-[2px] rounded-full bg-primary" />}
      <span className={`truncate min-w-0 flex-1 ${selected ? "font-semibold" : "font-medium"}`}>{model.name}</span>
      {model.vision && <ImageIcon className={`w-3 h-3 shrink-0 ${selected ? "opacity-70" : "opacity-40"}`} />}
      {win && <span className={`shrink-0 text-[10px] tabular-nums ${selected ? "text-primary/70" : "text-muted-foreground/60"}`}>{win}</span>}
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

export function ModelSelector({ value, provider, onChange, disabledModels = [], disabled = false, disabledTooltip, think, onThinkChange }: ModelSelectorProps) {
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

  // 思考开关默认开启，所以只在**关掉**时才在触发器上留个记号。
  // 与同一工具栏里 replyStyle 的做法一致：默认态什么都不显示，只有偏离默认才占位置。
  // 否则一个常亮的图标会白占宽度，还得让用户去分辨"亮着是开还是关"。
  const showThinkOff = think === false;
  // 开关开着、但当前模型本身不支持思考 → 开关此刻不起作用，得如实告诉用户。
  // thinking 由后端下发（已含声明与启发式判定），前端不重复判断模型名。
  const thinkInert = think !== false && current?.thinking === false;

  const trigger = (
    <button
      type="button"
      className={`inline-flex items-center h-7 gap-1 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors ${disabled ? "opacity-30 cursor-not-allowed" : ""}`}
      onClick={() => { if (!disabled) setOpen(!open); }}
      title={showThinkOff ? "深度思考已关闭" : undefined}
    >
      {current?.name || value}
      {/* 用 lucide 自带的 off 图标表达关闭态。不要给普通图标加 line-through——
          那是文本装饰，对 SVG 不生效，只会得到一个和开启态看起来一样的图标。 */}
      {showThinkOff && <LightbulbOff className="w-3 h-3 shrink-0 opacity-50" />}
      <ChevronDown className="w-3 h-3 opacity-60" />
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
        className="w-[250px] max-h-[70vh] overflow-y-auto p-1 gap-0 ring-1 ring-border shadow-lg [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent [&::-webkit-scrollbar-track]:bg-transparent hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/25 [scrollbar-width:thin] [scrollbar-color:transparent_transparent] hover:[scrollbar-color:rgba(128,128,128,0.25)_transparent]"
      >
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
              <div
                role="button"
                tabIndex={0}
                onClick={() => setExpanded(expanded === g.name ? null : g.name)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpanded(expanded === g.name ? null : g.name); } }}
                className={`flex items-center gap-1 py-1 pl-1 pr-1.5 rounded text-[11px] cursor-pointer select-none transition-colors ${isExpanded ? "text-foreground bg-muted/40" : "text-muted-foreground hover:text-foreground hover:bg-muted/25"}`}
              >
                {/* 披露箭头放左侧：它标示的是"这一项可展开"的层级关系，贴着标题才读得出来。
                    放在最右端时它离标题最远，反而像一个独立的前进按钮。右侧腾出来放模型数量。 */}
                <ChevronRight className={`w-3 h-3 shrink-0 opacity-50 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                <span className="font-semibold truncate flex-1 min-w-0">{g.label}</span>
                {!g.configured
                  ? <span className="text-[9px] px-1 py-px rounded bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 shrink-0">未配置</span>
                  : <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/50">{g.models.length}</span>}
              </div>
              {isExpanded && (
                <div
                  ref={(el) => { scrollRefs.current[g.name] = el; }}
                  className="pl-1.5 border-l border-border/40 ml-2.5 mb-1 max-h-[232px] overflow-y-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-transparent [&::-webkit-scrollbar-track]:bg-transparent hover:[&::-webkit-scrollbar-thumb]:bg-muted-foreground/25 [scrollbar-width:thin] [scrollbar-color:transparent_transparent] hover:[scrollbar-color:rgba(128,128,128,0.25)_transparent]"
                >
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

        {/* 模型级开关：深度思考。
            放在这里而不是工具栏，是因为它是模型参数而非会话设置——和"用哪个模型"是同一类决定。
            工具栏已经很满，而本开关默认开启、常态不需要露面。
            点它不关闭弹层：调完还能顺手换模型。 */}
        {onThinkChange && (
          <>
            <div className="border-t border-border/50 my-1" />
            <button
              onClick={() => onThinkChange(think === false)}
              title="关闭后不再向模型请求思考（省 token、更快），也不展示思考过程。模型本身不支持思考时本开关无效果。"
              className="flex items-center gap-1.5 w-full py-1 pl-1.5 pr-1.5 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
            >
              {think === false
                ? <LightbulbOff className="w-3 h-3 shrink-0 opacity-60" />
                : <Lightbulb className={`w-3 h-3 shrink-0 ${thinkInert ? "opacity-40" : "text-primary"}`} />}
              <span className="flex-1 text-left">深度思考</span>
              {/* 当前模型不支持时明说。否则用户开着开关却看不到任何思考过程，
                  只能怀疑是功能坏了——而真实原因是这个模型压根没这个能力。 */}
              {thinkInert && <span className="shrink-0 text-[9px] text-muted-foreground/50">此模型不支持</span>}
              {/* 极简开关轨道：布尔状态用轨道表达比"开/关"两个字更快读懂，也不占宽。
                  模型不支持时压暗成中性色——开关是"开"没错，但此刻不产生任何效果，
                  画成全亮的 primary 等于承诺了一个兑现不了的状态。 */}
              <span className={`shrink-0 w-6 h-3 rounded-full transition-colors relative ${think === false ? "bg-muted-foreground/25" : thinkInert ? "bg-muted-foreground/40" : "bg-primary"}`}>
                <span className={`absolute top-0.5 w-2 h-2 rounded-full bg-background transition-all ${think === false ? "left-0.5" : "left-3.5"}`} />
              </span>
            </button>
          </>
        )}

        {/* 底部操作栏 */}
        <div className="border-t border-border/50 my-1" />
        <button
          onClick={openProviderPanel}
          className="flex items-center gap-1.5 w-full py-1 pl-1.5 pr-2 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
        >
          <Settings className="w-3 h-3 shrink-0 opacity-60" />
          配置自定义 Provider
        </button>
      </PopoverContent>
    </Popover>
  );
}
