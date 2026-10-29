/**
 * 子 Agent 执行器 - 在隔离上下文中执行一个被委托的任务
 *
 * 设计要点（对齐 Superpowers + Kiro 的 subagent 模式）：
 * - 完全隔离：不继承父 agent 的对话历史，只接收一段任务 prompt + 可选 skill 正文
 * - 独立循环：自带精简版 agent loop（工具调用 + 流式），复用父级的 LLM 策略和工具实现
 * - 限 1 层递归：工具集不含 delegate_task，子 agent 无法再派发孙 agent
 * - 实时事件：所有中间事件通过 emit 回调上抛，由父级包装成 sub_agent_event 推送前端
 * - 默认 auto 落盘：子 agent 独占执行，改动直接落盘（不走待确认流程）
 *
 * 返回值：子 agent 的最终文本回复，作为工具结果回填给父 agent。
 */

import { coerceToolArgs, schemaForTool } from "../tools/argCoercion.js";
import { preNormalizeArgs } from "../tools/argPreNormalize.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { executeToolCall, getToolDefinitions, getReadOnlyToolDefinitions, getWikiToolDefinitions, getWikiPlanToolDefinitions, capToolContent, FULL_RESULT_TOOLS, ToolCallStatus, type ToolMeta, type SkillLoaderFn, type WikiTools, type WebCapability, type GateOutcome } from "../tools/index.js";
import type { LLMStrategy, ToolDef, LLMStreamCallbacks } from "../llm/types.js";
import type { LoadedSkill } from "./skillLoader.js";
import type { AgentHost } from "../host/index.js";
import { looksLikeIncompleteReply, parseToolArguments, LoopGuard, policyForSubAgent, isSoftToolFailure, buildReflectionPrompt, buildSummaryRestartPrompt, type StuckTarget } from "../agentGuards.js";
import type { NormalizedFinishReason } from "../llm/finishReasonMapper.js";
import { SUB_AGENT_SYSTEM_PROMPT } from "../systemPrompt.js";
import { buildEnvironmentNotice } from "../environment.js";


/** 子 agent 事件回调：父级据此包装成 sub_agent_event 推前端 */
export type SubAgentEmit = (type: string, data: Record<string, unknown>) => void;

/**
 * 子 Agent 全局并发闸门。
 *
 * 为什么要有：上层一次可以请求很多个子 Agent —— parallel_research / parallel_execute 天生是批量
 * 派发，模型也可能在同一轮里连续多次 delegate_task。实测模型很容易一次铺开五六个，
 * 结果是并发请求把网关打限流、token 陡增、前端的折叠卡片糊成一片，而用户根本来不及看。
 * 与其靠提示词劝模型克制（它不一定听），不如在这里做硬约束：同一时刻最多跑两个，
 * 其余的排队等待，拿到名额再开跑。
 *
 * 放在 SubAgentRunner 内部而不是各调用点：所有子 Agent（delegate / parallel / wiki）
 * 都必须经过 run()，闸门设在唯一的必经之处才不会漏。
 */
const MAX_CONCURRENT_SUB_AGENTS = 2;
let activeSubAgents = 0;
const subAgentWaiters: Array<() => void> = [];

/** 取一个并发名额；返回释放函数（幂等，重复调用只生效一次）。 */
async function acquireSubAgentSlot(): Promise<() => void> {
  // while 而非 if：被唤醒后需要重新确认名额（可能被别的等待者先抢走）
  while (activeSubAgents >= MAX_CONCURRENT_SUB_AGENTS) {
    await new Promise<void>((resolve) => subAgentWaiters.push(resolve));
  }
  activeSubAgents++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeSubAgents--;
    const next = subAgentWaiters.shift();
    if (next) next();
  };
}

/** 子 agent 执行所需的依赖（由父 AgentSession 注入） */
export interface SubAgentDeps {
  strategy: LLMStrategy;
  model: string;
  /**
   * 是否允许向模型请求思考。缺省（undefined）按 true 处理，即沿用"支持就开"的既有行为——
   * 这样未显式透传该字段的构造点不会因为本字段的引入而静默改变行为。
   */
  think?: boolean;
  /**
   * 该模型在 provider 目录 / providers.json 里声明的 thinking 能力（未声明则 undefined，
   * 由 strategy 回退到启发式判定）。由构造方用 declaredThinkingFor 解析后注入。
   */
  modelSupportsThinking?: boolean;
  cwd: string;
  workspaces: string[];
  /** 执行端能力（父注入一个独立的 auto 模式 host，子 agent 改动直接落盘） */
  host: AgentHost;
  /** 中断信号（与父 agent 共享，父取消时子也取消） */
  signal?: AbortSignal;
  /** 事件回调（已绑定 delegateId） */
  emit: SubAgentEmit;
  /** use_skill 工具的 skill 加载器（子 agent 也能加载技能到自己的上下文，与父隔离） */
  skillLoader?: SkillLoaderFn;
  /** web 能力（透传给 executeToolCall，支持 web_search/web_fetch） */
  web?: WebCapability;

  /**
   * Wiki 生成能力（规划 / 撰写，分阶段注入）。提供哪一项，工具集里就多出对应的那一个工具：
   *   · plan → wiki_plan_pages（登记页面清单）
   *   · save → wiki_save_page（落盘一页）
   * 只在生成 Wiki 的流程中注入 —— 普通 delegate_task 不传，那些子 Agent 便拿不到这些工具。
   */
  wiki?: WikiTools;

  /**
   * 只读模式：true 时子 Agent 只能用只读工具（read_file/search/list_dir/web_*），
   * 不能写文件或执行命令。用于并行调研——多个子 Agent 同时探索同一工作区零冲突。
   */
  readOnly?: boolean;
  /**
   * 可选：覆盖子 Agent 的轮次上限（默认使用 policyForSubAgent 的 maxRounds=200）。
   * 并行执行的子 Agent 应设一个更紧的上限（如 30），避免陷入长时间循环。
   */
  maxRounds?: number;
  /**
   * 可选：本次运行的 token 上限（输入 + 输出累计）。每轮结束后检查，超出即停止并返回 ok=false。
   * 用于按次计费的长任务（如 Wiki 生成）给单个子 Agent 封顶，防止一个页面把整次预算烧光。
   */
  tokenBudget?: number;
  /**
   * 可选：禁止访问的路径（按工具参数里的 path / paths 判断）。Wiki 撰写者用它挡住 .env、
   * 密钥文件 —— 页面要进 git，撰写者根本不该读到真实的凭据。
   */
  blockPath?: (path: string) => boolean;
  /** 允许写入的工作区外目录（父会话注入：产物 / 产出目录，完全访问模式下含通配 "*"） */
  writeRoots?: () => string[];
  /**
   * 命令信任门（父会话注入）：子 Agent 的 execute_command 在执行前经此门控——
   * 灾难命令硬拦、白名单放行、未信任则把审批冒泡到父会话再到用户。不注入则不门控。
   * @param toolCallId 该命令对应的工具调用 id，透传给前端做内联审批定位
   */
  gateCommand?: (command: string, toolCallId?: string) => Promise<GateOutcome>;
}

/** 子 agent 执行的结构化结果：明确区分成功与失败，供编排者据此决定如何回填上下文 */
export interface SubAgentResult {
  /** 是否成功完成任务（false 表示失败/未形成可信结论） */
  ok: boolean;
  /** 子 agent 的最终文本（成功为结论，失败为尝试过程与失败原因） */
  text: string;
  /** 子 agent 本次执行累计消耗的 input tokens（含其所有回合），供父 Agent 累加 */
  inputTokens: number;
  /** 子 agent 本次执行累计消耗的 output tokens */
  outputTokens: number;
  /** 总 tokens（向后兼容，= inputTokens + outputTokens） */
  tokens: number;
  /** 因超出 tokenBudget 而停止 */
  budgetExceeded?: boolean;
}

function looksLikeInternalToolTrace(text: string): boolean {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;
  return (
    /to=functions\./i.test(trimmed) ||
    /recipient_name/i.test(trimmed) ||
    /tool_uses/i.test(trimmed) ||
    /analysis code/i.test(trimmed) ||
    /"intent"\s*:\s*".*?"[\s\S]*?"tasks"\s*:/i.test(trimmed)
  );
}

function sanitizeSubAgentFinalText(text: string): string {
  const trimmed = (text || "").trim();
  if (!trimmed) return trimmed;
  if (!looksLikeInternalToolTrace(trimmed)) return trimmed;
  return "子 Agent 已完成执行，但最终结论格式异常，混入了内部调试/工具调用痕迹；请以过程卡片中的实际调研步骤为准，由主 Agent 重新整理结论。";
}

/** 网络/网关层瞬时错误：值得重试（DNS/连接失败、超时、429、网关 5xx 等） */
function isTransientNetworkError(err: unknown): boolean {
  const msg = ((err as Error)?.message || "").toLowerCase();
  if (!msg) return false;
  return (
    /\b429\b/.test(msg) ||
    /rate limit|quota|too many requests/.test(msg) ||
    /gateway|upstream|proxy|service unavailable/.test(msg) ||
    /unexpected eof|connection reset|socket hang up|network error|fetch failed|timeout|timed out|econnreset|econnrefused|enotfound/.test(msg)
  );
}

/** 子 Agent 单轮 LLM 调用的最大重试次数（不含首次尝试） */
const SUBAGENT_TURN_MAX_RETRIES = 5;
/** 重试退避基础间隔（ms），指数递增：500 / 1000 / 2000 */
const SUBAGENT_RETRY_BASE_DELAY_MS = 500;

export class SubAgentRunner {
  // 累计本子 Agent 所有回合消耗的 token，run() 返回时上报给父 Agent
  private inputTokensUsed = 0;
  private outputTokensUsed = 0;

  constructor(private deps: SubAgentDeps) {}

  /** 已消耗 token（即便中途被 abort 抛错，也能从外部读取已产生的消耗） */
  getTokensUsed(): number {
    return this.inputTokensUsed + this.outputTokensUsed;
  }

  getInputTokensUsed(): number { return this.inputTokensUsed; }
  getOutputTokensUsed(): number { return this.outputTokensUsed; }

  /** 子 agent 的工具集：复用通用工具，天然不含 delegate_task（限 1 层递归）。
   * 只读模式下进一步收窄到只读工具白名单，保证并行调研并发安全。 */
  private getToolDefs(): ToolDef[] {
    const base = this.deps.readOnly ? getReadOnlyToolDefinitions() : getToolDefinitions();
    // Wiki 工具按阶段注入。刻意不并入 getToolDefinitions()：那是所有会话与子 Agent
    // 共用的公共列表，而这些工具只在生成流程里有意义（没有目标工作区时调用会被拒），
    // 常驻只会白占每轮 schema 篇幅，还可能被误用在无关场景。
    const extra: unknown[] = [];
    // 规划：只登记清单、不写文件，因此只读模式下也允许 ——
    // 只读契约约束的是「不得改动仓库」，而登记计划只发生在内存里。
    if (this.deps.wiki?.plan) extra.push(...getWikiPlanToolDefinitions());
    // 撰写：只写 .axon/wiki/ 下的页面，由调用方显式提供 save 才有。
    // 只读模式下也给：Wiki 撰写者应当「只读仓库 + 只能提交页面」，
    // 不能写别的文件、不能执行命令（被文档化的仓库内容可能含提示注入，见 agentSession.doGenerateWiki）。
    if (this.deps.wiki?.save) extra.push(...getWikiToolDefinitions());
    return [...base, ...extra] as unknown as ToolDef[];
  }

  /** 构造子 agent 的初始消息：系统提示（含 skill 正文）+ 工作区目录预览 + 任务 prompt */
  private async buildInitialMessages(prompt: string, skill: LoadedSkill | null): Promise<ChatCompletionMessageParam[]> {
    let system = `${SUB_AGENT_SYSTEM_PROMPT}\n\n${buildEnvironmentNotice({ commands: !this.deps.readOnly })}`;
    // 只读模式：明确告知子 Agent 它只能调研、不能改动，最终产出一份结论
    if (this.deps.readOnly) {
      system +=
        `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `只读调研模式（重要）\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `你当前处于只读调研模式：只能读文件、搜索、列目录、联网查询，` +
        `【不能】创建/修改文件、不能执行命令。你的任务是调研并产出一份结构清晰、自包含的中文结论` +
        `（含关键发现、涉及的文件路径与行号、你的判断）。不要尝试动手改任何东西——那不是你的职责。` +
        (this.deps.wiki?.save ? `\n例外：本任务的产出是 Wiki 页面，用 wiki_save_page 提交（这是唯一允许的写操作）。` : "");
    }
    if (skill) {
      system +=
        `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `已加载技能：${skill.name}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `请严格按以下技能说明执行任务。技能目录：${skill.dir}\n\n${skill.body}`;
    }

    // 自动预填工作区根目录结构,让子 agent 开局就知道文件在哪,不用猜路径
    let dirPreview = "";
    try {
      dirPreview = await executeToolCall("list_dir", { intent: "预览工作区结构", depth: 2 }, this.deps.cwd, this.deps.host, undefined, this.deps.workspaces);
    } catch { /* 预览失败不阻塞任务 */ }

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: system },
    ];
    if (dirPreview) {
      messages.push({
        role: "system",
        content: `以下是当前工作区的目录结构（自动预览,供你参考路径,不要向用户展示这是"预览"）：\n\n${dirPreview}`,
      });
    }
    messages.push({ role: "user", content: prompt });
    return messages;
  }

  /**
   * 执行被委托的任务，返回结构化成败结果。
   * @param prompt 任务描述
   * @param skill 已加载的 skill（含正文）；无 skill 时为通用任务执行
   */
  async run(prompt: string, skill: LoadedSkill | null): Promise<SubAgentResult> {
    // 并发闸门：超出上限的请求在这里排队，而不是一起打出去。
    const release = await acquireSubAgentSlot();
    try {
      return await this.runInner(prompt, skill);
    } finally {
      release();
    }
  }

  /** run() 的实际实现。已被并发闸门包裹，不要直接调用。 */
  private async runInner(prompt: string, skill: LoadedSkill | null): Promise<SubAgentResult> {
    let messages = await this.buildInitialMessages(prompt, skill);
    const policy = policyForSubAgent(this.deps.model);
    // 子 agent 轮次上限对齐 policy（与主 agent 同源），不再写死
    const MAX_ROUNDS = this.deps.maxRounds ?? policy.maxRounds;
    // 防失控守卫：重复调用指纹、文件重复读、连续失败计数统一收敛到 LoopGuard
    const guard = new LoopGuard(policy);
    let finalText = "";

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // 父 agent 取消时，signal 被 abort，子 agent 立即停止
      if (this.deps.signal?.aborted) {
        return { ok: false, text: finalText || "（任务已取消）", inputTokens: this.inputTokensUsed, outputTokens: this.outputTokensUsed, tokens: this.inputTokensUsed + this.outputTokensUsed };
      }
      const turn = await this.runTurnWithRetry(messages);
      const { content, toolCalls } = turn;
      if (this.deps.tokenBudget && this.inputTokensUsed + this.outputTokensUsed > this.deps.tokenBudget) {
        return { ok: false, text: finalText || "（已超出本次任务的 token 预算，已停止）", inputTokens: this.inputTokensUsed, outputTokens: this.outputTokensUsed, tokens: this.inputTokensUsed + this.outputTokensUsed, budgetExceeded: true };
      }
      // 消费归一化后的产品语义结束原因（策略层保证已填充）；协议原始 finishReason 不再在此点直接判断。
      const finishReason: NormalizedFinishReason = turn.normalizedFinishReason;

      // 无工具调用 → 候选最终结论，但先排查异常情况
      if (toolCalls.length === 0) {
        // 输出被截断（truncated，对应 max_tokens）→ 引导续写，而不是把半截当结论
        if (finishReason === "truncated" && content) {
          messages.push({ role: "assistant", content });
          messages.push({
            role: "user",
            content: "（系统提示：你的上一段输出到达了长度上限。请从中断处继续，输出剩余内容。直接输出下一段，保持前后衔接。）",
          });
          continue;
        }

        // reasoning 泄露（英文内心 OS / "我还需要.."）→ 引导纠正
        if (looksLikeIncompleteReply(content)) {
          const exceeded = guard.noteIncompleteRetry();
          messages.push({ role: "assistant", content });
          if (exceeded) {
            messages.push({
              role: "system",
              content: "你已多次输出未完成的内心 OS。现在必须基于已有信息，要么调用一个具体工具继续推进，要么给出完整的中文最终结论。二选一，不要再输出任何英文思考片段。",
            });
          } else {
            messages.push({
              role: "system",
              content:
                `你刚才输出的是内心思考（英文片段或"我还需要看 X"这类），不是最终结论。立即二选一：\n` +
                `1. 还需要信息 → 直接调用工具（read_file/search 等）\n` +
                `2. 信息已够 → 给出完整、结构化的中文最终结论\n` +
                `不要再输出英文思考片段。`,
            });
          }
          continue;
        }

        finalText = sanitizeSubAgentFinalText(content);
        this.deps.emit("stream_end", { elapsed: 0, tokens: content.length });
        return { ok: true, text: finalText, inputTokens: this.inputTokensUsed, outputTokens: this.outputTokensUsed, tokens: this.inputTokensUsed + this.outputTokensUsed };
      }

      // 记录 assistant 工具调用消息。
      // displayContent 保留给上层展示；runtimeContent 不带入下一轮模型上下文，避免 reasoning prose 污染。
      messages.push({
        role: "assistant",
        content: content || null,
        displayContent: content || null,
        runtimeContent: null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      } as ChatCompletionMessageParam);

      await this.executeToolCalls(toolCalls, messages, guard);

      // 卡住升级阶梯：反思·换路 → 深度复盘 → 投降（与主 Agent 同源，投降前先给"换路重来"的机会）
      if (guard.isStuck()) {
        const stuck = guard.getStuckTarget();
        if (guard.canReflect()) {
          await this.injectReflection(messages, stuck, guard);
          continue;
        }
        if (guard.canSummaryRestart()) {
          await this.injectSummaryRestart(messages, stuck, guard);
          continue;
        }
        // 阶梯耗尽仍卡住 → 强制收尾，给出失败结论
        messages.push({
          role: "system",
          content:
            `你已多次尝试（包括重新理清思路、换路重来）仍未能完成。请立即停止重试，` +
            `基于已有信息用中文给出结论：说明你想做什么、卡在哪里、失败原因、你的判断和建议。不要再调用任何工具。`,
        });
        const summary = await this.runTurnWithRetry(messages);
        finalText = sanitizeSubAgentFinalText(summary.content || "子 Agent 多次工具调用失败，未能完成任务。请检查相关文件或环境。");
        this.deps.emit("stream_end", { elapsed: 0, tokens: finalText.length });
        return { ok: false, text: finalText, inputTokens: this.inputTokensUsed, outputTokens: this.outputTokensUsed, tokens: this.inputTokensUsed + this.outputTokensUsed };
      }
    }

    // 兜底：循环耗尽（已达安全阀上限 ${MAX_ROUNDS} 轮仍未收尾）。正常任务几乎不会走到这里，
    // 走到这里说明任务确实很复杂或卡住了，给中性措辞并交出已有进展，不判刺眼的失败。
    if (!finalText) {
      finalText = "任务步骤较多，子 Agent 在多轮探索后仍未形成明确结论，可能任务过于复杂或需要拆分。以下没有可呈现的最终结果。";
      this.deps.emit("stream_end", { elapsed: 0, tokens: finalText.length });
    }
    return { ok: false, text: sanitizeSubAgentFinalText(finalText), inputTokens: this.inputTokensUsed, outputTokens: this.outputTokensUsed, tokens: this.inputTokensUsed + this.outputTokensUsed };
  }

  /**
   * 带重试的单轮调用：仅对网络/网关瞬时错误重试（最多 3 次，指数退避），
   * 其他错误（参数错误/认证失败等）直接抛出，不浪费重试次数。
   * 每次重试前通过 emit 推一条状态提示，让用户知道发生了什么，而不是静默等待或裸抛 "fetch failed"。
   */
  private async runTurnWithRetry(messages: ChatCompletionMessageParam[]): ReturnType<SubAgentRunner["_doRunTurn"]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= SUBAGENT_TURN_MAX_RETRIES; attempt++) {
      try {
        return await this._doRunTurn(messages);
      } catch (err) {
        lastErr = err;
        if (!isTransientNetworkError(err) || attempt === SUBAGENT_TURN_MAX_RETRIES) {
          throw err;
        }
        const delay = SUBAGENT_RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        this.deps.emit("status", {
          content: `请求失败（${(err as Error).message}），${delay}ms 后重试（第 ${attempt + 1}/${SUBAGENT_TURN_MAX_RETRIES} 次）...`,
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    // 理论上不可达（循环内已 return 或 throw），仅为满足类型检查
    throw lastErr;
  }

  /** 执行一个 LLM 回合，把流式事件通过 emit 上抛 */
  private _doRunTurn(messages: ChatCompletionMessageParam[]) {
    let streamStarted = false;
    const callbacks: LLMStreamCallbacks = {
      onReasoningDelta: (text) => this.deps.emit("reasoning_delta", { content: text }),
      onTextDelta: (text) => {
        if (!streamStarted) {
          this.deps.emit("stream_start", {});
          streamStarted = true;
        }
        this.deps.emit("stream_delta", { content: text });
      },
      // 与主会话一致：流式阶段检测到工具只代表"还没开始跑"，此刻参数仍在累加（子 agent 同样串行执行）
      onToolCallDetected: (name, id) => this.deps.emit("tool_call", { name, id, args: {}, cwd: this.deps.cwd, status: ToolCallStatus.Queued }),
    };

    return this.deps.strategy.runTurn({
      model: this.deps.model,
      messages,
      tools: this.getToolDefs(),
      signal: this.deps.signal,
      callbacks,
      temperature: 0.2,
      think: this.deps.think,
      modelSupportsThinking: this.deps.modelSupportsThinking,
    }).then((turn) => {
      // 累计本回合 input/output token，run() 结束时上报父 Agent
      if (turn.usage) {
        this.inputTokensUsed += turn.usage.promptTokens || 0;
        this.outputTokensUsed += turn.usage.completionTokens || 0;
      }
      return turn;
    });
  }

  /**
   * 反思·换路（重量层）：卡在某目标反复失败时，重读其真实状态 + 注入复盘引导，给一次"换路"机会。
   */
  private async injectReflection(messages: ChatCompletionMessageParam[], stuck: StuckTarget | null, guard: LoopGuard): Promise<void> {
    const freshState = await this.readStuckTargetState(stuck);
    messages.push({ role: "system", content: buildReflectionPrompt(stuck) + freshState } as ChatCompletionMessageParam);
    guard.noteReflected();
  }

  /**
   * 深度复盘（重量层）：反思后仍反复失败时，注入更强的复盘引导。
   * 不压缩上下文--失败原文是避免重蹈覆辙的依据。
   */
  private async injectSummaryRestart(messages: ChatCompletionMessageParam[], stuck: StuckTarget | null, guard: LoopGuard): Promise<void> {
    const freshState = await this.readStuckTargetState(stuck);
    messages.push({ role: "system", content: buildSummaryRestartPrompt(stuck) + freshState } as ChatCompletionMessageParam);
    guard.noteSummaryRestart();
  }

  /** 重读卡住目标的最新真实内容（仅当卡在某个文件上时）；失败不阻塞，返回空串。 */
  private async readStuckTargetState(stuck: StuckTarget | null): Promise<string> {
    if (!stuck?.path) return "";
    try {
      const content = await executeToolCall("read_file", { path: stuck.path }, this.deps.cwd, this.deps.host, {}, this.deps.workspaces);
      return `\n\n以下是 ${stuck.path} 的最新真实内容，请基于它（而不是你记忆中的旧状态）重新规划：\n${content}`;
    } catch {
      return "";
    }
  }

  /** 依次执行本回合的工具调用，结果回填 messages 并 emit 给前端。失败计数由 guard 跟踪。 */
  private async executeToolCalls(
    toolCalls: { id: string; name: string; arguments: string }[],
    messages: ChatCompletionMessageParam[],
    guard: LoopGuard,
  ): Promise<void> {
    for (const tc of toolCalls) {
      // 已取消：停止执行剩余工具
      if (this.deps.signal?.aborted) break;
      const toolName = tc.name;
      // 健壮解析参数：非法 JSON（如未转义的 Windows 路径）不静默吞成空参数，
      // 而是当作工具失败反馈给模型重写
      let toolArgs: Record<string, unknown> = {};
      let parseError = "";
      try {
        toolArgs = parseToolArguments(tc.arguments);
        const prepared = coerceToolArgs(toolName, preNormalizeArgs(toolName, toolArgs), schemaForTool(this.getToolDefs() as never, toolName));
        toolArgs = prepared.args;
        if (prepared.error && Object.keys(toolArgs).length > 0) parseError = prepared.error;
      } catch (err) {
        parseError = (err as Error).message;
      }

      this.deps.emit("tool_call", { id: tc.id, name: toolName, args: toolArgs, cwd: this.deps.cwd, status: "executing" });

      const verdict = guard.checkToolCall(toolName, tc.arguments);

      // 命令信任门：execute_command / start_process 在执行前先过父会话注入的 gate（灾难硬拦 / 白名单 / 冒泡审批）
      let gateOutcome: GateOutcome | null = null;
      if (!parseError && verdict.allowed && (toolName === "execute_command" || toolName === "start_process") && this.deps.gateCommand) {
        const command = String((toolArgs as { command?: unknown }).command ?? "");
        gateOutcome = await this.deps.gateCommand(command, tc.id);
      }

      let result: string;
      let status: "success" | "error" = "success";
      const meta: ToolMeta = {};
      // 执行前再核一遍工具是否在本次的工具集里：模型可能凭记忆调用没提供给它的工具
      // （例如只读子 Agent 调 execute_command）。只靠「不给 schema」挡不住，必须在执行处拦。
      const offered = (this.getToolDefs() as unknown as { function?: { name?: string } }[]).some((d) => d.function?.name === toolName);

      const argPaths = [toolArgs.path, ...(Array.isArray(toolArgs.paths) ? toolArgs.paths : [])].filter((x): x is string => typeof x === "string");
      const blocked = this.deps.blockPath ? argPaths.find((x) => this.deps.blockPath!(x)) : undefined;

      if (!offered) {
        result = `工具 ${toolName} 在本任务中不可用。请只使用提供给你的工具。`;
        status = "error";
      } else if (blocked) {
        result = `${blocked} 可能存放密钥或凭据，本任务不允许读取。写文档不需要真实的密钥值，跳过这个文件即可。`;
        status = "error";
      } else if (parseError) {
        result = parseError;
        status = "error";
      } else if (!verdict.allowed) {
        result = verdict.message || "调用被拦截。";
        status = "error";
      } else if (gateOutcome && !gateOutcome.allow) {
        // 信任门未放行（灾难命令 / 用户拒绝）→ 当作工具失败反馈给模型，不执行
        result = gateOutcome.aiMessage || "命令未执行。";
        if (gateOutcome.userMessage) meta.userMessage = gateOutcome.userMessage;
        status = "error";
      } else {
        try {
          result = await executeToolCall(toolName, toolArgs, this.deps.cwd, this.deps.host, meta, this.deps.workspaces, this.deps.skillLoader, this.deps.web, undefined, this.deps.signal, this.deps.wiki, this.deps.writeRoots?.());
          // 同文件重复读检测
          if (toolName === "read_file" && typeof toolArgs.path === "string") {
            result += guard.noteFileRead(toolArgs.path);
          }
        } catch (err) {
          result = `错误: ${(err as Error).message}`;
          status = "error";
        }
      }

      // 软失败（str_replace 未匹配 / 参数 JSON 非法）不计入连续失败，给模型纠错重试空间
      const softFail = status === "error" && (!!parseError || isSoftToolFailure(toolName, result));
      guard.recordToolResult(status === "success", softFail, { toolName, args: toolArgs });

      this.deps.emit("tool_result", {
        // 与主 Agent 同一口径：结论型/终端类发完整结果（终端类受硬上限约束），其余 500 字符预览
        id: tc.id, name: toolName, args: toolArgs, result: FULL_RESULT_TOOLS.has(toolName) ? capToolContent(toolName, result) : result.slice(0, 500), status,
        fileDiff: meta.fileDiff, readRange: meta.readRange, diagnostics: meta.diagnostics,
        searchResults: (meta as Record<string, unknown>).searchResults,
        fetchResult: (meta as Record<string, unknown>).fetchResult,
        userMessage: meta.userMessage,
      });

      const stored = capToolContent(toolName, result);
      messages.push({ role: "tool", tool_call_id: tc.id, content: stored } as ChatCompletionMessageParam);
    }
  }
}
