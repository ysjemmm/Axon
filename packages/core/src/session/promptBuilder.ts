/**
 * PromptBuilder —— 请求消息与注入构建（从 AgentSession 解耦）
 *
 * 职责单一：把"会话当前状态"翻译成发给 LLM 的消息数组。包含：
 * - GPT 系冗长度校准
 * - IDE 上下文提示（活动文件/选区/git diff）
 * - 多工作区 / 终端 cwd / skill / power / 上下文使用率等 system 注入
 * - 瞬态工具结果过滤、消息配对清洗、旧工具结果摘要截断
 *
 * 设计：本类不持有状态，只通过构造注入的 session 引用读取会话当前状态（@internal 字段），
 * 绝不修改 session 状态。messageText 为无状态纯函数，单独导出供 token 估算等复用。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { sanitizeToolPairing } from "../messageSanitizer.js";
import type { AgentSession } from "../agentSession.js";
import { workspaceOfPath } from "./focusWorkspace.js";

const ENHANCED_RENDERING_PROTOCOL =
  "增强渲染协议（覆盖任何旧规则）：只要你的意图是画一张图——流程图、状态图、时序图、类图、ER 图、架构图或关系图——" +
  "或者是要交付一个可预览的 SVG / HTML 原型，就必须使用 ```svg axon-render / ```mermaid axon-render / ```html axon-render。" +
  "判定标准是意图，不是语言：想给用户看图，就必须带 axon-render。漏带会被前端当成普通代码块、只显示源码，" +
  "用户看到的是一段代码而不是图，等于这张图没画出来。" +
  "唯一不带 axon-render 的场景是展示源码本身——代码示例、历史片段、讲解 HTML/SVG/Mermaid 语法，" +
  "此时必须使用普通 ```svg / ```mermaid / ```html。";

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
   * 上下文使用率提醒（≥60% 才出现）。百分比随每次请求的 token 占用逐步上涨，
   * 实时取的话同一轮里每涨 1% 就改一次注入，同样会断前缀缓存。
   */
  private buildUsageNotice(): string | null {
    // 用 lastTotalTokens（本地估算的上下文占用）而非 lastPromptTokens（端点报的计费口径）：
    // 后者经中转网关后与真实上下文能差 3.5 倍。另外 TokenAccountant 算占用时会调用 buildInjections，
    // 读一个由它自己写入的字段（上一次的值）而非同步重算，才不会形成循环。
    if (!(this.s.lastTotalTokens > 0 && this.s.getContextWindow() > 0)) return null;
    const usagePercent = this.s.lastTotalTokens / this.s.getContextWindow();
    if (usagePercent < 0.6) return null;
    const pct = Math.round(usagePercent * 100);
    return (
      `⚠️ 上下文使用率已达 ${pct}%。如果用户接下来要求做一个较大的功能（需要读写多个文件、多轮工具调用），` +
      `你应该在开始前简要提醒用户：当前会话上下文已较满（${pct}%），复杂任务可能导致上下文溢出或响应变慢，` +
      `建议开一个新会话来做这个功能。如果用户坚持在当前会话做，则正常执行不再重复提醒。`
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
    return this.turnFrozen ?? this.computeVolatile();
  }

  /**
   * 模型冗长度校准：GPT 系模型默认输出比 GLM/Claude 啰嗦得多，需要额外约束才能拉回相近颗粒度。
   * 仅对 GPT 系生效。
   */
  getVerbosityCalibration(): string | null {
    const isGpt = /^gpt/i.test(this.s.model);
    if (!isGpt) return null;
    return (
      "输出长度校准（重要）：你的回答要克制、信息密度高，向【够用即可】靠拢——\n" +
      "- 结论先行，直接说重点；不要长篇铺垫、不要复述用户问题、不要逐条罗列你做过的每一步\n" +
      "- 能用一句说清就不要展开成一段；能用一段就不要拆成多个小标题\n" +
      "- 只在用户明确问【为什么/原理/细节】时才展开背景与推理，否则默认给精炼版\n" +
      "- 实现类任务的收尾总结控制在 5 句以内（用户能看到工具卡片，无需复述过程）\n" +
      "- 不要用大量分级标题、编号清单把短答案撑长；段落和要点都从简\n" +
      "- 排版要紧凑：不要在每个要点/句子之间插空行，连续的短句优先合并成自然段\n" +
      "- 默认优先用连贯段落而不是项目符号列表；只有并列项达到 3 条以上且确实需要逐项区分时才用列表\n" +
      "- 不要为了可读性把每句话单独断行；除代码块、真正的多层列表、或用户明确要求外，避免稀疏排版"
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

  /** 构造发给 LLM 的消息：保证 [system_prompt + 历史] 前缀稳定，注入消息放尾部 */
  buildRequestMessages(): ChatCompletionMessageParam[] {
    const injections = this.buildInjections();
    const isDeepSeek = /deepseek/i.test(this.s.model);
    const isCacheFriendly = isDeepSeek || /glm|qwen|moonshot|kimi|yi-/i.test(this.s.model);

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
    // 请求组装这里只做"不改变已发内容"的事：抽出尾部注入、换成运行时内容、清洗工具配对。
    const extractedInjections: ChatCompletionMessageParam[] = [];
    const preFiltered: ChatCompletionMessageParam[] = [];

    const toRuntimeMessage = (m: ChatCompletionMessageParam): ChatCompletionMessageParam => {
      const anyMsg = m as any;
      if (anyMsg.role === "assistant" && Array.isArray(anyMsg.tool_calls)) {
        const { displayContent, runtimeContent, ...rest } = anyMsg;
        return { ...rest, content: runtimeContent || null } as ChatCompletionMessageParam;
      }
      return m;
    };

    for (const m of this.s.messages) {
      if ((m as any)._tailInjected && (m as any).role === "system") {
        extractedInjections.push(m);
      } else {
        preFiltered.push(toRuntimeMessage(m));
      }
    }

    const truncated = sanitizeToolPairing(preFiltered);

    const allTailInjections = isCacheFriendly ? [...extractedInjections, ...injections] : injections;
    if (allTailInjections.length === 0) return truncated;
    if (truncated.length === 0) return allTailInjections;

    const [systemMsg, ...rest] = truncated;
    if (isCacheFriendly) return [systemMsg, ...rest, ...allTailInjections];
    return [systemMsg, ...allTailInjections, ...rest];
  }

  /** 构建本轮要注入的 system 消息（长度校准/验证/多工作区/IDE/skill/power），供请求组装与 token 估算复用 */
  buildInjections(): ChatCompletionMessageParam[] {
    const injections: ChatCompletionMessageParam[] = [];

    injections.push({ role: "system", content: ENHANCED_RENDERING_PROTOCOL });

    const verbosityCalibration = this.getVerbosityCalibration();
    if (verbosityCalibration) {
      injections.push({ role: "system", content: verbosityCalibration });
    }

    if (this.s.workspaces.length > 1) {
      const wsInfo = this.s.workspaces.map((p, i) => `  ${i + 1}. ${p}`).join("\n");
      injections.push({
        role: "system",
        content:
          `当前会话绑定了多个工作区：\n${wsInfo}\n\n` +
          `重要规则：\n` +
          `- 所有路径一律使用绝对路径，禁止使用相对路径\n` +
          `- execute_command 必须始终传 cwd 参数（绝对路径），指定命令要在哪个工作区目录执行（不要省略）\n` +
          `- 访问文件时，path 必须使用完整绝对路径\n` +
          `- 不要用 ../、../../ 等相对路径去猜测其他工作区的位置\n` +
          `- search 工具的 path 参数：搜索某个工作区时直接传该工作区的绝对路径`,
      });

      // 列表本身不分主次，模型容易随便挑一个工作区就开查。再补一条"聚焦"提示，
      // 把用户当前真正在看的那个工作区标出来（依据活动文件，其次主工作区）。
      // 单独成一条而不是并进上面那条：工作区列表长期稳定，焦点随用户切文件而变，
      // 分开才不会让前者被后者的变化反复作废（利于前缀缓存）。
      // 焦点取本轮定格值：一轮之内用户切文件不会让 system 前缀变样（见 turnFrozen）。
      const focusHint = this.frozen().focusHint;
      if (focusHint) {
        injections.push({ role: "system", content: focusHint });
      }
    }

    // 终端 cwd 提示取本轮定格值：它随每条命令的 cwd 变化，实时取会让同一轮里的请求频繁断缓存。
    // 代价是本轮内该提示可能滞后于真实终端目录——可接受：多工作区规则已要求每条命令显式传 cwd，
    // 这条提示只影响"不传 cwd"的兜底行为。
    const terminalNotice = this.frozen().terminalNotice;
    if (terminalNotice) {
      injections.push({ role: "system", content: terminalNotice });
    }

    if (this.s.ideContextCache) {
      injections.push({ role: "system", content: this.s.ideContextCache, _tailInjected: true } as ChatCompletionMessageParam);
    }

    if (this.s.skillsPromptCache) {
      injections.push({ role: "system", content: this.s.skillsPromptCache, _tailInjected: true } as ChatCompletionMessageParam);
    }

    if (this.s.powersPromptCache) {
      injections.push({ role: "system", content: this.s.powersPromptCache, _tailInjected: true } as ChatCompletionMessageParam);
    }

    // Wiki 索引：只列「有哪些页、讲什么」，正文由模型按需 read_file（渐进式披露）。
    // 与 skills / powers 同样走 _tailInjected —— 它放在历史之后，内容变化时不会让
    // 前面那一大段历史的前缀缓存失效（前缀缓存的价值主要在历史，不在注入本身）。
    // 未使用 Wiki 的项目此处为 null，整条注入不存在。
    if (this.s.wikiPromptCache) {
      injections.push({ role: "system", content: this.s.wikiPromptCache, _tailInjected: true } as ChatCompletionMessageParam);
    }

    // 上下文使用率提醒：只在接近上限时出现，取本轮定格值（见 buildUsageNotice / turnFrozen）
    const usageNotice = this.frozen().usageNotice;
    if (usageNotice) {
      injections.push({ role: "system", content: usageNotice, _tailInjected: true } as ChatCompletionMessageParam);
    }

    return injections;
  }
}

/** 一轮之内定格不变的易变注入 */
interface FrozenInjections {
  terminalNotice: string | null;
  focusHint: string | null;
  usageNotice: string | null;
}
