import { describe, expect, it } from "vitest";
import { flattenToolHistory } from "./messageSanitizer.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

describe("flattenToolHistory", () => {
  it("把 assistant.tool_calls + tool 结果压平成纯文本 assistant", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "帮我读文件" },
      {
        role: "assistant",
        content: "我来读一下",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "文件内容..." },
      { role: "assistant", content: "读到了，内容是 xxx" },
    ];
    const out = flattenToolHistory(messages);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(messages[0]);
    // 中间那条被压平成纯文本 assistant，不再含 tool_calls 结构
    const flat = out[1] as any;
    expect(flat.role).toBe("assistant");
    expect(flat.tool_calls).toBeUndefined();
    expect(flat.content).toContain("read_file");
    expect(flat.content).toContain("文件内容...");
    // 末尾正常 assistant 保留
    expect(out[2]).toEqual(messages[3]);
  });

  it("多个 tool_calls 一次性压平", () => {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "search", arguments: JSON.stringify({ query: "foo" }) } },
          { id: "c2", type: "function", function: { name: "list_dir", arguments: JSON.stringify({ path: "src" }) } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "找到 3 处" },
      { role: "tool", tool_call_id: "c2", content: "目录内容" },
    ];
    const out = flattenToolHistory(messages);
    expect(out).toHaveLength(1);
    const flat = out[0] as any;
    expect(flat.role).toBe("assistant");
    expect(flat.content).toContain("search");
    expect(flat.content).toContain("list_dir");
    expect(flat.content).toContain("找到 3 处");
    expect(flat.content).toContain("目录内容");
  });

  it("无工具调用的纯文本历史原样保留", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    expect(flattenToolHistory(messages)).toEqual(messages);
  });

  it("孤立的 tool 消息被丢弃", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "hi" },
      { role: "tool", tool_call_id: "orphan", content: "孤立结果" },
      { role: "assistant", content: "done" },
    ];
    const out = flattenToolHistory(messages);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe("user");
    expect(out[1].role).toBe("assistant");
  });

  it("工具结果超长时截断", () => {
    const longResult = "x".repeat(1000);
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: longResult },
    ];
    const out = flattenToolHistory(messages);
    const flat = out[0] as any;
    expect(flat.content.length).toBeLessThan(longResult.length);
    expect(flat.content).toContain("…");
  });
});
