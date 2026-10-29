/**
 * 权限模式选择器（输入框工具栏）：安全 / 自动 / 完全访问，一层包含一层。
 * 安全是默认，按钮低调显示；切到自动 / 完全访问后按钮常驻高亮（琥珀 / 红），提醒用户 AI 正在免审批工作。
 */

import { useState } from "react";
import { Check, ChevronDown, ShieldCheck, ShieldAlert, Zap } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { PermissionMode } from "@/lib/permissionModes";

const OPTIONS: { id: PermissionMode; label: string; desc: string; icon: typeof ShieldCheck; tone: string; chip: string }[] = [
  {
    id: "safe",
    label: "安全",
    desc: "没信任过的命令、外部工具的写操作要你批准；文件只写在工作区内",
    icon: ShieldCheck,
    tone: "text-emerald-600 dark:text-emerald-400",
    chip: "text-foreground/70 hover:bg-muted/60 hover:text-foreground",
  },
  {
    id: "auto",
    label: "自动",
    desc: "包含安全模式的全部能力，且所有操作都不用你审批，改动直接写入",
    icon: Zap,
    tone: "text-amber-600 dark:text-amber-400",
    chip: "bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300",
  },
  {
    id: "full",
    label: "完全访问",
    desc: "包含自动模式的全部能力，还能读写工作区以外的任何文件夹",
    icon: ShieldAlert,
    tone: "text-red-600 dark:text-red-400",
    chip: "bg-red-500/10 text-red-700 hover:bg-red-500/15 dark:text-red-300",
  },
];

export function PermissionModePicker({ value, onChange }: { value: PermissionMode; onChange: (mode: PermissionMode) => void }) {
  const [open, setOpen] = useState(false);
  const current = OPTIONS.find((o) => o.id === value) ?? OPTIONS[0];
  const Icon = current.icon;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={`权限模式：${current.label}`}
          aria-label={`权限模式：${current.label}`}
          className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[13px] transition-colors data-[state=open]:bg-muted/60 ${current.chip}`}
        >
          <Icon className={`size-3.5 shrink-0 ${value === "safe" ? current.tone : ""}`} />
          <span className="whitespace-nowrap">{current.label}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={6} collisionPadding={8} className="w-[280px] gap-0 rounded-xl p-1.5 shadow-xl ring-1 ring-border/70">
        <div className="px-2 pb-1 pt-0.5 text-[11px] font-medium text-muted-foreground">权限模式</div>
        {OPTIONS.map((o) => {
          const OIcon = o.icon;
          const active = o.id === value;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => { onChange(o.id); setOpen(false); }}
              className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/60 ${active ? "bg-muted/50" : ""}`}
            >
              <OIcon className={`mt-0.5 size-4 shrink-0 ${o.tone}`} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-foreground">{o.label}</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{o.desc}</span>
              </span>
              {active && <Check className="mt-0.5 size-3.5 shrink-0 text-foreground/70" />}
            </button>
          );
        })}
        <div className="mx-2 mt-1 border-t border-border/60 pt-1.5 pb-0.5 text-[10px] leading-4 text-muted-foreground/80">
          格式化磁盘、删除整个根目录 / 用户目录这类命令，任何模式下都会先问你。
        </div>
      </PopoverContent>
    </Popover>
  );
}
