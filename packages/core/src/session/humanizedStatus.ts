/**
 * humanizedStatus —— 用模型即时生成「这一轮在干什么」的人话文案
 *
 * 背景：每轮开始时后端统一发 `status: "思考中..."`。Chat/Code 那侧配合工具卡片
 * 一起看没问题（卡片里有工具名、参数、结果），但 Cowork 刻意不展示工具调用，
 * 整轮就只剩这一句 —— 用户既不知道在处理哪份文件，也不知道走到哪一步。
 *
 * 这里用当前会话的模型生成两类文案：
 *   · 轮次意图：发起时一次，概括本轮目标（「核对两份台账的金额差异」）
 *   · 阶段文案：每个工具调用一次，描述当下动作（「打开 3 月台账核对金额列」）
 *
 * ── 三条硬约束（改之前先读）──
 * ① 不能阻塞主流程：生成失败、超时、模型胡说，主流程都必须照常往下跑。所有调用
 *    都是 fire-and-forget + try/catch 全吞，绝不向上抛。
 * ② 必须有即时兜底：状态行在用户按下发送那一刻就得有内容，等模型往返回来再显示
 *    就失去意义。所以前端先用规则占位，这里生成好了再推一条 status 覆盖。
 * ③ 成本必须可控：短 prompt、禁用思考、限制输出长度。一轮意图一次，阶段文案按
 *    工具调用次数走，所以阶段那条做了节流和去重（见 shouldGeneratePhase）。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { LLMStrategy } from "../llm/types.js";

/** 生成超时：超过就放弃，用规则兜底的文案 */
const GENERATE_TIMEOUT_MS = 6000;

/** 文案长度上限（字符）。超长的截断——状态行是一行，放不下长句。 */
const MAX_TEXT_LENGTH = 24;

/**
 * 同一轮内阶段文案的最小生成间隔。
 *
 * 不节流的话，一轮里连着十几次 read_file 就会打十几次模型请求，而用户根本来不及
 * 看清每一句。1.5s 足够让文案跟上动作，又把请求数压在可接受范围。
 */
const PHASE_THROTTLE_MS = 1500;

/** 本轮的生成状态（挂在 AgentSession 上，每轮重置） */
export interface HumanizedStatusState {
  /** 上次生成阶段文案的时刻，用于节流 */
  lastPhaseAt: number;
  /** 已生成过的阶段文案，用于去重（模型对相似工具调用容易给出同一句） */
  seen: Set<string>;
}

export function createHumanizedStatusState(): HumanizedStatusState {
  return { lastPhaseAt: 0, seen: new Set() };
}

/**
 * 清洗模型输出。
 *
 * 模型很爱加引号、句号、"正在"前缀，或者干脆回一整段解释。这里统一收拾干净：
 * 只取第一行、去掉包裹引号与结尾标点、砍掉超长部分。
 */
export function sanitize(raw: string): string {
  let text = (raw || "").trim();
  if (!text) return "";
  // 只取第一行：模型有时会先给一句再附解释
  text = text.split(/[\n\r]/)[0].trim();
  // 去掉包裹的引号（中英文都有）
  text = text.replace(/^["'「『“”]+/, "").replace(/["'」』“”]+$/, "");
  // 去掉结尾标点与省略号
  text = text.replace(/[。．.、，,；;：:！!？?…]+$/, "").trim();
  // 去掉"正在"前缀：状态行自己会带动态效果，前缀是冗余的
  text = text.replace(/^(正在|我正在|现在正在|开始)\s*/, "").trim();
  if (text.length > MAX_TEXT_LENGTH) text = `${text.slice(0, MAX_TEXT_LENGTH)}…`;
  return text;
}

/** 只保留文件名：绝对路径又长又会把状态行挤爆，而用户认得自己的文件名 */
function baseName(rawPath: string): string {
  return rawPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
}

/**
 * 跑一次极简的模型调用。
 *
 * 用 runTurn + 空 tools —— 和 Relay 评审子 Agent 同一个范式，不额外造一条请求通道。
 * 超时用 Promise.race 兜：不少中转网关在异常时会挂住连接不返回，没有超时的话这条
 * fire-and-forget 的 Promise 会一直悬着。
 */
async function generate(
  strategy: LLMStrategy,
  model: string,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const run = strategy.runTurn({
    model,
    messages,
    tools: [],
    signal,
    callbacks: {
      onReasoningDelta: () => {},
      onTextDelta: () => {},
      onToolCallDetected: () => {},
    },
  });

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("humanized status timeout")), GENERATE_TIMEOUT_MS);
  });

  const result = await Promise.race([run, timeout]);
  return sanitize(result.content || "");
}

const INTENT_SYSTEM =
  "你给办公软件的状态栏写一句话，告诉用户「我正在帮你做什么」。" +
  "要求：中文，不超过 20 字，一句话，像同事口头汇报。" +
  "直接说要做的事，不要加「正在」前缀，不要引号句号，不要解释，不要提到文件路径、" +
  "编程、脚本、工具名这类技术词。只输出这一句话。";

/**
 * 生成本轮意图文案。
 *
 * 输入只给用户请求和文件名 —— 不给完整路径（又长又没信息量），也不给系统提示
 * （那会让模型跑偏去描述自己的能力）。
 */
export async function generateIntent(params: {
  strategy: LLMStrategy;
  model: string;
  request: string;
  fileNames: string[];
  signal?: AbortSignal;
}): Promise<string> {
  const { strategy, model, request, fileNames, signal } = params;
  const files = fileNames.length > 0 ? `\n涉及文件：${fileNames.join("、")}` : "";
  const user = `用户的要求：${request.slice(0, 500)}${files}`;
  return generate(strategy, model, INTENT_SYSTEM, user, signal);
}

const PHASE_SYSTEM =
  "你给办公软件的状态栏写一句话，告诉用户「我现在这一步在做什么」。" +
  "要求：中文，不超过 16 字，一句话。" +
  "不要加「正在」前缀，不要引号句号，不要解释。" +
  "不要提工具名、命令、代码、脚本这类技术词——用户是做表格和文档的人，" +
  "把「跑脚本处理数据」说成「整理表格里的数据」这样的说法。只输出这一句话。";

/**
 * 生成阶段文案。
 *
 * 注意传给模型的是【动作语义】而不是工具名：工具名是实现细节，直接丢给模型它很容易
 * 原样抄进文案里（"执行 execute_command"），那正是要避免的东西。
 */
export async function generatePhase(params: {
  strategy: LLMStrategy;
  model: string;
  /** 本轮意图，作为上下文让阶段文案和目标对得上 */
  intent: string;
  /** 工具动作的语义描述，如 "读取文件 账目.xlsx" */
  action: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { strategy, model, intent, action, signal } = params;
  const user = `总目标：${intent || "处理用户的文件"}\n当前这一步：${action}`;
  return generate(strategy, model, PHASE_SYSTEM, user, signal);
}

/**
 * 工具调用 → 动作语义描述（喂给模型，不直接展示）。
 *
 * 刻意只给"做什么 + 对哪个文件"，不给工具名和完整参数：模型拿到工具名就容易把它
 * 抄进文案里，而参数里常有大段脚本内容，既浪费 token 又会把模型注意力带偏。
 */
export function describeAction(toolName: string, args: Record<string, unknown>): string {
  const rawPath = typeof args.path === "string" ? args.path : "";
  const base = rawPath ? baseName(rawPath) : "";

  switch (toolName) {
    case "read_file":
      return base ? `查看文件 ${base} 的内容` : "查看一个文件的内容";
    case "create_file":
      return base ? `把结果写成新文件 ${base}` : "把结果写成一个新文件";
    case "str_replace":
    case "apply_patch":
      return base ? `修改文件 ${base} 里的内容` : "修改文件内容";
    case "list_dir":
      return "查看文件夹里有哪些文件";
    case "search":
      return "在文件里查找需要的内容";
    case "execute_command":
    case "start_process":
      // 办公任务里这一步基本都是用 Python 处理表格/文档，是最耗时的环节。
      // 说成"用程序批量处理"而不是"执行命令"，模型才不会写出一句像黑客操作的话。
      return "用程序批量处理这些数据";
    case "check_diagnostics":
      return "检查处理结果有没有问题";
    default:
      return "继续处理手上的任务";
  }
}

/**
 * 是否该为这次工具调用生成阶段文案。
 *
 * 两道闸：
 * ① 节流 —— 一轮里连着十几次 read_file 不该打十几次请求
 * ② 去重 —— 同一个动作描述只生成一次（重复读同一个文件很常见）
 *
 * 命中就地更新状态（取 token 语义）：调用方拿到 true 即代表已占用本次配额，
 * 不需要自己再记一遍。
 */
export function shouldGeneratePhase(state: HumanizedStatusState, action: string, now = Date.now()): boolean {
  if (state.seen.has(action)) return false;
  if (now - state.lastPhaseAt < PHASE_THROTTLE_MS) return false;
  state.lastPhaseAt = now;
  state.seen.add(action);
  return true;
}
