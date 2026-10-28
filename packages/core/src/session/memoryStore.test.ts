import { describe, expect, it } from "vitest";
import { applyMemoryUpdates, parseMemoryMarkdown, renderMemoryMarkdown } from "./memoryStore.js";

describe("结构化会话记忆", () => {
  it("解析并稳定渲染旧版 Markdown", () => {
    const blocks = parseMemoryMarkdown("## 项目背景\n\n- Axon 是 monorepo。\n\n## 待办\n\n- 验证记忆注入。\n");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].section).toBe("project");
    expect(renderMemoryMarkdown(blocks)).toContain("## 项目背景");
    expect(renderMemoryMarkdown(blocks)).toContain("验证记忆注入");
  });

  it("按 key 增量更新，不重写未涉及的章节", () => {
    const before = "## 工作区理解\n\n- Axon 主工作区。\n\n## 设计决策\n\n- 工具卡片使用折叠行。";
    const after = applyMemoryUpdates(before, [{
      action: "upsert",
      key: "tool-card-style",
      section: "decisions",
      title: "工具卡片样式",
      content: "- 图标统一使用中性灰。",
    }]);
    expect(after).toContain("Axon 主工作区");
    expect(after).toContain("工具卡片使用折叠行");
    expect(after).toContain("图标统一使用中性灰");
  });

  it("支持 append 和 delete，记忆可以持续增长或清理过时块", () => {
    const appended = applyMemoryUpdates("## 待办\n\n- 验证构建。", [{
      action: "append",
      key: "todos",
      title: "待办",
      content: "- 更新 README。",
    }]);
    expect(appended).toContain("验证构建");
    expect(appended).toContain("更新 README");

    const deleted = applyMemoryUpdates(appended, [{ action: "delete", key: "todos" }]);
    expect(deleted).not.toContain("验证构建");
    expect(deleted).not.toContain("更新 README");
  });
});
