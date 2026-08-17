/**
 * DSML 工具调用解析器（DeepSeek V4 原生协议）
 *
 * DeepSeek V4 系列（deepseek-v4-pro 等）的原生工具调用协议用 DSML 文本块编码：
 *
 *   <｜DSML｜tool_calls>
 *   <｜DSML｜invoke name="function_name">
 *   <｜DSML｜parameter name="param" string="true">字符串值</｜DSML｜parameter>
 *   <｜DSML｜parameter name="count" string="false">5</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜tool_calls>
 *
 * 当模型没有被正确引导走标准 function calling 时（典型场景：会话中途从其它模型切换到
 * deepseek，历史里缺少 deepseek 期望的工具调用格式），它会把工具调用以这段 DSML 文本
 * 直接吐进 content。本模块负责：
 *   - parseDsmlToolCalls：从文本里解析出标准化工具调用 + 剥离 DSML 后的正文
 *   - looksLikeDsmlStart：流式阶段判断累积文本是否像 DSML 块开头，用于提前抑制正文泄漏
 *
 * 竖线可能被网关/字体转成全角 ｜ 或半角 |，解析前统一 normalize。
 */

/** 解析出的单次工具调用（不含 id，id 由调用方统一分配以保证唯一）。 */
export interface ParsedDsmlCall {
  name: string;
  /** JSON 字符串参数（上层负责 JSON.parse） */
  arguments: string;
}

/** 把 DSML 标记的全角竖线 ｜ 统一成半角 |，便于正则匹配。 */
function normalizePipes(text: string): string {
  return text.replace(/｜/g, "|");
}

/** DSML tool_calls 块的开始标记（normalize 后半角竖线）。 */
const DSML_START = "<|DSML|tool_calls>";

/**
 * 从一段文本里提取 DSML tool_calls 块并解析成工具调用列表。
 * @returns 解析成功返回 { calls, cleanText }（cleanText 为移除 DSML 块后的正文）；
 *          文本中不含完整 DSML 块、或块内没有合法 invoke 时返回 null。
 */
export function parseDsmlToolCalls(
  text: string,
): { calls: ParsedDsmlCall[]; cleanText: string } | null {
  const norm = normalizePipes(text);
  const blockRe = /<\|DSML\|tool_calls>([\s\S]*?)<\/\|DSML\|tool_calls>/;
  const m = norm.match(blockRe);
  if (!m) return null;

  const block = m[1];
  const calls: ParsedDsmlCall[] = [];
  const invokeRe = /<\|DSML\|invoke name="([^"]+)"\s*>([\s\S]*?)<\/\|DSML\|invoke>/g;
  let im: RegExpExecArray | null;
  while ((im = invokeRe.exec(block)) !== null) {
    const name = im[1];
    const args: Record<string, unknown> = {};
    const paramRe = /<\|DSML\|parameter name="([^"]+)" string="(true|false)"\s*>([\s\S]*?)<\/\|DSML\|parameter>/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(im[2])) !== null) {
      const pname = pm[1];
      const isString = pm[2] === "true";
      const raw = pm[3];
      if (isString) {
        args[pname] = raw;
      } else {
        try {
          args[pname] = JSON.parse(raw);
        } catch {
          args[pname] = raw; // string="false" 但值不是合法 JSON 时按字符串兜底，避免丢参
        }
      }
    }
    if (Object.keys(args).length === 0) continue; // 无参数的 invoke 视为无效，跳过
    calls.push({ name, arguments: JSON.stringify(args) });
  }

  if (calls.length === 0) return null;

  const cleanText = norm.replace(blockRe, "").trim();
  return { calls, cleanText };
}

/**
 * 判断一段（已 normalize 竖线、已去前导空白的）文本是否看起来像 DSML tool_calls 块的开头。
 * 流式下用于提前判断"正文里开始出现 DSML 工具调用"，从而抑制后续文本泄漏给前端。
 */
export function looksLikeDsmlStart(normalizedText: string): boolean {
  // 至少累积 3 个字符（"<|D"）才判断，避免单个 "<" 或 "<|" 被误判为 DSML
  if (normalizedText.length < 3) return false;
  // ① 文本是开始标记的前缀（还在累积标记本身）② 文本已包含完整开始标记
  return DSML_START.startsWith(normalizedText) || normalizedText.startsWith(DSML_START);
}
