/**
 * WorkspaceAxonPanel —— 多工作区 .axon 配置现状一览
 *
 * 只读展示 + 逐个初始化。刻意不提供"全部初始化"：这些工作区里可能混着公司仓库，
 * 一键在十几个仓库里创建 AXON.md 是最容易造成污染的操作，必须由用户逐个确认。
 */

import { Loader2, RefreshCw, Sparkles, X, Check, CircleDashed } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/** 与 core 的 WorkspaceAxonStatus 保持一致（前端不直接 import core 包） */
export interface WorkspaceAxonStatusItem {
  workspace: string;
  hasAxonMd: boolean;
  hasLocalOverride: boolean;
  hasSettings: boolean;
  rules: number;
  memory: number;
  skills: number;
  agents: number;
}

export interface WorkspaceAxonPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  statuses: WorkspaceAxonStatusItem[];
  loading?: boolean;
  onRefresh: () => void;
  /** 单个工作区初始化；批量操作刻意不提供 */
  onInitialize: (workspace: string) => void;
}

/** 取路径最后一段作为显示名，Windows 反斜杠与 POSIX 斜杠都吃 */
function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || path;
}

/** 状态徽章：已启用 / 仅目录 / 未启用 */
function StatusBadges({ item }: { item: WorkspaceAxonStatusItem }) {
  const badges: { key: string; label: string; muted?: boolean }[] = [];
  if (item.hasAxonMd) badges.push({ key: "axon", label: "AXON.md" });
  if (item.hasSettings) badges.push({ key: "settings", label: "settings" });
  if (item.rules > 0) badges.push({ key: "rules", label: `${item.rules} 规则` });
  if (item.memory > 0) badges.push({ key: "memory", label: `${item.memory} 记忆` });
  if (item.skills > 0) badges.push({ key: "skills", label: `${item.skills} Skills` });
  if (item.agents > 0) badges.push({ key: "agents", label: `${item.agents} Agents` });
  if (item.hasLocalOverride) badges.push({ key: "local", label: "本地覆盖", muted: true });

  if (badges.length === 0) {
    return <span className="text-[11px] text-muted-foreground/60">未启用</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      {badges.map((badge) => (
        <span
          key={badge.key}
          className={`rounded px-1.5 py-px text-[10px] ${
            badge.muted
              ? "bg-muted/40 text-muted-foreground/70"
              : "bg-foreground/8 text-muted-foreground"
          }`}
        >
          {badge.label}
        </span>
      ))}
    </span>
  );
}

export function WorkspaceAxonPanel({
  open,
  onOpenChange,
  statuses,
  loading,
  onRefresh,
  onInitialize,
}: WorkspaceAxonPanelProps) {
  const enabled = statuses.filter((item) => item.hasAxonMd).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!max-w-[680px] w-[680px] max-h-[76vh] !flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="flex flex-row items-center gap-2 px-4 py-3 pr-12 border-b border-border space-y-0 shrink-0">
          <DialogTitle className="text-sm">工作区 Axon 配置</DialogTitle>
          <span className="text-[11px] text-muted-foreground/60">
            {statuses.length > 0 ? `${enabled}/${statuses.length} 已启用` : "读取中"}
          </span>
        </DialogHeader>

        <div className="shrink-0 border-b border-border/60 bg-muted/20 px-4 py-2">
          <p className="text-[11px] leading-relaxed text-muted-foreground/80">
            这里只读取现状，不会自动创建任何文件。需要哪个工作区启用，就单独点它的「初始化」——
            AI 不会替你往仓库里写配置，也不会批量处理。
          </p>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading && statuses.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : statuses.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-muted-foreground">
              当前会话还没有绑定工作区。
            </div>
          ) : (
            <ul className="divide-y divide-border/50">
              {statuses.map((item) => (
                <li key={item.workspace} className="flex items-start gap-3 px-4 py-2.5">
                  <span className="mt-0.5 shrink-0">
                    {item.hasAxonMd ? (
                      <Check className="h-3.5 w-3.5 opacity-60" />
                    ) : (
                      <CircleDashed className="h-3.5 w-3.5 opacity-30" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium text-foreground">{baseName(item.workspace)}</span>
                      <StatusBadges item={item} />
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/50" title={item.workspace}>
                      {item.workspace}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 shrink-0 px-2 text-[11px]"
                    disabled={item.hasAxonMd}
                    onClick={() => onInitialize(item.workspace)}
                    title={item.hasAxonMd ? "该工作区已有 AXON.md，不会重复创建" : "只为这个工作区创建缺失的 .axon 文件"}
                  >
                    <Sparkles className="mr-1 h-3 w-3" />
                    {item.hasAxonMd ? "已启用" : "初始化"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2.5">
          <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading}>
            {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1 h-3.5 w-3.5" />}
            刷新
          </Button>
          <span className="ml-auto text-[11px] text-muted-foreground/50">
            初始化只补缺失文件，不覆盖已有内容
          </span>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            <X className="mr-1 h-3.5 w-3.5" />
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
