/**
 * Credits 计费系统 —— 请求级（per agent turn）四段加权计费
 *
 * 计费哲学（对齐 Kiro 的体验）：每个用户 turn 收一笔小额 credits，数字小且可预期；
 * 同时体现真实成本结构——把一轮 prompt 拆成四段，按"复用程度"差异化加权：
 *   · 记忆（对话历史）：每轮重发但绝大部分命中提示缓存，边际成本极低 → 重折扣
 *   · system（系统提示/工具/skill/power/IDE 上下文）：稳定、可缓存 → 轻折扣
 *   · 本次输入（用户新消息 + 子 Agent）：真正新增、全价
 *   · 输出：最贵
 * 这样大记忆会话只小幅加价（如 100k vs 10k ≈ 2:1），而不是线性 10:1。
 *
 * 系数是【商业定价默认值】，按档位（低成本/中端/高端/旗舰）分级，可按需调。
 */

/** 模型档位 */
export type ModelTier = "低成本" | "中端" | "高端" | "旗舰";

/** 每个模型的档位（用于选系数；附带原始 token 单价，仅作参考/展示） */
export interface ModelCreditRate {
  inputPer1K: number;
  outputPer1K: number;
  tier: ModelTier;
}

/** 模型 → 档位表（前缀/包含模糊匹配；未命中按"中端"兜底） */
export const CREDIT_RATES: Record<string, ModelCreditRate> = {
  "deepseek-v4-flash": { inputPer1K: 0.014, outputPer1K: 0.028, tier: "低成本" },
  "deepseek-v4-pro": { inputPer1K: 0.0435, outputPer1K: 0.087, tier: "中端" },
  "qwen3-coder-plus": { inputPer1K: 0.065, outputPer1K: 0.325, tier: "中端" },
  "qwen3.6-plus": { inputPer1K: 0.065, outputPer1K: 0.325, tier: "中端" },
  "glm-4-flash": { inputPer1K: 0, outputPer1K: 0, tier: "低成本" },
  "glm-4-flashx": { inputPer1K: 0, outputPer1K: 0, tier: "低成本" },
  "glm-5.1": { inputPer1K: 0.14, outputPer1K: 0.44, tier: "中端" },
  "MiniMax-M2.7": { inputPer1K: 0.06, outputPer1K: 0.24, tier: "中端" },
  "gpt-5.4": { inputPer1K: 0.25, outputPer1K: 1.5, tier: "高端" },
  "gpt-5.5": { inputPer1K: 0.5, outputPer1K: 3.0, tier: "旗舰" },
};

/** 一个 turn 的 token 分段（来自 agentSession.buildTokenBreakdown + 输出） */
export interface TurnTokenBreakdown {
  /** 记忆（对话历史） */
  memoryTokens: number;
  /** system（框架开销：系统提示/工具/skill/power/IDE 上下文） */
  systemTokens: number;
  /** 本次输入（本轮新增的用户消息 + 工具结果 + 中间 assistant 回填 + 本轮子 Agent） */
  questionTokens: number;
  /** 输出 */
  outputTokens: number;
}

/** 每档计费系数（credits）：每次请求基础 + 四段每 1K token 的单价 */
interface TierCoef {
  /** 每次请求基础（保证 floor，复用极高时也至少收这点） */
  base: number;
  /** 记忆：重折扣（命中缓存，边际极低） */
  memoryPer1K: number;
  /** system：轻折扣（稳定/可缓存） */
  systemPer1K: number;
  /** 本次输入：全价 */
  inputPer1K: number;
  /** 输出：最贵 */
  outputPer1K: number;
}

/**
 * 各档默认系数（可调）。标定目标（旗舰）：
 *   - 典型短问答（记忆~70k + system~12k + 输入~0 + 输出~小）≈ 0.3 + 0.35 + 0.12 ≈ 0.77 credits
 *   - 大记忆 100k vs 10k 做同一件事 ≈ 0.9 vs 0.45（约 2:1，而非 10:1）
 */
const TIER_COEF: Record<ModelTier, TierCoef> = {
  "低成本": { base: 0.2, memoryPer1K: 0.02, systemPer1K: 0.04, inputPer1K: 0.1, outputPer1K: 0.4 },
  "中端": { base: 0.5, memoryPer1K: 0.048, systemPer1K: 0.09, inputPer1K: 0.25, outputPer1K: 1.0 },
  "高端": { base: 1.0, memoryPer1K: 0.08, systemPer1K: 0.15, inputPer1K: 0.5, outputPer1K: 2.5 },
  "旗舰": { base: 2.0, memoryPer1K: 0.12, systemPer1K: 0.25, inputPer1K: 1.0, outputPer1K: 5.0 },
};

/** 最低消耗（防 0 credits 的极端短请求） */
export const MIN_CREDITS_PER_TURN = 0.5;

/** 模型名模糊匹配档位（带版本/后缀也能命中），未知模型回退中端 */
export function findRate(model: string): ModelCreditRate {
  const normalized = (model || "").toLowerCase().replace(/\s+/g, "-");
  if (CREDIT_RATES[normalized]) return CREDIT_RATES[normalized];
  for (const [key, rate] of Object.entries(CREDIT_RATES)) {
    if (normalized.startsWith(key.toLowerCase()) || normalized.includes(key.toLowerCase())) return rate;
  }
  return { inputPer1K: 0.14, outputPer1K: 0.44, tier: "中端" };
}

/**
 * 计算一个 turn 的 credits（请求级 + 四段加权）。
 * @param model 模型名
 * @param b 本 turn 的 token 分段
 */
export function calculateCredits(model: string, b: TurnTokenBreakdown): number {
  const c = TIER_COEF[findRate(model).tier];
  const raw =
    c.base +
    (Math.max(0, b.memoryTokens) / 1000) * c.memoryPer1K +
    (Math.max(0, b.systemTokens) / 1000) * c.systemPer1K +
    (Math.max(0, b.questionTokens) / 1000) * c.inputPer1K +
    (Math.max(0, b.outputTokens) / 1000) * c.outputPer1K;
  return Math.max(MIN_CREDITS_PER_TURN, Math.round(raw * 100) / 100);
}

/** 格式化 credits（2 位小数） */
export function formatCredits(credits: number): string {
  return credits.toFixed(2);
}

/** Credits 明细（前端 hover 展示） */
export interface CreditDetail {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  inputRate: number;
  outputRate: number;
  tier: string;
  /** 记忆（对话历史）token */
  memoryTokens?: number;
  /** system token（框架开销） */
  systemTokens?: number;
  /** 本次问题 token（本次输入 + 子 Agent） */
  questionTokens?: number;
}

/** 构建 credits 明细对象（供前端 tooltip 展示） */
export function buildCreditDetail(model: string, b: TurnTokenBreakdown): CreditDetail {
  const rate = findRate(model);
  const c = TIER_COEF[rate.tier];
  return {
    inputTokens: b.memoryTokens + b.systemTokens + b.questionTokens,
    outputTokens: b.outputTokens,
    cachedInputTokens: 0,
    inputRate: c.inputPer1K,
    outputRate: c.outputPer1K,
    tier: rate.tier,
    memoryTokens: b.memoryTokens,
    systemTokens: b.systemTokens,
    questionTokens: b.questionTokens,
  };
}
