/**
 * 回复底部的用量标签：按后端给的 billing 决定显示什么（见 core/billing.ts）。
 *  - cost：配置了单价的 provider，显示估算花费
 *  - tokens：未配置单价，显示本轮消耗的 Token 数（如 1.2K）
 *  - credits：官方 provider；旧历史没有 billing 字段时也按这个显示
 * hover 都给出输入 / 缓存命中 / 输出的拆分。
 *
 * tokens 模式的标题数字 = 没命中缓存的输入 + 输出（与后端 billing.headlineTokens 一致）。
 * 不用累计输入：每次工具调用都会把整段上下文重发一遍，十几次请求的累计输入轻松上百万，
 * 而其中大部分命中缓存、按很低的价格计费——当标题既吓人又不反映真实开销。
 */

import type { ChatMessage } from "./types";

type Stats = NonNullable<ChatMessage["turnStats"]>;

export function formatTokenCount(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1).replace(/\.?0+$/, "")}M`;
}

function formatCost(cost: { amount: number; currency: string }): string {
  const digits = cost.amount > 0 && cost.amount < 0.01 ? 4 : 2;
  return `${cost.currency}${cost.amount.toFixed(digits)}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-white/70">{label}</span>
      <span className="text-right">{value}</span>
    </>
  );
}

const tooltipClass = "pointer-events-none absolute bottom-full left-0 z-50 mb-2 hidden rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs leading-relaxed text-white shadow-xl group-hover/credits:block";

export function TurnUsageLabel({ stats, uncertain }: { stats: Stats; uncertain: boolean }) {
  const mark = uncertain ? "(?)" : "";
  const usage = stats.usage;

  if ((stats.billing === "cost" || stats.billing === "tokens") && usage) {
    const cached = Math.min(usage.cached, usage.input);
    const headline = usage.input - cached + usage.output;
    const text = stats.billing === "cost" && stats.cost ? formatCost(stats.cost) : `${formatTokenCount(headline)} tokens`;
    const requests = usage.requests ?? 0;
    return (
      <span className="relative inline-flex cursor-default border-b border-dotted border-muted-foreground/40 group/credits">
        {text}{mark}
        <span className={tooltipClass}>
          <span className="flex flex-col">
            <span className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 whitespace-nowrap">
              {requests > 1 && <Row label="请求模型" value={`${requests} 次（平均每次 ${formatTokenCount(usage.input / requests)}）`} />}
              <Row label="新输入" value={`${(usage.input - cached).toLocaleString()} tokens`} />
              {cached > 0 && <Row label="缓存命中" value={`${cached.toLocaleString()} tokens`} />}
              <Row label="输出" value={`${usage.output.toLocaleString()} tokens`} />
            </span>
            <span className="mt-1 max-w-[260px] whitespace-normal text-center text-[9px] leading-snug text-white/50">
              {usage.estimated
                ? "端点未返回用量，数字为本地估算"
                : stats.billing === "cost"
                  ? "按 Provider 配置的单价估算，缓存命中按缓存价计"
                  : cached > 0
                    ? "标题 = 新输入 + 输出。每次调用工具都会重发整段上下文，重复的部分命中缓存，价格很低，不计入标题"
                    : "本轮所有请求合计"}
            </span>
          </span>
        </span>
      </span>
    );
  }

  const credits = `Credits: ${(stats.credits ?? 0).toFixed(2)}${mark}`;
  const detail = stats.creditDetail;
  if (!detail) return <span>{credits}</span>;
  return (
    <span className="relative inline-flex cursor-default border-b border-dotted border-muted-foreground/40 group/credits">
      {credits}
      <span className={tooltipClass}>
        <span className="flex flex-col">
          <span className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 whitespace-nowrap">
            <Row label="Memory" value={`${(detail.memoryTokens ?? 0).toLocaleString()} tokens`} />
            <Row label="System" value={`${(detail.systemTokens ?? 0).toLocaleString()} tokens`} />
            <Row label="Question" value={`${(detail.questionTokens ?? detail.inputTokens).toLocaleString()} tokens`} />
            <Row label="Output" value={`${detail.outputTokens.toLocaleString()} tokens`} />
          </span>
          <span className="mt-1 text-center text-[9px] text-white/50">Token split is approximate.</span>
        </span>
      </span>
    </span>
  );
}
