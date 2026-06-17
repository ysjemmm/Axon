/**
 * 多轮（multi-turn）评估类型
 *
 * 与单轮不同：多轮在真实临时沙箱里跑——模型的工具调用会被真正执行（读/写/搜/命令），
 * 结果回填给模型，循环到模型不再调工具或到轮次上限。能测到：
 *  - create_file「先查目录→再创建」完整闭环
 *  - str_replace 失败后的降级恢复
 *  - bug 修复的「搜索→读→改→验证」链路
 *  - 整个任务的最终落盘结果是否正确
 */

import type { JudgeSpec } from "./types.ts";

/** 文件最终状态断言：路径 → 该文件最终内容必须包含的子串（全部满足才算通过） */
export type FinalFileExpectation = Record<string, string[]>;

export interface MultiTurnScenario {
  id: string;
  description: string;
  /** 初始用户消息 */
  userMessage: string;
  /** 沙箱初始文件（相对路径 → 内容） */
  files?: Record<string, string>;
  expected: {
    /** 轨迹中必须出现的工具（无序，全部需出现） */
    toolsUsed?: string[];
    /** 轨迹中必须按此相对顺序出现的工具子序列（允许中间夹其他调用） */
    toolSequence?: string[];
    /** 轨迹中绝不能出现的工具 */
    toolsAbsent?: string[];
    /** 任务跑完后，对沙箱最终文件内容的断言 */
    finalFiles?: FinalFileExpectation;
    /** 不应存在的文件（如：要求改而非新建时，不该多出文件）；相对路径 */
    absentFiles?: string[];
  };
  /** 轮次上限（默认 8） */
  maxRounds?: number;
  /** 可选 LLM-as-judge（评判最终回复质量/是否真完成） */
  judge?: JudgeSpec;
}

/** 单次工具调用记录（含执行结果摘要与成败） */
export interface ToolTraceEntry {
  round: number;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  resultPreview: string;
}

/** 多轮运行的原始结果（未打分） */
export interface MultiTurnRunResult {
  trace: ToolTraceEntry[];
  finalReply: string;
  rounds: number;
  latency: number;
  tokens: number;
  /** 任务结束后读出的沙箱最终文件内容（仅 expected.finalFiles/absentFiles 涉及的路径） */
  finalFileContents: Record<string, string | null>;
}

/** 多轮维度得分 */
export interface MultiTurnDimensionScores {
  /** 任务完成度（最终文件断言通过比例）——最重要 */
  taskCompletion: number;
  /** 工具轨迹正确性（用到该用的、顺序对、没用禁用的） */
  toolTrajectory: number;
  /** 没有调用禁用工具 */
  noForbidden: number;
  /** 效率（轮次/调用数惩罚） */
  efficiency: number;
  /** judge（无则 null） */
  judge: number | null;
}

export interface MultiTurnResult {
  scenarioId: string;
  trace: ToolTraceEntry[];
  finalReply: string;
  rounds: number;
  scores: MultiTurnDimensionScores;
  overall: number;
  passed: boolean;
  latency: number;
  tokens: number;
}
