/**
 * 内置用量查询模板。新增一个平台 = 在这里加一份数据，不用改引擎或界面。
 *
 * verified=false 的模板是按公开文档 / 社区用法写的，尚未用真实账号核对过响应格式：
 * 自动识别仍会尝试它们（取不到数值就算失败，不会误报），界面上会标注「未验证」。
 */

import type { QuotaPreset } from "./types.js";

const bearerApiKey = { authorization: "Bearer {{apiKey}}" };

export const QUOTA_PRESETS: QuotaPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek 余额",
    description: "DeepSeek 开放平台账户余额（GET /user/balance），每种币种一条。",
    hosts: ["api.deepseek.com"],
    needs: ["apiKey"],
    verified: false,
    rule: {
      steps: [{ id: "main", url: "{{origin}}/user/balance", headers: bearerApiKey }],
      metrics: [{ each: "$.balance_infos", labelPath: "@.currency", labelMap: { CNY: "余额（人民币）", USD: "余额（美元）" }, kind: "balance", remaining: "@.total_balance", unitPath: "@.currency" }],
    },
  },
  {
    id: "moonshot-cn",
    label: "Kimi（月之暗面）余额",
    description: "Moonshot 开放平台可用余额（GET /v1/users/me/balance）。",
    hosts: ["api.moonshot.cn"],
    needs: ["apiKey"],
    verified: false,
    rule: {
      steps: [{ id: "main", url: "{{origin}}/v1/users/me/balance", headers: bearerApiKey }],
      metrics: [{ label: "可用余额", kind: "balance", remaining: "$.data.available_balance", unit: "¥" }],
    },
  },
  {
    id: "moonshot-ai",
    label: "Kimi（Moonshot 国际站）余额",
    description: "Moonshot 国际站可用余额（GET /v1/users/me/balance）。",
    hosts: ["api.moonshot.ai"],
    needs: ["apiKey"],
    verified: false,
    rule: {
      steps: [{ id: "main", url: "{{origin}}/v1/users/me/balance", headers: bearerApiKey }],
      metrics: [{ label: "可用余额", kind: "balance", remaining: "$.data.available_balance", unit: "$" }],
    },
  },
  {
    id: "siliconflow",
    label: "硅基流动余额",
    description: "SiliconFlow 账户总余额（GET /v1/user/info）。",
    hosts: ["api.siliconflow.cn", "api.siliconflow.com"],
    needs: ["apiKey"],
    verified: false,
    rule: {
      steps: [{ id: "main", url: "{{origin}}/v1/user/info", headers: bearerApiKey }],
      metrics: [{ label: "账户余额", kind: "balance", remaining: "$.data.totalBalance", unit: "¥" }],
    },
  },
  {
    id: "openrouter",
    label: "OpenRouter 额度",
    description: "账户充值余额（/api/v1/credits）与当前 Key 的限额（/api/v1/key）。",
    hosts: ["openrouter.ai"],
    needs: ["apiKey"],
    verified: false,
    rule: {
      steps: [
        { id: "key", url: "{{origin}}/api/v1/key", headers: bearerApiKey },
        { id: "credits", url: "{{origin}}/api/v1/credits", headers: bearerApiKey, optional: true },
      ],
      metrics: [
        { label: "账户余额", kind: "balance", total: "credits:$.data.total_credits", used: "credits:$.data.total_usage", unit: "$" },
        { label: "此 Key 限额", kind: "quota", used: "key:$.data.usage", total: "key:$.data.limit", remaining: "key:$.data.limit_remaining", unit: "$" },
      ],
    },
  },
  {
    id: "zhipu-coding",
    label: "智谱 GLM 编程套餐",
    description: "GLM Coding Plan 的时间窗口限额（5 小时 Token 额度、MCP 调用次数等）。",
    hosts: ["open.bigmodel.cn", "api.z.ai"],
    needs: ["apiKey"],
    verified: false,
    rule: {
      steps: [{ id: "main", url: "{{origin}}/api/monitor/usage/quota/limit", headers: { authorization: "{{apiKey}}" } }],
      metrics: [{
        each: "$.data.limits",
        labelPath: "@.type",
        labelMap: { TOKENS_LIMIT: "5 小时 Token 额度", TIME_LIMIT: "MCP 调用次数" },
        kind: "window",
        percent: "@.percentage",
        used: "@.currentValue",
        total: "@.usage",
        remaining: "@.remaining",
        resetAt: "@.nextResetTime",
      }],
    },
  },
  {
    id: "new-api-key",
    label: "new-api / one-api 中转站（API Key）",
    description: "OpenAI 兼容的账单接口：令牌额度（/v1/dashboard/billing/subscription）与已用（/v1/dashboard/billing/usage）。大部分中转站都支持，只需要 API Key。",
    needs: ["apiKey"],
    verified: false,
    rule: {
      steps: [
        { id: "sub", url: "{{origin}}/v1/dashboard/billing/subscription", headers: bearerApiKey },
        { id: "usage", url: "{{origin}}/v1/dashboard/billing/usage", headers: bearerApiKey, query: { start_date: "2023-01-01", end_date: "{{today}}" }, optional: true },
      ],
      metrics: [{ label: "令牌额度", kind: "quota", total: "sub:$.hard_limit_usd", used: { path: "usage:$.total_usage", scale: 100 }, unit: "$" }],
    },
  },
  {
    id: "new-api-user",
    label: "new-api 中转站（账户余额 + 订阅）",
    description: "账户剩余额度与已用（/api/user/self），开通了订阅套餐的再显示套餐额度与下次重置时间（/api/subscription/self）。需要中转站「个人设置」里生成的系统访问令牌和用户 ID。",
    needs: ["accessToken"],
    vars: [{ name: "userId", label: "用户 ID", placeholder: "个人设置页里的数字 ID" }],
    verified: false,
    rule: {
      auth: { header: "authorization", prefix: "Bearer " },
      steps: [
        { id: "main", url: "{{origin}}/api/user/self", headers: { "new-api-user": "{{vars.userId}}" } },
        // 没开通订阅的站点或账户这一步会失败，跳过即可，只显示余额
        { id: "sub", url: "{{origin}}/api/subscription/self", headers: { "new-api-user": "{{vars.userId}}" }, optional: true },
      ],
      metrics: [
        { label: "账户余额", kind: "balance", remaining: "main:$.data.quota", used: "main:$.data.used_quota", scale: 500000, unit: "$" },
        {
          label: "订阅额度",
          each: "sub:$.data.subscriptions",
          kind: "window",
          used: "@.subscription.amount_used",
          total: "@.subscription.amount_total",
          resetAt: "@.subscription.next_reset_time",
          scale: 500000,
          unit: "$",
        },
      ],
    },
  },
  {
    id: "subscription",
    label: "订阅额度（/api/subscription）",
    description: "按周期重置的订阅额度，需要面板登录令牌。",
    needs: ["accessToken"],
    verified: true,
    rule: {
      auth: { header: "authorization", prefix: "Bearer " },
      steps: [{ id: "main", url: "{{origin}}/api/subscription" }],
      metrics: [{
        label: "订阅额度",
        kind: "window",
        used: "$.data.subscriptions[0].subscription.amount_used",
        total: "$.data.subscriptions[0].subscription.amount_total",
        resetAt: "$.data.subscriptions[0].subscription.next_reset_time",
        scale: 500000,
        unit: "$",
      }],
    },
  },
  {
    id: "credits-usage",
    label: "Credits 用量（/user/api/usage）",
    description: "用 API Key 查询已用与总 Credits。",
    needs: ["apiKey"],
    verified: true,
    rule: {
      steps: [{ id: "main", url: "{{origin}}/user/api/usage", headers: bearerApiKey }],
      metrics: [{ label: "Credits", kind: "quota", used: "$.totalCredits", total: "$.creditLimit", unit: "Credits" }],
    },
  },
];

export function getQuotaPreset(id: string): QuotaPreset | undefined {
  return QUOTA_PRESETS.find((preset) => preset.id === id);
}

function hostMatches(host: string, patterns: string[]): boolean {
  return patterns.some((pattern) => host === pattern || host.endsWith(`.${pattern}`));
}

/** 按 baseUrl 给模板排序：主机匹配的在前，通用模板在后，其他平台的专用模板不返回 */
export function presetsForBaseUrl(baseUrl: string): Array<QuotaPreset & { matched: boolean }> {
  let host = "";
  try { host = new URL(baseUrl).hostname; } catch { /* baseUrl 无效时只给通用模板 */ }
  const matched = QUOTA_PRESETS.filter((p) => p.hosts && host && hostMatches(host, p.hosts)).map((p) => ({ ...p, matched: true }));
  const generic = QUOTA_PRESETS.filter((p) => !p.hosts).map((p) => ({ ...p, matched: false }));
  return [...matched, ...generic];
}
