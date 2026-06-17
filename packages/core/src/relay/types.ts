/**
 * Relay - 长任务工作流引擎的数据模型
 *
 * 命名取意：Axon（轴突）靠郎飞结一站站「中继接力」把信号长程精确传导出去。
 * Relay 就是把一个大需求拆成「需求 → 设计 → 计划 → 执行」几段，每段产出可读文档、
 * 经人工确认门后再接力传向下一段，期间可派发多个子 Agent 并行接力。
 *
 * 与 Kiro spec / Superpowers 的对标关系：
 * - brainstorm 阶段 ≈ Superpowers 的 brainstorming（苏格拉底式澄清需求）
 * - design 阶段   ≈ 设计签字
 * - plan 阶段     ≈ writing-plans（拆成带文件路径/验证步骤的小任务）
 * - executing     ≈ subagent-driven-development / executing-plans（逐项执行 + 勾选推进）
 */

/** Relay 的生命周期阶段（状态机） */
export type RelayPhase =
  | "brainstorm" // 需求澄清，产出 requirements.md
  | "design"     // 方案设计，产出 design.md
  | "plan"       // 任务拆解，产出 plan.md + 结构化任务清单
  | "executing"  // 逐项执行任务
  | "done";      // 全部完成

/** 阶段顺序（用于推进计算，done 是终态不在可推进序列里） */
export const PHASE_ORDER: RelayPhase[] = ["brainstorm", "design", "plan", "executing", "done"];

/** 每个产出文档阶段对应的文件名 */
export const PHASE_DOC_FILE: Partial<Record<RelayPhase, string>> = {
  brainstorm: "requirements.md",
  design: "design.md",
  plan: "plan.md",
};

/** 单阶段评审的结论 */
export interface ReviewVerdict {
  /** 是否通过 */
  passed: boolean;
  /** 发现的问题（按严重度），通过时可为空 */
  issues: { severity: "critical" | "major" | "minor"; description: string }[];
  /** 评审小结 */
  summary: string;
}

/** 一个任务的两阶段评审结果 */
export interface TaskReview {
  /** 第一阶段：规格符合性（是否满足任务卡与需求/设计） */
  spec?: ReviewVerdict;
  /** 第二阶段：代码质量（坏味道、重复、边界、是否破坏现有逻辑） */
  quality?: ReviewVerdict;
  /** 综合结论：两阶段都通过且无 critical 才算 passed */
  passed: boolean;
  /** 评审完成时间 */
  reviewedAt: string;
}

/** 任务的评审流转状态（用于前端展示与执行流转） */
export type TaskReviewStatus =
  | "none"             // 未评审
  | "reviewing"        // 评审中
  | "passed"           // 评审通过
  | "changes_requested"; // 被打回，需修复

/** 单个执行任务（plan 阶段拆出，executing 阶段逐项推进） */
export interface RelayTask {
  /** 层级编号，如 "1"、"1.2"（与 plan.md 复选框前缀一致） */
  id: string;
  /** 任务标题（一句话说明做什么） */
  title: string;
  /** 可选：实现要点，如涉及的文件路径、验证步骤、对应需求条目 */
  details?: string;
  /** 任务状态 */
  status: "pending" | "in_progress" | "completed";
  /** 可选：依赖的任务 id 列表。无依赖的任务之间可并行，有依赖须等前置完成 */
  deps?: string[];
  /** 评审流转状态（默认 none） */
  reviewStatus?: TaskReviewStatus;
  /** 两阶段评审结果（评审后写入） */
  review?: TaskReview;
}

/** Relay 质量门配置（创建时确定，影响执行阶段行为） */
export interface RelayQualityConfig {
  /** 是否强制 TDD（先写失败测试 → 实现 → 测试通过）。默认 false（尊重全局"非必要不写测试"） */
  tdd: boolean;
  /** 是否启用两阶段评审（规格符合性 + 代码质量）。默认 true */
  review: boolean;
}

/** 默认质量门配置 */
export const DEFAULT_QUALITY_CONFIG: RelayQualityConfig = {
  tdd: false,
  review: true,
};

/** Relay 元数据（落盘为 relay.json，文档正文另存 md 文件） */
export interface RelayMeta {
  /** 唯一 id（也是目录名，slug 化） */
  id: string;
  /** 人类可读标题 */
  title: string;
  /** 一句话目标摘要 */
  summary: string;
  /** 当前阶段 */
  phase: RelayPhase;
  /** 结构化任务清单（plan 阶段生成） */
  tasks: RelayTask[];
  /** 各阶段是否已通过用户确认门（checkpoint）。key 为产出该阶段文档的阶段名 */
  approvals: Partial<Record<RelayPhase, boolean>>;
  /** 质量门配置（TDD / 评审开关） */
  quality?: RelayQualityConfig;
  /** 关联的会话 id（哪个对话创建/驱动了这个 relay） */
  sessionId?: string;
  /** 创建时间 ISO 字符串 */
  createdAt: string;
  /** 更新时间 ISO 字符串 */
  updatedAt: string;
}

/** Relay 完整数据：元信息 + 三份阶段文档正文（供前端面板渲染） */
export interface RelayData extends RelayMeta {
  /** requirements.md 正文（未生成时为空串） */
  requirements: string;
  /** design.md 正文 */
  design: string;
  /** plan.md 正文 */
  plan: string;
}

/** Relay 列表项摘要（不含文档正文，列表展示用） */
export interface RelaySummary {
  id: string;
  title: string;
  summary: string;
  phase: RelayPhase;
  taskTotal: number;
  taskDone: number;
  updatedAt: string;
}

/** 把完整 RelayData 压成列表摘要 */
export function toRelaySummary(d: RelayMeta): RelaySummary {
  const taskDone = d.tasks.filter((t) => t.status === "completed").length;
  return {
    id: d.id,
    title: d.title,
    summary: d.summary,
    phase: d.phase,
    taskTotal: d.tasks.length,
    taskDone,
    updatedAt: d.updatedAt,
  };
}

/** 计算给定阶段的下一阶段（done 之后仍是 done） */
export function nextPhase(phase: RelayPhase): RelayPhase {
  const idx = PHASE_ORDER.indexOf(phase);
  if (idx < 0 || idx >= PHASE_ORDER.length - 1) return "done";
  return PHASE_ORDER[idx + 1];
}

/** 把任意字符串 slug 化为安全的目录名（小写、连字符、去非法字符） */
export function slugify(input: string): string {
  const base = (input || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-") // 保留中英文/数字/下划线，其余转连字符
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base || `relay-${Date.now().toString(36)}`;
}
