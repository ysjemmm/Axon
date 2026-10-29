/**
 * Cowork 流程 —— 把一次做成功的办公任务存成可重复运行的「流程」。
 *
 * ── 为什么要有它 ──
 * 财务、会计、客服的工作大多是周期性的：月底对账、每周工单汇总、每月报销整理。
 * 在聊天里做，每次都要重新描述一遍需求，结果还可能和上次不一样。流程把「怎么做」固定下来：
 * 用户只需要放进这一期的文件，点运行。这是 Cowork 和 Chat / Agent 的根本区别。
 *
 * 一个流程 = 输入槽（要放哪几类文件）+ 固定步骤 + 核对项 + 产出命名。
 * 运行时由前端把它拼成一条用户消息交给 Agent（见 web/cowork/flowPrompt.ts），
 * 运行时本身仍是 agent 模式，不需要新的执行引擎。
 *
 * 存储：~/.axon/cowork/flows.json（用户级）。办公用户没有「工作区」概念，流程跟人走。
 */

import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { HostFileSystem } from "../host/index.js";
import type { LLMStrategy } from "../llm/types.js";

export interface CoworkFlowInput {
  /** 槽位 id（流程内唯一），拼提示词时用 label，不用它 */
  id: string;
  /** 给用户看的名字，例如「银行流水」 */
  label: string;
  /** 一句提示，例如「从网银导出的 Excel」 */
  hint?: string;
  /** 是否可以放多个文件（批量处理） */
  multiple?: boolean;
  /** 是否可以不放 */
  optional?: boolean;
}

export interface CoworkFlowRun {
  sessionId: string;
  at: number;
}

export interface CoworkFlow {
  id: string;
  name: string;
  description?: string;
  inputs: CoworkFlowInput[];
  /** 固定步骤，按顺序执行 */
  steps: string[];
  /** 做完后必须逐条核对的项目，例如「汇总表合计等于各原表合计之和」 */
  checks: string[];
  /** 产出文件命名规则，例如「对账结果_{本期}.xlsx」 */
  outputName?: string;
  /** 每次运行要用户补充的信息，例如「本期月份」；空表示不需要 */
  askEachRun?: string;
  /** 由哪个内置模板复制而来 */
  templateId?: string;
  createdAt: number;
  updatedAt: number;
  /** 最近的运行记录（新的在前，最多保留 MAX_RUNS 条），历史列表据此标出「来自哪个流程」 */
  runs?: CoworkFlowRun[];
}

/** 保存时前端传来的内容：id 缺省表示新建 */
export type CoworkFlowInputDraft = Omit<CoworkFlow, "id" | "createdAt" | "updatedAt" | "runs"> & { id?: string };

const MAX_FLOWS = 200;
const MAX_RUNS = 50;
const MAX_ITEMS = 30;
const MAX_TEXT = 2000;

const text = (v: unknown, max = MAX_TEXT): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown, max = MAX_TEXT): string[] =>
  (Array.isArray(v) ? v : []).map((item) => text(item, max)).filter(Boolean).slice(0, MAX_ITEMS);

/** 校验并清理流程内容；名字、步骤、输入槽缺失时抛错（给用户看的中文） */
export function normalizeFlow(raw: unknown): Omit<CoworkFlowInputDraft, "id"> {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = text(obj.name, 60);
  if (!name) throw new Error("流程需要一个名字");
  const steps = list(obj.steps);
  if (steps.length === 0) throw new Error("流程至少需要一个步骤");
  const seen = new Set<string>();
  const inputs: CoworkFlowInput[] = [];
  for (const [index, item] of (Array.isArray(obj.inputs) ? obj.inputs : []).slice(0, 10).entries()) {
    const input = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const label = text(input.label, 40);
    if (!label) continue;
    let id = text(input.id, 40).replace(/[^\w-]/g, "") || `input${index + 1}`;
    while (seen.has(id)) id = `${id}_${index + 1}`;
    seen.add(id);
    inputs.push({
      id,
      label,
      ...(text(input.hint, 120) ? { hint: text(input.hint, 120) } : {}),
      ...(input.multiple === true ? { multiple: true } : {}),
      ...(input.optional === true ? { optional: true } : {}),
    });
  }
  if (inputs.length === 0) throw new Error("流程至少需要一个输入文件");
  const description = text(obj.description, 200);
  const outputName = text(obj.outputName, 120);
  const askEachRun = text(obj.askEachRun, 120);
  const templateId = text(obj.templateId, 60);
  return {
    name,
    ...(description ? { description } : {}),
    inputs,
    steps,
    checks: list(obj.checks),
    ...(outputName ? { outputName } : {}),
    ...(askEachRun ? { askEachRun } : {}),
    ...(templateId ? { templateId } : {}),
  };
}

/** 流程存储：一个 JSON 文件，读改写都整份进行（数量很少，最多几十个） */
export class CoworkFlowStore {
  private readonly path: string;
  /** 串行化写入：连点两次保存不能互相覆盖 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly fs: HostFileSystem, homeDir: string) {
    this.path = join(homeDir, ".axon", "cowork", "flows.json");
  }

  async list(): Promise<CoworkFlow[]> {
    try {
      const raw = await this.fs.read(this.path);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as { flows?: CoworkFlow[] };
      return Array.isArray(parsed.flows) ? parsed.flows.filter((f) => f && typeof f.id === "string") : [];
    } catch {
      return [];
    }
  }

  private mutate<T>(fn: (flows: CoworkFlow[]) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const flows = await this.list();
      const result = fn(flows);
      await this.fs.write(this.path, JSON.stringify({ flows }, null, 2));
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  save(draft: unknown, now = Date.now()): Promise<CoworkFlow> {
    const clean = normalizeFlow(draft);
    const id = text((draft as { id?: unknown } | null)?.id, 60);
    return this.mutate((flows) => {
      const existing = id ? flows.find((f) => f.id === id) : undefined;
      if (existing) {
        const updated: CoworkFlow = { ...clean, id: existing.id, createdAt: existing.createdAt, updatedAt: now, ...(existing.runs ? { runs: existing.runs } : {}) };
        flows[flows.indexOf(existing)] = updated;
        return updated;
      }
      if (flows.length >= MAX_FLOWS) throw new Error(`流程最多保存 ${MAX_FLOWS} 个，请先删除不用的`);
      const created: CoworkFlow = { ...clean, id: `flow-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`, createdAt: now, updatedAt: now };
      flows.unshift(created);
      return created;
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate((flows) => {
      const index = flows.findIndex((f) => f.id === id);
      if (index >= 0) flows.splice(index, 1);
    });
  }

  /** 记一次运行：最近运行的流程排到最前面 */
  recordRun(id: string, sessionId: string, now = Date.now()): Promise<void> {
    return this.mutate((flows) => {
      const index = flows.findIndex((f) => f.id === id);
      if (index < 0) return;
      const flow = flows[index];
      const runs = [{ sessionId, at: now }, ...(flow.runs ?? []).filter((r) => r.sessionId !== sessionId)].slice(0, MAX_RUNS);
      flows.splice(index, 1);
      flows.unshift({ ...flow, runs });
    });
  }
}

// ── 从一次任务提炼流程 ──────────────────────────────────────────────────────

const DRAFT_TIMEOUT_MS = 90_000;

const DRAFT_SYSTEM = `你帮办公人员（财务、会计、客服）把一次已经做成功的文件处理任务，整理成以后每期都能重复运行的「流程」。

只输出一个 JSON 对象，不要任何解释，不要代码块标记。字段：
{
  "name": "流程名，8 字以内，如「月度银行对账」",
  "description": "一句话说明这个流程做什么，30 字以内",
  "inputs": [{ "id": "英文短标识", "label": "这类文件叫什么，如「银行流水」", "hint": "一句提示，如「网银导出的 Excel」", "multiple": 是否可以一次放多个同类文件 }],
  "steps": ["第 1 步做什么", "第 2 步做什么"],
  "checks": ["做完后要核对的一项，必须能用数字或明确事实验证，如「汇总表合计等于各原表合计之和」"],
  "outputName": "产出文件命名规则，可用 {本期} 这类占位，如「对账结果_{本期}.xlsx」",
  "askEachRun": "每次运行需要用户补充的信息（如「本期月份」）；不需要就给空字符串"
}

要求：
- 步骤写成「下次换一批文件也能照做」的通用说法：不要写死这次的具体月份、金额、行数、文件名、绝对路径。
- 把这次过程中用户纠正过、补充过的要求都写进步骤里，那些正是下次最容易做错的地方。
- 步骤只写业务动作（「按凭证号匹配两张表」），不要写怎么编程、用什么库、跑什么脚本。
- 输入槽按「文件的角色」划分，不按这次的具体文件：三个月的流水是一个可多选的槽，不是三个槽。
- checks 给 2 到 5 条，覆盖金额合计、条数、有无遗漏/重复这类最容易出错的地方。`;

interface DraftSource {
  requests: { text: string; files: string[] }[];
  replies: string[];
  actions: string[];
  outputs: string[];
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
  return "";
}

const baseName = (p: string) => p.replace(/\\/g, "/").split("/").filter(Boolean).pop() || p;

/** 从会话消息里抽出提炼流程需要的素材：用户说了什么、做了哪些动作、产出了什么 */
export function collectDraftSource(messages: ChatCompletionMessageParam[]): DraftSource {
  const source: DraftSource = { requests: [], replies: [], actions: [], outputs: [] };
  for (const raw of messages) {
    const m = raw as ChatCompletionMessageParam & {
      displayText?: string;
      attachedFiles?: { name?: string }[];
      tool_calls?: { function?: { name?: string; arguments?: string } }[];
    };
    if (m.role === "user") {
      const text = (typeof m.displayText === "string" && m.displayText) || messageText(m.content);
      if (!text.trim() || (m as { _ephemeralInjected?: boolean })._ephemeralInjected) continue;
      source.requests.push({ text: text.slice(0, 1500), files: (m.attachedFiles ?? []).map((f) => f.name || "").filter(Boolean) });
    } else if (m.role === "assistant") {
      const reply = messageText(m.content).trim();
      if (reply && !m.tool_calls?.length) source.replies.push(reply.slice(0, 1500));
      for (const call of m.tool_calls ?? []) {
        const name = call.function?.name || "";
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(call.function?.arguments || "{}"); } catch { /* 参数损坏时只记工具名 */ }
        if (name === "report_outputs" && Array.isArray(args.files)) {
          for (const f of args.files as { path?: string; note?: string }[]) if (f?.path) source.outputs.push(`${baseName(f.path)}${f.note ? `（${f.note}）` : ""}`);
        } else if (name === "execute_command" && typeof args.command === "string") {
          source.actions.push(`运行程序：${args.command.slice(0, 300)}`);
        } else if ((name === "create_file" || name === "read_file") && typeof args.path === "string") {
          const body = name === "create_file" && typeof args.content === "string" ? `\n${args.content.slice(0, 1200)}` : "";
          source.actions.push(`${name === "create_file" ? "写文件" : "读文件"} ${baseName(args.path)}${body}`);
        }
      }
    }
  }
  return source;
}

function stripJson(raw: string): string {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/** 解析模型给出的流程草稿；字段不全时尽量补齐，实在不成立就抛错 */
export function parseFlowDraft(raw: string): Omit<CoworkFlowInputDraft, "id"> {
  let parsed: unknown;
  try { parsed = JSON.parse(stripJson(raw)); } catch { throw new Error("没能整理出流程，请重试一次"); }
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  if (!Array.isArray(obj.inputs) || obj.inputs.length === 0) obj.inputs = [{ id: "files", label: "要处理的文件", multiple: true }];
  return normalizeFlow(obj);
}

const DESCRIBE_PREFACE = `用户还没有用 AI 做过这件事，下面是他对自己例行工作的描述。请按同样的格式为它设计一个流程：
- 输入槽按描述里提到的文件角色划分；描述没提到但显然需要的文件也加上（标为 optional）。
- 步骤写成办公人员能看懂、能核对的业务动作；描述里没说清的地方按行业惯例补全，宁可具体。
- checks 针对这类工作最容易出错的地方。`;

/** 根据用户一句话的描述起草流程（还没做过这件事、想直接建一个例行流程时） */
export async function generateFlowDraftFromDescription(params: {
  strategy: LLMStrategy;
  model: string;
  description: string;
  signal?: AbortSignal;
}): Promise<Omit<CoworkFlowInputDraft, "id">> {
  const description = params.description.trim().slice(0, 4000);
  if (!description) throw new Error("先描述一下这个流程要做什么");
  return runDraft(params.strategy, params.model, `${DESCRIBE_PREFACE}\n\n【用户的描述】\n${description}`, params.signal);
}

async function runDraft(strategy: LLMStrategy, model: string, user: string, signal?: AbortSignal): Promise<Omit<CoworkFlowInputDraft, "id">> {
  const run = strategy.runTurn({
    model,
    messages: [{ role: "system", content: DRAFT_SYSTEM }, { role: "user", content: user }],
    tools: [],
    signal,
    callbacks: { onReasoningDelta: () => {}, onTextDelta: () => {}, onToolCallDetected: () => {} },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("整理流程超时，请重试")), DRAFT_TIMEOUT_MS); });
  try {
    const result = await Promise.race([run, timeout]);
    return parseFlowDraft(result.content || "");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 用当前模型把会话提炼成流程草稿（用户确认、修改后才保存） */
export async function generateFlowDraft(params: {
  strategy: LLMStrategy;
  model: string;
  messages: ChatCompletionMessageParam[];
  signal?: AbortSignal;
}): Promise<Omit<CoworkFlowInputDraft, "id">> {
  const source = collectDraftSource(params.messages);
  if (source.requests.length === 0) throw new Error("这个任务还没有内容，做完一次再保存为流程");
  const parts = [
    "【用户的要求（按时间顺序，后面的往往是纠正或补充）】",
    ...source.requests.map((r, i) => `${i + 1}. ${r.text}${r.files.length ? `\n   附带文件：${r.files.join("、")}` : ""}`),
    "",
    "【处理过程中做过的动作】",
    ...source.actions.slice(-40),
    "",
    "【最终产出】",
    ...(source.outputs.length ? source.outputs : ["（未登记）"]),
    "",
    "【给用户的最终说明】",
    source.replies.slice(-2).join("\n\n") || "（无）",
  ];
  return runDraft(params.strategy, params.model, parts.join("\n").slice(0, 24_000), params.signal);
}
