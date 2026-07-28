import { describe, expect, it } from "vitest";
import { supportsThinking } from "./thinkingSupport.js";

describe("supportsThinking", () => {
  describe("声明优先", () => {
    it("显式 true：即使名字完全认不出来也采信", () => {
      // 中转站可以叫任何名字，这正是声明存在的理由
      expect(supportsThinking("GTP-5.6-luna", true)).toBe(true);
      expect(supportsThinking("我司自研大模型-v1", true)).toBe(true);
      expect(supportsThinking("glm-4-flash", true)).toBe(true);
    });

    it("显式 false：即使名字看起来像推理模型也不下发", () => {
      // 用户能关掉"名字像但中转站实际不支持"的模型——这是 false 存在的意义，
      // 不能被启发式覆盖，否则用户根本没法禁用
      expect(supportsThinking("claude-opus-5", false)).toBe(false);
      expect(supportsThinking("deepseek-r1", false)).toBe(false);
      expect(supportsThinking("gpt-5.5", false)).toBe(false);
    });
  });

  describe("无声明时的兜底启发式", () => {
    it("名字里直接写了 thinking/reasoner 的一律认为支持", () => {
      expect(supportsThinking("kimi-k2-thinking")).toBe(true);
      expect(supportsThinking("deepseek-reasoner")).toBe(true);
      expect(supportsThinking("qwen3-235b-thinking")).toBe(true);
    });

    it("Claude：Opus 4 及以后、Sonnet 4.5 及以后", () => {
      expect(supportsThinking("claude-opus-4-6")).toBe(true);
      // 回归用例：早先的字面枚举漏掉了 opus-5，目录里的旗舰模型静默拿不到思考能力
      expect(supportsThinking("claude-opus-5")).toBe(true);
      expect(supportsThinking("claude-sonnet-4-5")).toBe(true);
      expect(supportsThinking("claude-sonnet-5")).toBe(true);
    });

    it("Claude：Sonnet 4.0 与 Haiku 不认为支持", () => {
      expect(supportsThinking("claude-sonnet-4")).toBe(false);
      expect(supportsThinking("claude-haiku-4-5")).toBe(false);
      expect(supportsThinking("claude-3-5-sonnet")).toBe(false);
    });

    it("OpenAI：o 系列与 GPT-5 及以后", () => {
      expect(supportsThinking("o1")).toBe(true);
      expect(supportsThinking("o3-mini")).toBe(true);
      expect(supportsThinking("gpt-5.5")).toBe(true);
      expect(supportsThinking("gpt-5.6-luna")).toBe(true);
    });

    it("OpenAI：GPT-4 及更早不认为支持", () => {
      expect(supportsThinking("gpt-4o")).toBe(false);
      expect(supportsThinking("gpt-4.1")).toBe(false);
    });

    it("国产系列：GLM-5+/DeepSeek V4+/Qwen 3.7+", () => {
      expect(supportsThinking("glm-5.2")).toBe(true);
      expect(supportsThinking("glm-5.1")).toBe(true);
      expect(supportsThinking("deepseek-v4-pro")).toBe(true);
      expect(supportsThinking("qwen-3.7-plus")).toBe(true);
      expect(supportsThinking("qwq-32b")).toBe(true);
    });

    it("国产系列：旧版本不认为支持", () => {
      expect(supportsThinking("glm-4-flash")).toBe(false);
      expect(supportsThinking("glm-4-flashx")).toBe(false);
      expect(supportsThinking("deepseek-v3")).toBe(false);
      expect(supportsThinking("qwen3-coder-plus")).toBe(false);
    });

    it("认不出来的名字宁漏不错（漏判只是少个能力，乱判会断流）", () => {
      // 用户提到的 GTP 拼写：正则追不上中转站命名，只能靠声明
      expect(supportsThinking("GTP-5.6-luna")).toBe(false);
      expect(supportsThinking("我司自研大模型-v1")).toBe(false);
      expect(supportsThinking("")).toBe(false);
    });
  });
});
