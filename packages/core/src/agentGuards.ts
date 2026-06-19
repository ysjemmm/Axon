/**
 * Agent 运行时守卫 - 主 agent 与子 agent 共享的防护工具
 *
 * 把"判断模型输出是否是未完成的内心 OS"这类纯逻辑抽出来，
 * 保证主 agent（agentSession）和子 agent（subAgentRunner）行为一致。
 */

/**
 * 启发式检测：模型给出的内容是不是"未完成的内心 OS"而不是给用户的最终答案。
 *
 * 判定为"未完成"的特征（满足任一）：
 * - 内容很短（< 80 字符）且全英文 ASCII（中文用户场景下，短英文几乎一定是 reasoning 泄露）
 * - 含明显的英文 reasoning 信号词："Need more"、"Let me"、"I'll"、"OK let me"、"Continue" 等
 * - 含"我还需要..."这种典型未完成过渡句且整体较短
 */
export function looksLikeIncompleteReply(content: string): boolean {
  const trimmed = (content || "").trim();
  if (!trimmed) return false;

  // 全英文 ASCII 内容（中文用户场景下，英文回复几乎一定不是给用户的最终答案）
  const isAsciiOnly = /^[\x00-\x7F]+$/.test(trimmed);

  // 短内容（< 80 字符）且全英文：极可能是 reasoning 泄露
  if (isAsciiOnly && trimmed.length < 80) return true;

  // 较长的全英文内容但含明显的内心 OS 信号词（不限于开头）
  if (isAsciiOnly) {
    const reasoningSignals = /\b(need\s+(to|read|more|check)|let me|i['']?ll\s+\w+|also\s+\w+|maybe|we\s+(need|should)|but\s+(first|diagnostics)|inspect|undefined\s+in)/i;
    if (reasoningSignals.test(trimmed)) return true;
  }

  // 英文 reasoning 信号词（开头匹配，兜底）
  const englishReasoningPatterns = [
    /^need\s/i,
    /^let me\b/i,
    /^i['']?ll\s+(check|read|look|continue)/i,
    /^ok\s+let/i,
    /^continue\s+with/i,
    /^next,?\s+i/i,
    /^also\s/i,
  ];
  if (englishReasoningPatterns.some((p) => p.test(trimmed))) return true;

  // 中文未完成过渡句
  if (/^我(还|再|继续)?(需要|得|要)/.test(trimmed) && trimmed.length < 60) return true;
  if (/^(让我|接下来|下面我)/.test(trimmed) && trimmed.length < 40) return true;

  return false;
}

/**
 * 健壮解析 LLM 生成的工具调用参数 JSON。
 *
 * 模型偶尔会生成不规范的 JSON，最常见是 Windows 路径里的反斜杠未转义
 * （如 "D:\vscode\main.js" 里的 \v \m 不是合法 JSON 转义符），导致
 * JSON.parse 抛 "Bad escaped character"。直接崩会让整轮回复失败。
 *
 * 策略：先正常 parse；失败则尝试修复常见问题（转义孤立反斜杠）后再 parse；
 * 仍失败则抛出带原始内容的错误，由调用方当作"工具参数非法"反馈给模型重写。
 *
 * @returns 解析后的参数对象
 * @throws 修复后仍无法解析时抛错（错误信息含原始字符串片段，便于模型纠正）
 */
export function parseToolArguments(raw: string): Record<string, unknown> {
  const text = (raw ?? "").trim();
  if (!text) return {};

  // 1) 正常解析
  try {
    return JSON.parse(text);
  } catch {
    // 进入修复
  }

  // 2) 修复：把不是合法 JSON 转义序列的孤立反斜杠转义掉
  //    合法转义：\" \\ \/ \b \f \n \r \t \uXXXX —— 其余的 \（含 \x \v \0 \a 等 C 风格转义、
  //    Windows 路径反斜杠、正则里的 \d \s \w \. 等）都补成 \\，使其成为合法 JSON。
  try {
    const repaired = text.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
    return JSON.parse(repaired);
  } catch {
    // 仍失败
  }

  // 3) 二次修复：处理 \uXXXX 不完整（少于 4 位十六进制）等情况——把不合法的 \u 也转义掉
  try {
    const repaired = text
      .replace(/\\u(?![0-9a-fA-F]{4})/g, "\\\\u")
      .replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
    return JSON.parse(repaired);
  } catch {
    // 仍失败
  }

  // 4) 修复裸对象字面量：模型有时吐 {key: value} 而非 {"key": "value"}。
  //    尝试给无引号的 key 加双引号、给简单的无引号 value（如路径名）加引号。
  //    这对含大段 HTML/代码的 content 字段不一定有效，但能救简单参数。
  try {
    // 给无引号的 key 加引号：匹配 { 或 , 后面紧跟的 word 字符到冒号
    let attempt = text.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
    // 给冒号后面不以 " { [ 或数字开头的简单值加引号（贪心到下一个逗号或 }）
    attempt = attempt.replace(/:\s*([^"{\[\d\s][^,}]*)/g, (_, v) => ': "' + v.trim().replace(/"/g, '\\"') + '"');
    return JSON.parse(attempt);
  } catch {
    // 仍失败
  }

  // 6) 彻底失败：抛出可读错误（截断原始内容，避免过长）
  const preview = text.length > 200 ? text.slice(0, 200) + "..." : text;
  throw new Error(
    `工具参数不是合法 JSON，无法解析。请重新生成这次工具调用，确保参数是严格合法的 JSON` +
    `（注意：Windows 路径里的反斜杠必须写成 \\\\，或直接用正斜杠 /）。原始参数：${preview}`,
  );
}


/**
 * Agent 防失控策略（policy）：把散落在 agentSession 与 subAgentRunner 里的硬编码
 * 阈值收敛成一处可配置项，并允许按模型族给出不同强度（强模型可放松，弱模型收紧）。
 */
export interface AgentPolicy {
  /** 同一工具+完全相同参数，累计调用超过此次数即拦截（防鬼打墙） */
  maxSameCall: number;
  /** 同一文件 read_file 超过此次数即提示模型用已读内容 */
  maxFileReads: number;
  /** 连续失败的工具调用达到此数即强制收尾 */
  maxConsecutiveFailures: number;
  /** reasoning 泄露续写次数上限 */
  maxIncompleteRetries: number;
  /** agent loop 总轮数硬上限（极端兜底） */
  maxRounds: number;
  /**
   * 同一"目标"（同一文件 / 同一搜索词 / 同一命令）累计失败达到此数即判定"卡在某处"，
   * 触发反思·换路。与 maxConsecutiveFailures 互补：后者要求连续，前者只看同一目标累计，
   * 且【含软失败】（如 str_replace 反复未匹配）——专治"参数微调着反复撞同一堵墙"的盲区。
   */
  maxTargetFailures: number;
  /** 投降前允许的"反思·换路"次数（轻量层：重读真实状态 + 复盘引导） */
  maxReflections: number;
  /** 投降前允许的"摘要重启"次数（重量层：压掉失败噪声为复盘摘要 + 重读后重来） */
  maxSummaryRestarts: number;
}

/** 默认策略：轮次上限作为纯安全阀（防真死循环），正常任务远碰不到；
 * 真正的"防失控/防卡住"靠下面的指纹去重与连续失败计数，而非轮数 */
export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  maxSameCall: 3,
  maxFileReads: 3,
  maxConsecutiveFailures: 3,
  maxIncompleteRetries: 3,
  maxRounds: 200,
  maxTargetFailures: 3,
  maxReflections: 1,
  maxSummaryRestarts: 1,
};

/**
 * 按模型族返回策略。轮次上限统一作为安全阀（很高），不随模型族大幅变动；
 * 真正的防失控交给指纹去重 + 连续失败计数。集中在这里，避免阈值散落在多个文件里各调各的。
 */
export function policyForModel(model: string): AgentPolicy {
  // 目前各模型共用同一套阈值；保留入参便于未来按模型族微调
  void model;
  return DEFAULT_AGENT_POLICY;
}

/**
 * 判断一次工具失败是否为"软失败"——错误返回里带了足够的纠错信息，模型据此重试属于正常纠错流程，
 * 不应计入"连续失败"强制收尾。典型：str_replace 未匹配/不唯一（返回了实际内容+行号）、
 * apply_patch 上下文未匹配、read_file 缺参数、工具参数 JSON 非法。
 * 这类错误给模型更多重试空间，避免被过早掐断。
 */
export function isSoftToolFailure(toolName: string, result: string): boolean {
  if (toolName === "str_replace") {
    return /未找到 oldStr|出现多次|不唯一/.test(result);
  }
  if (toolName === "apply_patch") {
    return /上下文未匹配/.test(result);
  }
  if (toolName === "read_file") {
    return /缺少必填参数 path/.test(result);
  }
  // 参数 JSON 非法（任何工具都可能）
  if (/工具参数不是合法 JSON/.test(result)) return true;
  return false;
}

/**
 * 子 agent 专用策略：在 policyForModel 基础上放宽容错。
 * 子 agent 看不到主对话上下文，路径/搜索词更易连续踩空，连续失败阈值收得太紧会被过早掐断，
 * 因此把连续失败上限放宽（4），其余沿用对应模型的策略。
 */
export function policyForSubAgent(model: string): AgentPolicy {
  return { ...policyForModel(model), maxConsecutiveFailures: 4 };
}

/** 单次工具调用经过 guard 检查后的裁决 */
export interface ToolGuardVerdict {
  /** 是否允许实际执行该工具（false 表示被拦截，应把 message 作为错误结果回填） */
  allowed: boolean;
  /** 被拦截时给模型的引导文本 */
  message?: string;
}

/** "卡住的目标"描述：某个工具在同一目标上反复失败时由 LoopGuard 产出，驱动反思·换路 */
export interface StuckTarget {
  /** 反复失败的工具名 */
  toolName: string;
  /** 归一化目标键（文件路径 / 搜索词 / 命令前缀），用于判重与展示 */
  key: string;
  /** 若卡在某个文件上，其路径——供"重量版反思"重读真实状态，消除"拿旧状态硬改"的根因 */
  path?: string;
  /** 该目标累计失败次数 */
  count: number;
}

/** 以"文件路径"为目标的工具：这些工具反复失败时可重读对应文件的真实内容辅助换路 */
const FILE_TARGET_TOOLS = new Set(["str_replace", "create_file", "read_file", "check_diagnostics"]);

/**
 * 从一次工具调用中提取"目标键"，用于按目标聚合失败次数。
 * 返回 null 表示该工具不纳入目标级失败跟踪（仍受连续失败计数约束）。
 */
function targetKeyOf(toolName: string, args: Record<string, unknown>): { key: string; path?: string } | null {
  if (FILE_TARGET_TOOLS.has(toolName)) {
    const p = typeof args.path === "string" ? args.path : undefined;
    return p ? { key: `${toolName}:${p}`, path: p } : null;
  }
  if (toolName === "search") {
    const q = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    return q ? { key: `search:${q}` } : null;
  }
  if (toolName === "execute_command") {
    const cmd = typeof args.command === "string" ? args.command.trim() : "";
    if (!cmd) return null;
    // 命令前两个 token 作为目标键（如 "npm run"、"node script.js"），忽略后续易变参数
    return { key: `cmd:${cmd.split(/\s+/).slice(0, 2).join(" ")}` };
  }
  return null;
}

/**
 * 反思·换路引导（轻量层，重读真实状态由调用方拼接到尾部）：
 * 卡在某目标反复失败时注入，逼模型停下来复盘、判根因、换一条明确不同的路。
 */
export function buildReflectionPrompt(stuck: StuckTarget | null): string {
  const where = stuck ? (stuck.path ? `你在「${stuck.path}」上` : `你在「${stuck.key}」上`) : "你";
  return (
    `⚠️ 检测到${where}已经反复尝试并失败了多次，你很可能陷入了思维定式、在同一条死路上打转。\n` +
    `现在【停下来】先理清思路再继续，不要重复刚才的做法：\n` +
    `1. 复盘：你试过哪几种【不同】的做法？每一种到底为什么失败（看清工具返回的真实报错，别凭印象）？\n` +
    `2. 根因：最可能的根本原因是什么——掌握的状态已过期？参数/匹配方式不对？还是这条路本身走不通？\n` +
    `3. 换路：选一条【明确不同】的路径——改用其他工具、基于下面的真实状态重新构造、把问题拆小、或换切入点。\n` +
    `⚠️ 反思范围仅限于本轮用户需求——不要因为看到历史里的旧搜索结果或旧文件内容而岔开话题。\n` +
    `硬性要求：在没有依据最新真实状态之前，禁止再用同样的参数/方式调用同一个工具。`
  );
}

/**
 * 摘要重启后的引导（重量层）：上下文已被压缩为复盘摘要、失败噪声已清除，
 * 提示模型当作"重新开始"，带着干净上下文换一条完全不同的路。
 */
export function buildSummaryRestartPrompt(stuck: StuckTarget | null): string {
  const where = stuck?.path ? `（尤其是之前卡住的「${stuck.path}」）` : "";
  return (
    `你之前的尝试反复失败，过程已整理为上面的【复盘摘要】，那些失败细节已从上下文清除。\n` +
    `现在请当作【重新开始】：基于复盘摘要里已确认的事实和最新真实状态${where}，\n` +
    `选一条与之前【完全不同】的思路重新解决。不要重走任何已被证明失败的老路。\n` +
    `如果重新评估后认为目标确实无法达成，就如实告诉用户原因和你的建议，不要再空转。`
  );
}

/**
 * 单轮 agent 执行的循环守卫：统一管理重复调用指纹、文件重复读计数、连续失败计数、
 * reasoning 续写计数。主 agent 与子 agent 共用同一份实现，消除两边的重复逻辑。
 *
 * 用法：每次用户输入（或每次子任务）新建一个实例，单轮生命周期内复用。
 */
export class LoopGuard {
  private callFingerprints = new Map<string, number>();
  private fileReadCounts = new Map<string, number>();
  private consecutiveFailures = 0;
  private incompleteRetries = 0;
  // 目标级失败跟踪：key=归一化目标键，value=该目标累计失败次数 + 工具名 + 文件路径（如有）。
  // 含软失败——专治"参数微调着反复撞同一堵墙"（如 str_replace 反复未匹配）这个连续失败计数抓不到的盲区。
  private targetFailures = new Map<string, { count: number; toolName: string; path?: string }>();
  // 投降前升级阶梯的已用次数：反思·换路、摘要重启
  private reflectionsUsed = 0;
  private summaryRestartsUsed = 0;

  constructor(private policy: AgentPolicy = DEFAULT_AGENT_POLICY) {}

  /**
   * 在执行某个工具前检查是否构成"相同参数重复调用"。
   * @param toolName 工具名
   * @param rawArgs 原始参数 JSON 字符串（用作指纹的一部分）
   */
  checkToolCall(toolName: string, rawArgs: string): ToolGuardVerdict {
    const fingerprint = `${toolName}:${rawArgs}`;
    const repeat = (this.callFingerprints.get(fingerprint) || 0) + 1;
    this.callFingerprints.set(fingerprint, repeat);
    if (repeat > this.policy.maxSameCall) {
      return {
        allowed: false,
        message:
          `检测到你在用完全相同的参数第 ${repeat} 次调用 ${toolName}，这通常意味着陷入了循环。` +
          `请停止重复这个调用，换一种思路：可能是参数需要调整、改用其他工具、或者你已经有足够信息可以直接回答了。`,
      };
    }
    return { allowed: true };
  }

  /**
   * 记录一次 read_file，超过阈值时返回追加给工具结果的提示（否则返回空串）。
   */
  noteFileRead(path: string): string {
    const cnt = (this.fileReadCounts.get(path) || 0) + 1;
    this.fileReadCounts.set(path, cnt);
    if (cnt > this.policy.maxFileReads) {
      return (
        `\n\n[提示：你已经第 ${cnt} 次读取 ${path} 了。该文件的内容已经在上下文中，` +
        `请直接基于已读内容工作，不要再零碎重读。如果确实需要更大范围，一次性读完整文件。]`
      );
    }
    return "";
  }

  /** 记录一次工具执行结果：失败累加连续失败计数，成功则归零。
   * soft=true 表示"软失败"（如 str_replace 未匹配、参数 JSON 非法）——这类错误的返回里
   * 带了纠错信息（实际内容/行号），模型据此重试是正常纠错流程，不应计入"连续失败"强制收尾。
   *
   * ctx（工具名 + 解析后参数）用于【目标级失败跟踪】：即便是软失败、即便参数在微调，只要反复
   * 卡在同一目标（同一文件/搜索词/命令）就累加，达到 maxTargetFailures 即触发反思·换路。 */
  recordToolResult(success: boolean, soft = false, ctx?: { toolName: string; args: Record<string, unknown> }): void {
    if (success) {
      this.consecutiveFailures = 0;
    } else if (!soft) {
      this.consecutiveFailures++;
    }
    // soft 失败：连续失败计数保持中立（不归零也不累加），但目标级跟踪【仍计入】（见下）
    if (ctx) {
      const t = targetKeyOf(ctx.toolName, ctx.args);
      if (t) {
        if (success) {
          this.targetFailures.delete(t.key); // 同一目标一旦成功，清除其失败累计
        } else {
          const prev = this.targetFailures.get(t.key);
          this.targetFailures.set(t.key, { count: (prev?.count ?? 0) + 1, toolName: ctx.toolName, path: t.path });
        }
      }
    }
  }

  /**
   * 找出当前"反复卡住"的目标（失败次数达到 maxTargetFailures 的目标）。
   * 优先返回【带文件路径】的目标——这样"重量版反思"能重读其真实内容；同类中取失败最多的。
   * 无任何达阈值目标时返回 null。
   */
  getStuckTarget(): StuckTarget | null {
    let withPath: StuckTarget | null = null;
    let withoutPath: StuckTarget | null = null;
    for (const [key, v] of this.targetFailures) {
      if (v.count < this.policy.maxTargetFailures) continue;
      const cand: StuckTarget = { toolName: v.toolName, key, path: v.path, count: v.count };
      if (v.path) {
        if (!withPath || v.count > withPath.count) withPath = cand;
      } else if (!withoutPath || v.count > withoutPath.count) {
        withoutPath = cand;
      }
    }
    return withPath ?? withoutPath;
  }

  /** 是否陷入"卡住"：要么某目标反复失败，要么连续硬失败达到阈值。两者都先走升级阶梯再投降。 */
  isStuck(): boolean {
    return this.getStuckTarget() !== null || this.consecutiveFailures >= this.policy.maxConsecutiveFailures;
  }

  /** 是否还能再做一次"反思·换路" */
  canReflect(): boolean {
    return this.reflectionsUsed < this.policy.maxReflections;
  }

  /** 是否还能再做一次"摘要重启" */
  canSummaryRestart(): boolean {
    return this.summaryRestartsUsed < this.policy.maxSummaryRestarts;
  }

  /** 记录一次"反思·换路"：用掉一次额度，并清空卡住计数给模型干净的重试窗口 */
  noteReflected(): void {
    this.reflectionsUsed++;
    this.resetStuckCounters();
  }

  /** 记录一次"摘要重启"：用掉一次额度，并清空卡住计数 */
  noteSummaryRestart(): void {
    this.summaryRestartsUsed++;
    this.resetStuckCounters();
  }

  /** 清空卡住相关计数（反思/摘要重启后调用），让模型带着干净状态重新尝试 */
  private resetStuckCounters(): void {
    this.targetFailures.clear();
    this.consecutiveFailures = 0;
  }

  /** 当前连续失败次数（用于提示文本） */
  get failures(): number {
    return this.consecutiveFailures;
  }

  /**
   * 记录一次 reasoning 泄露续写，返回是否已超过上限。
   * 超过上限后调用方应改为强制收尾，而非继续续写。
   */
  noteIncompleteRetry(): boolean {
    this.incompleteRetries++;
    return this.incompleteRetries > this.policy.maxIncompleteRetries;
  }
}
