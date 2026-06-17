/**
 * Relay 长任务工作流面板
 *
 * 展示一个 Relay 的：阶段进度（brainstorm→design→plan→executing→done）、
 * 三份阶段文档（需求/设计/计划）、可勾选的任务清单。
 * 通过 WS 的 relay_updated 事件实时刷新，也支持 REST 拉取与手动勾选任务。
 */

import { useState, useEffect, useCallback } from "react";
import { X, Check, Circle, Loader2, FileText, ListChecks, Lightbulb, PencilRuler, Trash2, ShieldCheck, ShieldAlert, FlaskConical } from "lucide-react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import {
  listRelays,
  getRelay,
  updateRelayTask,
  type RelaySummary,
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

interface RelayPanelProps {
  open: boolean;
  onClose: () => void;
  workspace: string;
  /** 外部推入的最新 relay（来自 WS relay_updated），用于实时刷新当前选中项 */
  liveRelay?: RelayData | null;
  /** 打开面板时默认聚焦的 relay id（如刚被 AI 创建的） */
  focusRelayId?: string | null;
  /** 请求删除某个 relay（由父组件通过 WS 通知后端：停止关联子 Agent + 落盘 + 删除产物） */
  onRequestDelete?: (id: string) => void;
  /** 后端确认删除的 relay id（来自 WS relay_deleted），用于从列表移除 */
  deletedRelayId?: string | null;
}

export function RelayPanel({ open, onClose, workspace, liveRelay, focusRelayId, onRequestDelete, deletedRelayId }: RelayPanelProps) {
  const [relays, setRelays] = useState<RelaySummary[]>([]);
  const [selected, setSelected] = useState<RelayData | null>(null);
  const [tab, setTab] = useState<"requirements" | "design" | "plan" | "tasks">("requirements");
  const [loading, setLoading] = useState(false);
  // 待确认删除的 relay（非空时弹出 shadcn 确认 Modal）
  const [pendingDelete, setPendingDelete] = useState<RelaySummary | RelayData | null>(null);

  /** 拉取列表 */
  const refreshList = useCallback(async () => {
    if (!workspace) return;
    try {
      const { relays } = await listRelays(workspace);
      setRelays(relays);
      return relays;
    } catch {
      setRelays([]);
    }
  }, [workspace]);

  /** 选中并加载某个 relay 详情 */
  const openRelay = useCallback(async (id: string) => {
    if (!workspace) return;
    setLoading(true);
    try {
      const data = await getRelay(id, workspace);
      setSelected(data);
      // 自动选一个有内容的 tab
      setTab(data.phase === "executing" || data.phase === "done" ? "tasks" : data.phase === "plan" ? "plan" : data.phase === "design" ? "design" : "requirements");
    } catch {
      setSelected(null);
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  // 打开面板时刷新列表，并聚焦指定 relay
  useEffect(() => {
    if (!open) return;
    (async () => {
      const list = await refreshList();
      const targetId = focusRelayId || (list && list.length > 0 ? list[0].id : null);
      if (targetId) openRelay(targetId);
    })();
  }, [open, focusRelayId, refreshList, openRelay]);

  // WS 实时更新：若推送的 relay 正是当前选中项，直接替换；同时刷新列表
  useEffect(() => {
    if (!liveRelay) return;
    setRelays((prev) => {
      const exists = prev.some((r) => r.id === liveRelay.id);
      const summary: RelaySummary = {
        id: liveRelay.id,
        title: liveRelay.title,
        summary: liveRelay.summary,
        phase: liveRelay.phase,
        taskTotal: liveRelay.tasks.length,
        taskDone: liveRelay.tasks.filter((t) => t.status === "completed").length,
        updatedAt: liveRelay.updatedAt,
      };
      return exists ? prev.map((r) => (r.id === liveRelay.id ? summary : r)) : [summary, ...prev];
    });
    setSelected((cur) => (cur && cur.id === liveRelay.id ? liveRelay : cur));
  }, [liveRelay]);

  /** 手动切换任务状态：pending ↔ completed（点击复选框） */
  const toggleTask = async (task: RelayTask) => {
    if (!selected || !workspace) return;
    const next = task.status === "completed" ? "pending" : "completed";
    try {
      const updated = await updateRelayTask(selected.id, task.id, next, workspace);
      setSelected(updated);
      refreshList();
    } catch { /* 忽略，下次刷新会纠正 */ }
  };

  // 后端确认删除：从列表移除，若是当前选中项则清空
  useEffect(() => {
    if (!deletedRelayId) return;
    setRelays((prev) => prev.filter((r) => r.id !== deletedRelayId));
    setSelected((cur) => (cur && cur.id === deletedRelayId ? null : cur));
    setPendingDelete((cur) => (cur && cur.id === deletedRelayId ? null : cur));
  }, [deletedRelayId]);

  /** 确认删除：通知父组件走 WS（停止子 Agent + 落盘 + 删产物），并乐观从列表移除 */
  const confirmDelete = () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    onRequestDelete?.(id);
    // 乐观更新：立即从 UI 移除（后端 relay_deleted 会再确认一次）
    setRelays((prev) => prev.filter((r) => r.id !== id));
    if (selected?.id === id) setSelected(null);
    setPendingDelete(null);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      {/* 面板 */}
      <div className="relative w-[680px] max-w-[92vw] h-full bg-background border-l border-border shadow-2xl flex flex-col">
        {/* 头部 */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <ListChecks className="w-4 h-4 text-primary" />
          <span className="font-medium text-sm">Relay 长任务</span>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground" title="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* 左侧列表 */}
          <div className="w-48 shrink-0 border-r border-border overflow-y-auto">
            {relays.length === 0 && (
              <p className="text-xs text-muted-foreground p-3">暂无 Relay。让 Axon 处理一个大任务时会自动创建。</p>
            )}
            {relays.map((r) => (
              <button
                key={r.id}
                onClick={() => openRelay(r.id)}
                className={`w-full text-left px-3 py-2 border-b border-border/50 hover:bg-muted/50 transition-colors ${selected?.id === r.id ? "bg-muted" : ""}`}
              >
                <div className="text-xs font-medium truncate">{r.title}</div>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="text-[10px] px-1 py-0.5 rounded bg-primary/10 text-primary">{PHASES[phaseIndex(r.phase)]?.label}</span>
                  {r.taskTotal > 0 && (
                    <span className="text-[10px] text-muted-foreground">{r.taskDone}/{r.taskTotal}</span>
                  )}
                </div>
              </button>
            ))}
          </div>

          {/* 右侧详情 */}
          <div className="flex-1 min-w-0 flex flex-col">
            {loading && (
              <div className="flex-1 flex items-center justify-center text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            )}
            {!loading && !selected && (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                选择左侧的一个 Relay 查看详情
              </div>
            )}
            {!loading && selected && (
              <>
                {/* 标题与阶段进度条 */}
                <div className="px-4 pt-3 pb-2 border-b border-border">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm truncate">{selected.title}</div>
                      <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{selected.summary}</div>
                    </div>
                    <button onClick={() => setPendingDelete(selected)} className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive shrink-0" title="删除">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {/* 质量门标识 */}
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded ${selected.quality?.review !== false ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}>
                      <ShieldCheck className="w-3 h-3" />
                      两阶段评审{selected.quality?.review !== false ? "开启" : "关闭"}
                    </span>
                    {selected.quality?.tdd && (
                      <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400">
                        <FlaskConical className="w-3 h-3" />
                        TDD
                      </span>
                    )}
                  </div>
                  <PhaseStepper phase={selected.phase} />
                </div>

                {/* tab 切换 */}
                <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border text-xs">
                  <TabBtn active={tab === "requirements"} onClick={() => setTab("requirements")} icon={<Lightbulb className="w-3 h-3" />} label="需求" dim={!selected.requirements} />
                  <TabBtn active={tab === "design"} onClick={() => setTab("design")} icon={<PencilRuler className="w-3 h-3" />} label="设计" dim={!selected.design} />
                  <TabBtn active={tab === "plan"} onClick={() => setTab("plan")} icon={<FileText className="w-3 h-3" />} label="计划" dim={!selected.plan} />
                  <TabBtn active={tab === "tasks"} onClick={() => setTab("tasks")} icon={<ListChecks className="w-3 h-3" />} label={`任务${selected.tasks.length ? ` (${selected.tasks.filter(t => t.status === "completed").length}/${selected.tasks.length})` : ""}`} dim={selected.tasks.length === 0} />
                </div>

                {/* tab 内容 */}
                <div className="flex-1 min-h-0 overflow-y-auto p-4">
                  {tab === "tasks" ? (
                    <TaskList tasks={selected.tasks} onToggle={toggleTask} />
                  ) : (
                    <DocView content={tab === "requirements" ? selected.requirements : tab === "design" ? selected.design : selected.plan} />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 删除确认 Modal（shadcn Dialog，替代原生 confirm） */}
      <Dialog open={!!pendingDelete} onOpenChange={(o) => { if (!o) setPendingDelete(null); }}>
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>删除 Relay</DialogTitle>
            <DialogDescription>
              确定删除「{pendingDelete?.title}」吗？需求、设计、计划文档与任务进度将一并移除，
              正在运行的关联子 Agent 会被停止。此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">取消</Button>
            </DialogClose>
            <Button variant="destructive" onClick={confirmDelete}>删除</Button>
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
    <div className="flex items-center gap-1 mt-2.5">
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
  // changes_requested
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
        // 用编号里的点号数量推断层级缩进
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
