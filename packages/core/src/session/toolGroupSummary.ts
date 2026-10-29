/**
 * toolGroupSummary —— 连续工具调用分组的一句话摘要
 *
 * 前端把「两段正文之间连续的工具 / 思考行」收进一个大折叠行（见 web 的 activityGroup.ts），
 * 折叠行标题要一句人话：「查看了历史会话面板和会话存储实现」。这句话由当前会话的模型生成。
 *
 * ── 分组规则必须与前端一致 ──
 * 前端按渲染出来的段切分：可见正文、或不收进折叠行的工具（编辑、产物、ask_user……）都会把
 * 分组切断。后端按同样的规则逐轮追踪（ToolGroupTracker），一组结束时生成摘要，按组内第一个
 * 工具调用的 id 回推给前端。两边规则若不一致，最坏情况是摘要挂不上（前端只显示统计），
 * 不会出错——前端在整组里查找带摘要的工具段，而不是只认第一个。
 *
 * ── 约束（与 humanizedStatus 同一套）──
 * ① 不阻塞主流程：fire-and-forget，失败 / 超时一律吞掉，前端照常显示统计。
 * ② 成本可控：关思考、限输出长度；只有 ≥ MIN_GROUP_TOOLS 个工具的组才生成。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { LLMStrategy } from "../llm/types.js";

/** 至少这么多个工具调用才成组（与前端 MIN_GROUP_TOOLS 一致）：单个工具收进折叠行没有意义 */
export const MIN_GROUP_TOOLS = 2;

/**
 * 不收进折叠行的工具（与前端 UNGROUPED_TOOLS 一致）：
 * 编辑要用户确认 / 撤销，产物、图片是交付物，ask_user / ask_form 等用户作答，
 * Skill / Power / Relay 有自己的卡片——这些都必须留在外面让用户看见。
 */
const UNGROUPED_TOOLS = new Set([
  "str_replace", "create_file", "apply_patch",
  "create_artifact", "edit_artifact", "render_media", "generate_image", "report_outputs", "report_checks",
  "ask_user", "ask_form",
  "use_skill", "activate_power", "update_memory", "update_tasks",
  "delegate_task",
]);

export function isGroupableTool(name: string): boolean {
  return !UNGROUPED_TOOLS.has(name) && !name.startsWith("relay_");
}

/** 与前端「弱内容」判定一致：没有字母数字汉字的正文（"..." 之类）不展示，也就不切断分组 */
export function isVisibleProse(text: string | null | undefined): boolean {
  const t = (text || "").trim();
  return !!t && /[A-Za-z0-9一-鿿]/.test(t);
}

export interface ToolCallBrief {
  id: string;
  name: string;
  arguments: string;
}

export interface ClosedToolGroup {
  /** 组内第一个工具调用的 id：前端据此把摘要挂到这一组上 */
  anchorToolCallId: string;
  /** 每个工具调用的动作描述，喂给模型生成摘要 */
  actions: string[];
}

/**
 * 逐轮追踪当前分组。每轮调用 onRound；本轮之后不再有工具调用时调用 close。
 * 返回的是「已结束、且够格生成摘要」的分组。
 */
/** 进行中的分组每隔几个工具出一条阶段摘要：3~5 个随机，节奏不机械 */
const PROGRESS_MIN = 3;
const PROGRESS_MAX = 5;
const nextProgressAt = () => PROGRESS_MIN + Math.floor(Math.random() * (PROGRESS_MAX - PROGRESS_MIN + 1));

export class ToolGroupTracker {
  private current: ClosedToolGroup | null = null;
  /** 当前分组自上次阶段摘要以来又执行了几个工具 */
  private sinceProgress = 0;
  private progressAt = nextProgressAt();

  /** 一轮 LLM 输出：先出正文、再出工具调用（与前端段顺序一致） */
  onRound(prose: string | null | undefined, toolCalls: ToolCallBrief[]): ClosedToolGroup[] {
    const closed: ClosedToolGroup[] = [];
    if (isVisibleProse(prose)) this.flushInto(closed);
    for (const tc of toolCalls) {
      if (!isGroupableTool(tc.name)) {
        this.flushInto(closed);
        continue;
      }
      if (!this.current) this.current = { anchorToolCallId: tc.id, actions: [] };
      this.current.actions.push(describeToolCall(tc));
      this.sinceProgress++;
    }
    return closed;
  }

  /** 本轮结束（出现最终回复）：收尾当前分组 */
  close(): ClosedToolGroup[] {
    const closed: ClosedToolGroup[] = [];
    this.flushInto(closed);
    return closed;
  }

  /**
   * 分组还在进行、又攒够了 3~5 个工具：返回到目前为止的分组，用来生成一条「正在…」的阶段摘要。
   * 用户看着折叠行里一长串工具在转，不知道 AI 在忙什么——隔几步给一句人话。
   */
  takeProgress(): ClosedToolGroup | null {
    if (!this.current || this.sinceProgress < this.progressAt) return null;
    this.sinceProgress = 0;
    this.progressAt = nextProgressAt();
    return { anchorToolCallId: this.current.anchorToolCallId, actions: [...this.current.actions] };
  }

  private flushInto(out: ClosedToolGroup[]): void {
    if (this.current && this.current.actions.length >= MIN_GROUP_TOOLS) out.push(this.current);
    this.current = null;
    this.sinceProgress = 0;
    this.progressAt = nextProgressAt();
  }
}

function baseName(rawPath: string): string {
  return rawPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() || rawPath;
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** 工具调用 → 一行动作描述。只给"做什么 + 对象"，不给大段参数（脚本、文件正文） */
export function describeToolCall(tc: ToolCallBrief): string {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(tc.arguments || "{}");
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch {
    // 参数不是合法 JSON（流式截断等）：只描述工具名
  }
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  const path = str("path");
  switch (tc.name) {
    case "read_file":
      return `读取文件 ${path ? baseName(path) : ""}`.trim();
    case "list_dir":
      return `列出目录 ${path ? baseName(path) : ""}`.trim();
    case "search":
      return `搜索代码「${clip(str("query") || str("pattern"), 60)}」`;
    case "execute_command":
    case "start_process":
      return `执行命令 ${clip(str("command"), 80)}`;
    case "web_search":
      return `联网搜索「${clip(str("query"), 60)}」`;
    case "web_fetch":
      return `打开网页 ${clip(str("url"), 80)}`;
    default:
      return path ? `${tc.name} ${baseName(path)}` : tc.name;
  }
}

/** 摘要长度上限（字符）：折叠行标题是一行 */
const MAX_SUMMARY_LENGTH = 40;
const GENERATE_TIMEOUT_MS = 15000;

/** 清洗模型输出：只取第一行，去引号、结尾标点，截断超长 */
export function sanitizeSummary(raw: string): string {
  let text = (raw || "").trim().split(/[\n\r]/)[0].trim();
  text = text.replace(/^["'「『“”*]+/, "").replace(/["'」』“”*]+$/, "");
  text = text.replace(/[。．.、，,；;：:！!？?…]+$/, "").trim();
  if (text.length > MAX_SUMMARY_LENGTH) text = `${text.slice(0, MAX_SUMMARY_LENGTH)}…`;
  return text;
}

const PROGRESS_SYSTEM =
  "你给编程助手界面里一组正在进行的工具调用写一行进度说明，告诉用户它此刻在忙什么。" +
  "要求：中文，不超过 22 字，以「正在」开头，侧重最近几步、说清在找什么或确认什么，" +
  "不要罗列文件名（最多提 1~2 个最关键的名字）。不要引号句号，不要解释。只输出这一行。";

const SUMMARY_SYSTEM =
  "你给编程助手界面里的一组工具调用写一行标题，概括这一组操作做了什么。" +
  "要求：中文，不超过 25 字，一句话，用「查看了…」「定位了…」「对比了…」这类过去式动宾短语，" +
  "说清在找什么或确认什么，而不是罗列文件名（最多提 2 个最关键的名字）。" +
  "不要引号句号，不要解释。只输出这一行标题。";

/**
 * 用当前会话的模型生成分组摘要。关闭思考、限制输出；失败返回空串（调用方据此不发事件）。
 */
export async function generateToolGroupSummary(params: {
  strategy: LLMStrategy;
  model: string;
  /** 本轮用户请求：让摘要和目标对得上 */
  request: string;
  actions: string[];
  /** 声明的思考能力：think:false 要据此决定是否显式下发「关闭思考」参数 */
  modelSupportsThinking?: boolean;
  signal?: AbortSignal;
  /** live：分组还在进行，写「正在…」的进度说明；缺省是分组结束后的过去式标题 */
  live?: boolean;
}): Promise<string> {
  const { strategy, model, request, actions, modelSupportsThinking, signal, live } = params;
  const shown = actions.slice(0, 20);
  const more = actions.length > shown.length ? `\n…另有 ${actions.length - shown.length} 个类似操作` : "";
  const user = `用户的要求：${clip(request, 300)}\n这一组操作：\n${shown.map((a) => `- ${a}`).join("\n")}${more}`;
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: live ? PROGRESS_SYSTEM : SUMMARY_SYSTEM },
    { role: "user", content: user },
  ];

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("tool group summary timeout")), GENERATE_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([
      strategy.runTurn({
        model,
        messages,
        tools: [],
        signal,
        think: false,
        modelSupportsThinking,
        maxOutputTokens: 200,
        callbacks: {
          onReasoningDelta: () => {},
          onTextDelta: () => {},
          onToolCallDetected: () => {},
        },
      }),
      timeout,
    ]);
    return sanitizeSummary(result.content || "");
  } finally {
    if (timer) clearTimeout(timer);
  }
}
