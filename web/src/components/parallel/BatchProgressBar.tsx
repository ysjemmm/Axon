/**
 * BatchProgressBar —— 批次整体进度条
 *
 * 视觉：
 * - 多段圆角进度条，每段代表一路 Agent
 * - 运行中段带 shimmer 动画（从左到右流光）
 * - 状态文本 + 元信息（耗时、token）
 */

import { CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import type { ParallelBatch } from "./types";

interface BatchProgressBarProps {
  batch: ParallelBatch;
}

export function BatchProgressBar({ batch }: BatchProgressBarProps) {
  const total = batch.agents.length;
  const done = batch.agents.filter((a) => a.status === "done").length;
  const failed = batch.agents.filter((a) => a.status === "failed").length;
  const running = batch.agents.filter((a) => a.status === "running").length;

  const statusIcon = () => {
    if (batch.status === "running") return <Loader2 className="w-4 h-4 text-primary animate-spin" />;
    if (batch.status === "partial_failed") return <AlertCircle className="w-4 h-4 text-amber-500" />;
    return <CheckCircle2 className="w-4 h-4 text-green-500" />;
  };

  const statusText = () => {
    if (batch.status === "running") return `${done}/${total} 完成，${running} 执行中`;
    if (batch.status === "partial_failed") return `${done}/${total} 完成，${failed} 失败`;
    return `全部完成 (${total} 路)`;
  };

  const elapsed = batch.elapsed
    ? batch.elapsed > 60000
      ? `${(batch.elapsed / 60000).toFixed(1)}min`
      : `${(batch.elapsed / 1000).toFixed(1)}s`
    : null;

  return (
    <div className="space-y-2.5">
      {/* 标题行 */}
      <div className="flex items-center gap-2.5">
        {statusIcon()}
        <span className="text-sm font-medium flex-1 truncate">{batch.intent}</span>
        <span className="text-[11px] text-muted-foreground shrink-0">{statusText()}</span>
      </div>

      {/* Relay 关联信息（可点击跳转） */}
      {batch.relayId && (
        <button
          onClick={() => {
            // 通过宿主跳转到 Relay 详情（扩展命令）
            const vscode = (window as any).__axonVSCode || (typeof (window as any).acquireVsCodeApi === "function" ? (window as any).acquireVsCodeApi() : null);
            if (vscode) vscode.postMessage({ type: "open_relay", relayId: batch.relayId });
          }}
          className="flex items-center gap-1 text-[11px] text-primary/70 hover:text-primary transition-colors"
        >
          <span>📋</span>
          <span className="underline underline-offset-2">来自 Relay 工作流</span>
          <span className="text-muted-foreground">→</span>
        </button>
      )}

      {/* 多段进度条 */}
      <div className="flex gap-[3px] h-2.5 rounded-full overflow-hidden bg-muted/50 p-[2px]">
        {batch.agents.map((agent) => {
          let cls = "bg-muted-foreground/15 rounded-full"; // pending
          if (agent.status === "running") cls = "bg-primary rounded-full relative overflow-hidden";
          if (agent.status === "done") cls = "bg-green-500 rounded-full";
          if (agent.status === "failed") cls = "bg-destructive rounded-full";
          return (
            <div
              key={agent.delegateId}
              className={`flex-1 h-full transition-all duration-500 ${cls}`}
              title={`${agent.intent} (${agent.status})`}
            >
              {/* running 状态的 shimmer 动画 */}
              {agent.status === "running" && (
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-[shimmer_1.5s_ease-in-out_infinite]" />
              )}
            </div>
          );
        })}
      </div>

      {/* 元信息 */}
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        {elapsed && <span>耗时 {elapsed}</span>}
        {batch.totalTokens != null && batch.totalTokens > 0 && (
          <span>{batch.totalTokens.toLocaleString()} tokens</span>
        )}
        <span>{total} 路并行</span>
      </div>
    </div>
  );
}
