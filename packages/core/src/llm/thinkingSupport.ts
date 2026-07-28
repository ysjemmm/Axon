/**
 * 「模型是否支持思考」的唯一判定入口。
 *
 * ── 为什么需要这个模块 ──
 * 思考参数不能盲传。各家的请求形状完全不同（Anthropic 的 thinking.budget_tokens、
 * 智谱的 thinking.type、qwen/deepseek 的 reasoning_effort、OpenAI Responses 的
 * reasoning.summary），而中转网关对不认识的参数**不是优雅忽略，是直接断流**
 * （见 chatCompletionsStrategy 里那几条 "收到会断流" 的注释）。断流发生在流中途，
 * 那时部分正文已经推给用户了，重试也救不回来。所以必须先判定能力再决定传不传。
 *
 * ── 判定顺序 ──
 * 1. **声明优先**：provider 目录 / providers.json 里模型自己声明的 `thinking` 字段。
 *    这是唯一可靠来源，和 `vision` 完全同一个层级——没人靠模型名猜是否支持图片，
 *    思考也不该靠猜。中转站的命名是任意的（用户环境里就有个把 GPT 打成 GTP 的
 *    `GTP-5.6-luna`），任何正则都追不上，只有声明能覆盖。
 * 2. **兜底启发式**：没有声明时按已知命名规律猜。它的存在只是为了"用户啥都没配
 *    也别丢掉已有能力"，不是判定主力。收拢在这一个函数里，而不是散在三个 strategy
 *    里各写一份正则——那样每加一个模型要改三处，漏了还不报错。
 *
 * 启发式必然覆盖不全：新系列、改名、中转站自定义名都会漏。漏判的后果是**少一个能力**
 * （不请求思考），不会炸；反过来乱判会断流。所以这里的取向是宁漏不错，
 * 想要准确就去声明 `thinking: true`。
 */

/**
 * 无声明时的兜底启发式：按已知命名规律判断。
 *
 * 只匹配"确认支持且命名稳定"的系列。刻意不做模糊的版本号算术
 * （如"opus 主版本 >= 4 就算支持"）——那只是把枚举换成更自信的猜测，
 * 遇到没见过的系列一样会错，而错的方向是断流。
 */
function guessByName(model: string): boolean {
  const m = model.toLowerCase();

  // 通用显式标记：名字里直接写了思考/推理的，一律认为支持
  if (/thinking|reasoner|reasoning/.test(m)) return true;

  // Anthropic Claude：Opus 4 及以后、Sonnet 4.5 及以后支持 extended thinking
  if (/opus-4|opus-[5-9]/.test(m)) return true;
  if (/sonnet-4[.-]5|sonnet-[5-9]/.test(m)) return true;

  // OpenAI：o 系列推理模型 + GPT-5 及以后
  if (/\bo[1345]\b|^o[1345]-/.test(m)) return true;
  if (/gpt-[5-9]/.test(m)) return true;

  // 智谱 GLM-5 及以后
  if (/glm-?[5-9]/.test(m)) return true;

  // DeepSeek V4 及以后 / R 系列
  if (/deepseek-?v?[4-9]|deepseek-?r\d/.test(m)) return true;

  // 通义千问 3.7 及以后 / QwQ
  if (/qwen-?3[.-]?[7-9]|qwen-?[4-9]|qwq/.test(m)) return true;

  // Kimi K2 及以后
  if (/kimi-?k[2-9]|\bk[2-9]-/.test(m)) return true;

  return false;
}

/**
 * 判定某模型本轮是否应该请求思考。
 *
 * @param model    真实 API model id
 * @param declared 模型在 provider 目录 / providers.json 里声明的 `thinking` 能力。
 *                 显式 true/false 都直接采信（false 是有意义的——用户可以关掉一个
 *                 名字看起来像推理模型、但中转站实际不支持的模型）；undefined 才走启发式。
 */
export function supportsThinking(model: string, declared?: boolean): boolean {
  if (typeof declared === "boolean") return declared;
  return guessByName(model);
}
