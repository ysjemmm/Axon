import { useState, useCallback, useEffect, useRef } from "react";
import { SessionContainer, type SessionTab } from "./components/SessionContainer";
import { SessionSidebar } from "./components/SessionSidebar";
import { SkillStudio } from "./components/SkillStudio";
import { RelayTabView } from "./components/RelayTabView";
import { PowerStudio } from "./components/PowerStudio";
import { McpStudio } from "./components/McpStudio";
import { ProviderStudio } from "./components/ProviderStudio";
import { History, X, Plus, HelpCircle } from "lucide-react";
import { listSessions } from "./lib/apiClient";
import { useWebSocket } from "./hooks/useWebSocket";
import { sessionEventBus } from "./hooks/useSessionEvents";
import { WS_BASE } from "./lib/api";
import { AxonLogo } from "./components/AxonLogo";

/** 生成稳定的 tab key（兼作面板 clientId） */
function genTabKey(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* ignore */ }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** URL 参数路由：不同 view 模式 */
function getViewMode(): "chat" | "skills" | "relay" | "powers" | "mcp" | "providers" {
  // WebviewPanel 模式：通过注入的全局变量传参
  const injected = (window as any).__axonViewParams as string | undefined;
  const searchStr = injected || window.location.search;
  const params = new URLSearchParams(searchStr.startsWith("?") ? searchStr : `?${searchStr}`);
  const view = params.get("view");
  if (view === "skills") return "skills";
  if (view === "relay") return "relay";
  if (view === "powers") return "powers";
  if (view === "mcp") return "mcp";
  if (view === "providers") return "providers";
  return "chat";
}

/** 获取注入参数中的指定 key */
function getViewParam(key: string): string {
  const injected = (window as any).__axonViewParams as string | undefined;
  const searchStr = injected || window.location.search;
  const params = new URLSearchParams(searchStr.startsWith("?") ? searchStr : `?${searchStr}`);
  return params.get(key) || "";
}

function App() {
  const viewMode = getViewMode();

  // Skills 独立视图模式
  if (viewMode === "skills") {
    const workspace = getViewParam("workspace");
    return (
      <div className="h-screen bg-background text-foreground">
        <SkillStudio workspace={workspace} onBack={() => {}} />
      </div>
    );
  }

  // Relay 独立视图模式（编辑器 Tab 内嵌）
  if (viewMode === "relay") {
    const workspace = getViewParam("workspace");
    const relayId = getViewParam("id");
    return (
      <div className="h-screen bg-background text-foreground">
        <RelayTabView workspace={workspace} relayId={relayId} />
      </div>
    );
  }

  // Powers 独立视图模式（编辑器 Tab 内嵌）
  if (viewMode === "powers") {
    const workspace = getViewParam("workspace");
    const powerName = getViewParam("name");
    return (
      <div className="h-screen bg-background text-foreground">
        <PowerStudio workspace={workspace} powerName={powerName} />
      </div>
    );
  }

  // 全局 MCP 配置管理（编辑器 Tab 内嵌，view=mcp）
  if (viewMode === "mcp") {
    const workspace = getViewParam("workspace");
    return (
      <div className="h-screen bg-background text-foreground">
        <McpStudio workspace={workspace} />
      </div>
    );
  }

  // 全局 Provider 配置管理（编辑器 Tab 内嵌，view=providers）
  if (viewMode === "providers") {
    const workspace = getViewParam("workspace");
    return (
      <div className="h-screen bg-background text-foreground">
        <ProviderStudio workspace={workspace} />
      </div>
    );
  }

  // 默认：Chat 模式
  type ChatMode = "agent" | "quest";
  // 顶层模式：Axon（智能体）/ 问答（纯问答）
  const [mode, setMode] = useState<ChatMode>(() => {
    try { const m = localStorage.getItem("axon_mode"); if (m === "quest" || m === "agent") return m; } catch { /* ignore */ }
    return "agent";
  });

  // 打开的 tab 列表（Axon + 问答 并集；从 localStorage 恢复，窗口重载不丢失）
  const [tabs, setTabs] = useState<SessionTab[]>(() => {
    try {
      const saved = localStorage.getItem("axon_tabs");
      if (saved) {
        const parsed = JSON.parse(saved) as SessionTab[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          // 兼容旧数据：缺 key/mode 的 tab 补默认值
          return parsed.map((t) => ({ ...t, key: t.key || genTabKey(), mode: t.mode || "agent" }));
        }
      }
    } catch { /* 解析失败用默认值 */ }
    return [{ id: null, title: "新对话", key: genTabKey(), mode: "agent" }];
  });

  // 每个模式各自的激活 tab key
  const [activeKeys, setActiveKeys] = useState<{ agent: string | null; quest: string | null }>(() => {
    try {
      const saved = localStorage.getItem("axon_activeKeys");
      if (saved) { const p = JSON.parse(saved); if (p && typeof p === "object") return { agent: p.agent ?? null, quest: p.quest ?? null }; }
    } catch { /* ignore */ }
    return { agent: null, quest: null };
  });

  // App 级持有唯一 Agent 连接，所有面板共享；事件统一分发到 sessionEventBus 按 clientId 路由
  const { connected, send } = useWebSocket(WS_BASE, (msg) => {
    const m = msg as { type?: string; clientId?: string };
    // 外部注入的上下文（如终端/编辑器选区）无 clientId：定向到当前激活的面板
    if (m && m.type === "add_context" && !m.clientId) {
      const key = activeKeys[mode];
      if (key) m.clientId = key;
    }
    sessionEventBus.dispatch(msg);
  });

  // 持久化
  useEffect(() => { try { localStorage.setItem("axon_tabs", JSON.stringify(tabs)); } catch { /* 忽略 */ } }, [tabs]);
  useEffect(() => { try { localStorage.setItem("axon_activeKeys", JSON.stringify(activeKeys)); } catch { /* 忽略 */ } }, [activeKeys]);
  useEffect(() => { try { localStorage.setItem("axon_mode", mode); } catch { /* 忽略 */ } }, [mode]);

  const [historyOpen, setHistoryOpen] = useState(false);
  // Tab 右键菜单状态（按 key 定位）
  const [contextMenu, setContextMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  // Tab 重命名状态（按 key）
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  // Tab 列表容器 ref（用于 scrollLeft 操控）
  const tabsContainerRef = useRef<HTMLDivElement>(null);

  // 横向滚轮：必须用 addEventListener + {passive:false} 才能 preventDefault
  useEffect(() => {
    const el = tabsContainerRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (e.deltaY !== 0) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  // 当前模式的 tabs / 激活项
  const modeTabs = tabs.filter((t) => t.mode === mode);
  const activeKey = activeKeys[mode];
  const currentTab = tabs.find((t) => t.key === activeKey) || modeTabs[0] || null;

  // 激活 tab 变化时自动滚入视野（新建 tab 时确保可见）。
  // 注意：必须放在 activeKey 声明【之后】——它是 const，提前在 effect 闭包里引用会触发 TDZ。
  useEffect(() => {
    if (!activeKey || !tabsContainerRef.current) return;
    const el = tabsContainerRef.current.querySelector(`[data-tab-key="${activeKey}"]`) as HTMLElement | null;
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [activeKey]);

  // 确保当前模式至少有一个 tab，且有合法激活项（切到空模式时自动建一个）
  useEffect(() => {
    if (modeTabs.length === 0) {
      const t: SessionTab = { id: null, title: "新对话", key: genTabKey(), mode };
      setTabs((prev) => [...prev, t]);
      setActiveKeys((prev) => ({ ...prev, [mode]: t.key }));
    } else if (!activeKey || !modeTabs.some((t) => t.key === activeKey)) {
      setActiveKeys((prev) => ({ ...prev, [mode]: modeTabs[0].key }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, modeTabs.length, activeKey]);

  // 定时同步 tab 标题（从后端 session 列表拿真实标题）
  useEffect(() => {
    const sync = async () => {
      try {
        const data = await listSessions();
        const sessions = data.sessions || [];
        setTabs((prev) =>
          prev.map((tab) => {
            if (!tab.id) return tab;
            const match = sessions.find((s: { id: string; title: string }) => s.id === tab.id);
            if (match && match.title && match.title !== tab.title) {
              return { ...tab, title: match.title };
            }
            return tab;
          })
        );
      } catch { /* 忽略 */ }
    };
    sync();
    const timer = setInterval(sync, 5000);
    return () => clearInterval(timer);
  }, []);

  /** 设置当前模式的激活 tab */
  const setActive = useCallback((key: string) => {
    setActiveKeys((prev) => ({ ...prev, [mode]: key }));
  }, [mode]);

  /** 从 History 选中一个已有会话（当前模式下） */
  const handleSelectSession = useCallback((id: string) => {
    const existing = tabs.find((t) => t.id === id && t.mode === mode);
    if (existing) {
      setActive(existing.key);
    } else {
      const newTab: SessionTab = { id, title: "加载中...", key: genTabKey(), mode };
      setTabs((prev) => [...prev, newTab]);
      setActive(newTab.key);
    }
    setHistoryOpen(false);
  }, [tabs, mode, setActive]);

  /** 从 History 点新建（当前模式） */
  const handleNewSession = useCallback(() => {
    const newTab: SessionTab = { id: null, title: "新对话", key: genTabKey(), mode };
    setTabs((prev) => [...prev, newTab]);
    setActive(newTab.key);
    setHistoryOpen(false);
  }, [mode, setActive]);

  /** 顶部 + 按钮：新建 tab（当前模式） */
  const handleNewTab = useCallback(() => {
    const newTab: SessionTab = { id: null, title: "新对话", key: genTabKey(), mode };
    setTabs((prev) => [...prev, newTab]);
    setActive(newTab.key);
  }, [mode, setActive]);

  /** 关闭 tab（按 key） */
  const handleCloseTab = useCallback((key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const closing = tabs.find((t) => t.key === key);
    if (!closing) return;
    // 取消其可能仍在运行的会话
    if (closing.id) {
      send({ type: "cancel", sessionId: closing.id, clientId: closing.key });
    }
    const closingMode = closing.mode;
    const remaining = tabs.filter((t) => t.mode === closingMode && t.key !== key);
    setTabs((prev) => prev.filter((t) => t.key !== key));

    if (remaining.length === 0) {
      // 最后一个 tab 被关闭：直接创建新空白会话（不等 effect 从历史里捡旧的）
      const newTab: SessionTab = { id: null, title: "新对话", key: genTabKey(), mode: closingMode };
      setTabs((prev) => [...prev, newTab]);
      setActiveKeys((prev) => ({ ...prev, [closingMode]: newTab.key }));
    } else {
      // 若关闭的是该模式当前激活项，切到相邻的前一个 tab
      setActiveKeys((prev) => {
        if (prev[closingMode] !== key) return prev;
        const closingIdx = tabs.filter((t) => t.mode === closingMode).findIndex((t) => t.key === key);
        // 优先选前一个（左边邻居），没有就选后一个
        const targetIdx = closingIdx > 0 ? closingIdx - 1 : 0;
        return { ...prev, [closingMode]: remaining[Math.min(targetIdx, remaining.length - 1)]?.key ?? remaining[0].key };
      });
    }
  }, [tabs, send]);

  /** 会话从 History 被删除后，关闭对应的 tab（如果打开着） */
  const handleSessionDeleted = useCallback((deletedId: string) => {
    const opened = tabs.find((t) => t.id === deletedId);
    if (!opened) return;
    if (opened.id) send({ type: "cancel", sessionId: opened.id, clientId: opened.key });
    const m = opened.mode;
    setTabs((prev) => prev.filter((t) => t.id !== deletedId));
    setActiveKeys((prev) => {
      if (prev[m] !== opened.key) return prev;
      const rest = tabs.filter((t) => t.mode === m && t.id !== deletedId);
      return { ...prev, [m]: rest.length > 0 ? rest[0].key : null };
    });
  }, [tabs, send]);

  /** ChatPanel 创建了新 session 后回调（按 tab key 定位），更新对应 tab 的 id */
  const handleSessionCreated = useCallback((key: string, id: string) => {
    setTabs((prev) =>
      prev.map((tab) => (tab.key === key ? { ...tab, id } : tab))
    );
  }, []);

  /** 压缩迁移：旧会话已冻结，打开新会话 tab */
  const handleCompactionMigrated = useCallback((newSessionId: string) => {
    const existing = tabs.find((t) => t.id === newSessionId && t.mode === mode);
    if (existing) {
      setActive(existing.key);
    } else {
      const newTab: SessionTab = { id: newSessionId, title: "新对话（继承记忆）", key: genTabKey(), mode };
      setTabs((prev) => [...prev, newTab]);
      setActive(newTab.key);
    }
  }, [tabs, mode, setActive]);

  /** 重命名 tab */
  const handleRenameTab = useCallback((key: string, val: string) => {
    const trimmed = val.trim();
    const tab = tabs.find((t) => t.key === key);
    if (trimmed && tab && trimmed !== tab.title) {
      setTabs((prev) => prev.map((t) => t.key === key ? { ...t, title: trimmed } : t));
      if (tab.id) {
        import("@/lib/apiClient").then(({ renameSession }) => { renameSession(tab.id!, trimmed).catch(() => {}); });
      }
    }
    setRenamingKey(null);
  }, [tabs]);

  return (
    <div className="h-screen bg-background text-foreground flex flex-col">
      {/* 顶层模式栏：Axon / 问答 */}
      <div className="flex items-center gap-1 px-2 border-b border-border shrink-0 h-[34px] bg-[var(--vscode-editorGroupHeader-tabsBackground,transparent)]">
        <button
          onClick={() => setMode("agent")}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
            mode === "agent" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
          }`}
          title="AXON：智能体（读写代码、执行命令）"
        >
          <AxonLogo size={14} />
          Axon
        </button>
        <button
          onClick={() => setMode("quest")}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
            mode === "quest" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
          }`}
          title="问答：不改动工作区"
        >
          <HelpCircle className="w-3.5 h-3.5" />
          问答
        </button>
      </div>

      {/* 会话 Tab 栏（当前模式） */}
      <div className="flex items-center border-b border-border shrink-0 h-[35px] bg-[var(--vscode-editorGroupHeader-tabsBackground,transparent)]">
        <div
          ref={tabsContainerRef}
          className="flex-1 flex items-stretch overflow-x-auto h-full [&::-webkit-scrollbar]:h-0 [-ms-overflow-style:none] [scrollbar-width:none]"
        >
          {modeTabs.map((tab) => (
            <div
              key={tab.key}
              data-tab-key={tab.key}
              onClick={() => setActive(tab.key)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({ key: tab.key, x: e.clientX, y: e.clientY });
              }}
              className={`group relative flex items-center gap-1 px-3 text-xs cursor-pointer select-none shrink-0 ${
                tab.key === activeKey
                  ? "bg-background text-foreground font-medium border-b-2 border-b-[var(--vscode-focusBorder,#007fd4)]"
                  : "bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/30 border-b-2 border-b-transparent"
              }`}
            >
              {renamingKey === tab.key ? (
                <input
                  autoFocus
                  defaultValue={tab.title}
                  className="bg-transparent border-b border-primary text-xs outline-none w-full min-w-[40px]"
                  onBlur={(e) => handleRenameTab(tab.key, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setRenamingKey(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="truncate max-w-[180px]">{tab.title}</span>
              )}
              <span
                onClick={(e) => handleCloseTab(tab.key, e)}
                className="ml-0.5 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-muted/80 transition-opacity shrink-0"
              >
                <X className="w-3 h-3" />
              </span>
            </div>
          ))}
        </div>

        {/* 新建 tab + 右侧工具按钮 */}
        <div className="flex items-center px-1 gap-1 shrink-0 h-full">
          <button
            onClick={handleNewTab}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
            title="新建对话"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setHistoryOpen(!historyOpen)}
            className="p-1 rounded hover:bg-muted transition-colors cursor-pointer"
            title="历史会话"
          >
            <History className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Tab 右键菜单 */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-[99]" onClick={() => setContextMenu(null)} />
          <div
            className="fixed z-[100] bg-popover border border-border rounded-md shadow-lg py-1 min-w-[120px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              className="w-full px-3 py-1.5 text-xs text-left hover:bg-muted transition-colors"
              onClick={() => {
                const k = contextMenu.key;
                setContextMenu(null);
                setRenamingKey(k);
              }}
            >
              重命名
            </button>
            <button
              className="w-full px-3 py-1.5 text-xs text-left hover:bg-muted text-destructive transition-colors"
              onClick={(e) => {
                const k = contextMenu.key;
                setContextMenu(null);
                handleCloseTab(k, e as unknown as React.MouseEvent);
              }}
            >
              关闭
            </button>
          </div>
        </>
      )}

      {/* 主体内容 */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        {/* 历史面板：覆盖在对话区上方（按当前模式过滤） */}
        {historyOpen && (
          <div className="absolute inset-0 z-50 bg-background flex flex-col">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-sm font-medium">历史会话 · {mode === "quest" ? "问答" : "Axon"}</span>
              <button
                onClick={() => setHistoryOpen(false)}
                className="p-1.5 rounded-md hover:bg-muted transition-colors cursor-pointer"
              >
                <X className="w-4 h-4 text-muted-foreground" />
              </button>
            </div>
            <div className="flex-1 overflow-hidden [&>div]:w-full [&>div]:border-r-0">
              <SessionSidebar
                currentSessionId={currentTab?.id ?? null}
                connected={connected}
                filterMode={mode}
                onSelectSession={handleSelectSession}
                onNewSession={handleNewSession}
                onSessionDeleted={handleSessionDeleted}
              />
            </div>
          </div>
        )}

        {/* 对话面板（多会话生命周期由 SessionContainer 管理，Axon/问答 面板并集，互不打断） */}
        <SessionContainer
          tabs={tabs}
          activeKey={activeKey}
          connected={connected}
          send={send}
          onSessionCreated={handleSessionCreated}
          onCompactionMigrated={handleCompactionMigrated}
        />
      </div>
    </div>
  );
}

export default App;
