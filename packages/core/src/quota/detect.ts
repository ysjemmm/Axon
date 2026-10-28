/**
 * 自动识别：拿 provider 现有的凭证把候选模板逐个试一遍，第一个取到数值的就是它。
 *
 * 只试「凭证已经齐了」的模板（需要面板令牌 / Cookie / 额外变量而用户还没填的跳过），
 * 所以识别过程不会向用户要东西，也不会把凭证发给 provider 以外的主机——模板里的地址
 * 要么是 {{origin}}，要么本身就是按 baseUrl 主机匹配出来的。
 */

import { runQuotaRule, type QuotaRunOptions } from "./engine.js";
import { presetsForBaseUrl } from "./presets.js";
import type { QuotaPreset, QuotaProvider, QuotaResult, QuotaRule } from "./types.js";

export interface QuotaDetectAttempt {
  preset: string;
  label: string;
  error: string;
}

export interface QuotaDetectResult {
  preset?: QuotaPreset;
  rule?: QuotaRule;
  result?: QuotaResult;
  attempts: QuotaDetectAttempt[];
}

export async function detectQuota(provider: QuotaProvider, options: QuotaRunOptions = {}): Promise<QuotaDetectResult> {
  const attempts: QuotaDetectAttempt[] = [];
  const hasAccessToken = !!(await options.secrets?.getAccessToken())?.value;
  const hasCookie = !!(await options.secrets?.getCookie());
  for (const preset of presetsForBaseUrl(provider.baseUrl)) {
    const ready = preset.needs.every((need) => need === "apiKey" ? !!provider.apiKey : need === "accessToken" ? hasAccessToken : hasCookie)
      && (preset.vars || []).length === 0;
    if (!ready) continue;
    const rule: QuotaRule = { ...preset.rule, enabled: true, preset: preset.id };
    try {
      // 识别是用户主动发起、规则来自内置模板，按受信规则执行
      const result = await runQuotaRule({ ...provider, quotaTrusted: true }, rule, { ...options, timeoutMs: options.timeoutMs || 8000 });
      return { preset, rule, result, attempts };
    } catch (error) {
      attempts.push({ preset: preset.id, label: preset.label, error: (error as Error).message.slice(0, 200) });
    }
  }
  return { attempts };
}
