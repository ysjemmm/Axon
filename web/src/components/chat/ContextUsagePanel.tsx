/**
 * ContextUsagePanel —— 上下文用量明细（悬停圆环时弹出）。
 *
 * 版式对齐 Claude 的上下文面板：
 *   标题 → 「已使用 x%」与「已用 / 窗口」→ 分段进度条 → 各来源一行（色块 · 名称 · token · 占比）
 *   → 剩余空间 → 可展开的 MCP 工具明细 → 「距自动压缩还剩 X」与「压缩会话」。
 *
 * 剩余空间 = 窗口 − 已用（真实还能装多少），不扣自动压缩预留；自动压缩线画成进度条上的刻度，
 * 离它还有多远看底栏「距自动压缩还剩」。各行加起来正好 100%。
 *
 * 数据来自后端 token_usage 事件的 breakdown（TokenAccountant.buildContextBreakdown）：
 * 各项已按总量缩放，加和等于「已使用」。旧后端没有 breakdown 时只显示总量与底栏。
 */

import { useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import { formatTokenCount } from "./format";
import type { ContextBreakdown, ContextCategoryKey } from "./types";

const CATEGORY_META: Record<ContextCategoryKey, { label: string; color: string; hint?: string }> = {
  messages: { label: "Messages", color: "#2f7be6" },
  systemTools: { label: "System tools", color: "#f0733a" },
  mcpTools: { label: "MCP tools", color: "#12b886", hint: "每个 MCP 工具的占用见下方「MCP 工具」" },
  skills: { label: "Skills", color: "#8c8c8c", hint: "可用技能与 Power 清单" },
  memory: { label: "Session memory", color: "#8c8c8c", hint: "会话记忆（随每轮注入）" },
  systemPrompt: { label: "System prompt", color: "#8c8c8c" },
  injections: { label: "Injected context", color: "#8c8c8c", hint: "IDE 上下文、运行环境、工作区规则等按轮注入" },
};
// 剩余与刻度跟随主题：写死浅灰的话，深色模式下「剩余空间」会变成一块刺眼的白
const MARK_COLOR = "color-mix(in oklab, var(--muted-foreground) 70%, transparent)";
const FREE_COLOR = "var(--muted)";

function pct(tokens: number, max: number): string {
  return max > 0 ? `${((tokens / max) * 100).toFixed(1)}%` : "—";
}

function Row({ color, label, tokens, max, hint, muted }: {
  color: string; label: string; tokens: number; max: number; hint?: string; muted?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 h-6">
      <span className="size-3 shrink-0 rounded-[3px]" style={{ background: color }} />
      <span
        className={`flex-1 min-w-0 truncate leading-6 ${muted ? "text-muted-foreground" : "text-foreground/75"}`}
        title={hint}
      >
        {label}
      </span>
      <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">{formatTokenCount(tokens)}</span>
      <span className="w-12 shrink-0 text-right tabular-nums text-foreground">{pct(tokens, max)}</span>
    </div>
  );
}

export function ContextUsagePanel({ used, max, breakdown, canCompact, compacting, compactStatus, onCompact }: {
  used: number;
  max: number;
  breakdown?: ContextBreakdown;
  canCompact: boolean;
  compacting: boolean;
  /** 不能压缩时的原因（显示在按钮的 title 上） */
  compactStatus: string | null;
  onCompact?: () => void;
}) {
  const [mcpOpen, setMcpOpen] = useState(false);
  const hasMax = max > 0;
  const percent = hasMax ? Math.min(used / max, 1) * 100 : 0;

  const categories = (breakdown?.categories ?? []).filter((c) => c.key === "messages" || c.tokens > 0);
  const autoAt = breakdown?.autoCompactAt ?? (hasMax ? Math.round(max * 0.75) : 0);
  const free = hasMax ? Math.max(0, max - used) : 0;
  const untilAuto = autoAt - used;
  const mcpTools = breakdown?.mcpTools ?? [];

  return (
    <div className="w-[272px] text-[13px] leading-none">
      <div className="flex items-center gap-1 text-[14px] font-medium text-foreground">
        上下文
        <span className="text-[9px] text-foreground/70">▼</span>
      </div>

      <div className="mt-3 flex items-baseline justify-between">
        <span className="text-[14px] text-foreground">已使用 {Math.round(percent)}%</span>
        <span className="tabular-nums text-muted-foreground">
          {formatTokenCount(used)}{hasMax ? ` / ${formatTokenCount(max).replace(/\.00M$/, "M")}` : ""}
        </span>
      </div>

      {/* 分段进度条：各来源 → 剩余（轨道底色）；竖线刻度 = 自动压缩线 */}
      {hasMax && (
        <div className="relative mt-2 flex h-1 w-full overflow-hidden rounded-full" style={{ background: FREE_COLOR }}>
          {(categories.length > 0 ? categories : [{ key: "messages" as const, tokens: used }]).map((c, i) => (
            <span
              key={c.key}
              className="h-full"
              style={{
                width: `${(c.tokens / max) * 100}%`,
                background: CATEGORY_META[c.key].color,
                marginLeft: i > 0 && c.tokens / max > 0.002 ? 1 : 0,
              }}
            />
          ))}
          {autoAt > 0 && autoAt < max && (
            <span
              className="absolute inset-y-0 w-px"
              style={{ left: `${(autoAt / max) * 100}%`, background: MARK_COLOR }}
              title={`自动压缩线 ${formatTokenCount(autoAt)}`}
            />
          )}
        </div>
      )}

      {categories.length > 0 && (
        <div className="mt-2.5 flex flex-col">
          {categories.map((c) => (
            <Row key={c.key} color={CATEGORY_META[c.key].color} label={CATEGORY_META[c.key].label} tokens={c.tokens} max={max} hint={CATEGORY_META[c.key].hint} />
          ))}
          {hasMax && <Row color={FREE_COLOR} label="Free space" tokens={free} max={max} />}
        </div>
      )}

      {mcpTools.length > 0 && (
        <div className="mt-2.5">
          <button
            type="button"
            onClick={() => setMcpOpen((v) => !v)}
            className="flex w-full items-center gap-2.5 h-6 text-left text-foreground/75 hover:text-foreground"
          >
            <ChevronRight className={`size-3 shrink-0 transition-transform ${mcpOpen ? "rotate-90" : ""}`} />
            <span className="flex-1">MCP 工具</span>
            <span className="tabular-nums text-muted-foreground">{mcpTools.length}</span>
          </button>
          {mcpOpen && (
            <div className="max-h-40 overflow-y-auto pl-[22px] pr-1">
              {mcpTools.map((t) => (
                <div key={t.name} className="flex items-center gap-2 h-6 text-muted-foreground">
                  <span className="flex-1 min-w-0 truncate" title={t.server ? `${t.server} · ${t.tool}` : t.tool}>
                    {t.server ? `${t.server} · ${t.tool}` : t.tool}
                  </span>
                  <span className="shrink-0 tabular-nums">{formatTokenCount(t.tokens)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-muted-foreground">
          {!hasMax ? "" : untilAuto > 0 ? `距自动压缩还剩 ${formatTokenCount(untilAuto)}` : "已到自动压缩线"}
        </span>
        <button
          type="button"
          disabled={!canCompact}
          onClick={onCompact}
          title={canCompact ? undefined : compactStatus ?? undefined}
          className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 h-7 text-[13px] text-foreground transition-colors hover:bg-muted-foreground/15 disabled:opacity-50 disabled:hover:bg-muted"
        >
          {compacting && <Loader2 className="size-3.5 animate-spin" />}
          {compacting ? "压缩中…" : "压缩会话"}
        </button>
      </div>
      {!canCompact && !compacting && compactStatus && (
        <div className="mt-1.5 text-[11px] leading-snug text-muted-foreground/80">{compactStatus}</div>
      )}
    </div>
  );
}
