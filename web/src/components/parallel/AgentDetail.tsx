/**
 * AgentDetail —— 单个并行 Agent 的完整详情视图
 *
 * 被 Agent 概览条选中后展示的"大视图"：占满内容区，内容自然撑开（父级面板统一滚动）。
 */

import { CheckCircle2, XCircle, Loader2, FileCode2, Circle, Terminal } from "lucide-react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { renderSegments } from "../chat/renderSegments";
import type { ParallelAgent } from "./types";

interface AgentDetailProps {
  agent: ParallelAgent;
  index: number;
}

export function AgentDetail({ agent, index }: AgentDetailProps) {
  const accent = {
    pending: { ring: "ring-muted-foreground/20", grad: "from-muted/40 to-transparent", dot: "text-muted-foreground/50" },
    running: { ring: "ring-primary/30", grad: "from-primary/10 to-transparent", dot: "text-primary" },
    done: { ring: "ring-green-500/30", grad: "from-green-500/10 to-transparent", dot: "text-green-500" },
    failed: { ring: "ring-destructive/30", grad: "from-destructive/10 to-transparent", dot: "text-destructive" },
  }[agent.status];

  const statusBadge = () => {
    switch (agent.status) {
      case "pending":
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-muted text-muted-foreground"><Circle className="w-3 h-3" /> 等待中</span>;
      case "running":
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-primary/10 text-primary"><Loader2 className="w-3 h-3 animate-spin" /> 执行中</span>;
      case "done":
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/10 text-green-600 dark:text-green-400"><CheckCircle2 className="w-3 h-3" /> 已完成</span>;
      case "failed":
        return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-destructive/10 text-destructive"><XCircle className="w-3 h-3" /> 失败</span>;
    }
  };

  const toolSegments = agent.inner.filter((s) => s.type === "tool");
  const doneTools = toolSegments.filter((s) => s.type === "tool" && s.status !== "pending");

  return (
    <div className="p-4 space-y-4">
      {/* 头部卡片：带状态渐变 + 序号徽章 */}
      <div className={`relative rounded-xl ring-1 ${accent.ring} overflow-hidden`}>
        <div className={`absolute inset-0 bg-gradient-to-br ${accent.grad} pointer-events-none`} />
        <div className="relative p-4 space-y-2.5">
          <div className="flex items-center gap-2.5">
            {/* 序号圆徽 */}
            <div className={`flex items-center justify-center w-8 h-8 rounded-lg bg-background ring-1 ${accent.ring} text-sm font-bold ${accent.dot} shrink-0`}>
              {index + 1}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {statusBadge()}
                {toolSegments.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Terminal className="w-3 h-3" />
                    {doneTools.length}/{toolSegments.length} 步
                  </span>
                )}
              </div>
            </div>
          </div>
          <h3 className="text-base font-semibold leading-snug">{agent.intent}</h3>

          {/* 文件作用域 */}
          {agent.fileScope.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {agent.fileScope.map((scope, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-background/60 text-foreground/70 ring-1 ring-border/60"
                >
                  <FileCode2 className="w-3 h-3 text-primary/60" />
                  {scope}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 执行过程（左侧时间线竖线） */}
      <div>
        <h4 className="text-xs font-semibold text-muted-foreground/80 uppercase tracking-wide mb-2">执行过程</h4>
        {agent.inner.length > 0 ? (
          <div className="relative pl-3 border-l-2 border-border/40 space-y-1">
            {renderSegments(agent.inner, agent.innerStreaming)}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground italic py-2 pl-3">
            {agent.status === "pending"
              ? "等待启动..."
              : agent.status === "running"
                ? "正在初始化..."
                : "（执行记录未保留，查看下方结论）"}
          </p>
        )}
      </div>

      {/* 结论 */}
      {agent.conclusion && (
        <div className="rounded-xl ring-1 ring-border bg-gradient-to-br from-muted/30 to-transparent p-4">
          <h4 className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground/80 uppercase tracking-wide mb-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
            执行结论
          </h4>
          <MarkdownRenderer content={agent.conclusion} />
        </div>
      )}
    </div>
  );
}
