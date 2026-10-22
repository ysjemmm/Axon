import { describe, it, expect } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { buildForkMessages } from "./forkHistory.js";

/** 造一条最简单的历史：两轮对话，每轮 = 用户消息 + 一段回复 + 一个工具轮 */
function history(): any[] {
  return [
    { role: "system", content: "SYSTEM" },
    { role: "user", content: "第一问", clientMessageId: "user-1" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      displayContent: null,
    },
    { role: "tool", tool_call_id: "t1", content: "文件内容" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问", clientMessageId: "user-2" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "t2", type: "function", function: { name: "search", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "t2", content: "搜索结果" },
    { role: "assistant", content: "第二答" },
  ];
}

describe("buildForkMessages", () => {
  it("按 clientMessageId 截到该轮结束（含工具调用与收尾正文），后面的轮次不带", () => {
    const out = buildForkMessages(history() as ChatCompletionMessageParam[], { upToMessageId: "user-1" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect((out.messages[1] as any).clientMessageId).toBe("user-1");
    // 第二轮的内容一条都不能跟过来
    expect(out.messages.some((m: any) => m.tool_call_id === "t2")).toBe(false);
  });

  it("锚点是最后一轮时，截到历史末尾", () => {
    const out = buildForkMessages(history() as ChatCompletionMessageParam[], { upToMessageId: "user-2" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 后面没有下一条用户消息了，整段历史都带走
    expect(out.messages).toHaveLength(9);
    expect((out.messages[out.messages.length - 1] as any).content).toBe("第二答");
  });

  it("id 匹配不上时按用户消息序号兜底（压缩摘要 / 老会话没有 clientMessageId）", () => {
    const msgs = history();
    delete (msgs[5] as any).clientMessageId;
    const out = buildForkMessages(msgs as ChatCompletionMessageParam[], {
      upToMessageId: "hist-u-9",
      upToUserIndex: 1,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((out.messages[5] as any).content).toBe("第二问");
    expect(out.messages).toHaveLength(9);
  });

  it("跳过瞬态消息，保证序号与前端渲染一致", () => {
    const msgs = history();
    // 单轮临时注入（反思/复盘）不该被算进历史
    msgs.splice(2, 0, { role: "assistant", content: "内部反思", _ephemeralInjected: true });
    const out = buildForkMessages(msgs as ChatCompletionMessageParam[], { upToUserIndex: 1 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.messages.some((m: any) => m.content === "内部反思")).toBe(false);
    expect(out.messages.filter((m: any) => m.role === "user")).toHaveLength(2);
  });

  it("截图注入的 user 消息不算轮次起点", () => {
    const msgs = history();
    // 第一轮的工具结果之后跟了一条截图注入（role=user 但不是用户气泡）
    msgs.splice(4, 0, { role: "user", content: "截图", _screenshotInjection: true });
    const out = buildForkMessages(msgs as ChatCompletionMessageParam[], { upToMessageId: "user-1" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 截图属于第一轮内部，应随第一轮一起带走
    expect(out.messages.some((m: any) => m._screenshotInjection)).toBe(true);
    expect((out.messages[out.messages.length - 1] as any).content).toBe("第一答");
  });

  it("截断后仍保证工具配对：缺结果的 tool_call 被补上占位结果", () => {
    const msgs = [
      { role: "system", content: "SYSTEM" },
      { role: "user", content: "问", clientMessageId: "user-1" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "x", arguments: "{}" } }] },
      { role: "assistant", content: "答" },
    ];
    const out = buildForkMessages(msgs as any, { upToMessageId: "user-1" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 有 tool_call 却没结果时，sanitizeToolPairing 会补一条 tool 消息，避免发给模型直接 400
    const toolMsg = out.messages.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeTruthy();
    expect((toolMsg as any).tool_call_id).toBe("t1");
  });

  it("没有锚点参数 / 锚点定位不到时明确失败（由调用方决定怎么提示）", () => {
    expect(buildForkMessages(history() as ChatCompletionMessageParam[], {}).ok).toBe(false);
    expect(buildForkMessages(history() as ChatCompletionMessageParam[], { upToMessageId: "不存在" }).ok).toBe(false);
    expect(buildForkMessages(history() as ChatCompletionMessageParam[], { upToUserIndex: 9 }).ok).toBe(false);
    expect(buildForkMessages(undefined, { upToUserIndex: 0 }).ok).toBe(false);
  });
});
