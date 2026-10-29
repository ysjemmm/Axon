/**
 * WikiController —— 「生成 / 刷新 Wiki」流程的编排中枢。
 *
 * 职责：把一次生成拆成「规划 → 建作业 → 逐页撰写 → 收尾」，并负责进度、取消、续跑。
 * 它不直接调 LLM，而是通过注入的 runSubAgent 驱动隔离子 Agent —— 这样编排逻辑
 * 可以脱离真实模型单测（跑得快、不花钱），而生成质量那一层交给 skill 与子 Agent。
 *
 * ── 为什么必须隔离运行 ──
 * 生成一页要读十几个文件，整个流程动辄上百次工具调用。若塞进主会话上下文，
 * 一轮下来上下文就废了，而且这些过程还会以卡片形式灌满聊天界面。
 * 隔离子 Agent 跑完即散，只把「页面已写成」这个事实带回。
 *
 * ── 为什么是两阶段（规划 + 撰写）──
 * 规划阶段先定「总共要写哪些页」，于是进度有了真实分母（3/8 而不是「已生成 3 页」），
 * 中断后的续跑也能精确算出还缺哪些。代价是多一次 LLM 调用，换来的是可展示的进度与可续跑性。
 *
 * ── 续跑为什么每次重新规划 ──
 * 不把上次的页面清单当圣旨：代码可能已经变了，重新勘察才能反映现状。
 * 「已完成」的判据取自【磁盘上当前存在哪些页】而非历史作业记录 ——
 * 用户手删掉一页，它就该自然地重回待生成，而不是被历史记录判定为「已完成」而永久缺失。
 */

import type { AgentHost } from "../host/index.js";
import { findProviderForModel } from "../providers.js";
import type { LoadedSkill } from "../skills/skillLoader.js";
import type { WikiTools } from "../tools/definitions.js";
import { WikiStore, wikiSlug, type WikiJob } from "./wikiStore.js";
import { buildWikiAuthoringSkill } from "./wikiAuthoringSkill.js";

/** 生成过程中的进度事件（由呈现端转发给 UI） */
export type WikiGenerationEvent =
  | { type: "planning"; workspace: string }
  | { type: "planned"; workspace: string; pages: { title: string; summary: string }[]; truncated?: boolean }
  | { type: "page_saved"; workspace: string; slug: string; title: string; done: number; total: number; usage?: WikiUsage }
  | { type: "page_failed"; workspace: string; title: string; reason: string }
  /**
   * cancelled 单独标出：用户主动取消既不是成功也不是失败，呈现端据此决定用信息提示而非警告。
   * 否则只能靠 message 里有没有「取消」二字来猜 —— 那是靠文案做逻辑，改一个字就失效。
   */
  | { type: "finished"; workspace: string; ok: boolean; done: number; total: number; failed: string[]; message: string; cancelled?: boolean; usage?: WikiUsage; budgetExceeded?: boolean };

/** 一次生成累计消耗的 token */
export interface WikiUsage {
  inputTokens: number;
  outputTokens: number;
}

/** 对一次子 Agent 运行的要求 */
export interface WikiSubAgentRequest {
  prompt: string;
  skill: LoadedSkill | null;
  /** 规划阶段为 true（只读勘察）；撰写阶段为 false（需要写页面） */
  readOnly: boolean;
  /** 本阶段可用的 wiki 工具。规划阶段给 plan，撰写阶段给 save */
  wiki?: WikiTools;
  /** 本次子 Agent 的轮次上限 */
  maxRounds: number;
  /** 本次子 Agent 的 token 上限（输入 + 输出） */
  tokenBudget: number;
}

/** 子 Agent 一次运行的结果 */
export interface WikiSubAgentResult {
  ok: boolean;
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * 生成选项：显式覆盖模型 / 页数上限，由呈现端从设置读出后透传进来。
 *
 * 为什么配置的「读取」在呈现端而「解析」在 core：读 VS Code 设置是形态相关的
 * （vscode.workspace.getConfiguration），而「这个模型该用哪个 provider」是形态无关的
 * 纯逻辑（findProviderForModel），后者留在 core 才能被单测覆盖。
 */
export interface WikiGenerationOptions {
  provider?: string;
  model?: string;
  /** 页面数上限。缺省用 WIKI_DEFAULT_MAX_PAGES */
  maxPages?: number;
  /** 整次生成的 token 上限（输入 + 输出）。缺省按页数估算，见 defaultWikiTokenBudget */
  tokenBudget?: number;
  /**
   * 生成范围：
   *   · full（默认）：重新规划，补写缺失的页面、重写「待复核」的页面
   *   · stale：不规划，只重写「待复核」的页面（便宜，适合代码改了一些之后刷新）
   *   · pages：不规划，只重写指定的页面（slug 列表）
   */
  mode?: "full" | "stale" | "pages";
  slugs?: string[];
}

/**
 * 子 Agent 的轮次 / token 上限。
 *
 * 为什么要分别封顶：子 Agent 默认可以跑 200 轮，每轮都把整段上下文重发一遍；
 * 一个在仓库里打转的子 Agent 就能把整次预算烧光。规划要通读仓库，给得宽一些；
 * 单页只聚焦一个主题，40 轮足够。
 */
export const WIKI_PLAN_MAX_ROUNDS = 60;
export const WIKI_PAGE_MAX_ROUNDS = 40;
export const WIKI_PLAN_TOKEN_BUDGET = 1_200_000;
export const WIKI_PAGE_TOKEN_BUDGET = 600_000;

/** 整次生成的默认 token 上限：规划一次 + 每页一份 */
export function defaultWikiTokenBudget(pages: number, planning: boolean): number {
  return (planning ? WIKI_PLAN_TOKEN_BUDGET : 0) + Math.max(1, pages) * WIKI_PAGE_TOKEN_BUDGET;
}

/**
 * 页面数上限的默认值。
 *
 * 为什么必须有上限：页数直接决定 LLM 调用次数（也就直接决定花费），
 * 同时它还是注入模型索引的长度来源。让规划自由发挥，一个大仓库可能产出上百页——
 * 既贵，又会让索引膨胀成第二个「多工作区清单」那样的大段常驻文本。
 */
export const WIKI_DEFAULT_MAX_PAGES = 15;

/**
 * 解析 Wiki 生成真正使用的 provider / model。
 *
 * 规则：显式配置优先 → 回退到会话所用（base 已含 Relay 执行阶段的模型覆盖）。
 * 只配了 model 没配 provider 时，在已配置的 provider 里找出提供该模型的那个 ——
 * 用户不该被迫手填一个本可以推断出来的字段。
 *
 * 抽成纯函数是为了可测：这段「取哪个字段、回退到谁」的分支最容易写错，
 * 而它一旦错了，代价是拿一个没配置的模型去跑本项目里最贵的操作。
 */
export function resolveWikiModel(
  base: { provider: string; model: string },
  opts: WikiGenerationOptions,
  // 作为参数注入（而非直接写死）以便单测覆盖「找到 / 找不到」两条分支
  findProvider: (model: string, fallback: string) => string | undefined = findProviderForModel,
): { provider: string; model: string } {
  if (opts.model) {
    return {
      provider: opts.provider || findProvider(opts.model, base.provider) || base.provider,
      model: opts.model,
    };
  }
  if (opts.provider) return { provider: opts.provider, model: base.model };
  return base;
}

export interface WikiGenerationDeps {
  host: AgentHost;
  /** 全部工作区（子 Agent 需要知道边界，避免越界写到别处） */
  workspaces: string[];
  store: WikiStore;
  /**
   * 运行一个子 Agent。注入而非直接 new SubAgentRunner —— 真实实现要拿 strategy/model，
   * 那是会话层的事；编排逻辑不该关心这些。测试里换成假实现即可完整验证流程。
   */
  runSubAgent: (req: WikiSubAgentRequest) => Promise<WikiSubAgentResult>;
  emit: (event: WikiGenerationEvent) => void;
  signal?: AbortSignal;
  model?: string;
  sessionId?: string;
  /** 页面数上限；缺省 WIKI_DEFAULT_MAX_PAGES */
  maxPages?: number;
  /** 整次生成的 token 上限；缺省 defaultWikiTokenBudget */
  tokenBudget?: number;
}

export interface WikiGenerationResult {
  ok: boolean;
  /** 本次结束时磁盘上共有多少页（含续跑前就存在的） */
  done: number;
  /** 本次规划的总页数 */
  total: number;
  /** 未能生成的页面标题 */
  failed: string[];
  message: string;
  /** 是否走了续跑（此前已有未完成的作业） */
  resumed: boolean;
  /** 本次累计消耗的 token */
  usage?: WikiUsage;
  /** 因达到 token 上限而提前停止 */
  budgetExceeded?: boolean;
}

type PlannedPage = { title: string; summary: string; sources: string[]; category?: string };

export class WikiController {
  constructor(private readonly deps: WikiGenerationDeps) {}

  /**
   * 为目标工作区生成 Wiki。
   *
   * 全程只写这一个工作区 —— 目标由用户在 UI 上显式选定，此处不做任何推定。
   * 生成是写操作，写错仓库会往不相干的项目里塞进一堆文件，而且它们还会被提交。
   */
  async generate(workspace: string, opts: Pick<WikiGenerationOptions, "mode" | "slugs"> = {}): Promise<WikiGenerationResult> {
    const { store, emit, signal } = this.deps;
    if (!workspace) {
      return { ok: false, done: 0, total: 0, failed: [], message: "未指定目标工作区。", resumed: false };
    }
    const mode = opts.mode ?? "full";

    const skill = buildWikiAuthoringSkill();
    const maxPages = Math.max(1, this.deps.maxPages ?? WIKI_DEFAULT_MAX_PAGES);

    // 用量与预算：每次子 Agent 跑完累加；超出上限就不再开新的子 Agent
    const usage: WikiUsage = { inputTokens: 0, outputTokens: 0 };
    const used = () => usage.inputTokens + usage.outputTokens;
    const run = async (req: Omit<WikiSubAgentRequest, "tokenBudget"> & { tokenBudget: number }) => {
      const res = await this.deps.runSubAgent({ ...req, tokenBudget: Math.max(1, Math.min(req.tokenBudget, budget - used())) });
      usage.inputTokens += res.inputTokens ?? 0;
      usage.outputTokens += res.outputTokens ?? 0;
      return res;
    };

    // 磁盘现状：既是「续跑时要跳过的页」，也是进度的真实基数。
    // 「待复核」的页面不算已完成 —— 刷新的意义正是重写它们。
    const existing = (await store.summary()).filter((p) => p.workspace === workspace);
    const freshSlugs = new Set(existing.filter((p) => !p.stale).map((p) => p.slug));
    const resumable: WikiJob | null = mode === "full" ? await store.getResumableJob(workspace) : null;

    let plan: PlannedPage[];
    let truncated = false;
    let budget: number;
    if (mode === "full") {
      budget = this.deps.tokenBudget ?? defaultWikiTokenBudget(maxPages, true);
      // 先报「已开始」。规划阶段要通读仓库、可能几十秒，期间若没有任何反馈，
      // 用户会以为按钮没生效。这条事件让呈现端立刻能给可见提示。
      emit({ type: "planning", workspace });

      // ── 阶段 1：规划 ──
      // 把已有页面告知规划者：它可以沿用（避免同一主题换名字导致重复页），
      // 也可以因为代码变化而调整页面划分。规划总是新鲜的。
      let planned: PlannedPage[] | null = null;
      await run({
        prompt: buildPlanPrompt(workspace, existing.map((p) => p.title), maxPages),
        skill,
        readOnly: true,
        maxRounds: WIKI_PLAN_MAX_ROUNDS,
        tokenBudget: WIKI_PLAN_TOKEN_BUDGET,
        wiki: {
          plan: async (pages) => {
            planned = pages;
            return `已登记 ${pages.length} 个页面。规划阶段完成，请结束本轮（不要尝试撰写正文）。`;
          },
        },
      });

      if (signal?.aborted) {
        return { ok: false, done: freshSlugs.size, total: 0, failed: [], message: "已取消。", resumed: false, usage };
      }
      // TS 不把闭包内的赋值纳入控制流分析：直接判断 `planned` 会被收窄成 never。
      const collected = planned as PlannedPage[] | null;
      if (!collected || collected.length === 0) {
        // 规划失败就别建作业 —— 建一个永远跑不完的空作业只会污染续跑判断
        const msg = "规划未能产出页面清单。可能是子 Agent 未调用 wiki_plan_pages，或仓库内容不足。";
        emit({ type: "finished", workspace, ok: false, done: freshSlugs.size, total: 0, failed: [], message: msg, usage });
        return { ok: false, done: freshSlugs.size, total: 0, failed: [], resumed: false, message: msg, usage };
      }
      // 硬性截断：提示词里已说明上限，但模型未必遵守。页数直接等于花费，
      // 这个上限不能只靠「请遵守」来保证 —— 必须由代码兜底。
      truncated = collected.length > maxPages;
      plan = dedupeBySlug(truncated ? collected.slice(0, maxPages) : collected);
    } else {
      // 不规划：直接拿现有页面的元信息当计划（标题、定位、依据、分类都在 frontmatter 里）
      const wanted = mode === "stale"
        ? existing.filter((p) => p.stale)
        : existing.filter((p) => (opts.slugs ?? []).includes(p.slug));
      plan = wanted.map((p) => ({ title: p.title, summary: p.summary, sources: p.sources, category: p.category }));
      budget = this.deps.tokenBudget ?? defaultWikiTokenBudget(plan.length, false);
      if (plan.length === 0) {
        const msg = mode === "stale" ? "没有需要复核的页面。" : "没有找到要重新生成的页面。";
        emit({ type: "finished", workspace, ok: true, done: 0, total: 0, failed: [], message: msg, usage });
        return { ok: true, done: 0, total: 0, failed: [], message: msg, resumed: false, usage };
      }
      // 这些页面本次一定重写：从「已完成」里拿掉
      for (const p of plan) freshSlugs.delete(wikiSlug(p.title));
    }
    const slugs = plan.map((p) => wikiSlug(p.title));
    const alreadyDone = slugs.filter((s) => freshSlugs.has(s));

    // ── 阶段 2：建作业 ──
    const job = await store.startJob({
      workspace,
      planned: slugs,
      alreadyDone,
      model: this.deps.model,
      sessionId: this.deps.sessionId,
    });
    emit({
      type: "planned",
      workspace,
      pages: plan.map((p) => ({ title: p.title, summary: p.summary })),
      // 被截断时如实告知：用户看到「共 8 页」却是从 30 页里砍出来的，
      // 与「仓库正好只有 8 个主题」是两回事，判断该调大上限还是接受现状全看这个信息。
      truncated: truncated || undefined,
    });

    // ── 阶段 3：逐页撰写 ──
    // 串行而非并发：每页都要子 Agent 深读若干文件，并发会同时打满上下文与请求配额，
    // 而且失败时的定位会因交错而变难。页面通常十几页，串行的总时长可以接受。
    const saved = new Set(alreadyDone);
    const failed: string[] = [];
    let budgetExceeded = false;
    for (const page of plan) {
      const slug = wikiSlug(page.title);
      if (saved.has(slug)) continue; // 已存在且不需要复核，跳过
      if (signal?.aborted) break;
      // 预算用完就停：剩下的页面留给下次续跑，已写好的都保留
      if (used() >= budget) { budgetExceeded = true; break; }

      const res = await run({
        prompt: buildPagePrompt(workspace, page),
        skill,
        // 撰写者只读仓库、只能提交页面：不给写文件和执行命令的工具。
        // 被文档化的仓库内容（README、注释）可能藏着提示注入，撰写者不该有被利用的能力。
        readOnly: true,
        maxRounds: WIKI_PAGE_MAX_ROUNDS,
        tokenBudget: WIKI_PAGE_TOKEN_BUDGET,
        wiki: {
          save: async (p) => {
            // 标题以计划为准：模型换了标题会写出一个计划外的孤儿页，
            // 进度也会对不上（这一页被判「未产出」，分子却多了一页）。同一次运行多次保存只覆盖这一页。
            const out = await store.save({ ...p, title: page.title, category: p.category || page.category, workspace });
            if (!out) throw new Error(`页面《${page.title}》写入 ${workspace} 失败。`);
            saved.add(out.slug);
            emit({ type: "page_saved", workspace, slug: out.slug, title: page.title, done: saved.size, total: slugs.length, usage: { ...usage } });
            return { slug: out.slug };
          },
        },
      });

      // 子 Agent 返回 ok=false，或它压根没调 wiki_save_page（页面没落盘），都算这一页失败。
      // 不能只看返回值：模型可能"以为自己写了"而实际没调用工具。
      if (!res.ok || !saved.has(slug)) {
        failed.push(page.title);
        emit({ type: "page_failed", workspace, title: page.title, reason: res.ok ? "未产出页面内容" : "子 Agent 执行失败" });
      }
    }

    // ── 阶段 4：收尾 ──
    const cancelled = !!signal?.aborted;
    const ok = !cancelled && !budgetExceeded && failed.length === 0;
    const jobExtra = { workspace, usage: { ...usage } };
    if (cancelled || budgetExceeded) {
      // 取消 / 预算用完都不是失败：保持可续跑语义，下次点击接着写剩下的，不必从头再来
      await store.finishJob(job.id, "interrupted", budgetExceeded ? "达到本次 token 上限" : undefined, jobExtra);
    } else {
      await store.finishJob(
        job.id,
        failed.length === 0 ? "done" : "failed",
        failed.length > 0 ? `${failed.length} 页未成功：${failed.join("、")}` : undefined,
        jobExtra,
      );
    }

    const cost = `（用量 ${formatTokens(used())} tokens）`;
    const message = cancelled
      ? `已取消，已完成 ${saved.size}/${slugs.length} 页。下次点击会接着写剩下的。${cost}`
      : budgetExceeded
        ? `已达到本次 token 上限，完成 ${saved.size}/${slugs.length} 页。下次点击会接着写剩下的。${cost}`
        : failed.length === 0
          ? `生成完成，共 ${slugs.length} 页。${cost}`
          : `完成 ${saved.size}/${slugs.length} 页，${failed.length} 页未成功：${failed.join("、")}。${cost}`;

    emit({ type: "finished", workspace, ok, done: saved.size, total: slugs.length, failed, message, cancelled: cancelled || undefined, usage: { ...usage }, budgetExceeded: budgetExceeded || undefined });
    return { ok, done: saved.size, total: slugs.length, failed, message, resumed: resumable !== null, usage: { ...usage }, budgetExceeded: budgetExceeded || undefined };
  }
}

/** 同一计划里标题不同但文件名相同的页面（如「A/B」与「A B」）只保留第一个，否则会互相覆盖 */
function dedupeBySlug(pages: PlannedPage[]): PlannedPage[] {
  const seen = new Set<string>();
  return pages.filter((p) => {
    const slug = wikiSlug(p.title);
    if (seen.has(slug)) return false;
    seen.add(slug);
    return true;
  });
}

function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

/** 规划阶段的提示词（方法论在 skill 正文里，这里只给本次的具体任务） */
function buildPlanPrompt(workspace: string, existingTitles: string[], maxPages: number): string {
  const head =
    `请为工作区 \`${workspace}\` 规划项目 Wiki 的页面清单。\n\n` +
    `先用只读工具勘察仓库（顶层结构、README / 配置文件、核心模块），弄清这是什么项目、主干在哪，` +
    `再决定页面划分。完成后用 wiki_plan_pages 一次性提交完整清单。\n\n` +
    // 明确给出上限与理由：页数直接等于花费，让模型知道「名额有限、要挑重点」，
    // 而不是列出一份超出预算的清单再被代码截断（那样前 N 页的取舍就变成了听天由命）。
    `**最多 ${maxPages} 页**（超出只会取前 ${maxPages} 页）。请把有限的名额留给最值得长期留存的主干内容，` +
    `不要把名额花在看代码就明白的细节上。\n\n` +
    // 分类是页面在侧边栏的归属依据。必须在这里讲清候选集合：
    // 让模型自由发明类别名，结果会是每页一个类，分组比平铺更难找。
    `**每页都要指定 category**，从这五个词里选一个（决定它在列表里归入哪一组）：\n` +
    `- 概览：这是什么项目、技术栈、怎么跑起来\n` +
    `- 架构：整体怎么搭起来的（路由、外壳、分层、主题这类骨架）\n` +
    `- 领域：业务概念与数据（数据模型、核心对象、账本口径）\n` +
    `- 功能：具体页面或模块的实现（某页做什么、怎么交互）\n` +
    `- 约定：规范、坑、非显而易见的决定（组件库用法、命名约束）\n`;

  if (existingTitles.length === 0) {
    return `${head}\n本仓库尚无 Wiki 页面。`;
  }
  // 告知已有页面：避免为同一主题换名字产出重复页，也让规划者能判断哪些需要保留、哪些该合并
  const list = existingTitles.map((t) => `- ${t}`).join("\n");
  return (
    `${head}\n` +
    `本仓库已有以下页面（沿用它们的标题即可，不要为同一主题另起名字）：\n${list}\n\n` +
    `若代码已有较大变化、现有划分已不合适，也可以重新组织 —— 规划以当前代码为准。`
  );
}

/** 撰写阶段的提示词（只聚焦这一页） */
function buildPagePrompt(workspace: string, page: { title: string; summary: string; sources: string[]; category?: string }): string {
  const lines = [
    `请撰写 Wiki 页面《${page.title}》，工作区 \`${workspace}\`。`,
    ``,
    `本页定位：${page.summary}`,
  ];
  // 撰写阶段也带上分类：保存时它要随 wiki_save_page 一起提交，
  // 否则页面会落成「未分类」，在侧边栏里进不了任何一组。
  if (page.category) lines.push(`本页分类：${page.category}（保存时请在 category 参数中原样带上）`);
  if (page.sources.length > 0) {
    lines.push(``, `规划时拟依据以下文件（请真的去读；若发现更贴切的依据，可以调整，但必须是你确实读过的）：`);
    for (const s of page.sources) lines.push(`- ${s}`);
  }
  lines.push(
    ``,
    `只聚焦这一页，不要顺手写别的页面。完成后用 wiki_save_page 提交（工具会立即落盘，无需再确认）。`,
  );
  return lines.join("\n");
}
