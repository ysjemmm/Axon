/**
 * 会话侧边栏 - 列表 + 新建 + 切换 + 删除
 */

import { useState, useEffect } from "react";
import { Plus, MessageSquare, Trash2, PanelLeft, Search } from "lucide-react";
import { listSessions, deleteSession } from "@/lib/apiClient";

interface SessionMeta {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  mode?: "agent" | "quest";
}

interface SessionSidebarProps {
  currentSessionId: string | null;
  connected: boolean;
  /** 仅展示该模式的会话（agent/quest）；缺省展示全部 */
  filterMode?: "agent" | "quest";
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  /** 会话被删除后通知上层（用于同步关闭对应 tab） */
  onSessionDeleted?: (id: string) => void;
}

export function SessionSidebar({ currentSessionId, connected: _connected, filterMode, onSelectSession, onNewSession, onSessionDeleted }: SessionSidebarProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState("");

  // 加载会话列表
  const loadSessions = async () => {
    try {
      const data = await listSessions();
      setSessions(data.sessions || []);
    } catch {
      // 后端未连接
    }
  };

  useEffect(() => {
    loadSessions();
    // 定时刷新（简单方案，以后可改 WS 推送）
    const timer = setInterval(loadSessions, 5000);
    return () => clearInterval(timer);
  }, []);

  // 删除会话
  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteSession(id);
    const remaining = sessions.filter((s) => s.id !== id);
    setSessions(remaining);
    // 通知上层关闭对应 tab
    onSessionDeleted?.(id);
    // 如果删除的是当前正在显示的会话：切到剩余列表的第一个，没有则新建
    if (id === currentSessionId) {
      if (remaining.length > 0) {
        onSelectSession(remaining[0].id);
      } else {
        onNewSession();
      }
    }
  };

  // 格式化时间
  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000) return "刚刚";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  if (collapsed) {
    return (
      <div className="w-12 border-r border-border flex flex-col items-center py-3 gap-2">
        <button onClick={() => setCollapsed(false)} className="p-2 rounded-md hover:bg-muted transition-colors cursor-pointer">
          <PanelLeft className="w-4 h-4 text-muted-foreground" />
        </button>
        <button onClick={onNewSession} className="p-2 rounded-md hover:bg-muted transition-colors cursor-pointer">
          <Plus className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>
    );
  }

  return (
    <div className="w-64 border-r border-border flex flex-col h-full bg-muted/30">
      {/* 搜索框 */}
      <div className="px-2 pt-2 pb-1">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/60" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索会话..."
            className="w-full pl-7 pr-2 py-1.5 text-xs rounded-md border border-border/60 bg-background placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>
      {/* 会话列表 */}
      <div className="flex-1 overflow-y-auto py-1">
        {sessions.length === 0 && (
          <div className="text-xs text-muted-foreground text-center py-8">暂无会话</div>
        )}
        {sessions
          .filter((s) => (filterMode ? (s.mode ?? "agent") === filterMode : true))
          .filter((s) => !search || s.title.toLowerCase().includes(search.toLowerCase()))
          .map((s) => (
          <div
            key={s.id}
            onClick={() => onSelectSession(s.id)}
            className={`group flex items-center gap-2 mx-2 px-2 py-2 rounded-md cursor-pointer transition-colors border ${
              s.id === currentSessionId ? "bg-primary/10 border-primary/30" : "border-transparent hover:bg-muted/50"
            }`}
          >
            <MessageSquare className="w-4 h-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate">{s.title}</div>
              <div className="text-[11px] text-muted-foreground/70">{formatTime(s.updatedAt)}</div>
            </div>
            <button
              onClick={(e) => handleDelete(s.id, e)}
              className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-all cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
