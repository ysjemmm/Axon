/**
 * PromptBuilder —— 请求消息与注入构建（从 AgentSession 解耦）
 *
 * 职责单一：把"会话当前状态"翻译成发给 LLM 的消息数组。包含：
 * - GPT 系冗长度校准
 * - IDE 上下文提示（活动文件/选区/git diff）
 * - 多工作区 / 终端 cwd / skill / power / 上下文使用率等 system 注入（缓存友好模型按轮锚在用户消息之前）
 * - 瞬态工具结果过滤、消息配对清洗、旧工具结果摘要截断
 *
 * 设计：本类不持有状态，只通过构造注入的 session 引用读取会话当前状态（@internal 字段），
 * 绝不修改 session 状态。messageText 为无状态纯函数，单独导出供 token 估算等复用。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { sanitizeToolPairing } from "../messageSanitizer.js";
import type { AgentSession } from "../agentSession.js";
import { workspaceOfPath } from "./focusWorkspace.js";
import { buildEnvironmentNotice } from "../environment.js";
import { requestProtocolFor } from "../providers.js";

/*
 * 关于「不要给注入块加说明」—— 这里曾有过一条自我介绍的说明文字（先后两版），
 * 目的是压掉模型每轮开头那句"这是注入内容，我当参考材料看"。两版都无效，原因不在措辞：
 *
 * 实测对比 —— 未加说明的历史会话里，reasoning 段提到注入的占比约 0.0%
 * （98703 段中 15 处、887542 段中 105 处，且多为代码里 injected/attached 等词）；
 * 而加了说明的会话里这一比例是 6.7%。差别不在提示词，而在于**可见回复被写进了历史**：
 * 一旦助手在某轮说过"这段是注入内容，我不当指令执行"，这句话就成为少样本范例，
 * 之后每轮都照演一遍（推理本身不持久化，但可见回复会）。
 *
 * 所以结论是：注入块本身不需要任何自我介绍；该做的恰恰是**不去谈论它**。
 * 谁若想再加说明，先解释清楚为什么它不会重新制造上面那个循环。
 */

/** 取一条消息的纯文本内容（兼容 string 与多模态 parts） */
export function messageText(m: ChatCompletionMessageParam): string {
  if (!m) return "";
  const c = (m as { content?: unknown }).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return (c as Array<{ type?: string; text?: string }>).map((p) => (p.type === "text" ? p.text || "" : "")).join("");
  }
  return "";
}

export class PromptBuilder {
  constructor(private readonly s: AgentSession) {}

  /**
   * 本轮定格的"随工具执行而变"的注入（终端 cwd 提示、工作区聚焦提示）。
   *
   * ⚠️ 为什么必须定格：Anthropic / Responses 协议把所有 system 消息合并成顶层 system /
   * instructions，放在全部对话之前。所以尾部注入在这两条链路上其实位于前缀**最开头**——
   * 任何一条注入在两次请求之间变了，整段前缀缓存从第一个字节起失效，这次请求按全价重算。
   *
   * 实测：终端 cwd 提示随每次 execute_command 的 cwd 实时变化，同一轮中凡是"上一条命令换了目录"
   * 的请求都比相邻请求贵约 3 倍（0.8 → 2.7 credit）。工作区聚焦同理，随用户切换活动文件而变。
   *
   * 所以这两条在 beginTurn() 时算一次，本轮之内逐字节不变；下一轮开头再刷新。
   * 回归测试见 promptBuilder.injectionStability.test.ts。
   */
  private turnFrozen: FrozenInjections | null = null;

  /**
   * 除当前用户回合外，再保留最近几个**用户回合**的 reasoning_content；更早的【删除字段】。
   *
   * ── 边界是「用户回合」，不是「带思考的消息条数」 ──
   * 当前回合（最后一条真实用户消息之后）的思考必须原样回传：做到第 5 步时，模型要看得到
   * 自己前 4 步是怎么想的，否则只能凭 tool_calls 重新推一遍思路——每一步都从
   * 「用户让我按方向 A……」重新起头，正是要消除的那种复述。DeepSeek 官方文档同样要求
   * 带 tools 时本回合的 reasoning_content 完整回传（见 turnFinalizer），其服务端对更早回合
   * 的思考本来也会丢弃。早先按条数清（值为 0 时连当前回合一起清空）就踩了这一点。
   *
   * ── 为什么之前的回合是 0（全部清空）而不是"保留最近三轮" ──
   * 先试过保留最近 3 轮，实测无效：那 3 轮本身就已经是同一种句式的复制品
   * （"用户选择了X，我先摸清Y"），保留下来等于把 3 个范例原样喂回去，模型照抄。
   * 这类重复只需要【一个】样本就足以形成 few-shot，所以「少留几轮」不解决问题，必须清零。
   *
   * ── 为什么删字段而不是置空 ──
   * 早先保留空字符串 `""` 以满足"字段存在性"，但 DeepSeek 校验的是"原样回传"而非"字段存在"：
   * 空字符串会触发 400 `reasoning_content must be passed back to the API`。
   * 删掉字段的语义是"这条消息没有思考"，DeepSeek 服务端对更早回合的思考本来也会丢弃，
   * 不会因为字段缺失而报错。任务脉络仍由 tool_calls 与工具结果完整承载，不缺信息。
   *
   * ── 缓存代价 ──
   * 回合之内被清空的集合不变，每一步的前缀逐字节稳定；只有新回合开始时，上一回合的思考
   * 从「有内容」变成「删除」，前缀从上一回合的第一条思考处断开一次（每回合一次，不是每步一次）。
   */
  private static readonly REASONING_KEEP_PREVIOUS_TURNS = 0;

  /** 每轮开头调用：按当前状态定格本轮的易变注入 */
  beginTurn(): void {
    this.turnFrozen = this.computeVolatile();
  }

  /** 终端 cwd 与主工作区不同时的提示（实时计算；请求组装应经由 turnFrozen 取值） */
  private buildTerminalCwdNotice(): string | null {
    if (this.s.terminalCwd === this.s.cwd) return null;
    return `⚠️ 注意：Axon 终端当前工作目录为 \`${this.s.terminalCwd}\`，与主工作区不同。execute_command 不传 cwd 时将在此目录执行。`;
  }

  /**
   * 上下文使用率提醒（达到自动压缩线才出现）。
   *
   * 与自动压缩线（session.getAutoCompactAt）对齐：早先是固定 60%，于是在系统自己都还判定
   * 「不需要压缩」的时候，模型就先替用户下了「别在这个会话继续做」的结论——而这句话
   * 会被写进可见回复、随历史长期留存，压缩完之后还在继续说。
   * 百分比随每次请求的 token 占用逐步上涨，
   * 实时取的话同一轮里每涨 1% 就改一次注入，同样会断前缀缓存；但占用**回落**（压缩）
   * 时必须立刻作废它，见 frozen()。
   */
  private buildUsageNotice(): string | null {
    // 用 lastTotalTokens（本地估算的上下文占用）而非 lastPromptTokens（端点报的计费口径）：
    // 后者经中转网关后与真实上下文能差 3.5 倍。另外 TokenAccountant 算占用时会调用 buildInjections，
    // 读一个由它自己写入的字段（上一次的值）而非同步重算，才不会形成循环。
    if (!(this.s.lastTotalTokens > 0 && this.s.getContextWindow() > 0)) return null;
    const autoAt = this.s.getAutoCompactAt();
    if (!(autoAt > 0) || this.s.lastTotalTokens < autoAt) return null;
    const usagePercent = this.s.lastTotalTokens / this.s.getContextWindow();
    const pct = Math.round(usagePercent * 100);
    return (
      `【上下文使用率】当前已用 ${pct}%（这是此刻的实际占用）。如果用户接下来要求做一个较大的功能（需要读写多个文件、多轮工具调用），` +
      `可以简短提一句「会话已较长，必要时可另开一个新会话」，一句话带过即可。` +
      `不要把它说成「这个任务做不完 / 做不了」，也不要每轮重复；用户选择继续就正常执行、不再提及。`
    );
  }

  private computeVolatile(): FrozenInjections {
    return {
      terminalNotice: this.buildTerminalCwdNotice(),
      focusHint: this.s.workspaces.length > 1 ? this.buildFocusWorkspaceHint() : null,
      usageNotice: this.buildUsageNotice(),
    };
  }

  /** 取本轮定格值；未调用过 beginTurn（内部调用路径）时退回实时计算，行为与旧版一致 */
  private frozen(): FrozenInjections {
    const frozen = this.turnFrozen;
    if (!frozen) return this.computeVolatile();
    // 定格只为防「上涨」——每涨 1% 就改写注入会断前缀缓存。反过来，占用**回落到阈值以下**时
    // 必须立刻作废这条提醒：否则模型会在已经压缩过的会话里继续告诉用户「上下文较满」，
    // 用户看到的是压缩后的 10%、模型说的却是压缩前的 80%。
    // 回落只可能来自压缩，而压缩自己就重写了历史、那次缓存早已失效，所以这里刷新不额外破费。
    if (frozen.usageNotice && this.buildUsageNotice() === null) {
      return { ...frozen, usageNotice: null };
    }
    return frozen;
  }

  /**
   * 模型冗长度校准：GPT 系模型默认输出比 GLM/Claude 啰嗦得多，需要额外约束才能拉回相近颗粒度。
   * 仅对 GPT 系生效。排版规则（段落优先、不插空行、不稀疏断行）对所有模型都适用，
   * 已并入系统提示的「回复排版」，这里只留冗长度本身。
   */
  getVerbosityCalibration(): string | null {
    const isGpt = /^gpt/i.test(this.s.model);
    if (!isGpt) return null;
    return (
      "输出长度校准（重要）：你的回答要克制、信息密度高，向【够用即可】靠拢——\n" +
      "- 结论先行，直接说重点；不要长篇铺垫、不要复述用户问题、不要逐条罗列你做过的每一步\n" +
      "- 能用一句说清就不要展开成一段；能用一段就不要拆成多个小标题\n" +
      "- 只在用户明确问【为什么/原理/细节】时才展开背景与推理，否则默认给精炼版\n" +
      "- 不要用大量分级标题、编号清单把短答案撑长；段落和要点都从简"
    );
  }

  /**
   * 构造 IDE 上下文提示（仅当 host 提供 ideContext，即 IDE 形态）。
   * 包含活动文件、选区/选中文本、其它打开的文件、git diff 概览——让 Agent 像 IDE 内助手一样
   * 感知用户"正在看什么、改了什么"。非 IDE 形态（host.ideContext 为空）返回 null，不注入。
   */
  async buildIdeContextPrompt(force = false): Promise<string | null> {
    const ide = this.s.host.ideContext;
    if (!ide) return null;
    if (!force) return null;
    try {
      const parts: string[] = [];

      const active = ide.activeEditor();
      if (active) {
        let line = `- 当前活动文件：${active.path}`;
        if (active.selection) {
          const sel = active.selection;
          line += `（选区：第 ${sel.startLine + 1} 行第 ${sel.startCharacter + 1} 列 ~ 第 ${sel.endLine + 1} 行第 ${sel.endCharacter + 1} 列）`;
        }
        parts.push(line);
        if (active.selectedText && active.selectedText.trim()) {
          const snippet = active.selectedText.length > 2000
            ? active.selectedText.slice(0, 2000) + "\n…（选中内容过长已截断）"
            : active.selectedText;
          parts.push(`- 用户选中的代码：\n\`\`\`\n${snippet}\n\`\`\``);
        }
      }

      const openFiles = ide.openFiles().filter((p) => !active || p !== active.path);
      if (openFiles.length > 0) {
        const shown = openFiles.slice(0, 20);
        parts.push(`- 其它已打开的文件：\n${shown.map((p) => `  · ${p}`).join("\n")}`);
      }

      const diff = await ide.gitDiff();
      if (diff && diff.trim()) {
        const shown = diff.length > 4000 ? diff.slice(0, 4000) + "\n…（diff 过长已截断）" : diff;
        parts.push(`- 当前工作区 git diff（未提交改动）：\n\`\`\`diff\n${shown}\n\`\`\``);
      }

      if (parts.length === 0) return null;

      return (
        `【IDE 上下文】以下是用户当前在编辑器里的实时状态，供你理解"用户正在关注/操作什么"。\n` +
        `当用户说"这个文件""这里""当前选中的"等指代时，优先据此理解；但不要凭空假设用户的意图，必要时仍以工具核实为准。\n\n` +
        parts.join("\n")
      );
    } catch (err) {
      console.warn("[ide-context] 获取 IDE 上下文失败（忽略）:", (err as Error).message);
      return null;
    }
  }

  /**
   * 计算「当前应优先关注的工作区」提示（多工作区时才有意义，单工作区返回 null）。
   *
   * 为什么需要它：多工作区会话（用户可能绑了十几个）里，工作区列表只是一份平铺清单，
   * 谁都不是重点。用户提问若不点名工作区，模型只能自己挑一个——于是出现
   * "我明明在看 A 项目的文件，它却跑去分析 B 项目"。
   *
   * 信号优先级（前者更强）：
   * 1. 活动编辑器文件所在的工作区 —— 用户正盯着这个文件，注意力信号最强；
   * 2. 主工作区（用户选中 / 绑定的那个，即 cwd）—— 兜底默认值。
   */
  private buildFocusWorkspaceHint(): string | null {
    const workspaces = this.s.workspaces;
    if (workspaces.length <= 1) return null;

    let focus: string | null = null;
    let viaActiveFile = false;
    try {
      // activeEditor 是同步只读调用，但取 IDE 状态在个别宿主可能抛错，兜住不影响主流程。
      const active = this.s.host.ideContext?.activeEditor();
      if (active?.path) {
        const owner = workspaceOfPath(active.path, workspaces);
        if (owner) {
          focus = owner;
          viaActiveFile = true;
        }
      }
    } catch {
      // 忽略：退回主工作区
    }
    if (!focus) focus = this.s.cwd || workspaces[0];
    if (!focus) return null;

    const why = viaActiveFile
      ? "用户当前在编辑器里打开的文件位于该工作区"
      : "这是当前选中（绑定）的主工作区";
    return (
      `【工作区聚焦】应优先关注的工作区：${focus}（${why}）。\n` +
      `- 用户提问没有明确指定工作区时，默认先在这个工作区里查找、分析、改动，不要一上来就翻其他工作区。\n` +
      `- 只有当用户明确提到别的工作区 / 项目名，或在该工作区内确实找不到目标时，才转向其他工作区。`
    );
  }

  /**
   * 构造发给 LLM 的消息。
   *
   * 缓存友好模型（DeepSeek / Qwen / GLM / Kimi / GPT 等）：每轮的上下文注入锚在
   * **该轮用户消息之前**，而不是追加在整段历史之后。
   *
   * 为什么不放尾部：一轮里有 N 次工具调用，就有 N 次请求。注入放尾部时，每次请求的
   * 最后一段都是「渲染协议 + IDE 上下文 + skills + 记忆……」这一大块 system 消息，
   * 模型读到的末尾不是「工具结果刚回来」，而是像新一轮刚开始——于是每一步的思考都先把
   * 「用户让我按方向 A，我已经做了……」重新复述一遍，看起来像每次回复都失忆。
   * 而且尾部注入跟在不断增长的历史之后，永远落在未命中区，每一步都按全价重发一遍。
   *
   * 现在的做法：每轮开头把注入定格成快照挂在用户消息上（见 snapshotContextInjections），
   * 请求组装时在每个带快照的用户消息前，只发出相对上一份快照**变了的那几项**。
   * 轮内每一步的前缀逐字节不变；跨轮时旧快照原样留在历史里，前缀同样不断。
   * 只针对当前这一步的临时纠偏（_tailInjected 的 system 消息）仍放尾部。
   */
  buildRequestMessages(): ChatCompletionMessageParam[] {
    const isDeepSeek = /deepseek/i.test(this.s.model);
    // 自动 Prompt Caching（GPT / o 系列）和显式前缀缓存模型都要求：
    // 已发过的 system + 历史保持在请求最前面，不能被易变注入插到前面去。
    // 走 Anthropic / Responses 协议时，策略层会把历史中间的 system 原地保留（<system-reminder> 块 /
    // developer 消息），所以无论什么模型都按「锚定在用户消息前」组装 —— 早先按模型名判断，
    // GPT 走 Responses、GLM / Kimi 走 Anthropic 兼容端点时都被当成「不友好」，注入插到最前面，整段前缀缓存失效。
    const protocol = requestProtocolFor(this.s.provider, this.s.model);
    const isCacheFriendly = protocol === "anthropic" || protocol === "responses"
      || isDeepSeek || /^(gpt|o1|o3|o4)/i.test(this.s.model)
      || /glm|qwen|moonshot|kimi|yi-/i.test(this.s.model);

    // ⚠️ 这里【不能】以 turnStartMsgCount（本轮起点）为界改写历史。
    //
    // 早先有两条这样的规则：之前轮次的瞬态工具（search 等）结果整条移除、
    // 超过 200 字（DeepSeek 80 字）的工具结果截短。问题在于上一轮里这些结果是**完整**发出去的，
    // 用户一发新消息它们就变了——前缀缓存从中间断开，整段历史按未缓存重新计费。
    // 实测：每次发问后的首个请求 ≈6.8 credit，同一轮后续请求 ≈2 credit，差出来的就是这一下。
    // 回归测试见 promptBuilder.prefixStability.test.ts。
    //
    // 工具结果在【写入历史时】按各工具的单次上限一次裁到位（toolOutcomeRecorder → capToolContent），
    // 此后不再改写：回合收尾的旧结果裁剪（pruneOldToolResults）也已移除，理由相同。
    // 旧结果的总体积交给滚动压缩——低频的整体重写，而不是每轮一刀。
    // 请求组装这里只做"不改变已发内容"的事：抽出单步临时注入、换成运行时内容、清洗工具配对。
    const ephemeralTail: ChatCompletionMessageParam[] = [];
    const preFiltered: ChatCompletionMessageParam[] = [];

    // 清空边界：倒数第 (KEEP_PREVIOUS_TURNS + 1) 条真实用户消息。它之前的思考清空内容，之后的原样回传
    const userIndexes: number[] = [];
    this.s.messages.forEach((m, i) => {
      if (isRealUserMessage(m)) userIndexes.push(i);
    });
    const reasoningBoundary = userIndexes[userIndexes.length - 1 - PromptBuilder.REASONING_KEEP_PREVIOUS_TURNS] ?? 0;
    // 当前用户回合的起点：之后的工具轮叙述原样回传给模型（见 toRuntimeMessage）
    const currentTurnStart = userIndexes[userIndexes.length - 1] ?? 0;
    const dropReasoning = (index: number): boolean => {
      if (index >= reasoningBoundary) return false;
      const r = (this.s.messages[index] as { reasoning_content?: unknown }).reasoning_content;
      return typeof r === "string" && r.length > 0;
    };

    const toRuntimeMessage = (m: ChatCompletionMessageParam, index: number): ChatCompletionMessageParam => {
      const anyMsg = m as any;
      let out: ChatCompletionMessageParam = m;
      if (anyMsg.role === "assistant" && Array.isArray(anyMsg.tool_calls)) {
        // displayGroupSummary：前端折叠行标题，纯展示字段，不发给 provider
        const { displayContent, runtimeContent, displayGroupSummary, ...rest } = anyMsg;
        // 工具轮叙述：当前回合原样回传，之前回合不发（见 toolTurnMessage 文件头）。
        // 一律不发时，模型在历史里看到的自己"只调工具、从不说话"，这比系统提示里的
        // 叙述纪律更有说服力——一轮里越往后正文越少，最后只剩一串工具卡片。
        // 之前回合仍然不发，避免过渡叙述跨轮成为照抄的范例；分界与思考清空是同一处，
        // 新回合时前缀在同一个位置断开，不额外破费缓存。
        const prose = index >= currentTurnStart && typeof displayContent === "string" && displayContent.trim()
          ? displayContent
          : null;
        out = { ...rest, content: runtimeContent || prose } as ChatCompletionMessageParam;
      }
      if (anyMsg.role === "user" && anyMsg._contextInjections) {
        const { _contextInjections, ...rest } = anyMsg;
        out = rest as ChatCompletionMessageParam;
      }
      // 之前回合的思考：删掉字段（不是置空）。DeepSeek 校验"原样回传"，空字符串会 400；
      // 删掉字段则表示"这条消息没有思考"，服务端不校验不存在的字段。
      if (dropReasoning(index)) {
        const { reasoning_content, ...rest } = out as unknown as Record<string, unknown>;
        return rest as unknown as ChatCompletionMessageParam;
      }
      return out;
    };

    for (let i = 0; i < this.s.messages.length; i++) {
      const m = this.s.messages[i];
      if ((m as any)._tailInjected && (m as any).role === "system") {
        ephemeralTail.push(m);
      } else {
        preFiltered.push(toRuntimeMessage(m, i));
      }
    }

    const truncated = sanitizeToolPairing(preFiltered);

    if (isCacheFriendly) {
      return [...this.anchorContextInjections(truncated, this.s.messages), ...ephemeralTail];
    }

    // 非缓存友好链路（Anthropic / Responses 会把 system 合并到最前面）：注入紧跟系统提示词
    const allInjections = [...this.buildInjections(), ...ephemeralTail];
    if (allInjections.length === 0) return truncated;
    if (truncated.length === 0) return allInjections;
    const [systemMsg, ...rest] = truncated;
    return [systemMsg, ...allInjections, ...rest];
  }

  /**
   * 把每轮的上下文注入展开到对应用户消息之前（只发相对上一份快照有变化的项）。
   *
   * 快照从原始 messages 里取（runtime 消息已剥掉 _contextInjections），按用户消息的出现顺序对应。
   * 最后一条真实用户消息若没有快照（旧会话 / 未走 beginTurn 的内部路径），用实时注入兜底；
   * 历史里一份快照都没有时，兜底的这一份就会完整发出——与旧行为的内容一致，只是位置前移。
   */
  private anchorContextInjections(
    runtime: ChatCompletionMessageParam[],
    original: ChatCompletionMessageParam[],
  ): ChatCompletionMessageParam[] {
    const snapshots = new Map<number, ContextInjection[]>();
    let userOrdinal = 0;
    for (const m of original) {
      if (!isRealUserMessage(m)) continue;
      const snap = (m as any)._contextInjections;
      // 旧快照里可能还存着使用率提醒（见 snapshotContextInjections），过期的数字不能再发
      if (Array.isArray(snap)) snapshots.set(userOrdinal, snap.filter((i: ContextInjection) => i?.key !== "usage"));
      userOrdinal++;
    }

    const userCount = runtime.filter(isRealUserMessage).length;
    if (userCount === 0) {
      // 没有用户消息（极端内部路径）：退回旧的尾部注入
      return [...runtime, ...this.buildInjections()];
    }
    if (!snapshots.has(userCount - 1)) snapshots.set(userCount - 1, this.snapshotContextInjections());

    const emitted = new Map<string, string>();
    const result: ChatCompletionMessageParam[] = [];
    // 使用率提醒只挂在当前这一轮（最后一条用户消息）之前，取本轮定格值，一轮之内不变
    const usageNotice = this.frozen().usageNotice;
    let ordinal = 0;
    for (const m of runtime) {
      if (isRealUserMessage(m)) {
        const current = ordinal === userCount - 1;
        const snap = snapshots.get(ordinal++);
        if (snap) result.push(...diffInjections(emitted, snap));
        if (current && usageNotice) result.push({ role: "system", content: usageNotice });
      }
      result.push(m);
    }
    return result;
  }

  /**
   * 动画 / 图片生成未开启时的提示。
   *
   * 用户问「能不能做视频 / 画张图」时，模型手里没有工具就容易答「不支持」——其实只是没开。
   * 这段原本常驻系统提示，开着工具时也占着位置；现在只在缺工具时注入。
   */
  private buildCapabilityHint(): string | null {
    const lines: string[] = [];
    if (!(this.s.mediaEnabled && this.s.host?.mediaRenderer)) {
      lines.push(
        "动画 / 视频：本产品能把 HTML 动画渲染成 GIF / MP4，但用户还没开启。用户问能不能生成视频、做动画时，" +
        "不要说不支持，告诉他去「设置 → 搜索 axon.media.enabled（Axon 分类下的「允许 AI 生成动画 / 视频」）」打开；开启前可以先用 html 产物交出能播放的页面动画。",
      );
    }
    if (!(this.s.imageEnabled && this.s.host?.imageGenerator)) {
      lines.push(
        "图片生成：本产品支持文生图，但用户还没开启或没配置生图服务。用户要插画、封面、写实画面时，" +
        "不要说不能生成图片，告诉他去「设置 → Axon → 图片生成」打开 axon.image.enabled 并填写服务地址、API Key、模型名。",
      );
    }
    return lines.length > 0 ? `【未开启的能力】\n${lines.map((l) => `- ${l}`).join("\n")}` : null;
  }

  /**
   * 产物目录与「成品怎么交付」的提示。
   *
   * 只在 Agent（Code）模式注入：问答模式没有写文件工具，本来也只能走 create_artifact，
   * 多说一句反而占位置。
   *
   * 三个信息缺一不可：
   * ① 成品走 create_artifact，不要用 create_file 往仓库里塞一个"产物文件"；
   * ② 目录由后端定，不要自己拼绝对路径（自己拼的路径一旦落在工作区外会被拒）；
   * ③ 目录具体在哪——用户想知道文件存哪了，模型回答时得说得出来。
   */
  private buildArtifactNotice(): string | null {
    if (this.s.mode === "quest") return null;
    const dir = this.s.getArtifactDir();
    if (!dir) return null;
    return (
      "【产物目录】用户会想单独打开 / 保存 / 复用的成品（HTML 原型、SVG、报告文档、独立脚本、清单模板等）" +
      `一律用 create_artifact 交付，它会自动存进产物目录：${dir}\n` +
      "- 不要用 create_file / str_replace 往这个目录写成品：路径由后端拼，你不需要、也不应该自己传路径\n" +
      "- 也不要因为「这是 Agent 模式」就把成品当成项目源码新建到仓库里——两者是不同性质的文件：" +
      "改仓库用 create_file / str_replace（有改动审阅），交出成品用 create_artifact（有预览卡片）\n" +
      "- 用户问「文件存哪了」时，按上面的目录回答"
    );
  }

  /**
   * 本轮上下文注入的快照（每项带 key，用于跨轮比较只发变化项）。
   * AgentSession 在 beginTurn() 之后把它挂到本轮用户消息上，本轮之内不再变化。
   */
  snapshotContextInjections(): ContextInjection[] {
    return this.buildKeyedInjections()
      // 使用率提醒不进快照：快照随用户消息落盘、之后每次请求都会再发，一条「80%」会在压缩后、
      // 重开会话后一直留在历史里，模型据此说「上下文不够」，而界面上只用了 10%。
      // 它只在当前这一轮发，见 anchorContextInjections。
      .filter(({ key }) => key !== "usage")
      .map(({ key, message }) => ({ key, content: messageText(message) }));
  }

  /** 本轮全部注入（含使用率提醒）的 key 与文本，供上下文用量按来源拆分 */
  listInjections(): ContextInjection[] {
    return this.buildKeyedInjections().map(({ key, message }) => ({ key, content: messageText(message) }));
  }

  /** 构建本轮要注入的 system 消息（长度校准/验证/多工作区/IDE/skill/power），供请求组装与 token 估算复用 */
  buildInjections(): ChatCompletionMessageParam[] {
    return this.buildKeyedInjections().map(({ message }) => message);
  }

  private buildKeyedInjections(): Array<{ key: InjectionKey; message: ChatCompletionMessageParam }> {
    const injections: Array<{ key: InjectionKey; message: ChatCompletionMessageParam }> = [];
    const add = (key: InjectionKey, content: string) => injections.push({ key, message: { role: "system", content } });

    // 运行环境（操作系统 / shell / 日期）：同一天之内不变，按轮快照只在跨天时补发一次
    add("env", buildEnvironmentNotice({ commands: this.s.mode !== "quest" }));

    // 产物目录：把「成品该往哪交」说清楚。
    //
    // 为什么必须显式说：Agent 模式下模型的默认动作是 create_file 往仓库里写文件，
    // 于是「交付一份独立成品」被当成「新建一个源码文件」，落到工作区里——用户在 + 菜单里
    // 设置的产物目录完全没被用上。更糟的是它若按用户给的绝对路径去 create_file，
    // 又会撞工作区边界报错，看起来像"外部路径被拦截"。
    // 这里连同目录一起给出，模型就不必自己拼路径、也不该自己拼。
    const artifactNotice = this.buildArtifactNotice();
    if (artifactNotice) add("artifact", artifactNotice);

    // 动画 / 图片生成没开时告诉模型怎么开；开着时用法与对外保密要求都在各自的工具描述里
    const capabilityHint = this.buildCapabilityHint();
    if (capabilityHint) add("capabilities", capabilityHint);

    // 权限模式：安全模式不注入（默认行为）；自动 / 完全访问时告诉模型不用等审批、能写到哪
    if (this.s.permissionMode === "auto") {
      add("permission", "权限模式：自动。命令、改动、外部工具调用都不需要用户逐个批准，直接执行；文件写入仍限定在工作区（和产物目录）内。动手前依旧要想清楚，删除数据、推送代码、发邮件这类不可逆或对外的操作按用户的要求来，别擅自扩大范围。");
    } else if (this.s.permissionMode === "full") {
      add("permission", "权限模式：完全访问。命令、改动、外部工具调用都不需要用户逐个批准，直接执行；可以读写本机任意目录（包括工作区以外，用绝对路径）。动手前依旧要想清楚，删除数据、推送代码、发邮件这类不可逆或对外的操作按用户的要求来，别擅自扩大范围。");
    }

    const verbosityCalibration = this.getVerbosityCalibration();
    if (verbosityCalibration) {
      add("verbosity", verbosityCalibration);
    }

    if (this.s.workspaces.length > 1) {
      const wsInfo = this.s.workspaces.map((p, i) => `  ${i + 1}. ${p}`).join("\n");
      add(
        "workspaces",
        `当前会话绑定了多个工作区：\n${wsInfo}\n\n` +
          `重要规则：\n` +
          `- 所有路径一律使用绝对路径，禁止使用相对路径\n` +
          `- execute_command 必须始终传 cwd 参数（绝对路径），指定命令要在哪个工作区目录执行（不要省略）\n` +
          `- 访问文件时，path 必须使用完整绝对路径\n` +
          `- 不要用 ../、../../ 等相对路径去猜测其他工作区的位置\n` +
          `- search 工具的 path 参数：搜索某个工作区时直接传该工作区的绝对路径`,
      );

      // 列表本身不分主次，模型容易随便挑一个工作区就开查。再补一条"聚焦"提示，
      // 把用户当前真正在看的那个工作区标出来（依据活动文件，其次主工作区）。
      // 单独成一条而不是并进上面那条：工作区列表长期稳定，焦点随用户切文件而变，
      // 分开才不会让前者被后者的变化反复作废（利于前缀缓存）。
      // 焦点取本轮定格值：一轮之内用户切文件不会让 system 前缀变样（见 turnFrozen）。
      const focusHint = this.frozen().focusHint;
      if (focusHint) {
        add("focus", focusHint);
      }
    }

    // 终端 cwd 提示取本轮定格值：它随每条命令的 cwd 变化，实时取会让同一轮里的请求频繁断缓存。
    // 代价是本轮内该提示可能滞后于真实终端目录——可接受：多工作区规则已要求每条命令显式传 cwd，
    // 这条提示只影响"不传 cwd"的兜底行为。
    const terminalNotice = this.frozen().terminalNotice;
    if (terminalNotice) {
      add("terminal", terminalNotice);
    }

    if (this.s.ideContextCache) {
      add("ide", this.s.ideContextCache);
    }

    if (this.s.skillsPromptCache) {
      add("skills", this.s.skillsPromptCache);
    }

    if (this.s.powersPromptCache) {
      add("powers", this.s.powersPromptCache);
    }

    // Wiki 索引：只列「有哪些页、讲什么」，正文由模型按需 read_file（渐进式披露）。
    // 未使用 Wiki 的项目此处为 null，整条注入不存在。
    if (this.s.wikiPromptCache) {
      add("wiki", this.s.wikiPromptCache);
    }

    // 工作区 .axon：项目指令、路径规则与长期工作区知识。它和会话记忆分开：
    // .axon 属于仓库/工作区共享上下文，会话记忆属于当前会话；两者都作为按轮注入，
    // 避免配置变化让历史前缀缓存整体失效。
    if (this.s.workspaceAxonPromptCache) {
      add("workspaceAxon", this.s.workspaceAxonPromptCache);
    }

    // 会话记忆：整份文档作为一条按轮注入。
    // 刻意不并进系统提示开头：它的内容随会话推进而变化，放前面会让整段前缀缓存
    // 从变化点起失效；作为按轮注入，变化的代价就只落在这一条自己身上。
    if (this.s.memory && this.s.memory.trim()) {
      add(
        "memory",
        "【会话记忆】以下内容由你此前主动写入、或由用户导入，是本次会话已确认的背景前提。" +
          "直接当作已知事实使用：不要重新询问，也不要在回复里复述它。\n\n" + this.s.memory.trim(),
      );
    }

    // 任务清单：只在历史里已经看不到 update_tasks 调用（被压缩掉）且还有未完成项时注入
    const tasksNotice = this.s.getTaskListNotice?.();
    if (tasksNotice) add("tasks", tasksNotice);

    // 上下文使用率提醒：只在接近上限时出现，取本轮定格值（见 buildUsageNotice / turnFrozen）
    const usageNotice = this.frozen().usageNotice;
    if (usageNotice) {
      add("usage", usageNotice);
    }

    return injections;
  }
}

type InjectionKey =
  | "env" | "artifact" | "capabilities" | "verbosity" | "workspaces" | "focus" | "terminal"
  | "ide" | "skills" | "powers" | "wiki" | "workspaceAxon" | "memory" | "usage" | "tasks" | "permission";

/** 一项上下文注入的快照（挂在用户消息的 _contextInjections 上，随历史持久化） */
export interface ContextInjection {
  key: string;
  content: string;
}

/** 某项注入在新一轮里消失时的作废说明，避免模型继续按历史里的旧版本行事 */
const RETIRED_NOTICE: Record<string, string> = {
  // 旧会话的快照里可能还有 render：渲染规则已并入系统提示，不能说成「不再适用」
  render: "图表渲染规则以系统提示中的「图表渲染」为准。",
  artifact: "此前的【产物目录】提示已不再适用：成品仍用 create_artifact 交付，保存位置由后端决定。",
  capabilities: "此前关于「如何开启动画 / 图片生成」的提示已不再适用：对应能力现已开启，用法见工具说明。",
  verbosity: "此前的「输出长度校准」已不再适用。",
  workspaces: "此前的「多工作区规则」已不再适用：当前会话只绑定了一个工作区。",
  focus: "此前的「工作区聚焦」提示已不再适用。",
  terminal: "此前的「终端工作目录」提示已不再适用：终端已回到主工作区。",
  ide: "此前的【IDE 上下文】已过期，不要再据此判断用户当前的编辑器状态。",
  skills: "此前列出的 skill 清单已不再适用。",
  powers: "此前列出的 power 清单已不再适用。",
  wiki: "此前列出的 Wiki 索引已不再适用。",
  workspaceAxon: "此前注入的工作区 .axon 指令已不再适用。",
  memory: "【会话记忆】已被清空，此前的记忆内容不再作为已确认前提。",
  usage: "此前的「上下文使用率」提醒已不再适用。",
  permission: "权限模式已切回安全：没信任过的命令、外部工具的写操作要等用户批准，文件只能写在工作区（和产物目录）内。",
  tasks: "此前注入的【任务清单】已不再适用：以历史里最新一次 update_tasks 为准，或任务已全部完成。",
};

/** 相对已发出的注入，算出这一份快照需要新发的 system 消息（变化项 + 消失项的作废说明） */
function diffInjections(emitted: Map<string, string>, snapshot: ContextInjection[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  const present = new Set<string>();
  for (const { key, content } of snapshot) {
    present.add(key);
    if (emitted.get(key) === content) continue;
    emitted.set(key, content);
    out.push({ role: "system", content });
  }
  for (const key of [...emitted.keys()]) {
    if (present.has(key)) continue;
    emitted.delete(key);
    out.push({ role: "system", content: RETIRED_NOTICE[key] ?? `此前的「${key}」注入已不再适用。` });
  }
  return out;
}

/** 用户真正发出的消息（排除截图回填、续写引导这类系统代发的 user 消息） */
export function isRealUserMessage(m: ChatCompletionMessageParam): boolean {
  const anyMsg = m as any;
  return anyMsg?.role === "user" && !anyMsg._screenshotInjection && !anyMsg._tailInjected && !anyMsg._ephemeralInjected && !anyMsg._bgInline
    // 压缩留下的摘要不是用户发的（判定同 compactor.isSummaryMessage，这里内联以免循环依赖）
    && !(typeof anyMsg.content === "string" && anyMsg.content.startsWith("[对话历史摘要]"));
}

/** 一轮之内定格不变的易变注入 */
interface FrozenInjections {
  terminalNotice: string | null;
  focusHint: string | null;
  usageNotice: string | null;
}
