/**
 * AskUserToolExecutor —— ask_user 工具的问答门与结果整形
 *
 * 与 relayToolExecutor 同构的"从 dispatchToolCall 迁出的执行分支"：
 * - 解析并校验 questions（每个问题含 question / options / multi / allowOther），缺则直接返回错误、不弹门；
 * - 走 waitForUserAnswer 门：发 ask_user_request 给前端后【无限阻塞】，直到用户逐题作答完毕；
 *   会话被取消时由 AgentSession 解除阻塞并返回 null（避免 agent loop 永远卡住）；
 * - 把用户的选择整形成给模型看的文本结果（逐题列出，模型据此继续）。
 */

import { ToolName } from "../tools/index.js";

/** 一个可选项。 */
export interface AskUserOption {
  id: string;
  label: string;
  description?: string;
}

/** 一个问题（含它的选项与作答方式）。 */
export interface AskUserQuestion {
  question: string;
  options: AskUserOption[];
  /** true=多选（checkbox），false=单选（radio） */
  multi: boolean;
  /** 是否允许用户自己输入「其他」 */
  allowOther: boolean;
}

/** 用户对【单个问题】的作答。 */
export interface AskUserAnswer {
  /** 选中的选项 id（单选时最多一个；skipped 时为空） */
  selected: string[];
  /** "其他"自由文本（allowOther 且有填写时） */
  other?: string;
  /** 用户选择"跳过，让你自己决定" */
  skipped?: boolean;
}

/** 一次 ask_user 最多允许问几个问题（前端步进器不宜太长）。 */
const MAX_QUESTIONS = 4;

/**
 * 每个问题最多允许几个选项。「其他（自己输入）」不占这个配额 —— 它由前端另行提供，
 * 所以一屏最多就是「4 个选项 + 1 个其他」。模型多给的一律截断。
 */
const MAX_OPTIONS = 4;

/** ask_user 工具执行请求。 */
export interface AskUserToolExecuteRequest {
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallId: string;
}

/** ask_user 工具执行结果。 */
export interface AskUserToolExecuteResult {
  result: string;
  status: "success" | "error";
}

/** 依赖注入：把问答门与具体执行实现从 AgentSession 注入。 */
export interface AskUserToolExecutorDeps {
  waitForUserAnswer: (
    toolCallId: string,
    questions: AskUserQuestion[],
  ) => Promise<AskUserAnswer[] | null>;
}

/** 把模型给的单个选项规整成内部结构（缺 id 时按序号补 opt_i，无 label 则丢弃）。 */
function normalizeOption(raw: unknown, index: number): AskUserOption | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const label = typeof o.label === "string" ? o.label.trim() : "";
  if (!label) return null;
  const description = typeof o.description === "string" && o.description.trim() ? o.description.trim() : undefined;
  return {
    id: typeof o.id === "string" && o.id.trim() ? o.id.trim() : `opt_${index}`,
    label,
    description,
  };
}

/** 把模型给的单个问题规整成内部结构（无 question 则丢弃）。 */
function normalizeQuestion(raw: unknown): AskUserQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Record<string, unknown>;
  const question = typeof q.question === "string" ? q.question.trim() : "";
  if (!question) return null;
  const rawOptions = Array.isArray(q.options) ? q.options : [];
  const options: AskUserOption[] = [];
  for (let i = 0; i < rawOptions.length && options.length < MAX_OPTIONS; i++) {
    const opt = normalizeOption(rawOptions[i], i);
    if (opt) options.push(opt);
  }
  return {
    question,
    options,
    multi: q.multi === true,
    // allowOther 默认 true：缺省时给出「其他」兜底，只有显式 false 才关掉。
    allowOther: q.allowOther !== false,
  };
}

export class AskUserToolExecutor {
  constructor(private readonly deps: AskUserToolExecutorDeps) {}

  async execute(req: AskUserToolExecuteRequest): Promise<AskUserToolExecuteResult> {
    if (req.toolName !== ToolName.AskUser) {
      return { result: `未知的问答工具 ${req.toolName}`, status: "error" };
    }
    const { toolArgs, toolCallId } = req;

    const rawQuestions = Array.isArray(toolArgs.questions) ? toolArgs.questions : [];
    const questions: AskUserQuestion[] = [];
    for (const rq of rawQuestions) {
      const q = normalizeQuestion(rq);
      if (q) questions.push(q);
    }

    if (questions.length === 0) {
      return {
        result: "ask_user 调用失败：questions 至少要有 1 个问题，且每个问题都要有 question 与 options。",
        status: "error",
      };
    }
    const capped = questions.slice(0, MAX_QUESTIONS);

    const answers = await this.deps.waitForUserAnswer(toolCallId, capped);

    if (!answers) {
      return {
        result: "本次提问已被取消（会话结束或用户中止），没有得到回答。请基于已有信息自行继续，不要重复提问。",
        status: "error",
      };
    }

    const lines: string[] = [];
    for (let i = 0; i < capped.length; i++) {
      const q = capped[i];
      const a = answers[i];
      if (!a || a.skipped) {
        lines.push(`${i + 1}. ${q.question} → （跳过，由你决定）`);
        continue;
      }
      const chosen = a.selected
        .map((id) => q.options.find((o) => o.id === id))
        .filter((o): o is AskUserOption => !!o);
      const parts: string[] = [];
      if (chosen.length > 0) parts.push(chosen.map((o) => o.label).join("、"));
      if (a.other && a.other.trim()) parts.push(`其他：${a.other.trim()}`);
      lines.push(`${i + 1}. ${q.question} → ${parts.length > 0 ? parts.join("；") : "（未选择）"}`);
    }

    return { result: `用户的选择：\n${lines.join("\n")}`, status: "success" };
  }
}
