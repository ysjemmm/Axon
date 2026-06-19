/**
 * 模型选择器组件 - 两级菜单：一级 provider，hover 展开二级模型列表
 *
 * 数据驱动：从 /api/providers 拉取内置 + 自定义 provider 及其模型（实时刷新）。
 * 内置 MODELS 仅作离线兜底与 autoSelectModel 依据。打开下拉时会重新拉取，配置改动即时反映。
 */

import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
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
  /** Auto 选择档位 */
  tier?: "fast" | "balanced" | "flagship";
}

/**
 * Provider 键名常量（必须与后端 @axon/core 的 ESIGN_PROVIDER 保持一致）。
 * web 是独立工程、引用不到 @axon/core，故在此本地镜像一份，集中收口，
 * 避免 provider 字面量散落到每个模型条目里、改名时漏改。
 */
const PROVIDER_ESIGN = "esign";
const PROVIDER_ZHIPU = "zhipu";

export const MODELS: ModelOption[] = [
  // ── 系统 ──
  { id: "auto", name: "Auto", contextWindow: 0, description: "根据任务和当前可用模型自动选择", free: false, vision: true, provider: PROVIDER_ESIGN, group: "系统" },
  // ── OpenAI ──
  { id: "gpt-5.5", name: "GPT-5.5", contextWindow: 1000000, description: "最新旗舰模型", free: false, vision: true, provider: PROVIDER_ESIGN, group: "OpenAI", tier: "flagship" },
  { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 1000000, description: "高性能模型", free: false, vision: true, provider: PROVIDER_ESIGN, group: "OpenAI", tier: "flagship" },
  // ── DeepSeek ──
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1000000, description: "1.6T MoE，1M 上下文，开源旗舰", free: false, vision: false, provider: PROVIDER_ESIGN, group: "DeepSeek", tier: "balanced" },
  // ── Anthropic ──
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", contextWindow: 1000000, description: "Anthropic 旗舰，超强推理", free: false, vision: true, provider: PROVIDER_ESIGN, group: "Anthropic", tier: "flagship" },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", contextWindow: 1000000, description: "最新 Opus，代码/分析顶级", free: false, vision: true, provider: PROVIDER_ESIGN, group: "Anthropic", tier: "flagship" },
  // ── 智谱 ──
  { id: "glm-5.1", name: "GLM-5.1", contextWindow: 200000, description: "智谱最新旗舰模型", free: false, vision: false, provider: PROVIDER_ESIGN, group: "智谱", tier: "balanced" },
  { id: "glm-4-flash", name: "GLM-4 Flash", contextWindow: 128000, description: "免费，快速响应", free: true, vision: false, provider: PROVIDER_ZHIPU, group: "智谱", tier: "fast" },
  { id: "glm-4-flashx", name: "GLM-4 FlashX", contextWindow: 128000, description: "免费，极速推理", free: true, vision: false, provider: PROVIDER_ZHIPU, group: "智谱", tier: "fast" },
];

// ── provider / 模型动态加载（从 /api/providers 拉取内置 + 自定义）──────────

/** 后端解析出的 provider（脱敏，含其模型与配置状态） */
let _providers: ResolvedProviderInfo[] = [];
let _loaded = false;
let _loading = false;
const _subs = new Set<() => void>();

/** Auto 系统伪模型（始终置于菜单顶部） */
const AUTO_MODEL = MODELS.find((m) => m.id === "auto")!;
/** 内置 provider 的展示名兜底 */
const BUILTIN_LABELS: Record<string, string> = { [PROVIDER_ESIGN]: "eSign", [PROVIDER_ZHIPU]: "智谱" };

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
    tier: m.tier,
  };
}

/** provider 分组（已配置且含未禁用模型）；内置在前、自定义在后。供两级菜单。 */
export interface ProviderGroup { name: string; label: string; builtin: boolean; models: ModelOption[] }

export function getProviderGroups(): ProviderGroup[] {
  // 兜底：后端不可用时，从内置 MODELS（去掉 auto）按 provider 分组
  if (_providers.length === 0) {
    const map = new Map<string, ModelOption[]>();
    for (const m of MODELS) {
      if (m.id === "auto") continue;
      if (!map.has(m.provider)) map.set(m.provider, []);
      map.get(m.provider)!.push(m);
    }
    return [...map.entries()].map(([name, models]) => ({ name, label: BUILTIN_LABELS[name] || name, builtin: true, models }));
  }
  const groups = _providers
    .filter((p) => p.configured)
    .map((p) => ({
      name: p.name,
      label: p.label || BUILTIN_LABELS[p.name] || p.name,
      builtin: p.builtin,
      models: p.models.filter((m) => !m.disabled).map((m) => _toOption(p.name, p.label || p.name, m)),
    }))
    .filter((g) => g.models.length > 0);
  // 内置在前、自定义在后
  return [...groups.filter((g) => g.builtin), ...groups.filter((g) => !g.builtin)];
}

/** 全部可选模型（auto + 各 provider 未禁用模型） */
export function getModels(): ModelOption[] {
  return [AUTO_MODEL, ...getProviderGroups().flatMap((g) => g.models)];
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

/**
 * Auto：在【当前可用模型】（已配置 provider + 未禁用，取自 getModels()）里按任务档位挑选，
 * 不写死模型 id；目标档位没有可用模型时优雅降级到相邻档位，绝不返回跑不起来的模型。
 */
export function autoSelectModel(input: string, hasImages: boolean): ModelOption {
  const available = getModels().filter((m) => m.id !== "auto");
  // 极端：一个 provider 都没配 → 退回内置 gpt-5.5（运行时会提示"未配置"，这是真实的未配置状态）
  if (available.length === 0) return MODELS.find((m) => m.id === "gpt-5.5")!;

  const tierOf = (m: ModelOption): "fast" | "balanced" | "flagship" => m.tier || "balanced";
  /** 在 pool 里按档位偏好顺序取第一个命中的；都没有则取 pool 第一个，pool 空再退回任意可用 */
  const pick = (prefs: Array<"fast" | "balanced" | "flagship">, pool: ModelOption[]): ModelOption => {
    for (const t of prefs) { const hit = pool.find((m) => tierOf(m) === t); if (hit) return hit; }
    return pool[0] || available[0];
  };

  // 看图：必须用 vision 模型，优先旗舰；没有 vision 模型则尽力选一个（UI 会拦截无 vision 时附图）
  if (hasImages) {
    const visionPool = available.filter((m) => m.vision);
    if (visionPool.length > 0) return pick(["flagship", "balanced", "fast"], visionPool);
    return pick(["flagship", "balanced", "fast"], available);
  }

  // 复杂任务（含代码块 / 改代码意图 / 较长）→ 旗舰档优先
  const mutationKeywords = [
    "重构", "实现", "修复", "debug", "调试", "优化", "创建文件", "新建", "添加",
    "改写", "替换", "删除", "写一个", "帮我写", "帮我改", "帮我加", "设计", "架构",
  ];
  const isComplex = input.includes("```") || input.length > 80 || mutationKeywords.some((k) => input.includes(k));
  if (isComplex) return pick(["flagship", "balanced", "fast"], available);

  // 探索/定位/导航 → 均衡档（决策果断、省 token）
  const explorationKeywords = [
    "找", "搜索", "查找", "定位", "在哪", "叫什么", "还是啥", "是哪个",
    "看看", "看下", "有没有", "有哪些", "了解", "介绍", "梳理", "结构",
    "接口", "方法", "函数", "类", "文件", "工作区", "项目", "目录", "模块",
  ];
  if (explorationKeywords.some((k) => input.includes(k))) return pick(["balanced", "flagship", "fast"], available);

  // 简单短问答/概念题 → 便宜快档
  return pick(["fast", "balanced", "flagship"], available);
}

interface ModelSelectorProps {
  value: string;
  onChange: (modelId: string) => void;
  disabledModels?: string[];
  /** 整个选择器禁用（如压缩期间） */
  disabled?: boolean;
  disabledTooltip?: string;
}

/** 单个模型行（菜单项） */
function ModelRow({ model, selected, disabled, onPick }: { model: ModelOption; selected: boolean; disabled: boolean; onPick: () => void }) {
  const win = model.contextWindow >= 1000000 ? `${(model.contextWindow / 1000000).toFixed(0)}M` : `${(model.contextWindow / 1000).toFixed(0)}K`;
  const sub = model.contextWindow > 0 ? `${model.description} · ${win}` : model.description;
  return (
    <button
      disabled={disabled}
      onClick={onPick}
      className={`flex items-center justify-between w-full gap-3 py-1.5 pl-2 pr-3 rounded-md text-xs text-left transition-colors ${selected ? "bg-muted/60" : "hover:bg-muted/50"} disabled:opacity-40 disabled:cursor-not-allowed`}
    >
      <div className="flex flex-col gap-0 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`text-xs ${selected ? "font-semibold" : "font-medium"}`}>{model.name}</span>
          {model.vision && (
            <span className="text-[9px] px-1 py-px rounded bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 leading-none">多模态</span>
          )}
        </div>
        {sub && (
          <span className="text-[10px] text-muted-foreground/70 leading-tight truncate">{sub}</span>
        )}
      </div>
      {selected && <Check className="w-3 h-3 text-muted-foreground shrink-0" />}
    </button>
  );
}

export function ModelSelector({ value, onChange, disabledModels = [], disabled = false, disabledTooltip }: ModelSelectorProps) {
  const groups = useProviderGroups();
  const current = findModel(value);
  const [open, setOpen] = useState(false);
  // 当前展开（hover）的 provider；打开时默认展开当前所选模型所属 provider
  const [expanded, setExpanded] = useState<string | null>(null);

  const onOpenChange = (next: boolean) => {
    if (disabled) return;
    setOpen(next);
    if (next) {
      void refreshModels(); // 打开即拉最新，配置改动即时反映
      setExpanded(current?.provider ?? null);
    }
  };

  const pick = (id: string) => { onChange(id); setOpen(false); };
  const autoDisabled = disabledModels.includes(AUTO_MODEL.id);

  const trigger = (
    <button
      className={`inline-flex items-center h-7 gap-1 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors ${disabled ? "opacity-30 cursor-not-allowed" : ""}`}
      onClick={() => { if (!disabled) setOpen(!open); }}
    >
      {current?.name || value}
      <ChevronDown className="w-3 h-3 opacity-60" />
    </button>
  );

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {disabled && disabledTooltip ? (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">{trigger}</span>
              </TooltipTrigger>
              <TooltipContent side="top" align="start">
                <p className="text-xs">{disabledTooltip}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          trigger
        )}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="w-auto min-w-[220px] max-w-[380px] max-h-[70vh] overflow-y-auto p-1 gap-0 ring-1 ring-border shadow-lg"
      >
        {/* Auto（系统） */}
        <ModelRow model={AUTO_MODEL} selected={value === AUTO_MODEL.id} disabled={autoDisabled} onPick={() => pick(AUTO_MODEL.id)} />
        {groups.length > 0 && <div className="border-t border-border/50 my-1" />}

        {/* provider 一级 + hover 内联展开二级模型 */}
        {groups.map((g) => {
          const isExpanded = expanded === g.name;
          return (
            <div key={g.name} onMouseEnter={() => setExpanded(g.name)}>
              <div className={`flex items-center justify-between gap-2 py-1.5 pl-2 pr-2 rounded-md text-xs cursor-default ${isExpanded ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                <span className="font-medium truncate">{g.label}</span>
                <ChevronRight className={`w-3 h-3 opacity-60 shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
              </div>
              {isExpanded && (
                <div className="pl-2 border-l border-border/40 ml-2 mb-1">
                  {g.models.map((m) => (
                    <ModelRow key={m.id} model={m} selected={m.id === value} disabled={disabledModels.includes(m.id)} onPick={() => pick(m.id)} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
