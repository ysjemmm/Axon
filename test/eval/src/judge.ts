/**
 * LLM-as-judge —— 对模型回复的主观质量打分（0-1）
 *
 * 仅当场景声明了 scenario.judge 时启用。用一个独立的 judge 模型按 rubric 给回复打分，
 * 强制输出 JSON 以便解析。用于「无工具纯问答」「回复是否有帮助」等规则无法判定的维度。
 */

import OpenAI from "openai";
import type { EvalScenario } from "./types.ts";

const JUDGE_SYSTEM = `你是一个严格的评审员。根据给定的评分标准（rubric），对 AI 助手的回复打分。
只输出一个 JSON 对象，格式：{"score": <0到1的小数>, "reason": "<简短理由>"}。
score=1 表示完全符合标准，score=0 表示完全不符合。不要输出 JSON 以外的任何内容。`;

export interface JudgeResult {
  score: number;
  reason: string;
}

export async function judgeReply(
  scenario: EvalScenario,
  reply: string,
  client: OpenAI,
  judgeModel: string,
): Promise<JudgeResult> {
  if (!scenario.judge) return { score: 0, reason: "no judge spec" };

  const prompt = `## 评分标准\n${scenario.judge.rubric}\n\n## 用户问题\n${scenario.userMessage}\n\n## AI 助手的回复\n${reply || "(空回复)"}\n\n请按标准打分，只输出 JSON。`;

  try {
    const response = await client.chat.completions.create({
      model: judgeModel,
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: 200,
    });
    const content = response.choices[0]?.message.content || "";
    // 容错：从文本中抽取 JSON
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { score: 0, reason: `judge 输出无法解析: ${content.slice(0, 80)}` };
    const parsed = JSON.parse(match[0]) as { score?: number; reason?: string };
    const score = typeof parsed.score === "number" ? Math.max(0, Math.min(1, parsed.score)) : 0;
    return { score, reason: parsed.reason || "" };
  } catch (err) {
    return { score: 0, reason: `judge 异常: ${(err as Error).message}` };
  }
}
