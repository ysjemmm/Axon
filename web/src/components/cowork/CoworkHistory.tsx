/**
 * CoworkHistory —— Cowork 的历史任务列表
 *
 * 为什么不直接复用 SessionSidebar：那个组件是给开发者看的（显示模型名、
 * 消息条数、折叠开关），Cowork 这一屏刻意不出现这些概念。但数据源是同一个
 * `/api/sessions`，靠 mode=cowork 过滤出办公会话 —— 后端为此新增了这个模式，
 * 它的运行时行为仍等同 agent，只是落盘时打了标记。
 */

import { displaySessionTitle } from "@/lib/sessionTitle";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Repeat2, Trash2, X } from "lucide-react";
import { deleteSession, listSessions, type SessionMeta } from "@/lib/apiClient";
import { relativeTime } from "./relativeTime";
import type { CoworkFlow } from "./flowTypes";

interface CoworkHistoryProps {
  open: boolean;
  /** 当前打开的会话 id，用于高亮 */
  currentSessionId: string | null;
  /** 会话 → 来源流程（流程记着自己的运行记录） */
  flowOfSession?: Map<string, CoworkFlow>;
  onClose: () => void;
  onSelect: (sessionId: string) => void;
}

export function CoworkHistory({ open, currentSessionId, flowOfSession, onClose, onSelect }: CoworkHistoryProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await listSessions();
      const list = (data.sessions || []).filter(
        // 同时做两道过滤：① 防御损坏数据（后端可能返回缺 id 的项）② 只要 cowork
        (s): s is SessionMeta => !!s && typeof s === "object" && typeof s.id === "string" && s.mode === "cowork",
      );
      setSessions(list);
    } catch {
      // 后端不可用：保持空列表，不弹错误打断用户
    }
    setLoading(false);
  }, []);

  // 只在打开时拉取，关着不轮询——这个面板不是常驻视图，没必要一直占着请求
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void load();
  }, [open, load]);

  const handleDelete = useCallback(async (id: string) => {
    setDeletingId(id);
    try {
      await deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch {
      // 删除失败就保持原样，下次打开会重新拉取
    }
    setDeletingId(null);
  }, []);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-50 flex flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
        <span className="text-[13px] font-medium text-foreground">历史任务</span>
        <button
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          aria-label="关闭历史任务"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在加载
          </div>
        )}

        {!loading && sessions.length === 0 && (
          <p className="py-10 text-center text-[13px] text-muted-foreground">
            还没有历史任务
          </p>
        )}

        {!loading && sessions.map((session) => (
          <div
            key={session.id}
            className={`group mb-1.5 flex items-center gap-2 rounded-lg border px-3 py-2.5 transition-colors ${
              session.id === currentSessionId
                ? "border-primary/40 bg-primary/5"
                : "border-border hover:bg-muted/40"
            }`}
          >
            <button
              onClick={() => { onSelect(session.id); onClose(); }}
              className="min-w-0 flex-1 text-left"
            >
              <span className="block truncate text-[13px] text-foreground">{displaySessionTitle(session.title) || "未命名任务"}</span>
              <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {flowOfSession?.get(session.id) && (
                  <span className="inline-flex items-center gap-0.5 text-primary"><Repeat2 className="h-3 w-3" />{flowOfSession.get(session.id)!.name}</span>
                )}
                {relativeTime(session.updatedAt)}
              </span>
            </button>
            <button
              onClick={() => handleDelete(session.id)}
              disabled={deletingId === session.id}
              className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-destructive group-hover:opacity-100 disabled:opacity-40"
              aria-label={`删除 ${session.title || "未命名任务"}`}
            >
              {deletingId === session.id
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Trash2 className="h-3.5 w-3.5" />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
