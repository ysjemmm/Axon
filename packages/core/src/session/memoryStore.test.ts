import { describe, expect, it } from "vitest";
import { applyMemoryUpdates, mergeMemoryMarkdown, parseMemoryMarkdown, renderMemoryForModel, renderMemoryMarkdown, threeWayMergeMemory } from "./memoryStore.js";

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

describe("防丢与防覆盖", () => {
  it("upsert 只写了新信息（比原块短一半以上）时保留旧条目", () => {
    const before = "## 当前状态\n\n- 已完成登录页\n- 已完成注册页\n- 已接入短信验证码\n- 已完成个人中心";
    const after = applyMemoryUpdates(before, [{ action: "upsert", key: "当前状态", content: "- 已完成设置页" }]);
    for (const line of ["已完成登录页", "已完成注册页", "已接入短信验证码", "已完成个人中心", "已完成设置页"]) {
      expect(after).toContain(line);
    }
  });

  it("upsert 给出完整的新版本时正常替换", () => {
    const before = "## 当前状态\n\n- 登录页进行中";
    const after = applyMemoryUpdates(before, [{ action: "upsert", key: "当前状态", content: "- 登录页已完成，已通过验收" }]);
    expect(after).not.toContain("登录页进行中");
  });

  it("用 section 名猜 key 只命中标准章节块，不会把任意同类块整块换掉", () => {
    const before = "## 登录模块进度\n\n- 已完成登录页";
    const after = applyMemoryUpdates(before, [{ action: "upsert", key: "status", section: "status", title: "注册模块进度", content: "- 注册页进行中" }]);
    expect(after).toContain("已完成登录页");
    expect(after).toContain("注册页进行中");
  });

  it("key 不同但标题相同，更新到同一个块而不是生成重复章节", () => {
    const after = applyMemoryUpdates("## 工具卡片样式\n\n- 折叠行", [
      { action: "append", key: "tool-card-style", title: "工具卡片样式", content: "- 图标中性灰" },
    ]);
    expect(after.match(/## 工具卡片样式/g)).toHaveLength(1);
    expect(after).toContain("图标中性灰");
  });

  it("append 不重复已有条目", () => {
    const after = applyMemoryUpdates("## 待办\n\n- 验证构建", [{ action: "append", key: "待办", content: "- 验证构建\n- 更新 README" }]);
    expect(after.match(/验证构建/g)).toHaveLength(1);
  });

  it("导入是合并：同标题行级并集，新标题追加", () => {
    const merged = mergeMemoryMarkdown("## 用户偏好\n\n- 中文回复", "## 用户偏好\n\n- 不要分割线\n\n## 项目结构\n\n- monorepo");
    expect(merged).toContain("中文回复");
    expect(merged).toContain("不要分割线");
    expect(merged).toContain("## 项目结构");
  });

  it("三方合并：用户的修改与后台新写的块都保留，用户删掉的块不会复活", () => {
    const base = "## 用户偏好\n\n- 中文回复\n\n## 待办\n\n- 验证构建";
    const current = base + "\n\n## 踩坑\n\n- Windows 路径要转义";
    const draft = "## 用户偏好\n\n- 中文回复\n- 不要分割线";
    const merged = threeWayMergeMemory(base, current, draft);
    expect(merged).toContain("不要分割线");
    expect(merged).toContain("Windows 路径要转义");
    expect(merged).not.toContain("验证构建");
  });

  it("给模型看的版本标出每个块的 key", () => {
    expect(renderMemoryForModel("## 用户偏好\n\n- 中文回复")).toContain("〔key: 用户偏好〕");
  });
});
