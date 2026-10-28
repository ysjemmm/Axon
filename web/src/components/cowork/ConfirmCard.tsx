/**
 * 连接器操作的确认卡片（Cowork）：发邮件、建 Issue 这类会对外产生影响的动作，执行前让用户看清楚。
 * 邮件按「收件人 / 主题 / 正文 / 附件」展示；其他操作列出参数。
 */

import { ShieldQuestion } from "lucide-react";
import type { PendingConfirm } from "./useCoworkSession";

const LABELS: Record<string, string> = { to: "收件人", cc: "抄送", bcc: "密送", subject: "主题", text: "正文", attachments: "附件" };

function display(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v.replace(/\\/g, "/").split("/").pop() : JSON.stringify(v))).join("、");
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function ConfirmCard({ confirm, onAnswer }: { confirm: PendingConfirm; onAnswer: (confirmed: boolean) => void }) {
  const isMail = /mail_send$/.test(confirm.label);
  const entries = Object.entries(confirm.args).filter(([k, v]) => v !== undefined && v !== "" && (!isMail || k in LABELS));
  return (
    <div className="mb-2 rounded-xl border border-amber-300/70 bg-amber-50 px-3.5 py-3 dark:border-amber-900/60 dark:bg-amber-950/25">
      <div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
        <ShieldQuestion className="h-4 w-4 text-amber-600 dark:text-amber-500" />
        {isMail ? "确认发送这封邮件？" : `确认执行：${confirm.label}`}
      </div>
      <dl className="mt-2 max-h-48 space-y-1 overflow-y-auto text-[12px]">
        {entries.map(([key, value]) => (
          <div key={key} className="flex gap-2">
            <dt className="w-12 shrink-0 text-muted-foreground">{LABELS[key] ?? key}</dt>
            <dd className={`min-w-0 flex-1 text-foreground ${key === "text" ? "whitespace-pre-wrap" : "truncate"}`}>{display(value)}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-2.5 flex justify-end gap-2">
        <button onClick={() => onAnswer(false)} className="rounded-md border border-border px-3 py-1.5 text-[12px] hover:bg-muted/60">不要</button>
        <button onClick={() => onAnswer(true)} className="rounded-md bg-primary px-3.5 py-1.5 text-[12px] font-medium text-primary-foreground">{isMail ? "发送" : "允许"}</button>
      </div>
    </div>
  );
}
