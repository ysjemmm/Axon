import { describe, expect, it } from "vitest";
import { QUEST_SYSTEM_PROMPT, SUB_AGENT_SYSTEM_PROMPT, SYSTEM_PROMPT, isAxonSystemPrompt } from "./systemPrompt.js";

describe("系统提示", () => {
  it("不写死 shell，不用 ━ 分隔线", () => {
    for (const p of [SYSTEM_PROMPT, QUEST_SYSTEM_PROMPT, SUB_AGENT_SYSTEM_PROMPT]) {
      expect(p).not.toContain("━");
      expect(p).not.toMatch(/PowerShell 语法/);
    }
  });

  it("主提示与子 Agent 共用同一份改文件规则（分散改动首选 apply_patch）", () => {
    expect(SYSTEM_PROMPT).toContain("apply_patch 一次提交所有变更块");
    expect(SUB_AGENT_SYSTEM_PROMPT).toContain("apply_patch 一次提交所有变更块");
    expect(SUB_AGENT_SYSTEM_PROMPT).not.toContain("分散小改用多次 str_replace");
  });

  it("建文件前不再强制列目录", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/调用前【必须】先用 list_dir/);
  });

  it("排版与渲染规则三处共享：Quest 也有排版规则", () => {
    expect(QUEST_SYSTEM_PROMPT).toContain("## 回复排版");
    expect(QUEST_SYSTEM_PROMPT).toContain("axon-render");
    expect(QUEST_SYSTEM_PROMPT).toContain("Code 模式");
  });

  it("子 Agent 结论有固定结构，且任务指定格式时让路", () => {
    for (const s of ["**结论**", "**关键发现**", "**改动**", "**未完成 / 不确定**", "任务描述指定了输出格式"]) {
      expect(SUB_AGENT_SYSTEM_PROMPT).toContain(s);
    }
  });

  it("功能开启说明不再常驻系统提示（改为按需注入）", () => {
    expect(SYSTEM_PROMPT).not.toContain("axon.media.enabled");
    expect(QUEST_SYSTEM_PROMPT).not.toContain("window.renderAudio");
  });

  it("isAxonSystemPrompt 认得新旧各版、不误伤其它 system 消息", () => {
    expect(isAxonSystemPrompt(SYSTEM_PROMPT)).toBe(true);
    expect(isAxonSystemPrompt(QUEST_SYSTEM_PROMPT)).toBe(true);
    expect(isAxonSystemPrompt("你是 Axon，一个 AI 编程助手（旧版）……")).toBe(true);
    expect(isAxonSystemPrompt("【会话记忆】……")).toBe(false);
    expect(isAxonSystemPrompt(undefined)).toBe(false);
  });
});
