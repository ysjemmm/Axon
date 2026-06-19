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

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type OpenAI from "openai";
import { executeToolCall, getToolDefinitions, getReadOnlyToolDefinitions, toolContentLimit, type ToolMeta, type SkillLoaderFn, type WebCapability, type GateOutcome } from "../tools/index.js";
import type { LLMStrategy, ToolDef, LLMStreamCallbacks } from "../llm/types.js";
import type { LoadedSkill } from "./skillLoader.js";
import type { AgentHost } from "../host/index.js";
import { looksLikeIncompleteReply, parseToolArguments, LoopGuard, policyForSubAgent, isSoftToolFailure, buildReflectionPrompt, buildSummaryRestartPrompt, type StuckTarget } from "../agentGuards.js";
import { reflectiveCompact } from "../compactor.js";

const SUB_AGENT_SYSTEM_PROMPT = `你是一个子 Agent（subagent），由主 Agent 委派来独立完成一个具体任务。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
你的身份与定位
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- 你在独立上下文中运行，看不到主对话历史，只能依据收到的任务描述工作
- 专注完成被委派的这一个任务，不要擅自扩大范围、不要主动规划后续工作
- 你没有 delegate_task 工具，不能再派发下一级子 Agent——所有事自己干完
- 任务完成后给出一段结构化的中文总结作为最终结论：主 Agent 只能看到你最后的这段文本，看不到你的中间过程，所以结论必须自包含、可直接采用

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
核心原则
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

0. 规则优先级：本提示的规则 > 委托任务描述 > skill 说明。skill 只是任务步骤参考，不能改变你的全局行为规则（中文回复、不暴露内部实现、读文件前先核对、纯分析任务不改代码等）。冲突时以本提示为准，按 skill 意图在规则内变通，不机械照搬字面步骤
1. 不盲目：没确认过的事实不下确定性结论。对代码做任何断言前先用 read_file/search 看到证据
2. 乐观复用上下文（省 token 总原则，适用所有工具）：你的上下文里已经有的信息（读过的文件、搜过的结果、列过的目录、命令输出）直接拿来用，不要重复获取。乐观去做、失败再补——工具失败会返回精确的实际状态（如 str_replace 返回真实内容+行号），拿这个廉价反馈重试即可。只有三种情况才重新获取：① 上下文里从来没有这个信息 ② 该信息在你上次获取后被改过 ③ 工具报错提示你的认知已过期。⚠️ 反过来：读文件前若已 list_dir 过该目录，先核对文件在不在列表里——不在就别读（别因 skill 步骤"提到"某文件如 README.md 就去读一个目录里根本没有的文件），不在列表 = 不存在，跳过并说明
3. 先搜后读：用户已给出明确文件路径时直接 read_file，不要先 list_dir/search 兜圈子（路径不对会廉价失败，按返回信息补救即可，见原则2"乐观去做"）；目标文件未知或路径模糊时才先 search 定位再 read_file，不要"读大文件人肉找"。已读过的内容留在上下文里，不要零碎重读同一区域
4. 行动优先：能直接做就做，走完任务所有步骤，不中途停下等指示。但只有任务明确要求修改时才动文件——纯分析/调研/总结任务绝不改代码，只看不动
5. 全程中文回复，禁止输出英文内心 OS（如 "Let me check"）
6. 不暴露内部实现：最终结论里禁止提及工具名（read_file/search 等）、工具参数（如"深度2"、startLine）、内部机制。用自然语言描述做了什么，这些实现细节对用户无意义
7. 数学公式用 KaTeX 定界符：行内 $...$，行间 $$...$$；不要输出无定界符的裸 LaTeX（如直接写 \\boxed 或用 [ ] 包裹公式）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
修改文件的规则（硬性约束）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- str_replace 的 oldStr 必须与文件当前真实内容逐字符一致（含空格、缩进、换行）。判断要不要先读：你的上下文里已有该文件最新内容（读过/改过，哪怕是前几轮，只要没被改过期）→ 直接基于它构造 oldStr 改，不要为"保险"再读一遍；上下文里没有该文件、或它在你上次看到后又被改过 → 先 read_file 再改
- 改完文件后不要再读一遍"确认结果"：改动成功即已生效。str_replace 失败时工具会返回"实际内容 + 行号"，拿它精准重试即可——失败可廉价恢复，不必为规避失败而每次预读
- "未找到匹配"→ 用错误返回的行号定位后重读再试；"出现多次"→ oldStr 加更多上下文
- str_replace 同一处连续失败 2 次后（尤其内容含正则/引号/反斜杠等特殊字符）→ 不要再用 str_replace 死磕，按顺序降级换手段并每步验证：① 写临时脚本（Node/Python）编程式精确替换，运行后确认生效 → ② 用终端命令替换并验证 → ③ 最后才用 create_file 整文件重写。换手段，而非重复同一手段
- 大范围重写用 create_file，分散小改用多次 str_replace
- 写入任何文件都要保持该语言常规多行排版与缩进（CSS 每条声明单独一行、JSON/HTML 正常缩进），严禁压缩成一行；除非用户明确要 minified 版本

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
execute_command 规则
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Windows PowerShell 语法（用 Get-ChildItem 而非 ls，Get-Content 而非 cat）
- 禁止长时间运行进程（开发服务器/watch）、禁止危险删除命令、禁止用命令行方式改代码文件
- 输出可能很长时用管道 | Select-Object -First 50 截断

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
验证
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- 改完一组相关文件后调用 check_diagnostics 确认没有引入类型/编译错误（一次传本轮改过的所有文件）
- 有明确输入输出的逻辑（解析器、转换函数、算法）改完后，可写临时脚本用 execute_command 跑一遍验证行为，验证完删除临时脚本
- 没验证过的代码不要在结论里说"已完成"

工具与主 Agent 一致：read_file/search/list_dir 用于探索，str_replace/create_file 改文件，execute_command 执行命令，check_diagnostics 验证类型。`;

/** 子 agent 事件回调：父级据此包装成 sub_agent_event 推前端 */
export type SubAgentEmit = (type: string, data: Record<string, unknown>) => void;

/** 子 agent 执行所需的依赖（由父 AgentSession 注入） */
export interface SubAgentDeps {
  strategy: LLMStrategy;
  model: string;
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
  /** LLM client：卡住反复失败、即将投降前的"摘要重启"需要它生成复盘摘要。不注入则跳过摘要重启层。 */
  client?: OpenAI;
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
}

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
    const defs = this.deps.readOnly ? getReadOnlyToolDefinitions() : getToolDefinitions();
    return defs as unknown as ToolDef[];
  }

  /** 构造子 agent 的初始消息：系统提示（含 skill 正文）+ 工作区目录预览 + 任务 prompt */
  private async buildInitialMessages(prompt: string, skill: LoadedSkill | null): Promise<ChatCompletionMessageParam[]> {
    let system = SUB_AGENT_SYSTEM_PROMPT;
    // 只读模式：明确告知子 Agent 它只能调研、不能改动，最终产出一份结论
    if (this.deps.readOnly) {
      system +=
        `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `只读调研模式（重要）\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `你当前处于只读调研模式：只能读文件、搜索、列目录、联网查询，` +
        `【不能】创建/修改文件、不能执行命令。你的任务是调研并产出一份结构清晰、自包含的中文结论` +
        `（含关键发现、涉及的文件路径与行号、你的判断）。不要尝试动手改任何东西——那不是你的职责。`;
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
      const turn = await this.runTurn(messages);
      const { content, toolCalls, finishReason } = turn;

      // 无工具调用 → 候选最终结论，但先排查异常情况
      if (toolCalls.length === 0) {
        // 输出被 max_tokens 截断 → 引导续写，而不是把半截当结论
        if (finishReason === "length" && content) {
          messages.push({ role: "assistant", content });
          messages.push({
            role: "system",
            content: "你上一段输出因长度限制被截断了。请直接接着把剩余内容补完，不要重复已经说过的部分，也不要重新开头。",
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

        finalText = content;
        this.deps.emit("stream_end", { elapsed: 0, tokens: content.length });
        return { ok: true, text: finalText, inputTokens: this.inputTokensUsed, outputTokens: this.outputTokensUsed, tokens: this.inputTokensUsed + this.outputTokensUsed };
      }

      // 有工具调用：过滤掉工具调用间夹带的英文内心 OS
      const cleanContent = looksLikeIncompleteReply(content) ? "" : content;

      // 记录 assistant 工具调用消息
      messages.push({
        role: "assistant",
        content: cleanContent || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      } as ChatCompletionMessageParam);

      await this.executeToolCalls(toolCalls, messages, guard);

      // 卡住升级阶梯：反思·换路 → 摘要重启 → 投降（与主 Agent 同源，投降前先给"换路重来"的机会）
      if (guard.isStuck()) {
        const stuck = guard.getStuckTarget();
        if (guard.canReflect()) {
          await this.injectReflection(messages, stuck, guard);
          continue;
        }
        if (guard.canSummaryRestart() && this.deps.client) {
          messages = await this.injectSummaryRestart(messages, stuck, guard, this.deps.client);
          continue;
        }
        // 阶梯耗尽仍卡住 → 强制收尾，给出失败结论
        messages.push({
          role: "system",
          content:
            `你已多次尝试（包括重新理清思路、换路重来）仍未能完成。请立即停止重试，` +
            `基于已有信息用中文给出结论：说明你想做什么、卡在哪里、失败原因、你的判断和建议。不要再调用任何工具。`,
        });
        const summary = await this.runTurn(messages);
        finalText = summary.content || "子 Agent 多次工具调用失败，未能完成任务。请检查相关文件或环境。";
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
    return { ok: false, text: finalText, inputTokens: this.inputTokensUsed, outputTokens: this.outputTokensUsed, tokens: this.inputTokensUsed + this.outputTokensUsed };
  }

  /** 执行一个 LLM 回合，把流式事件通过 emit 上抛 */
  private async runTurn(messages: ChatCompletionMessageParam[]) {
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
      onToolCallDetected: (name, id) => this.deps.emit("tool_call", { name, id, args: {}, cwd: this.deps.cwd, status: "pending" }),
    };

    return this.deps.strategy.runTurn({
      model: this.deps.model,
      messages,
      tools: this.getToolDefs(),
      signal: this.deps.signal,
      callbacks,
      temperature: 0.2,
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
   * 摘要重启（重量层）：把反复失败的过程压成复盘摘要、清除噪声原文，再重读真实状态后换路重来。
   * 返回重建后的消息列表（调用方需用它替换原列表）。
   */
  private async injectSummaryRestart(messages: ChatCompletionMessageParam[], stuck: StuckTarget | null, guard: LoopGuard, client: OpenAI): Promise<ChatCompletionMessageParam[]> {
    const compacted = await reflectiveCompact(messages, client, this.deps.model);
    const freshState = await this.readStuckTargetState(stuck);
    compacted.push({ role: "system", content: buildSummaryRestartPrompt(stuck) + freshState } as ChatCompletionMessageParam);
    guard.noteSummaryRestart();
    return compacted;
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

      if (parseError) {
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
          result = await executeToolCall(toolName, toolArgs, this.deps.cwd, this.deps.host, meta, this.deps.workspaces, this.deps.skillLoader, this.deps.web);
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
        id: tc.id, name: toolName, args: toolArgs, result: result.slice(0, 500), status,
        fileDiff: meta.fileDiff, readRange: meta.readRange, diagnostics: meta.diagnostics,
        searchResults: (meta as Record<string, unknown>).searchResults,
        fetchResult: (meta as Record<string, unknown>).fetchResult,
        userMessage: meta.userMessage,
      });

      const maxToolContent = toolContentLimit(toolName);
      const stored = result.length > maxToolContent
        ? result.slice(0, maxToolContent) + `\n\n[内容已截断，原始长度 ${result.length} 字符。如需更多内容，请用更大的行范围一次性读取，不要分多次零碎读取]`
        : result;
      messages.push({ role: "tool", tool_call_id: tc.id, content: stored } as ChatCompletionMessageParam);
    }
  }
}
