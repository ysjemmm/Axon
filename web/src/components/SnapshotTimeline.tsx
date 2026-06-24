/**
 * SnapshotTimeline —— 闪电回滚时间线
 *
 * 展示 AI 操作的历史快照，支持一键回滚到任意节点。
 * 通过 postMessage 与后端通信：
 *   → { type: "list_snapshots" }        获取快照列表
 *   → { type: "restore_snapshot", id }  回滚到指定快照
 *   ← { type: "snapshots_listed" }      快照列表返回
 *   ← { type: "snapshot_restored" }     回滚结果
 */

import { useState, useEffect, useCallback } from "react";
import { History, RotateCcw, ChevronDown, ChevronRight, Clock, Loader2 } from "lucide-react";

interface Snapshot {
  id: string;
  createdAt: number;
  label: string;
  files: string[];
}

interface SnapshotTimelineProps {
  /** 发送消息到后端 */
  send: (msg: Record<string, unknown>) => void;
  /** 监听后端事件 */
  onSnapshotEvent?: (handler: (msg: any) => void) => () => void;
}

export function SnapshotTimeline({ send, onSnapshotEvent }: SnapshotTimelineProps) {
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // 请求快照列表
  const refresh = useCallback(() => {
    send({ type: "list_snapshots" });
  }, [send]);

  // 首次展开时请求快照列表
  useEffect(() => {
    if (expanded && !loaded) {
      refresh();
      setLoaded(true);
    }
  }, [expanded, loaded, refresh]);

  // 监听后端事件
  useEffect(() => {
    if (!onSnapshotEvent) return;
    return onSnapshotEvent((msg: any) => {
      if (msg.type === "snapshots_listed") {
        setSnapshots(msg.snapshots || []);
        setLoaded(true);
      }
      if (msg.type === "snapshot_restored") {
        setRestoring(null);
        if (msg.ok) refresh();
      }
    });
  }, [onSnapshotEvent, refresh]);

  const handleRestore = useCallback(
    (id: string) => {
      setRestoring(id);
      send({ type: "restore_snapshot", snapshotId: id });
    },
    [send],
  );

  // 始终显示面板：即使没有快照也让用户看到"闪电回滚"入口

  return (
    <div className="rounded-lg border border-border bg-popover/50 overflow-hidden text-sm">
      {/* 标题栏 */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-accent/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        )}
        <History className="w-4 h-4 text-primary shrink-0" />
        <span className="font-medium">闪电回滚</span>
        {snapshots.length > 0 ? (
          <span className="text-xs text-muted-foreground bg-muted rounded-full px-1.5 py-0.5">
            {snapshots.length}
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground/60">AI 改文件后自动生成</span>
        )}
      </button>

      {/* 时间线 */}
      {expanded && (
        <div className="border-t border-border/50 max-h-80 overflow-y-auto">
          {snapshots.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              暂无快照（AI 修改文件后自动生成）
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {snapshots.map((snap, idx) => (
                <div
                  key={snap.id}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent/50 transition-colors group ${
                    idx === 0 ? "bg-primary/5" : ""
                  }`}
                >
                  {/* 时间线节点 */}
                  <div className="relative flex items-center shrink-0">
                    <div
                      className={`w-2 h-2 rounded-full ${
                        idx === 0 ? "bg-primary ring-2 ring-primary/20" : "bg-muted-foreground/40"
                      }`}
                    />
                    {idx < snapshots.length - 1 && (
                      <div className="absolute top-full left-1/2 -translate-x-1/2 w-px h-[calc(100%+4px)] bg-border" />
                    )}
                  </div>

                  {/* 快照信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{snap.label}</div>
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Clock className="w-2.5 h-2.5" />
                      {formatTime(snap.createdAt)}
                      {snap.files.length > 0 && <span>· {snap.files.length} 文件</span>}
                    </div>
                  </div>

                  {/* 回滚按钮 */}
                  {idx !== 0 && (
                    <button
                      onClick={() => handleRestore(snap.id)}
                      disabled={restoring !== null}
                      className="opacity-0 group-hover:opacity-100 flex items-center gap-1 text-xs text-amber-500 hover:text-amber-600 hover:bg-amber-500/10 rounded px-2 py-1 transition-all disabled:opacity-50"
                    >
                      {restoring === snap.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <RotateCcw className="w-3 h-3" />
                      )}
                      回滚
                    </button>
                  )}
                  {idx === 0 && (
                    <span className="text-[10px] text-primary/70 font-medium px-1">当前</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 格式化时间戳 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}
