import { describe, expect, it } from "vitest";
import { serializeHistoryForMemory } from "./compactor.js";

describe("会话记忆历史序列化", () => {
  it("保留工具名称、参数和关键路径", () => {
    const text = serializeHistoryForMemory([
      { role: "user", content: "把工作区改成折叠行" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "p1",
          type: "function",
          function: {
            name: "apply_patch",
            arguments: JSON.stringify({ path: "web/src/components/ToolCallItem.tsx" }),
          },
        }],
      } as any,
      { role: "tool", content: "已应用补丁" } as any,
    ]);

    expect(text).toContain("apply_patch");
    expect(text).toContain("web/src/components/ToolCallItem.tsx");
    expect(text).not.toContain("（工具调用）");
  });
});
