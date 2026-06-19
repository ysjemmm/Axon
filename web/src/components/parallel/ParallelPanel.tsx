/**
 * ParallelPanel —— 多 Agent 并行工作流面板
 *
 * 顶层布局：
 * - 无批次时：空状态引导页（输入框 + 说明）
 * - 有批次时：当前批次的多列 Agent 进度展示 + 输入框
 * - 支持取消正在运行的批次 / 删除历史批次
 */

import { useState, useRef, useCallback } from "react";
import { Send, GitBranch, Zap, Square, Trash2, Loader2, Circle, CheckCircle2, XCircle } from "lucide-react";
import { useParallelSession } from "./useParallelSession";
import { ModelSelector, autoSelectModel, findModel } from "@/components/ModelSelector";
import { MentionEditor, type MentionEditorHandle } from "@/components/chat/MentionEditor";
import { AgentDetail } from "./AgentDetail";
import { BatchProgressBar } from "./BatchProgressBar";
import { FileChangesPanel } from "./FileChangesPanel";
import type { ParallelBatch } from "./types";

/** 通过宿主打开文件 */
function openFileInHost(path: string): void {
  const vscode = (window as any).__axonVSCode || (typeof (window as any).acquireVsCodeApi === "function" ? (window as any).acquireVsCodeApi() : null);
  if (vscode) vscode.postMessage({ type: "open_file", path });
}

interface ParallelPanelProps {
  connected: boolean;
  send: (cmd: Record<string, unknown>) => void;
}

export function ParallelPanel({ connected, send }: ParallelPanelProps) {
  const { state, thinking, thinkingStatus, submit, cancelBatch, deleteBatch, undoFile, setActiveBatch } = useParallelSession({ connected, send });
  const [model, setModel] = useState(() => {
    try { return localStorage.getItem("axon_parallel_model") || "auto"; } catch { return "auto"; }
  });

  // 模型选择持久化
  const handleModelChange = useCallback((m: string) => {
    setModel(m);
    try { localStorage.setItem("axon_parallel_model", m); } catch { /* ignore */ }
  }, []);
  const [composerEmpty, setComposerEmpty] = useState(true);
  const editorRef = useRef<MentionEditorHandle>(null);

  const handleSubmit = useCallback(() => {
    const { text } = editorRef.current?.read() ?? { text: "" };
    if (!text.trim()) return;
    // 如果是 auto 模式，根据内容选择模型
    let actualModel = model;
    let actualProvider: string | undefined;
    if (model === "auto") {
      const selected = autoSelectModel(text, false);
      actualModel = selected.id;
      actualProvider = selected.provider;
    } else {
      const found = findModel(model);
      if (found) actualProvider = found.provider;
    }
    submit(text.trim(), actualModel, actualProvider);
    editorRef.current?.clear();
    setComposerEmpty(true);
    editorRef.current?.focus();
  }, [model, submit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  // 当前查看的批次
  const activeBatch = state.activeBatchId
    ? state.batches.find((b) => b.batchId === state.activeBatchId) || null
    : state.batches[0] || null;

  // 是否有正在运行的批次
  const hasRunning = thinking || state.batches.some((b) => b.status === "running");

  return (
    <div className="flex flex-col h-full">
      {/* 批次切换器：多于 1 个批次时显示，隔离切换查看 */}
      {state.batches.length > 1 && !thinking && (
        <BatchSwitcher
          batches={state.batches}
          activeBatchId={activeBatch?.batchId ?? null}
          onSelect={(id) => setActiveBatch(id)}
        />
      )}

      {/* AI 回复和并行结果统一在 BatchSwitcher + BatchDetailView 展示 */}

      {/* 批次详情视图 */}
      {thinking ? (
        /* 正在分析需求中 */
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-6 h-6 text-primary animate-spin" />
            <p className="text-sm text-muted-foreground">{thinkingStatus || "正在分析需求，拆分并行子任务..."}</p>
          </div>
        </div>
      ) : activeBatch ? (
        <BatchDetailView
          batch={activeBatch}
          onCancel={() => cancelBatch(activeBatch.batchId)}
          onDelete={() => { deleteBatch(activeBatch.batchId); setActiveBatch(null); }}
          onUndoFile={undoFile}
        />
      ) : (
        /* 空状态引导 */
        <EmptyState />
      )}

      {/* 底部输入区 */}
      <div className="shrink-0 border-t border-border p-3 space-y-2">
        <div className="flex items-end gap-2">
          <div className="flex-1 min-w-0 rounded-lg border border-border bg-background px-3 py-2 focus-within:ring-1 focus-within:ring-ring">
            <MentionEditor
              ref={editorRef}
              disabled={!connected || hasRunning}
              placeholder={hasRunning ? "等待当前任务完成..." : "描述你的需求，AI 会自动拆分为多个并行子任务..."}
              onChange={() => setComposerEmpty(editorRef.current?.isEmpty() ?? true)}
              onKeyDown={handleKeyDown}
            />
          </div>
          <button
            onClick={handleSubmit}
            disabled={!connected || composerEmpty || hasRunning}
            className="shrink-0 p-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <ModelSelector
            value={model}
            onChange={handleModelChange}
            disabled={hasRunning}
          />
          {!connected && (
            <p className="text-[11px] text-destructive">未连接到 Agent 服务</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** 空状态引导页 */
function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="text-center max-w-sm space-y-4">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10">
          <GitBranch className="w-8 h-8 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">多 Agent 并行</h2>
          <p className="text-sm text-muted-foreground mt-1">
            描述一个复杂需求，AI 会自动拆分为多个互不依赖的子任务，
            派发多个 Agent 同时执行——前端、后端、测试并行推进。
          </p>
        </div>
        <div className="text-left space-y-2 text-xs text-muted-foreground">
          <div className="flex items-start gap-2">
            <Zap className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
            <span>每个 Agent 有独立的文件作用域，互不冲突</span>
          </div>
          <div className="flex items-start gap-2">
            <Zap className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
            <span>实时查看每路 Agent 的进度和工具调用</span>
          </div>
          <div className="flex items-start gap-2">
            <Zap className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
            <span>自动聚合所有 Agent 的执行结论</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 批次切换器：顶部横向 tab，隔离切换查看不同批次 */
function BatchSwitcher({ batches, activeBatchId, onSelect }: {
  batches: ParallelBatch[];
  activeBatchId: string | null;
  onSelect: (id: string) => void;
}) {
  const statusDot = (status: ParallelBatch["status"]) => {
    if (status === "running") return <Loader2 className="w-3 h-3 text-primary animate-spin shrink-0" />;
    if (status === "partial_failed") return <XCircle className="w-3 h-3 text-amber-500 shrink-0" />;
    return <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />;
  };

  return (
    <div className="shrink-0 flex items-stretch gap-1 px-2 py-1.5 border-b border-border overflow-x-auto [&::-webkit-scrollbar]:h-1">
      {batches.map((batch) => {
        const active = batch.batchId === activeBatchId;
        return (
          <button
            key={batch.batchId}
            onClick={() => onSelect(batch.batchId)}
            className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors max-w-[200px] ${
              active
                ? "bg-primary/10 text-primary font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
            }`}
            title={batch.intent}
          >
            {statusDot(batch.status)}
            <span className="truncate">{batch.intent}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 批次详情视图：进度总览 + 文件变更 + Agent 概览条 + 选中 Agent 大视图 */
function BatchDetailView({ batch, onCancel, onDelete, onUndoFile }: {
  batch: ParallelBatch;
  onCancel: () => void;
  onDelete: () => void;
  onUndoFile: (path: string) => void;
}) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selectedAgent = batch.agents[selectedIdx] || batch.agents[0];

  const agentStatusDot = (status: ParallelBatch["agents"][number]["status"]) => {
    switch (status) {
      case "pending": return <Circle className="w-3 h-3 text-muted-foreground/40" />;
      case "running": return <Loader2 className="w-3 h-3 text-primary animate-spin" />;
      case "done": return <CheckCircle2 className="w-3 h-3 text-green-500" />;
      case "failed": return <XCircle className="w-3 h-3 text-destructive" />;
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      {/* 顶部进度概览 + 文件变更 */}
      <div className="shrink-0 px-4 py-3 border-b border-border space-y-3 bg-gradient-to-b from-muted/20 to-transparent">
        <div className="flex items-center justify-end">
          {batch.status === "running" ? (
            <button
              onClick={onCancel}
              className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors"
              title="取消执行"
            >
              <Square className="w-3 h-3 fill-current" />
              取消
            </button>
          ) : confirmDelete ? (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-destructive font-medium">确认删除？</span>
              <button
                onClick={() => { setConfirmDelete(false); onDelete(); }}
                className="px-2 py-0.5 rounded text-[11px] font-medium bg-destructive text-white hover:bg-destructive/90 transition-colors"
              >
                删除
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-2 py-0.5 rounded text-[11px] font-medium border border-border text-foreground hover:bg-muted transition-colors"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
              title="删除记录"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
        <BatchProgressBar batch={batch} />
        <FileChangesPanel batch={batch} onOpenFile={openFileInHost} onUndoFile={onUndoFile} />
      </div>

      {/* Agent 概览条：横向并排，一眼看到所有 Agent + 状态 */}
      <div className="shrink-0 flex items-stretch gap-1.5 px-3 py-2 border-b border-border overflow-x-auto [&::-webkit-scrollbar]:h-1">
        {batch.agents.map((agent, i) => {
          const active = i === selectedIdx;
          return (
            <button
              key={agent.delegateId}
              onClick={() => setSelectedIdx(i)}
              className={`shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-all max-w-[180px] ${
                active
                  ? "border-primary/50 bg-primary/10 text-foreground shadow-sm font-medium"
                  : "border-border bg-transparent text-muted-foreground hover:bg-muted/40 hover:border-border"
              }`}
            >
              {agentStatusDot(agent.status)}
              <span className="font-semibold shrink-0">A{i + 1}</span>
              <span className="truncate">{agent.intent}</span>
            </button>
          );
        })}
      </div>

      {/* 选中 Agent 的完整大视图（面板级滚动） */}
      <div className="flex-1 overflow-y-auto">
        {selectedAgent && (
          <AgentDetail key={selectedAgent.delegateId} agent={selectedAgent} index={selectedIdx} />
        )}
      </div>
    </div>
  );
}

/** 批次列表视图（已由 BatchSwitcher 取代，保留空实现位） */
