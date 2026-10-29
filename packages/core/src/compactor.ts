/**
 * 上下文压缩器 - 无感压缩历史消息
 *
 * 策略：当 token 用量超过阈值时，保留 system prompt + 最近 N 轮原文，
 * 把更早的消息用 LLM 生成摘要替代。
 *
 * 用户端完全无感，只是 token 进度条百分比会降下来。
 *
 * 关键约束（防 API 400）：切割点必须落在完整回合边界上，绝不能把
 * assistant(tool_calls) 与其对应的 role:tool 结果拆散——否则发给
 * OpenAI/Anthropic 会因"孤儿 tool_calls / 孤儿 tool 结果"直接报错。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { DEFAULT_CONTEXT_WINDOW } from "./llm/modelContext.js";
import { estimateChatMessagesTokens } from "./llm/tokenEstimator.js";
import type { LLMStrategy } from "./llm/types.js";
import { NO_TRUNCATE_TOOLS } from "./tools/catalog.js";
import { parseMemoryUpdates, renderMemoryForModel, type MemoryUpdate } from "./session/memoryStore.js";

/** 压缩配置 */
interface CompactConfig {
  /** 触发压缩的 token 阈值（占总上下文的百分比） */
  triggerPercent: number;
  /** 保留最近多少条消息不压缩 */
  keepRecentCount: number;
  /** 上下文总容量（由调用方按当前模型注入真实窗口大小） */
  maxTokens: number;
}

const DEFAULT_CONFIG: CompactConfig = {
  triggerPercent: 0.35,
  // 手动/溢出压缩：至少保留最近 3 个用户问题对应的完整回合。经验值按消息条数近似取 12 条，
  // 比原来的 8 条更保守，减少“刚聊完的重要细节被压掉”的体感。
  keepRecentCount: 12,
  maxTokens: DEFAULT_CONTEXT_WINDOW,
};

/**
 * 滚动压缩的用户可调配置。
 * 由呈现端（VS Code 设置 / CLI flag）注入，AgentSession 在触发压缩时读取。
 */
export interface CompactionUserConfig {
  /** 滚动压缩总开关。关闭后不再自动压缩历史（工具结果仍在写入历史时按单次上限裁剪） */
  enabled: boolean;
  /** 触发阈值：自上次压缩后累计 token 超过此值，异步触发滚动压缩 */
  triggerTokens: number;
  /** 保留最近多少条消息不压缩（原文保留） */
  keepRecentMessages: number;
  /** 旧工具结果 content 裁剪后保留的最大字符数（仅 pruneOldToolResults 使用，回合收尾已不再调用） */
  toolResultPruneChars: number;
  /**
   * @deprecated 回合收尾不再裁剪旧工具结果（会改写历史中间、断前缀缓存），该配置已无效，
   * 仅为兼容旧的宿主注入保留。工具结果改为写入历史时按单次上限一次裁到位（capToolContent）。
   */
  toolResultKeepTurns: number;
  /**
   * 自动压缩线：auto = 按窗口留出余量（见 autoCompactThreshold，约 75%~85%）；
   * early = 不超过窗口一半就压，换更稳的回复质量与更低的单轮成本。
   */
  autoCompactAt: AutoCompactMode;
}

export type AutoCompactMode = "auto" | "early";

/**
 * 余量 = 窗口 15%，夹在 [32k, 160k]：
 * - 下限 32k：一次回答里连读十几个文件、跑几条命令就能涨这么多，小窗口模型按比例算会不够；
 * - 上限 160k：1M 窗口按比例要留 150k，再多就是白白空着。
 */
const AUTO_COMPACT_RESERVE_RATIO = 0.15;
const AUTO_COMPACT_RESERVE_MIN = 32_000;
const AUTO_COMPACT_RESERVE_MAX = 160_000;
/** 无论窗口多小，自动压缩线都不低于窗口一半（否则小窗口模型几乎每轮都在压） */
const AUTO_COMPACT_FLOOR_RATIO = 0.5;
/** early 模式的压缩线 */
const EARLY_COMPACT_RATIO = 0.5;

/**
 * 自动压缩线（token）。按「窗口 − 余量」算，而不是固定比例：
 * 固定 75% 在 128k 模型上只剩 32k 余量，一次长回答就能撞上限；在 1M 模型上却空着 250k。
 *   128k → 96k（75%）· 200k → 168k（84%）· 1M → 850k（85%）
 * 前后端（上下文面板的刻度与「距自动压缩还剩」）都以这里为准。
 */
export function autoCompactThreshold(contextWindow: number, mode: AutoCompactMode = "auto"): number {
  if (!(contextWindow > 0)) return 0;
  const reserve = Math.min(
    AUTO_COMPACT_RESERVE_MAX,
    Math.max(AUTO_COMPACT_RESERVE_MIN, Math.round(contextWindow * AUTO_COMPACT_RESERVE_RATIO)),
  );
  const auto = Math.max(Math.round(contextWindow * AUTO_COMPACT_FLOOR_RATIO), contextWindow - reserve);
  return mode === "early" ? Math.min(auto, Math.round(contextWindow * EARLY_COMPACT_RATIO)) : auto;
}

/**
 * 默认滚动压缩配置。
 *
 * enabled 默认 false：滚动压缩会静默把早期消息替换为 LLM 摘要，用户完全无感知
 * （不弹窗、不询问，仅发一个前端未必监听的 rolling_summary_done 事件）。这是一个
 * 影响用户可见历史的行为，必须由用户显式开启，不能作为"未配置时的兜底行为"。
 * 各宿主（VS Code 设置 / Web server 环境变量）如需开启，应显式传入 enabled: true。
 */
export const DEFAULT_COMPACTION_CONFIG: CompactionUserConfig = {
  enabled: false,
  triggerTokens: 30_000,
  keepRecentMessages: 8,
  toolResultPruneChars: 800,
  toolResultKeepTurns: 2,
  autoCompactAt: "auto",
};

/**
 * 检查是否需要压缩。
 * @param totalTokens 当前累计 token（优先传 API 返回的真实值）
 * @param maxTokens 当前模型的真实上下文窗口
 * @param thresholdPercent 触发阈值百分比，默认 0.35（手动压缩用）。自动压缩线见 autoCompactThreshold
 */
export function needsCompaction(totalTokens: number, maxTokens = DEFAULT_CONTEXT_WINDOW, thresholdPercent = DEFAULT_CONFIG.triggerPercent): boolean {
  return totalTokens > maxTokens * thresholdPercent;
}

/**
 * 判断某条消息是否为"带工具调用的 assistant 消息"。
 * 这种消息后面必须紧跟它所有 tool_call 对应的 role:tool 结果，不可被切散。
 */
function hasToolCalls(msg: ChatCompletionMessageParam): boolean {
  const tc = (msg as { tool_calls?: unknown[] }).tool_calls;
  return Array.isArray(tc) && tc.length > 0;
}

/** 判断某条消息是否为工具结果 */
function isToolResult(msg: ChatCompletionMessageParam): boolean {
  return (msg as { role?: string }).role === "tool";
}

/**
 * 把"保留最近 N 条"的切割点向前对齐到一个完整回合边界，避免拆散
 * assistant(tool_calls) 与其 tool 结果。
 *
 * 输入 history（不含 system），返回安全的 splitIndex：history[0..splitIndex) 进摘要，
 * history[splitIndex..] 原样保留。保证：
 * - splitIndex 处不是"悬空的 tool 结果"（其前驱 assistant tool_calls 不能被切到摘要侧）
 * - 即把切割点一直向前移到某个不是 tool 结果、且其前一条不是带 tool_calls 的 assistant 的位置
 */
function alignSplitIndex(history: ChatCompletionMessageParam[], desiredKeep: number): number {
  let splitIndex = Math.max(0, history.length - desiredKeep);

  // 向前移动 splitIndex，直到它不会把一个 tool_call 序列切成两半
  while (splitIndex > 0 && splitIndex < history.length) {
    const firstKept = history[splitIndex];
    const prev = history[splitIndex - 1];
    // 情况一：保留侧第一条是 tool 结果 → 它的 assistant 调用在摘要侧，悬空。前移。
    if (isToolResult(firstKept)) {
      splitIndex--;
      continue;
    }
    // 情况二：摘要侧最后一条是带 tool_calls 的 assistant → 它的结果在保留侧，悬空。前移把整个序列纳入保留侧。
    if (hasToolCalls(prev)) {
      splitIndex--;
      continue;
    }
    break;
  }
  return splitIndex;
}

/**
 * 执行无感压缩
 *
 * @param messages 当前完整消息列表
 * @param strategy LLM 策略（用于生成摘要；与主对话使用同一策略，兼容 chat/responses/anthropic 协议）
 * @param model 模型名
 * @param config 压缩配置（调用方注入真实 maxTokens）
 * @returns 压缩后的消息列表
 */
export async function compactMessages(
  messages: ChatCompletionMessageParam[],
  strategy: LLMStrategy,
  model: string,
  config = DEFAULT_CONFIG,
  opts: SummaryOptions = {},
): Promise<ChatCompletionMessageParam[]> {
  // 分离：system prompt + 历史
  const systemMsg = messages[0]; // system prompt 始终保留
  const history = messages.slice(1);

  // 如果消息太少不需要压缩
  if (history.length <= config.keepRecentCount) {
    return messages;
  }

  // 切割点对齐到完整回合边界，避免拆散 tool_call/tool_result
  const splitIndex = alignSplitIndex(history, config.keepRecentCount);

  // 对齐后若没有可压缩的旧消息（全被纳入保留侧），直接返回原列表
  if (splitIndex <= 0) {
    return messages;
  }

  const oldMessages = history.slice(0, splitIndex);
  const recentMessages = history.slice(splitIndex);

  // 用 LLM 对旧消息生成摘要。旧消息开头可能就是上一次压缩留下的摘要：
  // 早先它被当成普通消息按 500 字截断后再摘要，压一次丢一截，多压几次前面的内容就没了。
  // 现在把它原文作为「已有摘要」传入，与新消息合并成新摘要。
  const prevSummary = oldMessages.find(isSummaryMessage);
  const prevSummaryText = typeof prevSummary?.content === "string" ? prevSummary.content.replace("[对话历史摘要]\n", "") : "";
  const summary = await generateMergedSummary(prevSummaryText, oldMessages, strategy, model, opts);

  // 构建压缩后的消息列表
  return [
    systemMsg,
    { role: "user" as const, content: `[对话历史摘要]\n${summary}` },
    { role: "assistant" as const, content: "明白，我已了解之前的对话内容。" },
    ...recentMessages,
  ];
}

/**
 * 回答进行中的压缩（两轮工具调用之间触发）：当前这条用户请求必须原样留在上下文里。
 *
 * compactMessages 按「最近 N 条」切：一次回答里连着十几轮工具调用时，最近 N 条全是工具轮，
 * 用户这一轮问了什么反而被压进摘要——模型接着干活却看不到原始要求。这里改成：
 *
 * ① 本轮（当前用户消息起）不大：只压更早的对话，本轮原样保留，与回合间压缩效果一样；
 * ② 本轮自己就很大（读了一堆大文件）：本轮前面的工具轮也进摘要，但用户消息原样钉在摘要之后，
 *    后面接着最近几轮工具调用（按 token 预算保留，至少保留最后一整轮）。
 *
 * 切割点同样不拆散 assistant(tool_calls) 与其 tool 结果。压不出东西时原样返回（调用方据此判断）。
 *
 * @param turnStart 当前用户消息在 messages 里的下标（≥1）
 * @param keepTokens 保留部分的 token 预算（本地估算口径）
 */
export async function compactKeepingCurrentTurn(
  messages: ChatCompletionMessageParam[],
  strategy: LLMStrategy,
  model: string,
  turnStart: number,
  keepTokens: number,
  opts: SummaryOptions = {},
): Promise<ChatCompletionMessageParam[]> {
  if (turnStart < 1 || turnStart >= messages.length) return messages;
  const systemMsg = messages[0];
  const before = messages.slice(1, turnStart);
  const userMsg = messages[turnStart];
  const turn = messages.slice(turnStart + 1);
  // 本轮之前只剩上次压缩留下的「摘要 + 确认」：再摘一遍省不出空间
  const beforeHasContent = before.some((m) => !isSummaryMessage(m) && !isSummaryAck(m) && !isEphemeral(m));

  let old: ChatCompletionMessageParam[];
  let kept: ChatCompletionMessageParam[];
  let pinned = false;
  if (beforeHasContent && estimateChatMessagesTokens([userMsg, ...turn]) <= keepTokens) {
    old = before;
    kept = [userMsg, ...turn];
  } else {
    // 从末尾往前按预算保留，再对齐到完整回合边界
    let keepCount = 0;
    let used = 0;
    for (let i = turn.length - 1; i >= 0; i--) {
      used += estimateChatMessagesTokens([turn[i]]);
      if (keepCount > 0 && used > keepTokens) break;
      keepCount++;
    }
    const split = alignSplitIndex(turn, keepCount);
    if (split <= 0) {
      if (!beforeHasContent) return messages;
      old = before;
      kept = [userMsg, ...turn];
    } else {
      old = [...before, userMsg, ...turn.slice(0, split)];
      kept = [userMsg, ...turn.slice(split)];
      pinned = true;
    }
  }

  const prevSummary = old.find(isSummaryMessage);
  const prevSummaryText = typeof prevSummary?.content === "string" ? prevSummary.content.replace("[对话历史摘要]\n", "") : "";
  let summary = await generateMergedSummary(prevSummaryText, old.filter((m) => !isEphemeral(m)), strategy, model, opts);
  if (pinned) {
    summary += "\n\n（摘要末尾是当前这条请求下已经完成的步骤。请求原文见下一条消息，在已完成的基础上继续，不要重做。）";
  }
  return [
    systemMsg,
    { role: "user" as const, content: `[对话历史摘要]\n${summary}` },
    { role: "assistant" as const, content: "明白，我已了解之前的对话内容。" },
    ...kept,
  ];
}

function isSummaryAck(msg: ChatCompletionMessageParam): boolean {
  return msg?.role === "assistant" && typeof msg.content === "string" && msg.content.startsWith("明白，我已了解");
}

/** 单轮临时注入（反思引导等）：不属于对话事实，不进摘要 */
function isEphemeral(msg: ChatCompletionMessageParam): boolean {
  return !!(msg as { _ephemeralInjected?: boolean })._ephemeralInjected;
}

/** 工具调用 → 一行「工具名 + 关键参数」：摘要要知道改了哪个文件、跑了什么命令，而不只是「(工具调用)」 */
function describeToolCallsBrief(msg: ChatCompletionMessageParam): string {
  const calls = (msg as { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }).tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return "";
  return calls.map((call) => {
    const name = call?.function?.name || "未知工具";
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(call?.function?.arguments || "{}"); } catch { /* 参数不是合法 JSON 时只给工具名 */ }
    const key = ["path", "command", "query", "url"].find((k) => typeof args[k] === "string" && args[k]);
    const value = key ? String(args[key]).replace(/\s+/g, " ").slice(0, 160) : "";
    return value ? `${name}(${value})` : name;
  }).join("；");
}

/**
 * 压缩留下的摘要消息（role=user，内容以「[对话历史摘要]」开头）。它不是用户发的：
 * 压缩时要原样带上而不是截断，前端显示成「早期对话已压缩」分隔，
 * 按用户消息序号定位（编辑 / 分叉）时也要跳过它，前后端口径才一致。
 */
export function isSummaryMessage(msg: ChatCompletionMessageParam): boolean {
  return msg?.role === "user" && typeof msg.content === "string" && msg.content.startsWith("[对话历史摘要]");
}

/**
 * 把消息列表序列化为可读文本（供摘要 LLM 消费）。
 * 工具轮的正文在 displayContent 里（content 恒为 null），工具调用只保留工具名 + 关键参数。
 */
function serializeHistory(messages: ChatCompletionMessageParam[]): string {
  const MAX_CHARS = 800;
  return messages
    .map((msg) => {
      if (!msg) return ""; // 防御：消息为 undefined/null 时跳过
      if (isSummaryMessage(msg)) return ""; // 已有摘要由调用方单独传入
      if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.startsWith("明白，我已了解")) return "";
      const role = msg.role === "user" ? "用户" : msg.role === "assistant" ? "助手" : msg.role === "system" ? "系统" : "工具";
      const text = typeof msg.content === "string" && msg.content.trim()
        ? msg.content
        : typeof (msg as any).displayContent === "string" ? (msg as any).displayContent as string : "";
      const calls = describeToolCallsBrief(msg);
      const content = [text, calls ? `调用：${calls}` : ""].filter(Boolean).join("\n") || "（无文本内容）";
      const truncated = content.length > MAX_CHARS ? content.slice(0, MAX_CHARS) + "..." : content;
      return `[${role}] ${truncated}`;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * 记忆生成专用的历史序列化：单条截断比摘要宽得多。
 *
 * 摘要只需要知道「聊了什么」；记忆还要记住「具体改了哪个文件、执行了什么命令、报错原文是什么」。
 * 500 字符经常正好把关键路径或错误信息切掉，所以这里放到 2000。
 */
/** @internal 供记忆生成测试验证工具调用不会被压成无信息的"（工具调用）"。 */
export function serializeHistoryForMemory(messages: ChatCompletionMessageParam[]): string {
  const MAX_CHARS = 3000;
  return messages
    .map((msg) => {
      if (!msg) return "";
      const role = msg.role === "user" ? "用户" : msg.role === "assistant" ? "助手" : msg.role === "system" ? "系统" : "工具";
      const rawContent = typeof msg.content === "string" && msg.content.trim()
        ? msg.content
        : typeof (msg as any).displayContent === "string" && (msg as any).displayContent.trim()
          // 工具轮的叙述在 displayContent 里（content 恒为 null）：「为什么改这里」常常就写在这几句里
          ? (msg as any).displayContent as string
        : Array.isArray(msg.content)
          ? msg.content.map((part: any) => part?.type === "text" ? part.text : part?.type === "image_url" ? "（图片）" : "").filter(Boolean).join(" ")
          : typeof (msg as any).runtimeContent === "string"
            ? (msg as any).runtimeContent
            : "";
      const toolCalls = Array.isArray((msg as any).tool_calls)
        ? (msg as any).tool_calls.map((call: any) => {
            const name = call?.function?.name || call?.name || "未知工具";
            const args = call?.function?.arguments;
            let parsedArgs = args || "";
            if (typeof args === "string") {
              try { parsedArgs = JSON.stringify(JSON.parse(args)); } catch { /* 保留原始参数 */ }
            }
            return `调用工具 ${name}${parsedArgs ? ` 参数：${parsedArgs}` : ""}`;
          }).join("；")
        : "";
      const content = [rawContent, toolCalls].filter(Boolean).join("\n").trim() || "（无文本内容）";
      const truncated = content.length > MAX_CHARS ? content.slice(0, MAX_CHARS) + "…（已截断）" : content;
      return `[${role}] ${truncated}`;
    })
    .join("\n");
}

/**
 * 生成 / 更新会话记忆：把「现有记忆 + 这批历史」收敛成一份新的完整记忆。
 *
 * ── 与 generateRollingSummary 的分工（别合并成一个调用）──
 * 摘要是给模型看的上下文压缩，允许丢细节、控制在 1000 字内；
 * 记忆是给人跨会话看的结论，必须尽量完整：决策、约束、文件路径、数据、待办、踩过的坑都不能丢。
 * 目标不同，所以 prompt 和输出上限都不同。
 *
 * ⚠️ 必须用【压缩前】的历史调用：摘要一旦生成，被压掉的原文就没了，
 * 而记忆恰恰要保住摘要保不住的那些细节。
 */
export async function generateSessionMemory(
  prevMemory: string,
  messages: ChatCompletionMessageParam[],
  strategy: LLMStrategy,
  model: string,
  opts: { modelSupportsThinking?: boolean } = {},
): Promise<MemoryUpdate[]> {
  const historyText = serializeHistoryForMemory(messages);
  const existing = prevMemory.trim() ? renderMemoryForModel(prevMemory) : "";
  const systemPrompt = `你是会话记忆维护助手。会话记忆是这次会话「值得长期保留的结论」，会注入给之后的每一轮对话，也会被用户导出带到新会话里。你的任务：读「新增对话记录」，把其中值得保留的知识合并进「已有记忆」。

【已有记忆】（每个块后面的 〔key: …〕 是它的 key）
${existing || "（目前为空）"}

【新增对话记录】（上次整理记忆之后发生的对话）
${historyText}

一、要保留什么（宁可多写也不要漏）
- 用户交代的偏好、约束、规范（「以后都…」「不要…」「统一用…」），原话里的关键限定词不要丢。
- 敲定的设计决策及其理由、被否决的方案及原因。
- 工作区理解：项目结构、关键模块、构建 / 测试命令、关键文件的绝对路径。
- 完成的关键改动（改了哪些文件、为什么改）、验证结果。
- 未完成的待办、已知问题、踩过的坑与规避方式。
- 具体的值：路径、命令、配置项、版本号、报错原文的关键片段——这些最容易丢，也最有用。

二、不要保留什么
- 寒暄、重复确认、工具调用的过程、失败重试的中间态、能直接从源码读到的普通事实。

三、怎么输出
只输出 JSON，不要 Markdown 包裹，不要解释：
{"updates":[{"action":"append|upsert|delete","key":"…","section":"project|workspace|decisions|preferences|status|pitfalls|todos|other","title":"中文标题","content":"Markdown 内容"}]}
- 更新已有块必须用它的原 key（〔key: …〕里的值），不要另起一个意思相同的新块。
- 给已有块增加条目 → append，content 只写新增的条目。
- 改写已有块 → upsert，content 必须是该块【改写后的完整内容】（保留仍然有效的旧条目），不是只写变化的部分。
- 新主题 → 新 key + 新标题；每个块只讲一个主题，按主题归并，不要一句话一个块。
- 明确过时、被推翻的整块才 delete；只是部分过时就 upsert 完整的新版本。
- 只返回本次需要变化的块，没变化的旧块不要重复输出；没有值得更新的内容就返回 {"updates":[]}。`;

  const turn = await strategy.runTurn({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: "请只输出本次需要合并的 JSON 增量更新。" },
    ],
    tools: [],
    callbacks: SILENT_CALLBACKS,
    maxOutputTokens: 4000,
    // 整理记忆是抽取任务，不需要深度思考：关掉思考能快很多，也不会把输出预算花在推理上
    think: false,
    modelSupportsThinking: opts.modelSupportsThinking,
  });

  return parseMemoryUpdates(turn.content || "");
}

/** 生成摘要用的空回调（不需要流式上报给前端，只取最终 content） */
const SILENT_CALLBACKS = {
  onReasoningDelta: () => {},
  onTextDelta: () => {},
  onToolCallDetected: () => {},
};

/**
 * 生成摘要：把「已有摘要 + 本批旧消息」合并成一份新摘要。手动 / 溢出压缩与滚动压缩共用。
 *
 * 摘要是压缩后模型唯一能看到的早期上下文，比记忆更偏「过程」：做到哪一步、改了哪些文件、
 * 用户纠正过什么。早先输出上限 500 token（约 700 字）还要求「1000 字以内」，长会话压一次
 * 就截断一次；现在放宽到 2000 token，并要求保留路径、命令、用户原话里的约束。
 */
async function generateMergedSummary(
  prevSummary: string,
  messages: ChatCompletionMessageParam[],
  strategy: LLMStrategy,
  model: string,
  opts: SummaryOptions = {},
): Promise<string> {
  const ask = async (history: ChatCompletionMessageParam[]): Promise<string> => {
    const historyText = serializeHistory(history);
    const systemPrompt = `你是对话摘要助手。这份摘要会替代被压缩掉的早期对话，之后模型只能通过它了解前面发生过什么，所以要让模型读完就能无缝接着干活。

${prevSummary ? `【已有摘要】（更早的对话，必须合并保留其中仍然有效的信息）\n${prevSummary}\n` : ""}
【需要合并的新对话】
${historyText}

必须保留：
1. 用户的目标、偏好与约束（保留原话里的关键限定词），以及用户纠正过你的地方。
2. 敲定的决策及理由、否决过的方案。
3. 已完成的操作：改了哪些文件（写路径）、执行过的关键命令、验证结果。
4. 当前进度：做到哪一步、还剩什么、卡在哪里。
5. 关键的具体值：路径、配置项、报错原文的关键片段。

可以丢弃：寒暄与重复确认、工具输出的大段原文、失败重试的中间过程。

输出：按主题分组的简洁要点列表，控制在 1500 字以内；已有摘要里仍然有效的内容要保留，不要因为新内容多就把旧的挤掉。`;

    const turn = await strategy.runTurn({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "请输出合并后的完整摘要。" },
      ],
      tools: [],
      callbacks: SILENT_CALLBACKS,
      maxOutputTokens: 3000,
      // 必须关思考：思考型模型（deepseek-v4-pro 等）会把输出额度全花在推理上、正文为空。
      // 早先就是这样拿到空摘要，再用一句「（无法生成摘要）」把整段早期对话换掉了。
      think: false,
      modelSupportsThinking: opts.modelSupportsThinking,
    });
    return (turn.content || "").trim();
  };

  // 第一次失败（空 / 异常）时用后半段消息再试一次：输入太长是另一个常见原因
  try {
    const first = await ask(messages);
    if (first) return first;
  } catch (err) {
    console.warn("[compact] 摘要生成失败，缩短输入重试:", (err as Error).message);
  }
  try {
    const second = await ask(messages.slice(Math.floor(messages.length / 2)));
    if (second) return second;
  } catch (err) {
    console.warn("[compact] 摘要重试仍失败，改用原文摘录:", (err as Error).message);
  }
  // 两次都失败：绝不能用一句「无法生成摘要」替换掉整段早期对话，从原文里摘录要点兜底
  return buildFallbackSummary(prevSummary, messages);
}

/** 摘要生成选项 */
export interface SummaryOptions {
  /** 声明的思考能力：think:false 据此决定是否显式下发「关闭思考」参数 */
  modelSupportsThinking?: boolean;
}

/**
 * 模型摘要两次都失败时的兜底：不调模型，直接从原文摘录。
 * 保留已有摘要全文、用户每一条消息的开头、涉及的文件与命令——信息密度不如模型摘要，
 * 但不会把早期对话整个丢掉。
 */
export function buildFallbackSummary(prevSummary: string, messages: ChatCompletionMessageParam[]): string {
  const asks: string[] = [];
  const touched: string[] = [];
  for (const msg of messages) {
    if (!msg || isSummaryMessage(msg)) continue;
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content) ? msg.content.map((p: any) => (p?.type === "text" ? p.text : "")).join(" ") : "";
      const oneLine = text.replace(/\s+/g, " ").trim();
      if (oneLine) asks.push(`- ${oneLine.slice(0, 200)}${oneLine.length > 200 ? "…" : ""}`);
    }
    const calls = describeToolCallsBrief(msg);
    if (calls) for (const c of calls.split("；")) if (!touched.includes(c)) touched.push(c);
  }
  const parts = ["（自动摘要生成失败，以下是从早期对话原文摘录的要点）"];
  if (prevSummary.trim()) parts.push(`更早的摘要：\n${prevSummary.trim()}`);
  if (asks.length) parts.push(`用户提过的问题与要求：\n${asks.slice(-30).join("\n")}`);
  if (touched.length) parts.push(`涉及的文件与命令：\n${touched.slice(-40).map((t) => `- ${t}`).join("\n")}`);
  return parts.join("\n\n");
}

// reflectiveCompact / generateFailureSummary 已移除。
//
// 原设计：Agent 反复失败时，把整段历史压成"失败复盘摘要"再让模型重来。
// 问题：复盘需要完整失败细节（哪条命令报了什么错、哪个文件改了几次）才能避免重蹈覆辙，
//       而压缩恰恰清除了这些关键依据，导致模型"知道失败了但不知道怎么失败的"，重新踩同一个坑。
//
// 现设计：反思/深度复盘仅注入引导（ReflectionHandler），不压缩上下文。
//       上下文压缩只由 CompactionController 在 token 真正接近窗口上限时触发。



// ──────────────────────────────────────────────────────────────────────────────
// 滚动摘要（rolling summary）—— 每累计一定量新 token 后，异步把"旧消息"压成摘要
//
// 与 compactMessages 的区别：
// - compactMessages：一次性大压缩（手动 / 自动压缩线 / 溢出触发），保留最近 12 条
// - rollingSummary：增量式小压缩（每累计 ~30K token 触发），保留最近 N 条，
//   把上一段摘要 + 中间消息合并成新的摘要，保持上下文体积始终稳定在低位
//
// 调用时机：每轮 stream_end 后异步触发，不阻塞用户发下一条消息
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 棚栏搜索：在 messages 中找到 system + 上一段摘要之后的位置。
 * 返回第一个"非 system、非摘要、非摘要确认"的消息索引。
 * 如果没有上一段摘要，返回 1（跳过 system）。
 */
function findSummaryBoundary(messages: ChatCompletionMessageParam[]): number {
  for (let i = 1; i < messages.length; i++) {
    const content = typeof messages[i].content === "string" ? (messages[i].content as string) : "";
    if (messages[i].role === "user" && content.startsWith("[对话历史摘要]")) continue;
    if (messages[i].role === "assistant" && content.startsWith("明白，我已了解")) continue;
    return i;
  }
  return Math.min(1, messages.length);
}

/**
 * 执行滚动摘要：
 * - system + 已有摘要 → 合并 → 新摘要
 * - 中间旧消息（摘要边界到 keepRecentCount 之间）→ 进新摘要
 * - 最近 keepRecentCount 条 → 原文保留
 *
 * @returns [新消息列表, 是否实际执行了摘要]；如果不需要摘要则返回 [原消息, false]
 */
export async function rollingCompact(
  messages: ChatCompletionMessageParam[],
  strategy: LLMStrategy,
  model: string,
  keepRecentCount = 8,
  opts: SummaryOptions = {},
): Promise<[ChatCompletionMessageParam[], boolean]> {
  const systemMsg = messages[0];
  const history = messages.slice(1);
  if (history.length <= keepRecentCount + 2) return [messages, false];

  // 找到已有摘要的边界
  const summaryEnd = findSummaryBoundary(messages) - 1; // history 坐标
  // 需要被压缩的旧消息（已有摘要之后的、不属于保留区的）
  const splitIndex = alignSplitIndex(history, keepRecentCount);
  if (splitIndex <= Math.max(summaryEnd, 1)) return [messages, false]; // 没有足够的旧消息可压缩

  const oldMessages = history.slice(Math.max(0, summaryEnd), splitIndex);
  if (oldMessages.length < 3) return [messages, false]; // 太少不值得压缩

  const recentMessages = history.slice(splitIndex);

  // 提取已有摘要文本（如果有）
  const prevSummaryText = summaryEnd > 0
    ? (typeof history[0]?.content === "string" && (history[0].content as string).includes("[对话历史摘要]")
      ? (history[0].content as string).replace("[对话历史摘要]\n", "")
      : "")
    : "";

  // 生成新摘要（合并旧摘要 + 新旧消息）
  const summary = await generateMergedSummary(prevSummaryText, oldMessages, strategy, model, opts);

  return [
    [
      systemMsg,
      { role: "user" as const, content: `[对话历史摘要]\n${summary}` },
      { role: "assistant" as const, content: "明白，我已了解之前的对话内容。" },
      ...recentMessages,
    ],
    true,
  ];
}
//
// 核心思路：Agent 一轮对话可能调 5-10 次工具，每次返回几百到几千 token。
// 但 2-3 轮后这些工具输出对后续对话几乎零价值——AI 已经提取了信息并写在回复里了。
// 本函数把"足够老"的 tool 结果 content 截断，但保留 tool_call 结构完整性。
// ──────────────────────────────────────────────────────────────────────────────

/** 单个 tool 结果 content 保留的最大字符数（超出部分替换为截断标记） */
const PRUNE_KEEP_CHARS = 800;

/** 工具结果裁剪配置（运行时可被 CompactionUserConfig 覆盖） */
let _pruneKeepChars = PRUNE_KEEP_CHARS;

/** 设置工具结果裁剪保留字符数（由 AgentSession 在配置变更时调用） */
export function setPruneKeepChars(chars: number): void {
  _pruneKeepChars = Math.max(50, Math.floor(chars));
}

/**
 * 根据工具名决定裁剪方向：保留开头还是末尾。
 * - read_file / list_dir：开头最重要（签名、import、目录结构）
 * - execute_command：末尾最重要（最新的报错 / 最终输出）
 * - search：开头有命中摘要（文件名:行号），但从末尾保留最新匹配更有价值
 * - 其余默认：保留开头
 */
function shouldKeepTail(toolName: string): boolean {
  const tailTools = ["execute_command", "search", "search_workspace", "grep", "get_process_output", "wait_process", "get_browser_logs"];
  return tailTools.includes(toolName);
}

/** 从工具调用的 function.name 提取工具名 */
function extractToolName(messages: ChatCompletionMessageParam[], toolIdx: number): string {
  const toolMsg = messages[toolIdx] as { role?: string; tool_call_id?: string };
  if (!toolMsg?.tool_call_id) return "";
  for (let i = toolIdx - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; tool_calls?: { id: string; function?: { name?: string } }[] };
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      const tc = m.tool_calls.find((t) => t.id === toolMsg.tool_call_id);
      return tc?.function?.name || "";
    }
  }
  return "";
}

/**
 * 找到与某条 tool 结果消息对应的 assistant tool_calls 消息。
 * 从 tool 消息向前扫描，直到找到带 tool_calls 且 id 匹配的 assistant。
 */
function findMatchingAssistant(
  messages: ChatCompletionMessageParam[],
  toolIdx: number,
): number {
  const toolMsg = messages[toolIdx] as { role?: string; tool_call_id?: string };
  if (!toolMsg || toolMsg.role !== "tool" || !toolMsg.tool_call_id) return -1;
  for (let i = toolIdx - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; tool_calls?: { id: string }[] };
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      if (m.tool_calls.some((tc) => tc.id === toolMsg.tool_call_id)) return i;
    }
  }
  return -1;
}

/**
 * 判断一条 assistant 消息（含 tool_calls）是否属于"最近 keepRecentTurns 轮"。
 * 通过统计该消息之后有多少次 user 消息来近似判断"轮次深度"。
 */
function countTurnsAfter(messages: ChatCompletionMessageParam[], idx: number): number {
  let turns = 0;
  for (let i = idx + 1; i < messages.length; i++) {
    if (messages[i].role === "user") turns++;
  }
  return turns;
}

/**
 * 即时裁剪旧 tool 结果——每次 turn 结束后调用。
 *
 * 规则：
 * - 找到所有 role:tool 消息
 * - 如果它对应的 assistant(tool_calls) 之后已经有 ≥ keepRecentTurns 次 user 消息，
 *   说明这个工具调用已经"足够老"，裁剪它的 content
 * - 裁剪 = 保留前 PRUNE_KEEP_CHARS 字符 + 截断标记
 * - 不破坏结构：tool_call_id 不变，tool_calls 原样保留
 *
 * @param messages 完整消息列表（含 system）
 * @param keepRecentTurns 保留最近几轮的 tool 结果不裁剪，默认 2
 * @returns 新的消息数组（已裁剪），原数组不被修改
 */
export function pruneOldToolResults(
  messages: ChatCompletionMessageParam[],
  keepRecentTurns = 2,
): ChatCompletionMessageParam[] {
  if (messages.length < 4) return messages;

  // 找出需要裁剪的 tool 消息索引
  const toPrune: { idx: number; originalLen: number }[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as { role?: string };
    if (msg.role !== "tool") continue;

    // 找到对应的 assistant(tool_calls)
    const assistantIdx = findMatchingAssistant(messages, i);
    if (assistantIdx < 0) continue;

    // 距离当前有多"老"
    const turnsAfter = countTurnsAfter(messages, assistantIdx);
    if (turnsAfter < keepRecentTurns) continue;

    // 检查是否已经裁剪过（避免重复裁剪）
    const content = typeof messages[i].content === "string" ? (messages[i].content as string) : "";
    if (content.includes("[... 已裁剪")) continue;
    if (content.length <= PRUNE_KEEP_CHARS) continue;

    // read_file / list_dir 的结果通常是后续改代码的依据，裁剪会丢失关键信息导致 AI 反复读文件。
    // 这些工具结果不在裁剪范围内，直接跳过。
    const toolName = extractToolName(messages, i);
    if (toolName === "read_file" || toolName === "list_dir") continue;
    // 结论型工具（子 Agent 交付物）一律不裁：它们没有“重新读一次”的回捞手段。
    // 终端类（execute_command / get_process_output）已移出该集合——输出体积由外部命令决定、
    // 旧轮次价值极低，故允许按下方的 keepTail 规则裁剪（保留尾部：报错与最终结论在末尾）。
    if (NO_TRUNCATE_TOOLS.has(toolName)) continue;

    toPrune.push({ idx: i, originalLen: content.length });
  }

  if (toPrune.length === 0) return messages;

  const keepChars = _pruneKeepChars;
  // 构建裁剪后的数组（浅拷贝 + 替换被裁剪的消息）
  const result = [...messages];
  for (const { idx, originalLen } of toPrune) {
    const original = result[idx];
    const content = typeof original.content === "string" ? original.content : "";
    const toolName = extractToolName(messages, idx);
    const keepTail = shouldKeepTail(toolName);

    let pruned: string;
    if (keepTail) {
      // 保留末尾（最新内容）：search 最新匹配、命令最终输出
      const tail = content.slice(-keepChars);
      pruned = `[... 已裁剪，原始结果 ${originalLen} 字符（保留最新 ${tail.length} 字符）...]\n\n${tail}`;
    } else {
      // 保留开头（函数签名、目录结构等）
      const head = content.slice(0, keepChars);
      pruned = `${head}\n\n[... 已裁剪，原始结果 ${originalLen} 字符 ...]`;
    }
    result[idx] = { ...original, content: pruned } as ChatCompletionMessageParam;
  }

  const savedChars = toPrune.reduce((sum, p) => sum + (p.originalLen - keepChars - 40), 0);
  if (savedChars > 0) {
    console.debug(`[prune] 裁剪了 ${toPrune.length} 条旧 tool 结果，节省约 ${savedChars} 字符 (≈${Math.round(savedChars / 4)} tokens)`);
  }

  return result;
}
