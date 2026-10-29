/**
 * 个别工具的「整体结构」纠正：在按 schema 纠正参数（argCoercion）之前跑。
 *
 * 这几种写法都是模型常见的、意思明确的偏差，按 schema 查必填会直接判错，所以先在这里摆正：
 *   · ask_user：把单个问题直接摊在顶层 {question, options}，或 questions 给成单个对象 / 问题字符串数组
 *   · ask_form：漏了外层 form，直接给 {title, fields}；或 fields 摊在顶层
 *   · load_tools：用 tools 代替 groups
 */

type Args = Record<string, unknown>;

const QUESTION_KEYS = ["question", "title", "text", "prompt", "header", "q"];

function pick(obj: Args, keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined) return obj[k];
  return undefined;
}

function tryParse(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!(t.startsWith("[") || t.startsWith("{"))) return v;
  try { return JSON.parse(t); } catch { return v; }
}

export function preNormalizeArgs(toolName: string, args: Args): Args {
  if (toolName === "ask_user") {
    let questions = tryParse(args.questions ?? args.question_list ?? args.items);
    // 单个问题摊在顶层
    if (questions === undefined && pick(args, QUESTION_KEYS) !== undefined) {
      const { questions: _q, ...single } = args;
      questions = [single];
    }
    if (questions && typeof questions === "object" && !Array.isArray(questions)) questions = [questions];
    return questions === undefined ? args : { ...args, questions };
  }
  if (toolName === "ask_form") {
    let form = tryParse(args.form ?? args.spec ?? args.schema);
    if ((form === undefined || form === null) && (args.fields !== undefined || args.title !== undefined)) {
      const { form: _f, ...rest } = args;
      form = rest;
    }
    if (form && typeof form === "object" && !Array.isArray(form)) {
      const f = form as Args;
      const fields = tryParse(f.fields ?? f.items ?? f.inputs ?? f.controls);
      form = { ...f, fields: fields && typeof fields === "object" && !Array.isArray(fields) ? [fields] : fields };
    } else if (Array.isArray(form)) {
      // 直接给了字段数组
      form = { fields: form };
    }
    return form === undefined ? args : { ...args, form };
  }
  if (toolName === "load_tools" && args.groups === undefined && args.tools !== undefined) {
    return { ...args, groups: args.tools };
  }
  return args;
}
