/**
 * Eval 框架核心类型定义
 */

/** LLM-as-judge 评分规格（用于无法用规则判定的回复质量维度） */
export interface JudgeSpec {
  /** 评判维度描述（给 judge 模型的 rubric） */
  rubric: string;
  /** 该维度在总分中的权重（0-1），默认 0 表示仅作参考不计入 */
  weight?: number;
}

/** 一个评估场景（测试用例） */
export interface EvalScenario {
  /** 唯一标识 */
  id: string;
  /** 场景描述（给人看） */
  description: string;
  /** 目标工具名（预期模型应该调用的工具） */
  targetTool: string;
  /** 用户消息 */
  userMessage: string;
  /** 预期判定条件 */
  expected: {
    /** 期望被调用的工具（支持多个，任一命中即算对） */
    toolCalled?: string[];
    /** 不应被调用的工具 */
    notCalled?: string[];
    /** 关键参数匹配（key: glob 或精确值） */
    argsMatch?: Record<string, string>;
    /** 期望的最终回复包含关键词（用于无工具场景的纯文字判定） */
    replyContains?: string[];
  };
  /** 工作区 fixture 目录名（相对于 fixtures/），缺省用空工作区 */
  fixture?: string;
  /** 预置的文件内容（mock 文件系统用） */
  files?: Record<string, string>;
  /** 可选：LLM-as-judge 质量评分（用于回复质量等主观维度） */
  judge?: JudgeSpec;
}

/** 评估变体（A/B 对比的一侧）：可覆盖模型 / 系统提示 / 工具描述 */
export interface Variant {
  /** 变体标识，如 "A" / "baseline" / "experiment" */
  id: string;
  /** 展示名 */
  label: string;
  /** 覆盖模型（缺省用全局 EVAL_MODEL） */
  model?: string;
  /** 覆盖系统提示（缺省用默认 eval 系统提示） */
  systemPrompt?: string;
  /** 覆盖指定工具的 description（toolName -> 新描述）；用于测试工具定义微调的效果 */
  toolDescriptions?: Record<string, string>;
}

/** 各维度得分（0-1） */
export interface DimensionScores {
  /** 正确选择了目标工具 */
  toolSelection: number;
  /** 关键参数正确 */
  argsCorrectness: number;
  /** 没有调用不该调的工具 */
  noForbidden: number;
  /** 效率（步骤数惩罚） */
  efficiency: number;
  /** LLM judge 质量分（无 judge 时为 null） */
  judge: number | null;
}

/** 单次运行的评估结果 */
export interface EvalResult {
  scenarioId: string;
  toolCalls: { name: string; args: Record<string, unknown> }[];
  reply: string;
  scores: DimensionScores;
  overall: number;
  passed: boolean;
  latency: number;
  tokens: number;
}

/** 同一场景多次运行的聚合结果（降方差） */
export interface AggregatedResult {
  scenarioId: string;
  runs: number;
  /** 通过率（passed 次数 / runs） */
  passRate: number;
  /** 平均总分 */
  meanScore: number;
  /** 总分标准差（稳定性指标，越小越稳） */
  stdDev: number;
  /** 各维度平均分 */
  meanScores: DimensionScores;
  avgLatency: number;
  totalTokens: number;
  /** 各次运行的工具调用（用于人工排查） */
  sampleToolCalls: string[][];
}

/** 一个变体在全部场景上的汇总 */
export interface VariantReport {
  variant: Variant;
  resolvedModel: string;
  results: AggregatedResult[];
  summary: {
    total: number;
    meanScore: number;
    passRate: number;
    avgLatency: number;
    totalTokens: number;
  };
}

/** A/B 对比报告 */
export interface ABReport {
  timestamp: string;
  runsPerScenario: number;
  variants: VariantReport[];
  /** 逐场景对比（仅 A/B 两变体时） */
  comparison?: {
    scenarioId: string;
    scores: Record<string, number>; // variantId -> meanScore
    delta: number;                  // B - A
    winner: string;                 // 变体 id 或 "tie"
  }[];
  /** 总体胜者 */
  overallWinner?: string;
}
