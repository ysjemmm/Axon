/**
 * useModelEffort —— 模型选择 + 思考强度联动的共享逻辑
 *
 * 为什么抽出来：这套逻辑（模型专属的强度偏好、Provider 配置热刷新后的合法性校验、
 * 默认值回落）原本只长在 ChatPanel 里，近百行。Cowork 面板也要同一组控件，
 * 照抄一份必然漂移 —— 两边对"配置被删了怎么回落"的判断稍有不同，就会表现为
 * 同一个模型在两个面板里强度不一样，而这种 bug 极难查。
 *
 * 状态存放在调用方（Chat 侧是 session，Cowork 侧是自己的 useState），
 * 本 hook 只负责"给定当前模型 → 算出可用档位、校验并纠正当前值"。
 * 这样 Chat 侧不用把 session 拆开传进来，Cowork 侧也不必为了复用去造一个假 session。
 *
 * 持久化走 localStorage（LAST_MODEL / LAST_PROVIDER / EFFORT_PREFERENCES），
 * 与会话无关，因此两个面板天然共享同一份选择 —— 用户在 Chat 选的模型，
 * 切到 Cowork 看到的是同一个，符合"同一个产品的不同工作面"的预期。
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { findModel, getModels, type ModelOption } from "@/components/ModelSelector";
import { STORAGE } from "@/lib/constants";

/** 读取某个 provider:model 的强度偏好。undefined = 从未设置过，null = 用户显式关闭 */
function readEffortPreference(key: string): string | null | undefined {
  if (!key) return undefined;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE.EFFORT_PREFERENCES) || "{}") as Record<string, string | null>;
    return Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] : undefined;
  } catch {
    return undefined;
  }
}

/** 写入某个 provider:model 的强度偏好 */
function writeEffortPreference(key: string, value: string | null): void {
  if (!key) return;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE.EFFORT_PREFERENCES) || "{}") as Record<string, string | null>;
    saved[key] = value;
    localStorage.setItem(STORAGE.EFFORT_PREFERENCES, JSON.stringify(saved));
  } catch { /* 忽略写入失败（隐私模式 / 配额满） */ }
}

/** 按 provider + id 精确定位模型；没有 provider 时退化为按 id 查找 */
export function resolveModel(modelId: string, provider?: string, pool?: ModelOption[]): ModelOption | undefined {
  const models = pool && pool.length > 0 ? pool : getModels();
  return provider
    ? models.find((m) => m.id === modelId && m.provider === provider)
    : (pool && pool.length > 0 ? models.find((m) => m.id === modelId) : findModel(modelId));
}

/**
 * 切换模型时该带出的强度值。
 * 优先该模型上次的用户偏好；声明支持思考且有档位时，未设默认值则选第一档。
 */
export function resolveEffortForModel(target: ModelOption | undefined): string | null {
  const levels = target?.effortLevels || [];
  const validDefault = levels.some((x) => x.value === target?.defaultEffort)
    ? target?.defaultEffort || null
    : (target?.thinking === true ? levels[0]?.value || null : null);
  const key = target ? `${target.provider}:${target.id}` : "";
  const preferred = readEffortPreference(key);
  // null 是合法值（用户显式关闭），必须与"没存过"区分开
  const validPreferred = preferred === null || levels.some((x) => x.value === preferred)
    ? preferred
    : undefined;
  return validPreferred !== undefined ? validPreferred : validDefault;
}

/**
 * 思考能力与强度档位是两件事：无档位时声明支持思考即开启，由后端补默认强度；
 * 有档位时由选择器状态决定，明确关闭必须保持关闭。
 */
export function shouldEnableThinking(model: ModelOption | undefined, effort: string | null): boolean {
  return effort !== null || (model?.thinking === true && !model.effortLevels?.length);
}

interface UseModelEffortOptions {
  /** 当前模型 id */
  model: string;
  /** 当前 provider（与 model 组成唯一键） */
  provider?: string;
  /** 当前强度值；null 表示关闭 */
  effort: string | null;
  /** 需要纠正强度时回调（配置变化、当前值失效等） */
  setEffort: (next: string | null) => void;
  /** 模型池。传入可复用调用方已订阅的列表，省一次 getModels() */
  models?: ModelOption[];
}

interface UseModelEffortResult {
  /** 当前模型解析结果 */
  selectedModel: ModelOption | undefined;
  /** 当前模型可用的强度档位；空数组表示不展示强度选择器 */
  levels: { label: string; value: string }[];
  /** 当前模型的默认强度（已校验合法性） */
  defaultEffort: string | null;
  /** 用户手动改强度：写入偏好并更新状态 */
  handleEffortChange: (next: string | null) => void;
}

export function useModelEffort({ model, provider, effort, setEffort, models }: UseModelEffortOptions): UseModelEffortResult {
  const selectedModel = resolveModel(model, provider, models);
  const levels = useMemo(() => selectedModel?.effortLevels || [], [selectedModel]);
  const defaultEffort = levels.some((x) => x.value === selectedModel?.defaultEffort)
    ? selectedModel?.defaultEffort || null
    : (selectedModel?.thinking === true ? levels[0]?.value || null : null);

  const preferenceKey = selectedModel ? `${selectedModel.provider}:${selectedModel.id}` : "";
  // 配置指纹：模型本身 + 档位列表 + 默认值。任一变化都要重新校验当前强度值。
  const configSignature = JSON.stringify({ model: preferenceKey, levels, defaultEffort, thinking: selectedModel?.thinking });
  const previousConfig = useRef<string | null>(null);

  const handleEffortChange = useCallback((next: string | null) => {
    writeEffortPreference(preferenceKey, next);
    setEffort(next);
  }, [preferenceKey, setEffort]);

  // Provider 配置可以在独立编辑器 Tab 中实时修改。模型仓库刷新后：
  // · 没有 level list → 清空并隐藏选择器
  // · 当前值被删 / 默认变化导致当前值失效 → 切到最新默认（无默认则关闭）
  // · 当前值仍合法 → 保留用户手动选择，不因无关配置刷新被覆盖
  useEffect(() => {
    const firstConfig = previousConfig.current === null;
    const configChanged = !firstConfig && previousConfig.current !== configSignature;
    previousConfig.current = configSignature;

    if (levels.length === 0) {
      if (effort !== null) setEffort(null);
      return;
    }
    // 首次拿到配置或配置变化：优先恢复用户保存值；没有保存值才应用模型默认值。
    if (firstConfig || configChanged) {
      const preferred = readEffortPreference(preferenceKey);
      const validPreferred = preferred === null || levels.some((x) => x.value === preferred)
        ? preferred
        : undefined;
      const next = validPreferred !== undefined ? validPreferred : defaultEffort;
      if (effort !== next) setEffort(next);
      return;
    }
    // 非空值若因异常状态变得非法，才回落到默认；用户主动关闭（null）不进这个分支。
    if (effort !== null && levels.some((x) => x.value === effort)) return;
    if (effort !== null) setEffort(defaultEffort);
  }, [configSignature, preferenceKey, levels, defaultEffort, effort, setEffort]);

  return { selectedModel, levels, defaultEffort, handleEffortChange };
}
