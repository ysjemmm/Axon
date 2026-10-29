import { describe, expect, it } from "vitest";
import { computeTurnCost, describeTurnUsage, formatTokenCount, headlineTokens, resolveTurnBilling } from "./billing.js";

describe("回复底部的用量展示", () => {
  const usage = { input: 2_000_000, cached: 1_500_000, output: 100_000 };

  it("没配置单价：只给 token 数", () => {
    expect(resolveTurnBilling("relay", undefined, "m", usage)).toEqual({ billing: "tokens", usage });
  });

  it("官方 provider 沿用 Credits", () => {
    expect(resolveTurnBilling("axon", { default: { input: 1 } }, "m", usage).billing).toBe("credits");
  });

  it("按模型单价估算，缓存命中单独计价，没配的模型用默认档", () => {
    const pricing = { currency: "$", models: { m: { input: 2, cacheRead: 0.2, output: 8 } }, default: { input: 1, output: 1 } };
    // 0.5M×2 + 1.5M×0.2 + 0.1M×8 = 1 + 0.3 + 0.8
    expect(resolveTurnBilling("relay", pricing, "m", usage).cost).toEqual({ amount: expect.closeTo(2.1, 6), currency: "$" });
    expect(resolveTurnBilling("relay", pricing, "other", usage).cost?.amount).toBeCloseTo(2.1, 6); // 默认档：2M×1（缓存按输入价）+ 0.1M×1
    // 缓存命中没单独定价时按输入价
    expect(computeTurnCost({ input: 1, output: 0 }, usage).amount).toBeCloseTo(2, 6);
  });

  it("token 数格式", () => {
    expect([999, 1234, 12_345, 1_234_567, 23_456_789].map(formatTokenCount)).toEqual(["999", "1.2K", "12K", "1.23M", "23.5M"]);
  });

  it("标题 token 数不含命中缓存的输入（十几次请求的累计输入不当标题）", () => {
    const turn = { input: 1_432_284, cached: 1_125_504, output: 8_040, requests: 17 };
    expect(headlineTokens(turn)).toBe(314_820);
    expect(describeTurnUsage({ billing: "tokens", usage: turn }, 0)).toBe("315K tokens");
  });
});
