/**
 * Cowork 核对结果（report_checks）：Agent 交付前的自查，渲染成核对清单。
 */

export type CoworkCheckStatus = "pass" | "warn" | "fail";

export interface CoworkCheck {
  label: string;
  status: CoworkCheckStatus;
  detail?: string;
}

const MAX_CHECKS = 12;
const STATUSES: CoworkCheckStatus[] = ["pass", "warn", "fail"];

/** 宽松解析：status 认几种常见写法，标签为空的项丢弃 */
export function parseChecks(args: Record<string, unknown>): CoworkCheck[] {
  let raw = args.checks;
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(raw)) return [];
  const out: CoworkCheck[] = [];
  for (const item of raw.slice(0, MAX_CHECKS)) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const label = String(obj.label ?? obj.name ?? "").trim().slice(0, 80);
    if (!label) continue;
    const s = String(obj.status ?? "").toLowerCase();
    const status: CoworkCheckStatus = STATUSES.includes(s as CoworkCheckStatus)
      ? (s as CoworkCheckStatus)
      : s === "ok" || s === "passed" || s === "success" ? "pass" : s === "error" || s === "failed" ? "fail" : "warn";
    const detail = String(obj.detail ?? obj.message ?? "").trim().slice(0, 300);
    out.push({ label, status, ...(detail ? { detail } : {}) });
  }
  return out;
}

export function checksResult(checks: CoworkCheck[]): string {
  const fail = checks.filter((c) => c.status === "fail").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  const tail = fail > 0
    ? `其中 ${fail} 项不通过：请在最终回复里说明原因，能修正的先修正再重新登记。`
    : warn > 0 ? `其中 ${warn} 项需留意，请在最终回复里简要提醒用户。` : "全部通过。";
  return `已登记 ${checks.length} 条核对结果，已显示给用户。${tail}`;
}
