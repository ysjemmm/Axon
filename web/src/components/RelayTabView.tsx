/**
 * RelayTabView —— 编辑器 Tab 内嵌的 Relay 详情视图
 *
 * 与 RelayPanel（浮层面板）共享子组件，但自己加载数据、无遮罩、铺满整个 Tab。
 * 通过 panelManager 打开时传入 relayId + workspace 参数。
 */

import { useState, useEffect, useCallback } from "react";
import { Check, Circle, Loader2, FileText, ListChecks, Lightbulb, PencilRuler, ShieldCheck, ShieldAlert, FlaskConical, Trash2 } from "lucide-react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import {
  getRelay,
  updateRelayTask,
  deleteRelay,
  type RelayData,
  type RelayPhase,
  type RelayTask,
  type TaskReview,
} from "@/lib/apiClient";

/** 阶段的中文标签与顺序 */
const PHASES: { key: RelayPhase; label: string }[] = [
  { key: "brainstorm", label: "需求" },
  { key: "design", label: "设计" },
  { key: "plan", label: "计划" },
  { key: "executing", label: "执行" },
  { key: "done", label: "完成" },
];

function phaseIndex(p: RelayPhase): number {
  return PHASES.findIndex((x) => x.key === p);
}

interface RelayTabViewProps {
  workspace: string;
  relayId: string;
}

export function RelayTabView({ workspace, relayId }: RelayTabViewProps) {
  const [relay, setRelay] = useState<RelayData | null>(null);
  const [tab, setTab] = useState<"requirements" | "design" | "plan" | "tasks">("requirements");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleted, setDeleted] = useState(false);

  /** 加载 relay 详情 */
  const loadRelay = useCallback(async () => {
    if (!relayId || !workspace) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getRelay(relayId, workspace);
      setRelay(data);
      // 自动选一个有内容的 tab
      setTab(
        data.phase === "executing" || data.phase === "done" ? "tasks"
        : data.phase === "plan" ? "plan"
        : data.phase === "design" ? "design"
        : "requirements"
      );
    } catch (e) {
      setError(`加载失败：${(e as Error).message || "未知错误"}`);
      setRelay(null);
    } finally {
      setLoading(false);
    }
  }, [relayId, workspace]);

  useEffect(() => { loadRelay(); }, [loadRelay]);

  /** 手动切换任务状态 */
  const toggleTask = async (task: RelayTask) => {
    if (!relay || !workspace) return;
    const next = task.status === "completed" ? "pending" : "completed";
    try {
      const updated = await updateRelayTask(relay.id, task.id, next, workspace);
      setRelay(updated);
    } catch { /* 忽略 */ }
  };

  /** 删除当前 relay */
  const handleDelete = async () => {
    if (!relay || !workspace) return;
    try {
      // 通过 ControlCommand 走 session 层删除（会取消正在执行的子 Agent）
      const vs = (window as any).__axonVSCode;
      if (vs) {
        vs.postMessage({ type: "delete_relay", relayId: relay.id, workspace });
      } else {
        // Web 形态 fallback：直接 REST 删除
        await deleteRelay(relay.id, workspace);
      }
      setDeleted(true);
      setConfirmDelete(false);
    } catch { /* 忽略 */ }
  };

  if (deleted) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        已删除。可关闭此标签页。
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        加载中...
      </div>
    );
  }

  if (error || !relay) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        {error || "未找到该 Relay"}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* 标题与阶段进度条 */}
      <div className="px-5 pt-4 pb-3 border-b border-border">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-base">{relay.title}</div>
            {relay.summary && (
              <div className="text-xs text-muted-foreground mt-1">{relay.summary}</div>
            )}
          </div>
          <button onClick={() => setConfirmDelete(true)} className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive shrink-0" title="删除">
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
        {/* 质量门标识 */}
        <div className="flex items-center gap-2 mt-2">
          <span className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded ${relay.quality?.review !== false ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}>
            <ShieldCheck className="w-3 h-3" />
            评审{relay.quality?.review !== false ? "开启" : "关闭"}
          </span>
          {relay.quality?.tdd && (
            <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400">
              <FlaskConical className="w-3 h-3" />
              TDD
            </span>
          )}
        </div>
        <PhaseStepper phase={relay.phase} />
      </div>

      {/* Tab 切换 */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-border text-xs">
        <TabBtn active={tab === "requirements"} onClick={() => setTab("requirements")} icon={<Lightbulb className="w-3 h-3" />} label="需求" dim={!relay.requirements} />
        <TabBtn active={tab === "design"} onClick={() => setTab("design")} icon={<PencilRuler className="w-3 h-3" />} label="设计" dim={!relay.design} />
        <TabBtn active={tab === "plan"} onClick={() => setTab("plan")} icon={<FileText className="w-3 h-3" />} label="计划" dim={!relay.plan} />
        <TabBtn active={tab === "tasks"} onClick={() => setTab("tasks")} icon={<ListChecks className="w-3 h-3" />} label={`任务${relay.tasks.length ? ` (${relay.tasks.filter(t => t.status === "completed").length}/${relay.tasks.length})` : ""}`} dim={relay.tasks.length === 0} />
      </div>

      {/* Tab 内容 */}
      <div className="flex-1 min-h-0 overflow-y-auto p-5">
        {tab === "tasks" ? (
          <TaskList tasks={relay.tasks} onToggle={toggleTask} />
        ) : (
          <DocView content={tab === "requirements" ? relay.requirements : tab === "design" ? relay.design : relay.plan} />
        )}
      </div>

      {/* 删除确认对话框 */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>删除 Relay</DialogTitle>
            <DialogDescription>
              确定删除「{relay.title}」吗？需求、设计、计划文档与任务进度将一并移除。此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">取消</Button>
            </DialogClose>
            <Button variant="destructive" onClick={handleDelete}>删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 阶段进度条 */
function PhaseStepper({ phase }: { phase: RelayPhase }) {
  const cur = phaseIndex(phase);
  return (
    <div className="flex items-center gap-1 mt-3">
      {PHASES.map((p, i) => {
        const done = i < cur;
        const active = i === cur;
        return (
          <div key={p.key} className="flex items-center gap-1 flex-1">
            <div className={`flex items-center gap-1 ${active ? "text-primary" : done ? "text-foreground/70" : "text-muted-foreground/50"}`}>
              {done ? <Check className="w-3 h-3" /> : active ? <Circle className="w-3 h-3 fill-primary/20" /> : <Circle className="w-3 h-3" />}
              <span className="text-[11px]">{p.label}</span>
            </div>
            {i < PHASES.length - 1 && <div className={`h-px flex-1 ${i < cur ? "bg-foreground/30" : "bg-border"}`} />}
          </div>
        );
      })}
    </div>
  );
}

function TabBtn({ active, onClick, icon, label, dim }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; dim?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1 px-2 py-1 rounded transition-colors ${active ? "bg-primary/10 text-primary" : dim ? "text-muted-foreground/50 hover:text-muted-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"}`}
    >
      {icon}
      {label}
    </button>
  );
}

function DocView({ content }: { content: string }) {
  if (!content.trim()) {
    return <div className="text-sm text-muted-foreground text-center py-12">该阶段文档尚未生成</div>;
  }
  return <MarkdownRenderer content={content} />;
}

/** 任务评审状态徽标 */
function ReviewBadge({ status, review }: { status?: RelayTask["reviewStatus"]; review?: TaskReview }) {
  if (!status || status === "none") return null;
  if (status === "reviewing") {
    return (
      <span className="inline-flex items-center gap-0.5 ml-1.5 text-[10px] px-1 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 align-middle">
        <Loader2 className="w-2.5 h-2.5 animate-spin" /> 评审中
      </span>
    );
  }
  if (status === "passed") {
    return (
      <span className="inline-flex items-center gap-0.5 ml-1.5 text-[10px] px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 align-middle">
        <ShieldCheck className="w-2.5 h-2.5" /> 评审通过
      </span>
    );
  }
  const critical = review?.spec?.issues.concat(review?.quality?.issues || []).filter((i) => i.severity === "critical").length || 0;
  return (
    <span className="inline-flex items-center gap-0.5 ml-1.5 text-[10px] px-1 py-0.5 rounded bg-destructive/10 text-destructive align-middle">
      <ShieldAlert className="w-2.5 h-2.5" /> 打回{critical > 0 ? ` (${critical} 严重)` : ""}
    </span>
  );
}

/** 评审未通过时展开问题列表 */
function ReviewIssues({ review }: { review: TaskReview }) {
  const all = [
    ...(review.spec?.issues.map((i) => ({ ...i, stage: "规格" })) || []),
    ...(review.quality?.issues.map((i) => ({ ...i, stage: "质量" })) || []),
  ];
  if (all.length === 0) return null;
  const color = (s: string) => s === "critical" ? "text-destructive" : s === "major" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground";
  return (
    <div className="mt-1 pl-2 border-l-2 border-destructive/30 space-y-0.5">
      {all.map((i, idx) => (
        <div key={idx} className="text-[11px]">
          <span className={`font-medium ${color(i.severity)}`}>[{i.stage}·{i.severity}]</span>{" "}
          <span className="text-muted-foreground">{i.description}</span>
        </div>
      ))}
    </div>
  );
}

/** 任务清单 */
function TaskList({ tasks, onToggle }: { tasks: RelayTask[]; onToggle: (t: RelayTask) => void }) {
  if (tasks.length === 0) {
    return <div className="text-sm text-muted-foreground text-center py-12">任务清单尚未生成（计划阶段产出）</div>;
  }
  return (
    <div className="space-y-1">
      {tasks.map((t) => {
        const depth = (t.id.match(/\./g) || []).length;
        return (
          <div key={t.id} className="flex items-start gap-2 py-1" style={{ paddingLeft: depth * 16 }}>
            <button onClick={() => onToggle(t)} className="mt-0.5 shrink-0" title="切换完成状态">
              {t.status === "completed" ? (
                <div className="w-4 h-4 rounded border border-primary bg-primary flex items-center justify-center">
                  <Check className="w-3 h-3 text-primary-foreground" />
                </div>
              ) : t.status === "in_progress" ? (
                <div className="w-4 h-4 rounded border border-amber-500 flex items-center justify-center">
                  <Loader2 className="w-2.5 h-2.5 text-amber-500 animate-spin" />
                </div>
              ) : (
                <div className="w-4 h-4 rounded border border-muted-foreground/40" />
              )}
            </button>
            <div className="min-w-0 flex-1">
              <div className={`text-sm ${t.status === "completed" ? "line-through text-muted-foreground" : ""}`}>
                <span className="text-muted-foreground mr-1.5 font-mono text-xs">{t.id}</span>
                {t.title}
                <ReviewBadge status={t.reviewStatus} review={t.review} />
              </div>
              {t.details && <div className="text-xs text-muted-foreground mt-0.5 whitespace-pre-wrap">{t.details}</div>}
              {t.review && !t.review.passed && <ReviewIssues review={t.review} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
