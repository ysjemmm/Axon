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

const LABEL_KEYS = ["label", "text", "title", "name", "option", "value", "content"];
const QUESTION_KEYS = ["question", "title", "text", "prompt", "header", "q"];
const MULTI_KEYS = ["multi", "multiple", "multiSelect", "multi_select", "multiselect", "allowMultiple", "allow_multiple"];
/** 模型自己加的「其他」选项：界面会自动提供，不重复显示 */
const OTHER_LABEL = /^(其他|其它|other|others|以上都不是|都不是|none of (the )?above)([（(：:].*)?$/i;

function firstString(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
}

/** 把模型给的单个选项规整成内部结构（缺 id 时按序号补 opt_i，无 label 则丢弃）。字符串选项直接当 label。 */
function normalizeOption(raw: unknown, index: number): AskUserOption | null {
  if (typeof raw === "string" || typeof raw === "number") {
    const label = String(raw).trim();
    return label ? { id: `opt_${index}`, label } : null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const label = firstString(o, LABEL_KEYS);
  if (!label) return null;
  const descRaw = o.description ?? o.desc ?? o.detail ?? o.hint;
  const description = typeof descRaw === "string" && descRaw.trim() ? descRaw.trim() : undefined;
  return {
    id: typeof o.id === "string" && o.id.trim() ? o.id.trim() : `opt_${index}`,
    label,
    description,
  };
}

/** 规整结果：问题本身，或说明它为什么不能用 */
type QuestionParse = { question: AskUserQuestion; truncated: boolean } | { error: string };

/** 把模型给的单个问题规整成内部结构。 */
function normalizeQuestion(raw: unknown, index: number): QuestionParse {
  if (typeof raw === "string") return { error: `第 ${index + 1} 题只给了文字「${raw.slice(0, 30)}」，没有 options` };
  if (!raw || typeof raw !== "object") return { error: `第 ${index + 1} 题不是对象` };
  const q = raw as Record<string, unknown>;
  const question = firstString(q, QUESTION_KEYS);
  if (!question) return { error: `第 ${index + 1} 题缺少 question（问题文字）` };
  let rawOptions: unknown = q.options ?? q.choices ?? q.answers ?? q.items;
  if (typeof rawOptions === "string") {
    const t = rawOptions.trim();
    try { rawOptions = JSON.parse(t); } catch { rawOptions = t.split(/\s*[\n|｜/、]\s*|\s*[,，]\s*/).filter(Boolean); }
  }
  const list = Array.isArray(rawOptions) ? rawOptions : [];
  const multiRaw = MULTI_KEYS.map((k) => q[k]).find((v) => v !== undefined);
  const multi = multiRaw === true || multiRaw === "true" || q.type === "multi" || q.type === "multiple" || q.type === "checkbox";
  const allowOther = q.allowOther !== false && q.allowOther !== "false" && q.allow_other !== false;
  const options: AskUserOption[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i++) {
    const opt = normalizeOption(list[i], i);
    if (!opt || seen.has(opt.label)) continue;
    if (allowOther && OTHER_LABEL.test(opt.label)) continue;
    seen.add(opt.label);
    // id 重复会让作答对不上：重复的按序号重新编
    if (options.some((o) => o.id === opt.id)) opt.id = `opt_${i}`;
    options.push(opt);
  }
  // 1 个选项 +「其他」还能成立（「按 X 来，还是你另说？」）；一个都没有、或关掉「其他」只剩 1 个，就没得选了
  if (options.length === 0 || (options.length === 1 && !allowOther)) {
    return { error: `第 ${index + 1} 题「${question.slice(0, 30)}」只有 ${options.length} 个有效选项（每个选项要有 label；「其他」界面会自动提供，不要自己写）` };
  }
  return {
    question: { question, options: options.slice(0, MAX_OPTIONS), multi, allowOther },
    truncated: options.length > MAX_OPTIONS,
  };
}

/** 调用失败时给模型的格式示范 */
const ASK_USER_EXAMPLE =
  '{"questions": [{"question": "用哪个数据库？", "options": [{"label": "PostgreSQL", "description": "功能全"}, {"label": "SQLite", "description": "零部署"}]}]}';

export class AskUserToolExecutor {
  constructor(private readonly deps: AskUserToolExecutorDeps) {}

  async execute(req: AskUserToolExecuteRequest): Promise<AskUserToolExecuteResult> {
    if (req.toolName !== ToolName.AskUser) {
      return { result: `未知的问答工具 ${req.toolName}`, status: "error" };
    }
    const { toolArgs, toolCallId } = req;

    const rawQuestions = Array.isArray(toolArgs.questions) ? toolArgs.questions : [];
    const questions: AskUserQuestion[] = [];
    const problems: string[] = [];
    let truncated = false;
    rawQuestions.forEach((rq, i) => {
      const parsed = normalizeQuestion(rq, i);
      if ("error" in parsed) problems.push(parsed.error);
      else { questions.push(parsed.question); truncated ||= parsed.truncated; }
    });

    // 有问题就整体打回、说清楚哪题错在哪：只弹能用的那几题，模型会以为全问到了
    if (questions.length === 0 || problems.length > 0) {
      return {
        result:
          `ask_user 调用格式不对，没有弹给用户：${problems.length ? problems.join("；") : "questions 是空的"}。\n` +
          `每题要有 question 和 1~4 个 options（每个选项至少有 label，通常给 2~4 个）。正确示例：${ASK_USER_EXAMPLE}\n` +
          `如果要用户填的是自由文本（路径、名称、数值），不要用 ask_user：直接在回复里问，或用 ask_form。`,
        status: "error",
      };
    }
    truncated ||= questions.length > MAX_QUESTIONS;
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

    const note = truncated ? `\n（超出上限的问题 / 选项没有展示：一次最多 ${MAX_QUESTIONS} 题、每题最多 ${MAX_OPTIONS} 个选项。还需要问的话等这些结果用完再问。）` : "";
    return { result: `用户的选择：\n${lines.join("\n")}${note}`, status: "success" };
  }
}
