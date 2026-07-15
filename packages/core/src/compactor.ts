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
import type { LLMStrategy } from "./llm/types.js";

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
  /** 滚动压缩总开关。关闭后不再自动压缩历史（工具结果裁剪仍生效，见 toolResultKeepTurns） */
  enabled: boolean;
  /** 触发阈值：自上次压缩后累计 token 超过此值，异步触发滚动压缩 */
  triggerTokens: number;
  /** 保留最近多少条消息不压缩（原文保留） */
  keepRecentMessages: number;
  /** 旧工具结果 content 裁剪后保留的最大字符数 */
  toolResultPruneChars: number;
  /** 保留最近几轮的工具结果不裁剪（0 = 全裁） */
  toolResultKeepTurns: number;
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
};

/**
 * 检查是否需要压缩。
 * @param totalTokens 当前累计 token（优先传 API 返回的真实值）
 * @param maxTokens 当前模型的真实上下文窗口
 * @param thresholdPercent 触发阈值百分比，默认 0.35（手动压缩用）。auto 压缩用 0.75
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

  // 用 LLM 对旧消息生成摘要
  const summary = await generateSummary(oldMessages, strategy, model);

  // 构建压缩后的消息列表
  return [
    systemMsg,
    { role: "user" as const, content: `[对话历史摘要]\n${summary}` },
    { role: "assistant" as const, content: "明白，我已了解之前的对话内容。" },
    ...recentMessages,
  ];
}

/**
 * 把消息列表序列化为可读文本（供摘要 LLM 消费）。两类摘要（无感压缩 / 反思式重启）共用。
 */
function serializeHistory(messages: ChatCompletionMessageParam[]): string {
  return messages
    .map((msg) => {
      if (!msg) return ""; // 防御：消息为 undefined/null 时跳过
      const role = msg.role === "user" ? "用户" : msg.role === "assistant" ? "助手" : msg.role === "system" ? "系统" : "工具";
      const content = typeof msg.content === "string" ? msg.content : "(工具调用)";
      const truncated = content.length > 500 ? content.slice(0, 500) + "..." : content;
      return `[${role}] ${truncated}`;
    })
    .join("\n");
}

/** 生成摘要用的空回调（不需要流式上报给前端，只取最终 content） */
const SILENT_CALLBACKS = {
  onReasoningDelta: () => {},
  onTextDelta: () => {},
  onToolCallDetected: () => {},
};

/**
 * 用 LLM 生成历史消息的摘要
 */
async function generateSummary(
  messages: ChatCompletionMessageParam[],
  strategy: LLMStrategy,
  model: string,
): Promise<string> {
  const historyText = serializeHistory(messages);

  const turn = await strategy.runTurn({
    model,
    messages: [
      {
        role: "system",
        content: `你是一个对话摘要助手。请将以下对话历史压缩为简洁的摘要。

必须保留：
1. 用户提到的个人信息（名字、偏好、背景）
2. 已完成的操作（创建/修改了哪些文件、执行了什么命令）
3. 重要的决策和结论
4. 当前任务的状态

必须丢弃：
- 工具调用的详细参数和完整输出
- 重复的问候和确认
- 中间过程的冗余信息

输出格式：用简洁的要点列表，控制在 1000 字以内。`,
      },
      {
        role: "user",
        content: historyText,
      },
    ],
    tools: [],
    callbacks: SILENT_CALLBACKS,
    maxOutputTokens: 500,
  });

  return turn.content || "（无法生成摘要）";
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
// - compactMessages：一次性大压缩（手动 / 75% / 溢出触发），保留最近 8 条
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
  const summary = await generateRollingSummary(prevSummaryText, oldMessages, strategy, model);

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

/**
 * 生成滚动摘要：合并"上一段摘要 + 本批旧消息"为新摘要。
 */
async function generateRollingSummary(
  prevSummary: string,
  newMessages: ChatCompletionMessageParam[],
  strategy: LLMStrategy,
  model: string,
): Promise<string> {
  const newHistoryText = serializeHistory(newMessages);

  const systemPrompt = `你是一个对话摘要助手。请将以下信息压缩为一份更新的摘要。

${prevSummary ? `已有上一段摘要（需合并保留有效信息）：\n${prevSummary}\n` : ""}
需要合并的新对话内容：
${newHistoryText}

必须保留：
1. 用户提到的个人信息（名字、偏好、背景）
2. 已完成的操作（创建/修改了哪些文件、执行了什么命令）
3. 重要的决策和结论
4. 当前任务的状态

必须丢弃：
- 工具调用的详细参数和完整输出
- 重复的问候和确认
- 中间过程的冗余信息

输出格式：用简洁的要点列表，控制在 1000 字以内。`;

  const turn = await strategy.runTurn({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: newHistoryText },
    ],
    tools: [],
    callbacks: SILENT_CALLBACKS,
    maxOutputTokens: 500,
  });

  return turn.content || "（无法生成摘要）";
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
  const tailTools = ["execute_command", "search", "search_workspace", "grep", "get_process_output", "get_browser_logs"];
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
