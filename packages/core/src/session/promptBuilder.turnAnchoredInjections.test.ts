import { describe, expect, it } from "vitest";
import { PromptBuilder } from "./promptBuilder.js";

/**
 * 回归：缓存友好模型（DeepSeek / Qwen / GLM 等）的上下文注入锚在本轮用户消息之前。
 *
 * 早先注入追加在整段历史之后：一轮 N 次工具调用，每次请求的末尾都是一大块 system 注入，
 * 模型读到的不是「工具结果刚回来」而像是新一轮开始，于是每一步的思考都把
 * 「用户让我按方向 A……」重新复述一遍；注入本身也永远落在前缀缓存的未命中区。
 */

function makeSession(overrides: Record<string, unknown> = {}) {
  const s: any = {
    model: "deepseek-v4-flash",
    cwd: "/work/main",
    terminalCwd: "/work/main",
    workspaces: ["/work/main"],
    host: {},
    messages: [{ role: "system", content: "SYSTEM PROMPT" }],
    ideContextCache: null,
    skillsPromptCache: null,
    powersPromptCache: null,
    wikiPromptCache: null,
    memory: "",
    lastTotalTokens: 0,
    getContextWindow: () => 1_000_000,
    ...overrides,
  };
  s.promptBuilder = new PromptBuilder(s);
  return s;
}

/** 模拟 AgentSession.handleUserInput：推入用户消息 → 定格注入 → 挂快照 */
function startTurn(s: any, text: string) {
  s.messages.push({ role: "user", content: text });
  s.promptBuilder.beginTurn();
  s.messages[s.messages.length - 1]._contextInjections = s.promptBuilder.snapshotContextInjections();
}

let callSeq = 0;
function toolStep(s: any) {
  const id = `call_${++callSeq}`;
  s.messages.push({
    role: "assistant",
    content: null,
    reasoning_content: "思考",
    tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }],
  });
  s.messages.push({ role: "tool", tool_call_id: id, content: "文件内容" });
}

const json = (msgs: any[]) => msgs.map((m) => JSON.stringify(m));

describe("缓存友好模型：上下文注入锚在本轮用户消息之前", () => {
  for (const model of ["deepseek-v4-flash", "qwen3.7-plus", "glm-5.2"]) {
    it(`${model}：工具调用后请求末尾是工具结果，不是注入`, () => {
      const s = makeSession({ model, ideContextCache: "IDE CTX", skillsPromptCache: "SKILLS" });
      startTurn(s, "按方向 A 实现");
      toolStep(s);

      const req = s.promptBuilder.buildRequestMessages();
      expect(req.at(-1)).toMatchObject({ role: "tool" });
      const userIdx = req.findIndex((m: any) => m.role === "user");
      const injected = req.slice(1, userIdx).map((m: any) => m.content);
      expect(injected).toContain("IDE CTX");
      expect(injected).toContain("SKILLS");
      // 内部快照字段不能发给 provider
      expect(req[userIdx]._contextInjections).toBeUndefined();
    });
  }

  it("轮内每一步的请求都以上一步的请求为完整前缀", () => {
    const s = makeSession({ ideContextCache: "IDE CTX" });
    startTurn(s, "按方向 A 实现");
    const steps: string[][] = [];
    for (let i = 0; i < 3; i++) {
      toolStep(s);
      // 轮内 IDE 状态变化不影响本轮已定格的快照
      s.ideContextCache = `IDE CTX changed ${i}`;
      steps.push(json(s.promptBuilder.buildRequestMessages()));
    }
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].slice(0, steps[i - 1].length)).toEqual(steps[i - 1]);
    }
  });

  it("跨轮：上一轮的请求是新一轮首个请求的完整前缀，且只补发变化的注入", () => {
    const s = makeSession({ ideContextCache: "IDE v1", skillsPromptCache: "SKILLS" });
    startTurn(s, "第一轮");
    toolStep(s);
    s.messages.push({ role: "assistant", content: "完成" });
    const lastOfTurn1 = json(s.promptBuilder.buildRequestMessages());

    s.ideContextCache = "IDE v2";
    startTurn(s, "第二轮");
    const firstOfTurn2 = s.promptBuilder.buildRequestMessages();

    expect(json(firstOfTurn2).slice(0, lastOfTurn1.length)).toEqual(lastOfTurn1);
    // 新增部分 = 变化的 IDE 上下文 + 第二轮用户消息；渲染协议、skills 没变，不重发
    expect(firstOfTurn2.slice(lastOfTurn1.length).map((m: any) => m.content)).toEqual(["IDE v2", "第二轮"]);
  });

  it("某项注入在新一轮消失时，补一条作废说明", () => {
    const s = makeSession({ memory: "# 记忆\n- 结论 A" });
    startTurn(s, "第一轮");
    s.messages.push({ role: "assistant", content: "好" });
    s.memory = "";
    startTurn(s, "第二轮");

    const req = s.promptBuilder.buildRequestMessages();
    const beforeTurn2 = req.at(-2);
    expect(beforeTurn2.role).toBe("system");
    expect(beforeTurn2.content).toContain("已被清空");
  });

  it("单步临时纠偏（_tailInjected system）仍放在请求末尾", () => {
    const s = makeSession();
    startTurn(s, "按方向 A 实现");
    toolStep(s);
    s.messages.push({ role: "system", content: "纠偏提示", _tailInjected: true, _ephemeralInjected: true });

    const req = s.promptBuilder.buildRequestMessages();
    expect(req.at(-1)?.content).toBe("纠偏提示");
    expect(req.at(-2)).toMatchObject({ role: "tool" });
  });

  it("旧会话（用户消息没有快照）：用实时注入兜底，放在最后一条用户消息之前", () => {
    const s = makeSession({
      ideContextCache: "IDE CTX",
      messages: [
        { role: "system", content: "SYSTEM PROMPT" },
        { role: "user", content: "旧问题" },
        { role: "assistant", content: "旧回答" },
        { role: "user", content: "新问题" },
      ],
    });
    const req = s.promptBuilder.buildRequestMessages();
    expect(req.at(-1)?.content).toBe("新问题");
    expect(req.at(-2)?.content).toBe("IDE CTX");
    expect(req[1]?.content).toBe("旧问题");
  });

  it("截图回填的 user 消息不当作本轮锚点", () => {
    const s = makeSession({ ideContextCache: "IDE CTX" });
    startTurn(s, "看看页面");
    toolStep(s);
    s.messages.push({ role: "user", content: [{ type: "text", text: "截图" }], _screenshotInjection: true });

    const req = s.promptBuilder.buildRequestMessages();
    const idx = req.findIndex((m: any) => m.content === "看看页面");
    expect(req[idx - 1]?.content).toBe("IDE CTX");
    expect(req.at(-1)?._screenshotInjection).toBe(true);
  });
});

describe("工作区 .axon 注入", () => {
  it("缓存友好模型：随本轮注入锚在用户消息之前", () => {
    const s = makeSession({ workspaceAxonPromptCache: "AXON RULES" });
    startTurn(s, "开始");
    toolStep(s);
    const req = s.promptBuilder.buildRequestMessages();
    const userIdx = req.findIndex((m: any) => m.role === "user");
    expect(req.slice(1, userIdx).map((m: any) => m.content)).toContain("AXON RULES");
    expect(req.at(-1)).toMatchObject({ role: "tool" });
  });

  it("非缓存友好模型：buildInjections 里是完整的 system 消息（没有 undefined）", () => {
    const s = makeSession({ model: "claude-opus-5.5", workspaceAxonPromptCache: "AXON RULES" });
    const injections = s.promptBuilder.buildInjections();
    expect(injections.every((m: any) => m && m.role === "system")).toBe(true);
    expect(injections.map((m: any) => m.content)).toContain("AXON RULES");
    expect(s.promptBuilder.buildRequestMessages().every((m: any) => m)).toBe(true);
  });
});
