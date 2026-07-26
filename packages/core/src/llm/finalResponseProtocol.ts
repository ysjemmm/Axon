import type { NormalizedToolCall, ToolDef } from "./types.js";

/** 内部终止协议工具名：Agent 回合只能以「真实工具调用」或本工具收尾。 */
export const FINAL_RESPONSE_TOOL_NAME = "finish_response";

/** 裸完成（无工具、非截断/异常）触发强制工具恢复轮的最大次数；超过则兜底收尾，不再无限恢复。 */
export const MAX_FINAL_RESPONSE_RECOVERIES = 2;

/**
 * finish_response 工具定义（内部终止协议）。
 *
 * 设计要点（避免重复总结）：content 是**可选**的。
 * - 模型的最终答复通常已经作为普通文本流式输出了 —— 此时应留空 content，由宿主直接用已展示的正文收尾。
 * - 只有在模型还没输出任何答复正文、想直接一句话收尾时，才把这句话放进 content。
 * 这样 finish_response 本质是"我说完了"的完成信号，而不是"再写一遍答复"的载体，从根上杜绝重复。
 */
export const FINAL_RESPONSE_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: FINAL_RESPONSE_TOOL_NAME,
    description:
      "标记当前任务已完成、向用户收尾。只有工作确实做完、无需再调用任何工具时才调用它来结束本回合。\n\n" +
      "【关于 content（重要，避免重复）】\n" +
      "- 如果你已经把最终答复/总结作为普通文本输出了，调用本工具时【必须留空 content】，绝不要把同一段话再写进 content —— 否则用户会看到两遍。\n" +
      "- 只有当你还没有输出任何答复文本、想直接用一句话收尾时，才把这句话放进 content。\n" +
      "换句话说：先正常输出你的答复正文，最后调用 finish_response（通常不带 content）来告诉系统你完成了。",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "可选。仅当你还没有输出任何答复正文时才填写的一句话最终答复；若答复已作为普通文本输出，请留空。",
        },
      },
      additionalProperties: false,
    },
  },
};

/** 判断一次工具调用是否是内部终止工具 finish_response。 */
export function isFinalResponseToolCall(call: NormalizedToolCall): boolean {
  return call.name === FINAL_RESPONSE_TOOL_NAME;
}

/**
 * 从 finish_response 参数中提取 content（可选）。
 *
 * 返回去除首尾空白后的字符串；参数缺失 / 非法 / content 非字符串时一律返回空串，
 * 视作"无 content 的纯完成信号"，由调用方回退到"已流式展示的正文"收尾。
 * 不再抛错——content 本就是可选项，缺失是合法的正常路径。
 */
export function extractFinalResponseContent(rawArguments: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments || "{}");
  } catch {
    return "";
  }
  const content = (parsed as { content?: unknown } | null)?.content;
  return typeof content === "string" ? content : "";
}

/**
 * 终止契约恢复轮注入给模型的引导：上一回合裸文本收尾（没调工具、也没调 finish_response）违反了终止协议。
 * 强调"答复已输出就直接 finish_response 收尾、不要重复内容"，避免恢复轮里模型重写一遍答复。
 */
export const FINAL_RESPONSE_RECOVERY_PROMPT =
  "（系统提示）上一回合你以纯文本结束，但没有调用任何工具，这不符合 Agent 的收尾约定。请二选一：\n" +
  "1. 若任务仍需推进 —— 立即调用对应的具体工具继续；\n" +
  "2. 若任务已经完成 —— 直接调用 finish_response 收尾。你之前已经输出过的答复正文会被自动采用，" +
  "所以调用 finish_response 时【不要】再重复写一遍答复内容，content 留空即可。\n" +
  "本回合不要只输出普通文本。";
