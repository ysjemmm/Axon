import { describe, expect, it } from "vitest";
import { PromptBuilder } from "./promptBuilder.js";
import { autoCompactThreshold } from "../compactor.js";

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
    // 与 AgentSession.getAutoCompactAt 同一算法（1M 窗口 → 850k）
    getAutoCompactAt(this: any) { return autoCompactThreshold(this.getContextWindow()); },
    // 产物目录注入会读它；默认给空串（等于「还没定下来」），需要它的用例自己覆盖
    getArtifactDir: () => "",
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

  it("跨轮：上一轮的请求（思考清空后）是新一轮首个请求的完整前缀，且只补发变化的注入", () => {
    const s = makeSession({ ideContextCache: "IDE v1", skillsPromptCache: "SKILLS" });
    startTurn(s, "第一轮");
    toolStep(s);
    s.messages.push({ role: "assistant", content: "完成" });
    const lastOfTurn1 = json(s.promptBuilder.buildRequestMessages());

    s.ideContextCache = "IDE v2";
    startTurn(s, "第二轮");
    const firstOfTurn2 = s.promptBuilder.buildRequestMessages();

    // 上一回合的思考在新回合里被清空内容（见 PromptBuilder.REASONING_KEEP_PREVIOUS_TURNS），
    // 这是每回合一次的预期断点；除此之外，上一回合的请求原样是新回合的前缀
    const clearedTurn1 = lastOfTurn1.map((m) => {
      const msg = JSON.parse(m);
      return JSON.stringify(msg.reasoning_content ? { ...msg, reasoning_content: "" } : msg);
    });
    expect(json(firstOfTurn2).slice(0, clearedTurn1.length)).toEqual(clearedTurn1);
    // 新增部分 = 变化的 IDE 上下文 + 第二轮用户消息；渲染协议、skills 没变，不重发
    expect(firstOfTurn2.slice(clearedTurn1.length).map((m: any) => m.content)).toEqual(["IDE v2", "第二轮"]);
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

describe("运行环境与未开启能力的注入", () => {
  it("注入运行环境；问答模式只给日期", () => {
    const agent = makeSession({ mode: "agent" });
    const quest = makeSession({ mode: "quest" });
    const envOf = (s: any) => s.promptBuilder.snapshotContextInjections().find((i: any) => i.key === "env")?.content;
    expect(envOf(agent)).toMatch(/操作系统 .*今天是/);
    expect(envOf(quest)).toMatch(/^【运行环境】今天是/);
  });

  it("渲染协议不再作为注入发送（已并入系统提示）", () => {
    const keys = makeSession().promptBuilder.snapshotContextInjections().map((i: any) => i.key);
    expect(keys).not.toContain("render");
  });

  it("动画 / 图片生成没开时提示怎么开，开了就不提", () => {
    const off = makeSession();
    const hint = off.promptBuilder.snapshotContextInjections().find((i: any) => i.key === "capabilities")?.content;
    expect(hint).toContain("axon.media.enabled");
    expect(hint).toContain("axon.image.enabled");

    const on = makeSession({
      mediaEnabled: true, imageEnabled: true, host: { mediaRenderer: {}, imageGenerator: {} },
    });
    expect(on.promptBuilder.snapshotContextInjections().map((i: any) => i.key)).not.toContain("capabilities");
  });

  it("旧会话快照里的 render 项消失时，不能说成「不再适用」", () => {
    const s = makeSession();
    s.messages.push({
      role: "user", content: "旧问题",
      _contextInjections: [{ key: "render", content: "增强渲染协议（旧）" }],
    });
    s.messages.push({ role: "assistant", content: "旧回答" });
    startTurn(s, "新问题");
    const req = s.promptBuilder.buildRequestMessages();
    const notice = req.find((m: any) => typeof m.content === "string" && m.content.includes("图表渲染"));
    expect(notice?.content).toContain("以系统提示中的「图表渲染」为准");
  });
});

describe("上下文使用率提醒只在当前这一轮发", () => {
  const busy = () => makeSession({ lastTotalTokens: 880_000, getContextWindow: () => 1_000_000 });

  it("不进落盘的快照", () => {
    const s = busy();
    startTurn(s, "第一轮");
    expect(s.messages.at(-1)._contextInjections.map((i: any) => i.key)).not.toContain("usage");
  });

  it("挂在当前用户消息之前；进入下一轮后，上一轮那条不再发", () => {
    const s = busy();
    startTurn(s, "第一轮");
    s.messages.push({ role: "assistant", content: "好" });
    startTurn(s, "第二轮");
    const req = s.promptBuilder.buildRequestMessages();
    const notices = req.filter((m: any) => typeof m.content === "string" && m.content.includes("【上下文使用率】"));
    expect(notices).toHaveLength(1);
    expect(req[req.indexOf(notices[0]) + 1].content).toBe("第二轮");
  });

  it("压缩后占用回落：不再提醒，旧快照里存着的过期提醒也不发", () => {
    const s = makeSession({ lastTotalTokens: 100_000, getContextWindow: () => 1_000_000 });
    // 旧版本落盘的快照里还带着 80% 的提醒
    s.messages.push({
      role: "user", content: "压缩前的问题",
      _contextInjections: [{ key: "usage", content: "⚠️ 上下文使用率已达 80%。" }],
    });
    s.messages.push({ role: "assistant", content: "回答" });
    startTurn(s, "压缩后的新问题");
    const text = JSON.stringify(s.promptBuilder.buildRequestMessages());
    expect(text).not.toContain("80%");
    expect(text).not.toContain("上下文使用率");
  });
});
