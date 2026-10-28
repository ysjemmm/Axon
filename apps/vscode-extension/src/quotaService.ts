/**
 * 用量查询的宿主侧逻辑已移到 core（quota/hostService.ts），与独立 server 共用。
 * 这里只做再导出；VS Code 的 SecretStorage 结构上满足 core 的 SecretKV。
 */

export { isQuotaTrusted, quotaSecrets, clearQuotaSecrets, quotaTokenStatus, saveQuotaTokens, queryProvider, quotaOverview, invalidateQuotaOverview, type QuotaOverviewEntry } from "@axon/core";
