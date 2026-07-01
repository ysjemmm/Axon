/**
 * PromptBuilder —— 请求消息与注入构建（从 AgentSession 解耦）
 *
 * 职责单一：把"会话当前状态"翻译成发给 LLM 的消息数组。包含：
 * - 回复风格指令 / GPT 系冗长度校准
 * - IDE 上下文提示（活动文件/选区/git diff）
 * - 多工作区 / 终端 cwd / skill / power / 上下文使用率等 system 注入
 * - 瞬态工具结果过滤、消息配对清洗、旧工具结果摘要截断
 *
 * 设计：本类不持有状态，只通过构造注入的 session 引用读取会话当前状态（@internal 字段），
 * 绝不修改 session 状态。messageText 为无状态纯函数，单独导出供 token 估算等复用。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { sanitizeToolPairing } from "../messageSanitizer.js";
import { TRANSIENT_TOOLS, TRANSIENT_TOOLS_AGGRESSIVE } from "../tools/catalog.js";
import type { AgentSession } from "../agentSession.js";

/** 取一条消息的纯文本内容（兼容 string 与多模态 parts） */
export function messageText(m: ChatCompletionMessageParam): string {
  if (!m) return "";
  const c = (m as { content?: unknown }).content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return (c as Array<{ type?: string; text?: string }>).map((p) => (p.type === "text" ? p.text || "" : "")).join("");
  return "";
}

export class PromptBuilder {
  constructor(private readonly s: AgentSession) {}

  /** 根据当前 replyStyle 返回要注入的风格指令文本（default 不注入） */
  getStyleInstruction(): string | null {
    switch (this.s.replyStyle) {
      case "concise":
        return "本次回复风格：简洁。直奔结论，能一句说清就别展开，省略非必要的背景和过程描述。";
      case "detailed":
        return "本次回复风格：详细。可以展开讲解，补充背景、原理和注意事项，但仍要遵守'禁止双总结/禁止分割线/不主动给规划'等格式约束。";
      default:
        return null;
    }
  }

  /**
   * 模型冗长度校准：GPT 系模型默认输出比 GLM/Claude 啰嗦得多，需要额外约束才能拉回相近颗粒度。
   * 仅对 GPT 系生效，且当用户显式选了"详细"风格时不压制（尊重用户意图）。
   */
  getVerbosityCalibration(): string | null {
    const isGpt = /^gpt/i.test(this.s.model);
    if (!isGpt || this.s.replyStyle === "detailed") return null;
    return (
      "输出长度校准（重要）：你的回答要克制、信息密度高，向【够用即可】靠拢——\n" +
      "- 结论先行，直接说重点；不要长篇铺垫、不要复述用户问题、不要逐条罗列你做过的每一步\n" +
      "- 能用一句说清就不要展开成一段；能用一段就不要拆成多个小标题\n" +
      "- 只在用户明确问【为什么/原理/细节】时才展开背景与推理，否则默认给精炼版\n" +
      "- 实现类任务的收尾总结控制在 5 句以内（用户能看到工具卡片，无需复述过程）\n" +
      "- 不要用大量分级标题、编号清单把短答案撑长；段落和要点都从简"
    );
  }

  /**
   * 构造 IDE 上下文提示（仅当 host 提供 ideContext，即 IDE 形态）。
   * 包含活动文件、选区/选中文本、其它打开的文件、git diff 概览——让 Agent 像 IDE 内助手一样
   * 感知用户"正在看什么、改了什么"。非 IDE 形态（host.ideContext 为空）返回 null，不注入。
   */
  async buildIdeContextPrompt(): Promise<string | null> {
    const ide = this.s.host.ideContext;
    if (!ide) return null;
    try {
      const parts: string[] = [];

      const active = ide.activeEditor();
      if (active) {
        let line = `- 当前活动文件：${active.path}`;
        if (active.selection) {
          const sel = active.selection;
          // 选区行号转 1-indexed 展示
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

  /** 构造发给 LLM 的消息：在 system prompt 之后插入风格指令和工作区信息（不污染持久化的 messages） */
  buildRequestMessages(): ChatCompletionMessageParam[] {
    const injections = this.buildInjections();
    const isDeepSeek = /deepseek/i.test(this.s.model);
    const transientSet = isDeepSeek ? TRANSIENT_TOOLS_AGGRESSIVE : TRANSIENT_TOOLS;

    // 先移除跨轮瞬态工具结果（search/list_dir/web_search/web_fetch/read_file），
    // 必须在 sanitizeToolPairing 之前执行：先删掉不需要的工具结果，
    // 再让 sanitizer 把关联的孤儿 tool_calls 一并清理，避免产生
    // "assistant(tool_calls) 后缺少 tool 结果" 的消息序列导致 API 400。
    const preFiltered = this.s.messages.filter((m) => {
      if ((m as any).role !== "tool") return true;
      const toolName = (m as any)._toolName as string | undefined;
      if (!toolName || !transientSet.has(toolName)) return true;
      // 只保留当前轮次的瞬态结果（在原始数组上的下标与 turnStartMsgCount 对齐）
      const idx = this.s.messages.indexOf(m);
      return idx >= this.s.turnStartMsgCount;
    });

    // 发送前清洗：移除孤儿 tool_calls / 孤儿 tool 结果（含上一步因瞬态过滤
    // 而产生的孤儿），避免历史损坏导致 API 400
    const cleaned = sanitizeToolPairing(preFiltered);

    // 滑动窗口截断：对非当前轮的 tool 消息，只保留摘要。
    // user/assistant 文字全部保留（"记忆"不丢），tool 调用记录保留（知道做过什么），
    // 只有旧工具的大块正文数据被截短（文件内容、命令输出等）。
    // DeepSeek 类模型更激进截断（长 context 下 TTFT 急剧上升）。
    const SUMMARY_LIMIT = isDeepSeek ? 80 : 200;
    const truncated = cleaned.map((m, idx) => {
      if ((m as any).role !== "tool") return m;
      // 当前轮次的工具结果保留完整
      if (idx >= this.s.turnStartMsgCount) return m;
      const content = (m as any).content as string;
      if (!content || content.length <= SUMMARY_LIMIT) return m;
      const toolName = (m as any)._toolName as string || "";
      const preview = content.slice(0, SUMMARY_LIMIT);
      const truncatedContent = `${preview}\n\n[内容已截断（原 ${content.length} 字符）。这是 ${toolName} 的历史结果，如需完整内容请重新调用该工具。]`;
      return { ...m, content: truncatedContent };
    });

    if (injections.length === 0) return truncated;
    if (truncated.length === 0) return injections;
    const [systemMsg, ...rest] = truncated;
    // Prompt caching 优化：DeepSeek 支持前缀缓存，注入放尾部保证 [system + 历史] 前缀稳定。
    // 其他模型（GPT/Claude）注入放前面（靠近 system prompt 时遵守度更高）。
    if (isDeepSeek) {
      return [systemMsg, ...rest, ...injections];
    }
    return [systemMsg, ...injections, ...rest];
  }

  /** 构建本轮要注入的 system 消息（风格/验证/多工作区/IDE/skill/power），供请求组装与 token 估算复用 */
  buildInjections(): ChatCompletionMessageParam[] {
    const injections: ChatCompletionMessageParam[] = [];

    // 模型差异校准：GPT 系（gpt-5.5 等）默认输出明显比 GLM/Claude 更冗长，
    // 同样的格式约束它遵守得更松。这里对 GPT 系额外注入一条"控长"指令，把它拉回与其他模型
    // 接近的颗粒度。仅在用户未显式选择"详细"风格时生效（detailed 时尊重用户意图，不压制）。
    const verbosityCalibration = this.getVerbosityCalibration();
    if (verbosityCalibration) {
      injections.push({ role: "system", content: verbosityCalibration });
    }

    // 风格指令
    const instruction = this.getStyleInstruction();
    if (instruction) {
      injections.push({ role: "system", content: instruction });
    }

    // 多工作区信息（让 AI 感知所有可操作的根路径）
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
    }

    // 终端工作目录提示：cd 后可能与主工作区不同
    if (this.s.terminalCwd !== this.s.cwd) {
      injections.push({
        role: "system",
        content: `⚠️ 注意：Axon 终端当前工作目录为 \`${this.s.terminalCwd}\`，与主工作区不同。execute_command 不传 cwd 时将在此目录执行。`,
      });
    }

    // IDE 上下文（仅 IDE 形态：活动文件/选区/打开文件/git diff，本轮开头预取）
    if (this.s.ideContextCache) {
      injections.push({ role: "system", content: this.s.ideContextCache });
    }

    // Skill 清单（渐进式披露的轻量层，本轮开头预取）
    if (this.s.skillsPromptCache) {
      injections.push({ role: "system", content: this.s.skillsPromptCache });
    }

    // Power 清单（轻量层，本轮开头预取）
    if (this.s.powersPromptCache) {
      injections.push({ role: "system", content: this.s.powersPromptCache });
    }

    // 上下文使用率较高时提醒 AI 告知用户
    if (this.s.lastPromptTokens > 0 && this.s.getContextWindow() > 0) {
      const usagePercent = this.s.lastPromptTokens / this.s.getContextWindow();
      if (usagePercent >= 0.6) {
        const pct = Math.round(usagePercent * 100);
        injections.push({
          role: "system",
          content:
            `⚠️ 上下文使用率已达 ${pct}%。如果用户接下来要求做一个较大的功能（需要读写多个文件、多轮工具调用），` +
            `你应该在开始前简要提醒用户：当前会话上下文已较满（${pct}%），复杂任务可能导致上下文溢出或响应变慢，` +
            `建议开一个新会话来做这个功能。如果用户坚持在当前会话做，则正常执行不再重复提醒。`,
        });
      }
    }

    return injections;
  }
}
