/**
 * 核对清单：Agent 交付前的自查结果（report_checks）。
 *
 * 放在产出文件旁边、说明文字之前：财务和会计拿到结果先看「对不对」，再看「怎么做的」。
 * 三种状态用不同形状区分（对勾 / 感叹号 / 叉），不只靠颜色。
 */

import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import type { CoworkCheck } from "./flowTypes";

const ICON = {
  pass: <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-500" aria-label="通过" />,
  warn: <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" aria-label="需留意" />,
  fail: <XCircle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-500" aria-label="不通过" />,
};

export function CheckList({ checks }: { checks: CoworkCheck[] }) {
  if (checks.length === 0) return null;
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const summary = failed > 0 ? `${failed} 项不通过` : warned > 0 ? `${warned} 项需留意` : "全部通过";
  const tone = failed > 0 ? "text-red-600 dark:text-red-500" : warned > 0 ? "text-amber-600 dark:text-amber-500" : "text-emerald-600 dark:text-emerald-500";
  return (
    <div className="rounded-xl border border-border bg-background px-3.5 py-2.5">
      <div className="mb-1.5 flex items-center gap-2 text-[12px]">
        <span className="font-medium text-foreground">核对</span>
        <span className={tone}>{summary}</span>
      </div>
      <ul className="space-y-1.5">
        {checks.map((check, index) => (
          <li key={`${index}-${check.label}`} className="flex items-start gap-2 text-[13px] leading-5">
            <span className="mt-0.5">{ICON[check.status]}</span>
            <span className="min-w-0">
              <span className="font-medium text-foreground">{check.label}</span>
              {check.detail && <span className="ml-2 text-muted-foreground">{check.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
