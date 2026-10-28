/**
 * 回归：工具轮 assistant 消息的三个正文字段各归其位。
 *
 * 线上事故：这三个字段曾被一起置 null，于是「工具之间夹杂的正文」在重启 IDE 后全部消失。
 * 当时的假设是"前端展示不受影响"——错的：用户看到的那几段话走的是内存态 stream_delta，
 * 重启即失；能撑过重启的只有落盘的 displayContent。
 */
import { describe, expect, it } from "vitest";
import { buildToolTurnAssistantMessage } from "./toolTurnMessage.js";

const calls = [
  { id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' },
  { id: "c2", name: "search", arguments: '{"query":"x"}' },
];

describe("buildToolTurnAssistantMessage", () => {
  it("正文进 displayContent（重启后靠它还原），content 恒为 null（不污染模型上下文）", () => {
    const msg = buildToolTurnAssistantMessage({ text: "我先摸清现有结构，再动手改。", toolCalls: calls }) as any;

    // 界面侧：必须留原文，否则重启后工具之间的文字就没了
    expect(msg.displayContent).toBe("我先摸清现有结构，再动手改。");
    // 模型侧：必须为 null，否则过渡叙述会成为少样本范例、模型每轮照抄同一句式
    expect(msg.content).toBeNull();
    expect(msg.runtimeContent).toBeNull();
  });

  it("tool_calls 原样保留 id / name / arguments", () => {
    const msg = buildToolTurnAssistantMessage({ text: "干活", toolCalls: calls }) as any;
    expect(msg.tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
      { id: "c2", type: "function", function: { name: "search", arguments: '{"query":"x"}' } },
    ]);
  });

  it("纯工具轮（模型没说话）→ displayContent 为 null，不要把空串写进去", () => {
    for (const text of ["", "   ", "\n\t "]) {
      const msg = buildToolTurnAssistantMessage({ text, toolCalls: calls }) as any;
      expect(msg.displayContent).toBeNull();
      expect(msg.content).toBeNull();
    }
  });

  it("reasoning 字段按 provider 原样带出（DeepSeek 缺它会 400）", () => {
    const blocks = [{ thinking: "想一想", signature: "sig" }];
    const msg = buildToolTurnAssistantMessage({
      text: "正文",
      toolCalls: calls,
      reasoningContent: "思考内容",
      anthropicThinkingBlocks: blocks,
    }) as any;
    expect(msg.reasoning_content).toBe("思考内容");
    expect(msg.anthropic_thinking_blocks).toEqual(blocks);
  });

  it("没有 reasoning 时不写出空字段（部分端点对空值敏感）", () => {
    const msg = buildToolTurnAssistantMessage({ text: "正文", toolCalls: calls }) as any;
    expect("reasoning_content" in msg).toBe(false);
    expect("anthropic_thinking_blocks" in msg).toBe(false);
  });
});
