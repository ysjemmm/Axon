/**
 * 内置业界常用模型清单（纯数据，供「添加模型」下拉框做建议候选项）。
 *
 * 注意：这只是下拉框的建议清单，不代表这些模型在用户的某个 provider 下一定可用；
 * 最终能否调用取决于该 provider 的模型列表（以各端点实际支持为准）。
 */

/** 能力标签：vision=支持图片输入，thinking=推理/思考型模型 */
export type BuiltinModelTag = "vision" | "thinking";

/**
 * LLM 调用协议。与 core 的 `ProviderProtocol` 逐字一致；
 * 这里本地再声明一份，是为了不给这个"纯数据"文件引入跨包依赖。
 */
export type BuiltinModelProtocol = "chat" | "responses" | "anthropic";

export interface BuiltinModel {
  /** 模型 id（发给 API 的那个） */
  id: string;
  /** 展示名（可选，仅用于下拉框里帮助辨认） */
  label?: string;
  /** 厂商 */
  vendor: string;
  /** 能力标签（可选） */
  tags?: BuiltinModelTag[];
  /**
   * 上下文窗口（token）。**只在有明确出处时填。**
   *
   * ⚠️ 刻意保持可选、允许留空，而不是给个"看着合理"的默认值：这个数是压缩阈值
   * （窗口 35% / 75%）与占用率显示的**分母**，写错会让压缩在该触发时不触发、不该触发时乱触发。
   * 留空时由 ProviderStudio 既有默认值兜底，比填一个错的更安全。
   */
  contextWindow?: number;
  /**
   * 是否支持 `cache_control` 显式缓存标记。**只在确定支持时才填 true。**
   *
   * ⚠️ 缺省（undefined）与 false 不等价：端点不支持却收到 cache_control 会**直接 400**。
   * 所以宁可留空、交给 provider/model 级推断，也不要凭"大厂应该都支持"填 true。
   */
  cacheControl?: boolean;
}

/**
 * 按厂商推断调用协议。
 *
 * 协议只由**厂商**决定、与具体型号无关（3 种取值），所以用函数推，而不是往 60 多条数据里
 * 各抄一遍——手抄既有写错的风险（多一个空格、大小写不一致），新增厂商时也容易漏改。
 * 未列出的厂商一律按 `chat`：OpenAI 兼容是绝大多数中转站/自建网关的默认形态。
 * OpenAI 官方的 `responses` 协议属于 provider 级选择，不在这里替用户决定。
 */
export function protocolForVendor(vendor: string): BuiltinModelProtocol {
  if (vendor === "Anthropic") return "anthropic";
  return "chat";
}

export const BUILTIN_MODELS: readonly BuiltinModel[] = [
  // ── OpenAI ──
  // GPT-6 已正式发布。依据 OpenAI 官网：
  //   · openai.com/index/introducing-gpt-6-sol-and-luna（Sol / Luna 两档）
  //   · openai.com/index/gpt-6-astra（Astra，2026-09-03 发布，正文明确给出 API 名 `gpt-6-astra`）
  //   · 官方文档侧栏含 "Using GPT-6"
  // 其中 `gpt-6-astra` 有官网原文直接证据；`gpt-6-sol` / `gpt-6-luna` 由官网标题
  // "GPT-6 Sol and Luna" 加命名惯例推得（5.6 时代端点已返回过 `GPT-5.6-luna`，后缀一致）。
  // 刻意不加裸 `gpt-6`：官方以 Sol / Luna / Astra 分档命名，没有任何证据表明存在不带档位后缀的
  // `gpt-6`——宁缺勿造，写一个不存在的 id 比少一条更糟。
  // 窗口逐条核对自官方单型号页 platform.openai.com/docs/models/<id>.md
  // （⚠️ 带 `/api` 前缀的同名 URL 会 403；不带前缀的才能拿到 Markdown 正文）。
  // 这七条**全部为 1,050,000** 上下文（最大输入 922,000 / 最大输出 128,000）。
  // 刻意不填 cacheControl：官方特性表里写的是 `prompt_caching`——那是 OpenAI 自有机制
  // （自动缓存 + prompt_cache_key / prompt_cache_options），**并不接受 `cache_control` 标记**。
  // 填了就会把 cache_control 发出去，而端点不认它的后果是 400。
  { id: "gpt-5.5", label: "GPT-5.5", vendor: "OpenAI", tags: ["vision", "thinking"], contextWindow: 1_050_000 },
  { id: "gpt-5.6", label: "GPT-5.6（Sol 的别名）", vendor: "OpenAI", tags: ["vision", "thinking"], contextWindow: 1_050_000 },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", vendor: "OpenAI", tags: ["vision", "thinking"], contextWindow: 1_050_000 },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", vendor: "OpenAI", tags: ["vision", "thinking"], contextWindow: 1_050_000 },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", vendor: "OpenAI", tags: ["vision", "thinking"], contextWindow: 1_050_000 },
  { id: "gpt-6-astra", label: "GPT-6 Astra", vendor: "OpenAI", tags: ["vision", "thinking"], contextWindow: 1_050_000 },
  { id: "gpt-6-sol", label: "GPT-6 Sol", vendor: "OpenAI", tags: ["vision", "thinking"], contextWindow: 1_050_000 },
  { id: "gpt-6-luna", label: "GPT-6 Luna", vendor: "OpenAI", tags: ["vision", "thinking"], contextWindow: 1_050_000 },

  // ── Anthropic ──
  // 窗口与缓存逐条核对自官方文档：
  //   docs.anthropic.com/docs/en/build-with-claude/context-windows
  //     「Claude Fable 5.1 / Mythos 5.1 / Fable 5 / Mythos 5 / Opus 5 / Opus 4.8 / Opus 4.7 /
  //       Opus 4.6 / Sonnet 5 / Sonnet 4.6 / Mythos Preview 为 1M；其余（含 Sonnet 4.5）为 200k」
  //   docs.anthropic.com/en/docs/about-claude/models/overview
  //     API ID 列逐字给出 claude-fable-5-1 / claude-opus-5 / claude-sonnet-5 /
  //     claude-haiku-4-5-20251001，并标注各自窗口。
  //   cacheControl：`cache_control` 显式缓存标记本就是 Anthropic 自己的机制，全线支持 → true
  //   （注意：这正是 cacheControl 只对 Anthropic 填 true 的原因——OpenAI 系走自动缓存 +
  //    prompt_cache_key/prompt_cache_options，并不认 cache_control 标记。）
  { id: "claude-opus-4-5", label: "Claude Opus 4.5", vendor: "Anthropic", tags: ["vision", "thinking"], contextWindow: 200_000, cacheControl: true },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", vendor: "Anthropic", tags: ["vision", "thinking"], contextWindow: 200_000, cacheControl: true },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", vendor: "Anthropic", tags: ["vision", "thinking"], contextWindow: 200_000, cacheControl: true },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", vendor: "Anthropic", tags: ["vision", "thinking"], contextWindow: 1_000_000, cacheControl: true },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", vendor: "Anthropic", tags: ["vision", "thinking"], contextWindow: 1_000_000, cacheControl: true },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", vendor: "Anthropic", tags: ["vision", "thinking"], contextWindow: 1_000_000, cacheControl: true },
  { id: "claude-opus-5", label: "Claude Opus 5", vendor: "Anthropic", tags: ["vision", "thinking"], contextWindow: 1_000_000, cacheControl: true },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", vendor: "Anthropic", tags: ["vision", "thinking"], contextWindow: 1_000_000, cacheControl: true },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", vendor: "Anthropic", tags: ["vision", "thinking"], contextWindow: 1_000_000, cacheControl: true },
  // Fable 是 Anthropic 官方产品线，见官网 https://www.anthropic.com/claude/fable
  // （正文同时提到 Fable 5.1 与 Fable 5，并称 Fable 5.1 是其最强编码模型）。
  // ⚠️ id 必须带 `claude-` 前缀——Anthropic 全线如此（claude-opus-4-8 / claude-sonnet-4-6），
  // 早先这里写成裸的 `fable-5` / `fable-5.1` 是错的，端点不会识别。
  { id: "claude-fable-5", label: "Claude Fable 5", vendor: "Anthropic", tags: ["vision", "thinking"], contextWindow: 1_000_000, cacheControl: true },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1", vendor: "Anthropic", tags: ["vision", "thinking"], contextWindow: 1_000_000, cacheControl: true },
  // Mythos 家族此前整条缺失，官方 context-windows 页明确将其列为 1M 窗口模型。
  // ⚠️ 窗口有官方原文；但 id 是把官方展示名（"Claude Mythos 5.1" 等）按 anthropic 命名惯例转写的
  // （claude-opus-4-8 那套），官方该页未直接给出这三个 id 字符串，需要端点核对一次。
  { id: "claude-mythos-5", label: "Claude Mythos 5", vendor: "Anthropic", tags: ["vision", "thinking"], contextWindow: 1_000_000, cacheControl: true },
  { id: "claude-mythos-5-1", label: "Claude Mythos 5.1", vendor: "Anthropic", tags: ["vision", "thinking"], contextWindow: 1_000_000, cacheControl: true },

  // ── Google ──
  // 窗口与 id 逐条取自官方模型对照表：
  //   docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-8-flash
  //   （该页同时列出 3.8 Flash / 3.7 Flash / 3.1 Pro 三列）
  // 三条均为 1,048,576 上下文、最大输出 65,536、输入支持文本/图像/音频/视频。
  // ⚠️ 修正 id：官方表里 "Gemini 3.1 Pro" 的 Model ID 是 `gemini-3.1-pro-preview`
  //   （Launch stage = Preview），**不是** `gemini-3.1-pro`——原 id 在端点上会找不到。
  //   3.8 / 3.7 Flash 的 id 与官方一致，均为 GA。
  // cacheControl 不填：Gemini 的上下文缓存走独立 API（cachedContents），不认 `cache_control` 标记。
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview", vendor: "Google", tags: ["vision", "thinking"], contextWindow: 1_048_576 },
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", vendor: "Google", tags: ["vision", "thinking"], contextWindow: 1_048_576 },
  { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash", vendor: "Google", tags: ["vision", "thinking"], contextWindow: 1_048_576 },
  // ── xAI Grok ──（此前整条线缺失，一个条目都没有）
  // 窗口依据官方文档 docs.x.ai/docs/models（更新日期 2026-09-21）：旗舰 `grok-4.7` 为 500k 上下文。
  // 4.6 / 4.5 的窗口该官方页未列，后经**第三方**（kingy.ai 与 DataCamp 两家一致）补得：
  //   Grok 4.6 为 500,000（2026-08-12 发布），Grok 4.5 同为 500,000
  //   （原文 "The context size is unchanged from Grok 4.5, which was already listed at 500K"）。
  // xAI 官方还声明了别名规则：<model> 指向最新稳定版、<model>-latest 指向最新版、
  // <model>-<date> 锁定具体版本。
  { id: "grok-4.7", label: "Grok 4.7（当前旗舰）", vendor: "xAI", tags: ["vision", "thinking"], contextWindow: 500_000 },
  { id: "grok-4.6", label: "Grok 4.6", vendor: "xAI", tags: ["vision", "thinking"], contextWindow: 500_000 },
  { id: "grok-4.5", label: "Grok 4.5", vendor: "xAI", tags: ["vision", "thinking"], contextWindow: 500_000 },

  // ── DeepSeek ──
  // 依据官方定价页 api-docs.deepseek.com/quick_start/pricing：
  //   两列均为 **1M 上下文 / 384K 最大输出**；官方同时提供 OpenAI 与 Anthropic 双格式端点
  //   （`https://api.deepseek.com` 与 `https://api.deepseek.com/anthropic`）。
  //   `deepseek-flash` = DeepSeek-V4.1-Flash（支持视觉）；
  //   `deepseek-v4-pro` = DeepSeek-V4-Pro-0813（不支持视觉，故不带 vision 标签）。
  // ⚠️ 官方原文注(1)：请使用 `deepseek-flash` 作为模型名；旧名 `deepseek-v4-flash` /
  //   `deepseek-v4-flash-vision-exp` **仍被接受但对应模型已退役**，请求由 V4.1-Flash 承接。
  //   所以这里补上正式名，退役别名保留并标注，而不是删掉——删了会让人以为压根不能调。
  { id: "deepseek-flash", label: "DeepSeek Flash（V4.1，当前正式名）", vendor: "DeepSeek", tags: ["vision", "thinking"], contextWindow: 1_000_000 },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", vendor: "DeepSeek", tags: ["thinking"], contextWindow: 1_000_000 },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash（退役别名，仍可用）", vendor: "DeepSeek", tags: ["vision", "thinking"], contextWindow: 1_000_000 },

  // ── 阿里通义千问 ──
  // ⚠️ 出处为**第三方**：qwen3.7-max 的 1M 取自 OpenRouter 对比页；
  //    qwen-3.7-plus 的 1M 取自 Artificial Analysis（原文 "Qwen3.7 Plus supports 1.0M tokens"）。
  { id: "qwen3.7-max", label: "通义千问 3.7 Max", vendor: "阿里通义千问", tags: ["vision", "thinking"], contextWindow: 1_000_000 },
  { id: "qwen-3.7-plus", label: "通义千问 3.7 Plus", vendor: "阿里通义千问", tags: ["vision", "thinking"], contextWindow: 1_000_000 },
  // ⚠️ 出处为**第三方**（OpenRouter 对比页 / qubrid / gptproto 三方一致，非阿里官方文档）：
  //    窗口 1M、最大输出 128K~131K。三方口径一致，但仍建议端点核对。
  //    qwen3.7-max / qwen-3.7-plus 本轮没拿到可靠窗口 → 留空。
  { id: "qwen3.8-max", label: "通义千问 3.8 Max", vendor: "阿里通义千问", tags: ["vision", "thinking"], contextWindow: 1_000_000 },

  // ── 智谱 GLM ──
  // ⚠️ 出处为**第三方**（OpenRouter）：GLM 5.3 窗口 1,310,720。单源，可信度低于官方文档。
  //    glm-5.3-flash / glm-5.2 本轮没拿到窗口 → 留空。
  { id: "glm-5.3", label: "GLM-5.3", vendor: "智谱 GLM", tags: ["thinking"], contextWindow: 1_310_720 },
  // ⚠️ 出处为**第三方**（Requesty 记 1M、llm-stats 记 1,048,576 输入 tokens，两家一致）。
  //    该型号在火山引擎目录里也存在（`glm-5-3-flash-260828`），但官方未给窗口数字。
  { id: "glm-5.3-flash", label: "GLM-5.3 Flash", vendor: "智谱 GLM", tags: ["thinking"], contextWindow: 1_048_576 },
  // GLM-5.2 的窗口取自火山引擎模型列表（`glm-5-2-260617` 标 1024k / 最大输出 128k）——
  // 那是字节自家托管目录的登记值，非智谱官方文档，但数值明确。
  { id: "glm-5.2", label: "GLM-5.2", vendor: "智谱 GLM", tags: ["thinking"], contextWindow: 1_048_576 },

  // ── Moonshot Kimi ──
  // ⚠️ 出处为**第三方**（OpenRouter：Kimi K2.5 为 262,144 token）。
  //    kimi-k2 本轮仍未拿到窗口 → 留空。
  // ⚠️ 出处为**第三方**（Requesty：kimi-k2 上下文 262K、最大输出 262K）。
  { id: "kimi-k2", label: "Kimi K2", vendor: "Moonshot Kimi", tags: ["thinking"], contextWindow: 262_144 },
  { id: "kimi-k2.5", label: "Kimi K2.5", vendor: "Moonshot Kimi", tags: ["thinking"], contextWindow: 262_144 },
  // ⚠️ 出处为**第三方**（qubrid 对比文）：Kimi K3 窗口 1,048,576。单源。
  //    kimi-k2 / kimi-k2.5 本轮没拿到窗口 → 留空。
  { id: "kimi-k3", label: "Kimi K3", vendor: "Moonshot Kimi", tags: ["thinking"], contextWindow: 1_048_576 },

  // ── 国内其他常见模型（字节豆包 / 小米 MiMo / 智源） ──
  // 豆包窗口取自官方模型列表（火山引擎 docs/82379/1799865 与 ai.volcengine.com/model）：
  //   `doubao-seed-2-0-pro-260215` 上下文窗口 256k、最大输入 224k、最大回答 128k。
  //   doubao-1.5-pro / doubao-seed-1.6 本轮没拿到对应行 → 留空。
  { id: "doubao-seed-2.0-pro", label: "豆包 Seed 2.0 Pro", vendor: "字节豆包", tags: ["vision", "thinking"], contextWindow: 262_144 },
  // ⚠️ 官方模型列表里这两条都带日期后缀，本清单用的是无后缀的通称，故映射时按"同族旗舰行"取值：
  //   doubao-seed-1.6 ← `doubao-seed-1-6-flash-250828` / `doubao-seed-1-6-vision-250815`，两行均 256k；
  //   doubao-1.5-pro  ← `doubao-1-5-pro-32k-250115`，窗口 128k（同族另有
  //     `doubao-1-5-pro-32k-character-250715` 记 32k——角色扮演特化版；此处取非特化的那一行）。
  //     该族多行均已标"即将下线"。
  { id: "doubao-1.5-pro", label: "豆包 1.5 Pro", vendor: "字节豆包", tags: ["vision"], contextWindow: 131_072 },
  { id: "doubao-seed-1.6", label: "豆包 Seed 1.6", vendor: "字节豆包", tags: ["vision", "thinking"], contextWindow: 262_144 },
  // ── 小米 MiMo ── 官方发布日志 https://mimo.mi.com/docs/en-US/updates/model
  // ⚠️ 早先这里只有 `MiMo-7B-RL`（2025-04-30 初代 7B 开源权重），差了整整三代，
  // 早已不是当前可调用的型号。以下 id 取自官方日志与 mimo.xiaomi.com 文档；
  // 官方文档明确"旗舰模型是 `mimo-v2.5-pro`"。
  { id: "mimo-v2.5-flash", label: "小米 MiMo V2.5 Flash", vendor: "小米 MiMo", tags: ["vision", "thinking"] },
  // 官方发布日志明写 mimo-v2.5 为 "Native full-modal perception + 1M context"。
  { id: "mimo-v2.5", label: "小米 MiMo V2.5", vendor: "小米 MiMo", tags: ["thinking"], contextWindow: 1_000_000 },
  // V2.6-Flash 窗口取自 Baseten 模型库（`MiMo-V2.6-Flash-RL`：309B-A15B 稀疏 MoE、混合注意力，
  // "supporting context windows up to 1M tokens"）。⚠️ 第三方来源；来源写的是 "1M"，
  // 此处按同族 V2.6-Pro 的官方口径记为 1,048,576。
  { id: "mimo-v2.6-flash", label: "小米 MiMo V2.6 Flash", vendor: "小米 MiMo", tags: ["vision", "thinking"], contextWindow: 1_048_576 },
  // V2.6-Pro 窗口取自 vLLM Recipes 模型卡（`XiaomiMiMo/MiMo-V2.6-Pro-RL`：1,048,576 ctx，
  // "supports up to 1M tokens of context"）。⚠️ 第三方来源——MiMo 官方发布日志只讲能力与速度、
  // 不给窗口数字。`mimo-v2.6-flash` 与 `mimo-v2.6-pro-ultraspeed` 的窗口本轮无出处 → 留空。
  // （ultraspeed 官方描述为 "Flagship V2.6-Pro performance"，暗示同窗口，但那是推断不是出处。）
  { id: "mimo-v2.6-pro", label: "小米 MiMo V2.6 Pro", vendor: "小米 MiMo", tags: ["vision", "thinking"], contextWindow: 1_048_576 },
  // ⚠️ 修正 id：官方发布日志给的型号名是 `mimo-v2.6-pro-ultraspeed`（"Flagship V2.6-Pro
  //    performance, up to 20x faster"），原写法 `mimo-v2.6-ultraspeed` 少了 `-pro-`。
  //    V2.6 系列的窗口该页未直接给出 → 留空。
  { id: "mimo-v2.6-pro-ultraspeed", label: "小米 MiMo V2.6 Pro Ultraspeed", vendor: "小米 MiMo", tags: ["thinking"] },
  { id: "Aquila3-34B", label: "Aquila 3（智源·天鹰）", vendor: "智源研究院" },
  // ── MiniMax ── 官方站点导航列出的当前型号：M3 / M2.7 / M2.5 / H3 / Speech 2.8 / Music 3.0。
  // 官方 id 逐字为 `MiniMax-M3` / `MiniMax-M2.7`——大小写与连字符必须照抄，不能写字面相近的其他形式。
  // ⚠️ M3 自 2026-06-01 起才是 M 系列前沿型号。只列 M2.7 会让人误以为那是最新的（实际是 3 月的）。
  // ⚠️ 出处为**第三方**（Artificial Analysis 与 BenchLM 两家对 MiniMax-M3 均记 1M，
  //    对 Hy3 均记 256K，口径一致；M2.7 的 204,800 为单源）。
  { id: "MiniMax-M3", label: "MiniMax M3", vendor: "MiniMax", tags: ["thinking"], contextWindow: 1_000_000 },
  { id: "MiniMax-M2.7", label: "MiniMax M2.7", vendor: "MiniMax", tags: ["thinking"], contextWindow: 204_800 },
  { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed", vendor: "MiniMax", tags: ["thinking"] },
  // ── 腾讯混元 ── 文本旗舰的 id 是 `hy3`（256K 上下文），**没有 `hunyuan-` 前缀**；
  // 早先这里写的 `hunyuan-hy3` 是拼错的。厂商目录另有 `hy-image-v3.0`（文生图）、
  // `hy-video-1.5`（文生视频）——非对话模型，不列进本清单。
  // ⚠️ 出处为**第三方**（Artificial Analysis / BenchLM 一致记 256K；Artifical Analysis 另记
  //    输入支持文本+图像+视频、开源权重 Apache 2.0）。官方 TokenHub 目录未直接给窗口。
  { id: "hy3", label: "混元 Hy3（文本旗舰）", vendor: "腾讯混元", tags: ["vision", "thinking"], contextWindow: 262_144 }
];
