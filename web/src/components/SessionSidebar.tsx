/**
 * 会话侧边栏 - 列表 + 新建 + 切换 + 删除
 */

import { useState, useEffect } from "react";
import { Plus, MessageSquare, Trash2, PanelLeft, Search, Loader2, GitFork, NotebookPen } from "lucide-react";
import { listSessions, deleteSession, openSessionMemoryInEditor } from "@/lib/apiClient";
import { isVSCode } from "@/lib/transport";

interface SessionMeta {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  mode?: "agent" | "quest";
  /** 该会话是否已沉淀记忆（决定记忆按钮的提示文案） */
  hasMemory?: boolean;
}

interface SessionSidebarProps {
  currentSessionId: string | null;
  connected: boolean;
  /** 仅展示该模式的会话（agent/quest）；缺省展示全部 */
  filterMode?: "agent" | "quest";
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  /** 分叉会话（只继承记忆，不复制对话历史） */
  onForkSession?: (id: string) => void;
  /** 会话被删除后通知上层（用于同步关闭对应 tab） */
  onSessionDeleted?: (id: string) => void;
  /** 变化时立即重新拉取会话列表（如分叉完成后），无需等下一次轮询 */
  refreshToken?: number;
}

export function SessionSidebar({ currentSessionId, connected: _connected, filterMode, onSelectSession, onNewSession, onForkSession, onSessionDeleted, refreshToken }: SessionSidebarProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState("");
  /** 正在打开记忆文件的会话 id（防连点 + 按钮转圈） */
  const [openingMemoryId, setOpeningMemoryId] = useState<string | null>(null);
  /** 打开失败时的行内提示（不弹窗：这里只是个次要入口，出错说一句就够） */
  const [openError, setOpenError] = useState("");

  // 加载会话列表
  const loadSessions = async () => {
    try {
      const data = await listSessions();
      // 防御性过滤：后端返回的列表若混入非对象/缺 id 项（如磁盘上损坏的会话文件），
      // 后面 s.id / s.title 的直接访问会抛 TypeError，把整个侧边栏（乃至上层）渲染打崩。
      const list = (data.sessions || []).filter(
        (s): s is SessionMeta => !!s && typeof s === "object" && typeof s.id === "string",
      );
      setSessions(list);
    } catch {
      // 后端未连接
    }
    setLoading(false);
  };

  useEffect(() => {
    loadSessions();
    // 定时刷新（简单方案，以后可改 WS 推送）
    const timer = setInterval(loadSessions, 5000);
    return () => clearInterval(timer);
    // refreshToken 变化（如分叉完成）时立刻重拉一次，并重置轮询计时
  }, [refreshToken]);

  // 出错提示只是顺手一句，留太久会像常驻状态，4 秒后自己消失
  useEffect(() => {
    if (!openError) return;
    const timer = setTimeout(() => setOpenError(""), 4000);
    return () => clearTimeout(timer);
  }, [openError]);

  // 分叉会话：从该会话派生一个新会话，只继承记忆（不复制对话历史）
  const handleFork = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onForkSession?.(id);
  };

  /**
   * 在编辑器中打开这条会话的记忆文件。
   *
   * 记忆没有独立文件，它就在会话档 ~/.axon/sessions/<id>.json 的 memory 字段里；
   * 真实路径与字段定位都由宿主完成，这里只管发起请求。
   */
  const handleOpenMemory = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (openingMemoryId) return;
    setOpeningMemoryId(id);
    setOpenError("");
    try {
      await openSessionMemoryInEditor(id);
    } catch (err) {
      setOpenError((err as Error).message || "打开记忆文件失败");
    } finally {
      setOpeningMemoryId(null);
    }
  };

  // 删除会话
  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (deletingId) return; // 正在删除中，防重复点击
    setDeletingId(id);
    try {
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
    } finally {
      setDeletingId(null);
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
      {openError && (
        <div className="mx-2 mb-1 px-2 py-1 rounded text-[11px] text-destructive bg-destructive/10 leading-snug break-all">
          {openError}
        </div>
      )}
      {/* 会话列表 */}
      <div className="flex-1 overflow-y-auto py-1">
        {loading ? (
          <div className="text-xs text-muted-foreground text-center py-8">加载中...</div>
        ) : sessions.length === 0 ? (
          <div className="text-xs text-muted-foreground text-center py-8">暂无会话</div>
        ) : (
          sessions
            .filter((s) => (filterMode ? (s.mode ?? "agent") === filterMode : true))
            .filter((s) => !search || s.title.toLowerCase().includes(search.toLowerCase()))
            .map((s) => (
          <div
            key={s.id}
            onClick={() => onSelectSession(s.id)}
            className={`group flex items-center gap-2 mx-2 px-2 py-2 rounded-md cursor-pointer transition-colors border ${
              s.id === currentSessionId
                ? "bg-primary/10 border-primary/30"
                : // hover 用前景色 7% 而不是 muted：muted 在多数主题里与列表底色几乎同色（早期用 muted/50 更是看不出来），
                  // 按前景色取一点灰/白，深浅主题下都有稳定对比，也不会和选中态的 primary 色相撞。
                  "border-transparent hover:bg-foreground/[0.07]"
            }`}
          >
            <MessageSquare className="w-4 h-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate">{s.title}</div>
              <div className="text-[11px] text-muted-foreground/70">{formatTime(s.updatedAt)}</div>
            </div>
            {/* 记忆文件入口：只在 IDE 形态下有意义（浏览器形态没有"用编辑器打开"这回事） */}
            {isVSCode && (
              <button
                onClick={(e) => handleOpenMemory(s.id, e)}
                disabled={openingMemoryId !== null}
                className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-primary/10 hover:text-primary transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                title={s.hasMemory ? "在编辑器中打开这条会话的记忆文件" : "这条会话还没有记忆，打开它的会话文件查看"}
                aria-label="打开记忆文件"
              >
                {openingMemoryId === s.id ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <NotebookPen className="w-3.5 h-3.5" />
                )}
              </button>
            )}
            <button
              onClick={(e) => handleFork(s.id, e)}
              className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-primary/10 hover:text-primary transition-all cursor-pointer"
              title="分叉会话（只继承记忆，不复制对话历史）"
              aria-label="分叉会话"
            >
              <GitFork className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={(e) => handleDelete(s.id, e)}
              disabled={deletingId !== null}
              className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 hover:text-destructive transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {deletingId === s.id ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        )))}
      </div>
    </div>
  );
}
