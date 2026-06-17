/**
 * 两阶段评审 - Relay 执行阶段的质量门
 *
 * 对标 Superpowers 的 subagent-driven-development：每个任务做完不直接采信，
 * 而是过两道【只读】评审子 Agent：
 *   1. 规格符合性（spec）：改动是否真的满足任务卡 + 需求/设计文档？有没有跑偏/漏做？
 *   2. 代码质量（quality）：有没有坏味道、重复、未处理边界、破坏现有逻辑？
 *
 * 任一阶段发现 critical 问题即判定不通过，由执行 Agent 修复后重审，而非带病推进。
 * 评审子 Agent 只读（read_file/search/list_dir），不改代码——评审者不应顺手改东西。
 */

import { SubAgentRunner } from "../skills/subAgentRunner.js";
import type { LLMStrategy } from "../llm/types.js";
import type { SkillLoaderFn, WebCapability } from "../tools/index.js";
import type { AgentHost } from "../host/index.js";
import type { ReviewVerdict, TaskReview } from "./types.js";

/** 评审依赖（由 AgentSession 注入） */
export interface ReviewDeps {
  strategy: LLMStrategy;
  model: string;
  cwd: string;
  workspaces: string[];
  /** 执行端能力（透传给只读评审子 Agent） */
  host: AgentHost;
  signal?: AbortSignal;
  skillLoader?: SkillLoaderFn;
  /** web 能力（透传给评审子 Agent） */
  web?: WebCapability;
  /** 事件发射器工厂：为某一阶段评审返回绑定其 id 的 emit（前端渲染评审卡片） */
  emitFor: (reviewId: string) => (type: string, data: Record<string, unknown>) => void;
}

/** 评审任务的上下文（执行 Agent 改完后提供给评审者的信息） */
export interface ReviewContext {
  /** relay 标题 */
  relayTitle: string;
  /** 任务编号与标题 */
  taskId: string;
  taskTitle: string;
  /** 任务实现要点（来自 plan.md） */
  taskDetails?: string;
  /** 需求文档正文（节选/全文） */
  requirements: string;
  /** 设计文档正文 */
  design: string;
  /** 本任务实际改动的文件路径列表（供评审者优先核查） */
  changedFiles: string[];
}

/**
 * 解析评审子 Agent 的结论文本为结构化裁决。
 * 约定评审者输出一行机器可读标记 VERDICT: PASS / FAIL，但模型未必严格遵守格式，
 * 因此做多重容错：兼容全角冒号、markdown 强调符、中文"通过/不通过"等表述；
 * 完全没有明确结论信号时，回退到"是否存在 critical 问题"判定，再不行才保守判未通过。
 */
export function parseVerdict(text: string): ReviewVerdict {
  // 先抽取问题条目（[critical]/[major]/[minor]）
  const issues: ReviewVerdict["issues"] = [];
  const lineRe = /\[(critical|major|minor)\]\s*(.+)/gi;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(text)) !== null) {
    issues.push({
      severity: m[1].toLowerCase() as "critical" | "major" | "minor",
      description: m[2].trim(),
    });
  }
  const hasCritical = issues.some((i) => i.severity === "critical");

  // 归一化：去掉 markdown 强调符与全角冒号，便于匹配
  const norm = text.replace(/[*_`]/g, "").replace(/：/g, ":");

  // 多重信号识别 PASS / FAIL
  const failSignal = /VERDICT:\s*FAIL|结论:\s*(不通过|未通过|失败|拒绝)|评审(不通过|未通过|失败)|\b(REJECT(ED)?|FAILED)\b/i.test(norm);
  const passSignal = /VERDICT:\s*PASS|结论:\s*(通过|合格|无问题)|评审通过|\b(APPROVED?|PASSED)\b/i.test(norm);

  let passed: boolean;
  if (failSignal && !passSignal) {
    passed = false;
  } else if (passSignal && !failSignal) {
    passed = true;
  } else {
    // 信号缺失或冲突：用 critical 兜底——无 critical 视为通过，有 critical 判否。
    // 这样即使模型没输出机器标记，也能依据它列出的问题做合理判定，而不是一律保守判否。
    passed = !hasCritical;
  }

  // critical 一票否决：无论信号如何，有 critical 必不通过
  if (hasCritical) passed = false;

  const summary = norm.replace(/VERDICT:\s*(PASS|FAIL)/i, "").trim().slice(0, 600);
  return { passed, issues, summary };
}

/** 构造规格符合性评审的 prompt */
function buildSpecPrompt(ctx: ReviewContext): string {
  return (
    `你是规格符合性评审员（只读）。请核查一个刚完成的开发任务【是否真正满足要求】，不要顺手改代码。\n\n` +
    `## Relay：${ctx.relayTitle}\n` +
    `## 任务 ${ctx.taskId}：${ctx.taskTitle}\n` +
    (ctx.taskDetails ? `### 实现要点\n${ctx.taskDetails}\n` : "") +
    `\n## 需求文档（节选）\n${ctx.requirements.slice(0, 3000)}\n` +
    `\n## 设计文档（节选）\n${ctx.design.slice(0, 3000)}\n` +
    `\n## 本次改动的文件\n${ctx.changedFiles.map((f) => `- ${f}`).join("\n") || "（未提供，请自行搜索定位）"}\n\n` +
    `请用 read_file/search 核查这些改动，重点判断：\n` +
    `1. 任务卡要求的功能是否都实现了？有没有漏做的子项？\n` +
    `2. 实现是否偏离了需求/设计的意图？\n` +
    `3. 有没有"看起来做了但实际是占位/TODO/假实现"的情况？\n\n` +
    `输出要求（中文）：先给简明评审小结，逐条列出问题（用 [critical]/[major]/[minor] 前缀），` +
    `最后【单独一行】输出机器标记：VERDICT: PASS 或 VERDICT: FAIL。` +
    `只有"功能完整、未跑偏、无假实现"才 PASS；有任何 critical 问题必须 FAIL。`
  );
}

/** 构造代码质量评审的 prompt */
function buildQualityPrompt(ctx: ReviewContext): string {
  return (
    `你是代码质量评审员（只读）。请审查一个刚完成的开发任务的代码质量，不要改代码。\n\n` +
    `## 任务 ${ctx.taskId}：${ctx.taskTitle}\n` +
    `## 本次改动的文件\n${ctx.changedFiles.map((f) => `- ${f}`).join("\n") || "（未提供，请自行搜索定位）"}\n\n` +
    `请用 read_file/search 审查，重点判断：\n` +
    `1. 是否引入坏味道：重复代码、超长函数、职责不清、魔法值硬编码？\n` +
    `2. 边界与错误处理是否充分？有没有吞异常、漏判空、未处理失败路径？\n` +
    `3. 是否破坏了现有逻辑或接口契约（调用方、被调用方）？\n` +
    `4. 命名、风格是否与项目现有约定一致？\n\n` +
    `输出要求（中文）：先给简明评审小结，逐条列出问题（用 [critical]/[major]/[minor] 前缀），` +
    `最后【单独一行】输出机器标记：VERDICT: PASS 或 VERDICT: FAIL。` +
    `结构性缺陷（破坏现有逻辑、严重坏味道）判 critical → FAIL；纯风格小问题判 minor 可 PASS。`
  );
}

/** 跑一个只读评审子 Agent，返回结构化裁决与消耗的 token */
async function runOneReview(prompt: string, reviewId: string, deps: ReviewDeps): Promise<{ verdict: ReviewVerdict; tokens: number }> {
  const runner = new SubAgentRunner({
    strategy: deps.strategy,
    model: deps.model,
    cwd: deps.cwd,
    workspaces: deps.workspaces,
    host: deps.host,
    signal: deps.signal,
    emit: deps.emitFor(reviewId),
    skillLoader: deps.skillLoader,
    web: deps.web,
    readOnly: true, // 评审者只读
  });
  const res = await runner.run(prompt, null);
  if (!res.ok) {
    return {
      verdict: { passed: false, issues: [{ severity: "major", description: "评审子 Agent 未能完成评审" }], summary: res.text.slice(0, 400) },
      tokens: res.tokens,
    };
  }
  return { verdict: parseVerdict(res.text), tokens: res.tokens };
}

/**
 * 执行两阶段评审。spec 不通过则短路（不再跑 quality，先让执行者修规格问题）。
 * @returns 完整 TaskReview（含两阶段评审子 Agent 累计消耗的 token）。passed 表示两阶段均通过。
 */
export async function runTwoStageReview(ctx: ReviewContext, deps: ReviewDeps): Promise<TaskReview & { tokens: number }> {
  const base = `review-${ctx.taskId}-${Date.now()}`;

  // 第一阶段：规格符合性
  const specRes = await runOneReview(buildSpecPrompt(ctx), `${base}-spec`, deps);
  if (!specRes.verdict.passed) {
    return { spec: specRes.verdict, passed: false, reviewedAt: new Date().toISOString(), tokens: specRes.tokens };
  }

  // 第二阶段：代码质量
  const qualityRes = await runOneReview(buildQualityPrompt(ctx), `${base}-quality`, deps);
  return {
    spec: specRes.verdict,
    quality: qualityRes.verdict,
    passed: specRes.verdict.passed && qualityRes.verdict.passed,
    reviewedAt: new Date().toISOString(),
    tokens: specRes.tokens + qualityRes.tokens,
  };
}

/** 把评审结果聚合成给执行 Agent 的反馈文本（用于打回修复） */
export function buildReviewFeedback(review: TaskReview): string {
  const lines: string[] = [];
  const collect = (label: string, v?: ReviewVerdict) => {
    if (!v) return;
    lines.push(`### ${label}：${v.passed ? "通过" : "未通过"}`);
    if (v.summary) lines.push(v.summary);
    for (const issue of v.issues) {
      lines.push(`- [${issue.severity}] ${issue.description}`);
    }
  };
  collect("规格符合性", review.spec);
  collect("代码质量", review.quality);
  return lines.join("\n");
}
