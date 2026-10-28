/**
 * 每轮回复底部的用量展示：花费估算 / Token 数 / 官方 Credits 三选一。
 *
 * - 官方 provider（axon）：沿用 Credits，那是官方的计费单位。
 * - 自定义 provider 配了单价（provider.pricing）：按端点实报的 token 数估算花费。
 * - 都没有：只显示本轮消耗的 Token 数。Credits 的档位系数是给官方定价用的，
 *   套在中转站上得到的数字和真实账单没有关系，不如直接给 token 数。
 *
 * 本轮 token 数取端点实报值的累加（每次请求的 prompt + completion）：一轮里每次工具调用都会把
 * 上下文重发一遍，这正是端点按量计费的口径。端点没报 usage 时退回本地估算。
 */

import { AXON_PROVIDER, type ModelPrice, type ProviderPricing } from "./providerTypes.js";

export interface TurnUsage {
  /** 本轮所有请求的输入 token 合计（含命中缓存的部分） */
  input: number;
  /** 其中命中缓存的输入 token */
  cached: number;
  /** 本轮所有请求的输出 token 合计 */
  output: number;
  /** true 表示端点没报 usage，数字是本地估算 */
  estimated?: boolean;
}

export interface TurnCost {
  amount: number;
  currency: string;
}

export type BillingMode = "credits" | "cost" | "tokens";

export interface TurnBilling {
  billing: BillingMode;
  usage: TurnUsage;
  cost?: TurnCost;
}

const hasNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** 取某模型的单价：先按模型 id，再用默认档；输入、输出都没填视为未配置 */
export function priceFor(pricing: ProviderPricing | undefined, model: string): ModelPrice | undefined {
  if (!pricing) return undefined;
  const price = pricing.models?.[model] ?? pricing.default;
  if (!price || (!hasNumber(price.input) && !hasNumber(price.output))) return undefined;
  return price;
}

/** 单价按每 100 万 token；命中缓存的输入没单独定价时按输入价计 */
export function computeTurnCost(price: ModelPrice, usage: TurnUsage, currency = "¥"): TurnCost {
  const input = hasNumber(price.input) ? price.input : 0;
  const output = hasNumber(price.output) ? price.output : 0;
  const cacheRead = hasNumber(price.cacheRead) ? price.cacheRead : input;
  const cached = Math.min(usage.cached, usage.input);
  const amount = ((usage.input - cached) * input + cached * cacheRead + usage.output * output) / 1_000_000;
  return { amount, currency };
}

export function resolveTurnBilling(providerName: string | undefined, pricing: ProviderPricing | undefined, model: string, usage: TurnUsage): TurnBilling {
  if (providerName === AXON_PROVIDER) return { billing: "credits", usage };
  const price = priceFor(pricing, model);
  if (price) return { billing: "cost", usage, cost: computeTurnCost(price, usage, pricing?.currency?.trim() || "¥") };
  return { billing: "tokens", usage };
}

/** 1234 → "1.2K"，3_400_000 → "3.4M" */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1).replace(/\.?0+$/, "")}M`;
}

/** 花费保留到有意义的位数：小于 0.01 时多给几位，避免一律显示 0.00 */
export function formatCost(cost: TurnCost): string {
  const digits = cost.amount > 0 && cost.amount < 0.01 ? 4 : 2;
  return `${cost.currency}${cost.amount.toFixed(digits)}`;
}

/** 给模型 / 提示用的一句话：花费优先，否则 token 数 */
export function describeTurnUsage(b: TurnBilling, credits: number): string {
  if (b.billing === "cost" && b.cost) return `约 ${formatCost(b.cost)}`;
  if (b.billing === "credits") return `${credits.toFixed(2)} credits`;
  return `${formatTokenCount(b.usage.input + b.usage.output)} tokens`;
}

/** 校验并清理计费单价：只保留非负数字；什么都没填返回 undefined（即删除配置） */
export function normalizePricing(raw: unknown): ProviderPricing | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = raw as { currency?: unknown; default?: unknown; models?: unknown };
  const cleanPrice = (value: unknown): ModelPrice | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const out: ModelPrice = {};
    for (const key of ["input", "output", "cacheRead"] as const) {
      const n = (value as Record<string, unknown>)[key];
      if (n === undefined || n === null || n === "") continue;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error(`单价必须是非负数字：${key}`);
      out[key] = n;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const models: Record<string, ModelPrice> = {};
  if (input.models && typeof input.models === "object") {
    for (const [id, value] of Object.entries(input.models as Record<string, unknown>)) {
      const price = cleanPrice(value);
      if (price) models[id] = price;
    }
  }
  const fallback = cleanPrice(input.default);
  if (!fallback && Object.keys(models).length === 0) return undefined;
  const currency = typeof input.currency === "string" ? input.currency.trim().slice(0, 8) : "";
  return { ...(currency ? { currency } : {}), ...(fallback ? { default: fallback } : {}), ...(Object.keys(models).length ? { models } : {}) };
}
