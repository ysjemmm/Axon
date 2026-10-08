import { useState, useCallback, useEffect } from "react";
import { SessionContainer, type SessionTab } from "./components/SessionContainer";
import { SessionSidebar } from "./components/SessionSidebar";
import { SessionSwitcher } from "./components/SessionSwitcher";
import { CoworkPanel } from "./components/CoworkPanel";
import { SkillStudio } from "./components/SkillStudio";
import { RelayTabView } from "./components/RelayTabView";
import { PowerStudio } from "./components/PowerStudio";
import { McpStudio } from "./components/McpStudio";
import { ProviderStudio } from "./components/ProviderStudio";
import { MarketplaceStudio } from "./components/MarketplaceStudio";
import { X } from "lucide-react";
import { listSessions, renameSession } from "./lib/apiClient";
import { useWebSocket } from "./hooks/useWebSocket";
import { sessionEventBus } from "./hooks/useSessionEvents";
import { WS_BASE } from "./lib/api";
import { STORAGE, CONTROL_CMD, TIMEOUT } from "./lib/constants";

/** 生成稳定的 tab key（兼作面板 clientId） */
function genTabKey(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* ignore */ }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** URL 参数路由：不同 view 模式 */
function getViewMode(): "chat" | "skills" | "relay" | "powers" | "mcp" | "providers" | "marketplace" {
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
  if (view === "marketplace") return "marketplace";
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

  // 全局 Marketplace 源管理（编辑器 Tab 内嵌，view=marketplace）
  if (viewMode === "marketplace") {
    return (
      <div className="h-screen bg-background text-foreground">
        <MarketplaceStudio />
      </div>
    );
  }

  // 默认：Chat 模式
  type ChatMode = "agent" | "quest";
  // 顶层模式：Axon（智能体）/ 问答（纯问答）
  const [mode, setMode] = useState<ChatMode>(() => {
    try { const m = localStorage.getItem(STORAGE.MODE); if (m === "quest" || m === "agent") return m; } catch { /* ignore */ }
    return "agent";
  });

  // 打开的 tab 列表（Axon + 问答 并集；从 localStorage 恢复，窗口重载不丢失）
  const [tabs, setTabs] = useState<SessionTab[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE.TABS);
      if (saved) {
        const parsed = JSON.parse(saved) as unknown;
        if (Array.isArray(parsed)) {
          // 防御性过滤：localStorage 内容可能被外部脚本/旧版本写坏（null、非对象、缺 id 字段等），
          // 不校验就直接 map 会在访问 t.key / t.id 时抛 TypeError，导致窗口重载后整个界面白屏。
          const valid: SessionTab[] = parsed
            .filter((t): t is Partial<SessionTab> => !!t && typeof t === "object")
            // 旧版本的「并行」模式已移除，残留的 tab 直接丢弃
            .filter((t) => (t.mode as string | undefined) !== "parallel")
            // 兼容旧数据：缺 key/mode 的 tab 补默认值；id 缺失或非字符串则视为新会话
            .map((t) => ({
              id: typeof t.id === "string" ? t.id : null,
              title: typeof t.title === "string" ? t.title : "新对话",
              key: t.key || genTabKey(),
              mode: (t.mode === "quest" ? "quest" : "agent") as SessionTab["mode"],
            }));
          if (valid.length > 0) return valid;
        }
      }
    } catch { /* 解析失败用默认值 */ }
    return [{ id: null, title: "新对话", key: genTabKey(), mode: "agent" }];
  });

  // 每个模式各自的激活 tab key
  const [activeKeys, setActiveKeys] = useState<{ agent: string | null; quest: string | null }>(() => {
    try {
      const saved = localStorage.getItem(STORAGE.ACTIVE_KEYS);
      if (saved) { const p = JSON.parse(saved); if (p && typeof p === "object") return { agent: p.agent ?? null, quest: p.quest ?? null }; }
    } catch { /* ignore */ }
    return { agent: null, quest: null };
  });

  /**
   * Cowork 是否接管整个面板。
   *
   * 用独立状态而不是塞进 `mode`：agent/quest 是"同一套界面的两种系统提示 + 工具集"，
   * 共享输入框、会话 tab、模型选择器；Cowork 换掉的是整个交互范式（面向办公文档，
   * 不出现工作区/Provider/工具卡片这些开发者概念）。
   * 做成独立开关，切回来时 Chat/Code 的会话与 tab 原样保留。
   */
  const [coworkOpen, setCoworkOpen] = useState<boolean>(() => {
    // 记住上次停在哪：Cowork 现在有自己的会话历史与隔离，重开面板回到它是对的。
    // 默认 true —— 办公文档是这个产品面的主入口，第一次打开就落在这里。
    try {
      const saved = localStorage.getItem(STORAGE.COWORK_OPEN);
      if (saved === "0") return false;
      if (saved === "1") return true;
    } catch { /* ignore */ }
    return true;
  });

  /**
   * Cowork 面板是否已挂载。
   *
   * 与 coworkOpen 分开：open 控制可见性，mounted 控制生命周期。
   * 一旦打开过就永久保持挂载 —— 切回 Chat 时 Cowork 的任务记录和正在跑的
   * 后台任务都要留着（它的任务状态在组件内，卸载即丢失）。
   *
   * 初值跟着 coworkOpen：默认就停在 Cowork 时必须首屏即挂载，
   * 否则会先渲染一帧 Chat 再被覆盖，表现为启动时闪一下。
   */
  const [coworkMounted, setCoworkMounted] = useState(coworkOpen);
  useEffect(() => {
    if (coworkOpen) setCoworkMounted(true);
  }, [coworkOpen]);

  // App 级持有唯一 Agent 连接，所有面板共享；事件统一分发到 sessionEventBus 按 clientId 路由
  const { connected, send } = useWebSocket(WS_BASE, (msg) => {
    const m = msg as { type?: string; clientId?: string };
    if (m.type === "set_mode") {
      const next = (m as any).mode;
      if (next === "cowork") {
        setCoworkOpen(true);
        return;
      }
      if (next === "agent" || next === "quest") {
        setCoworkOpen(false);
        setMode(next);
        return;
      }
      return;
    }
    // 外部注入的上下文（如终端/编辑器选区）无 clientId：定向到当前激活的面板
    if (m && m.type === CONTROL_CMD.ADD_CONTEXT && !m.clientId) {
      const key = activeKeys[mode];
      if (key) m.clientId = key;
    }
    sessionEventBus.dispatch(msg);
  });

  // 持久化
  useEffect(() => { try { localStorage.setItem(STORAGE.TABS, JSON.stringify(tabs)); } catch { /* 忽略 */ } }, [tabs]);
  useEffect(() => { try { localStorage.setItem(STORAGE.ACTIVE_KEYS, JSON.stringify(activeKeys)); } catch { /* 忽略 */ } }, [activeKeys]);
  useEffect(() => {
    // MODE 只存 agent/quest（Chat/Code 的子模式）；是否停在 Cowork 单独存，
    // 这样从 Cowork 退出时能回到上次用的 Chat/Code 模式。
    try { localStorage.setItem(STORAGE.MODE, mode); } catch { /* 忽略 */ }
    try { localStorage.setItem(STORAGE.COWORK_OPEN, coworkOpen ? "1" : "0"); } catch { /* 忽略 */ }
    // 上报给扩展用于按钮高亮（setContext axon.chatMode）：Cowork 打开时上报 cowork
    (window as any).__axonVSCode?.postMessage({ type: "mode_changed", mode: coworkOpen ? "cowork" : mode });
  }, [mode, coworkOpen]);

  const [historyOpen, setHistoryOpen] = useState(false);
  // 正在流式输出的面板 key 集合（由 SessionContainer 上报）。
  // 收掉横向 tab 条后，"还有会话在后台跑"没有别的地方能看出来，靠它在切换器上显示计数。
  const [runningKeys, setRunningKeys] = useState<ReadonlySet<string>>(() => new Set());

  // 当前模式的 tabs / 激活项
  const modeTabs = tabs.filter((t) => t.mode === mode);
  const activeKey = activeKeys[mode];
  const currentTab = tabs.find((t) => t.key === activeKey) || modeTabs[0] || null;

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

  // 空会话（id 为 null = 一条消息都没发过）一旦不再是任何模式的激活项就丢掉，
  // 否则每点一次「新建」再切走，列表里就多一条永远空着的「新对话」。
  // 运行中的不动：首条消息已发出、session_created 还没回来时 id 仍是 null。
  useEffect(() => {
    const keep = new Set([activeKeys.agent, activeKeys.quest]);
    setTabs((prev) => {
      const next = prev.filter((t) =>
        t.id !== null || keep.has(t.key) || runningKeys.has(t.key)
        // 该模式还没定激活项（启动首帧）时先不动，等上面的 effect 选定后再判断
        || activeKeys[t.mode] === null);
      return next.length === prev.length ? prev : next;
    });
  }, [activeKeys, runningKeys]);

  // 定时同步 tab 标题（从后端 session 列表拿真实标题）
  useEffect(() => {
    const sync = async () => {
      try {
        const data = await listSessions();
        // 防御性过滤：同 SessionSidebar，避免后端返回的坏数据在 .find 里访问 s.id 时抛错
        const sessions = (data.sessions || []).filter(
          (s) => !!s && typeof s === "object" && typeof (s as { id?: unknown }).id === "string",
        );
        setTabs((prev) =>
          prev.map((tab) => {
            if (!tab.id) return tab;
            const match = sessions.find((s) => s.id === tab.id);
            if (match && match.title && match.title !== tab.title) {
              return { ...tab, title: match.title };
            }
            return tab;
          })
        );
      } catch { /* 忽略 */ }
    };
    sync();
    const timer = setInterval(sync, TIMEOUT.SESSION_SYNC);
    return () => clearInterval(timer);
  }, []);

  /**
   * 切换器三档的统一入口。
   *
   * 三档都在【当前面板内】切换：agent/quest 换的是系统提示与工具集（共享输入框、
   * 会话 tab、模型选择器）；cowork 整页接管本面板（换掉整个交互范式）。
   * 切回 agent/quest 时 Chat 侧的会话与 tab 原样保留。
   */
  const handleSwitchMode = useCallback((next: "agent" | "quest" | "cowork") => {
    if (next === "cowork") {
      setCoworkOpen(true);
      return;
    }
    setCoworkOpen(false);
    setMode(next);
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

  /** 新建 tab（当前模式）：已有空会话就直接切过去复用，不再叠一条新的 */
  const openBlankTab = useCallback(() => {
    const blank = tabs.find((t) => t.mode === mode && t.id === null && !runningKeys.has(t.key));
    if (blank) {
      setActive(blank.key);
      return;
    }
    const newTab: SessionTab = { id: null, title: "新对话", key: genTabKey(), mode };
    setTabs((prev) => [...prev, newTab]);
    setActive(newTab.key);
  }, [tabs, mode, runningKeys, setActive]);

  /** 从 History 点新建（当前模式） */
  const handleNewSession = useCallback(() => {
    openBlankTab();
    setHistoryOpen(false);
  }, [openBlankTab]);

  /** 顶部 + 按钮：新建 tab（当前模式） */
  const handleNewTab = openBlankTab;

  /** 关闭 tab（按 key） */
  const handleCloseTab = useCallback((key: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const closing = tabs.find((t) => t.key === key);
    if (!closing) return;
    // 取消其可能仍在运行的会话
    if (closing.id) {
      send({ type: CONTROL_CMD.CANCEL, sessionId: closing.id, clientId: closing.key });
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
    if (opened.id) send({ type: CONTROL_CMD.CANCEL, sessionId: opened.id, clientId: opened.key });
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

  /** 重命名 tab（编辑态的开关由 SessionSwitcher 自己维护，这里只负责落库） */
  const handleRenameTab = useCallback((key: string, val: string) => {
    const trimmed = val.trim();
    const tab = tabs.find((t) => t.key === key);
    if (!trimmed || !tab || trimmed === tab.title) return;
    setTabs((prev) => prev.map((t) => t.key === key ? { ...t, title: trimmed } : t));
    if (tab.id) {
      renameSession(tab.id!, trimmed).catch(() => {});
    }
  }, [tabs]);


  return (
    <div className="relative h-screen bg-background text-foreground flex flex-col">
      {/* 会话切换器（单行标题 + 下拉列表，取代原横向 tab 条）。
          Cowork 打开时整行隐藏：那一屏不该出现会话/模式这些开发者概念，
          退出入口由 CoworkPanel 自己的「退出 Cowork」按钮提供。 */}
      {!coworkOpen && (
        <SessionSwitcher
          tabs={modeTabs}
          activeKey={activeKey}
          runningKeys={runningKeys}
          onSelect={setActive}
          onNewTab={handleNewTab}
          onCloseTab={handleCloseTab}
          onRename={handleRenameTab}
          onOpenHistory={() => setHistoryOpen(true)}
          mode={mode}
          onModeChange={handleSwitchMode}
        />
      )}

      {/* 主体内容 */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        {/* agent/quest 模式面板 */}
        <div className="absolute inset-0">
          {/* 历史面板：覆盖在对话区上方（按当前模式过滤） */}
          {historyOpen && (
            <div className="absolute inset-0 z-50 bg-background flex flex-col">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                <span className="text-sm font-medium">历史会话 · {mode === "quest" ? "Chat" : "Code"}</span>
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
            onRunningKeysChange={setRunningKeys}
          />
        </div>
      </div>

      {/*
        Cowork：覆盖层 + 常驻挂载。

        ⚠️ 两条都不能省，各自对应踩过的一个坑：
        ① 不能写成 `if (coworkOpen) return <CoworkPanel />`——那会把整棵 Chat 子树
           （连同 SessionContainer 里所有 ChatPanel 的会话状态）卸载掉，切回来表现为
           "按钮解锁 + 会话历史加载中"。所以用覆盖层。
        ② 也不能写成 `{coworkOpen && <CoworkPanel />}`——那样切走时 Cowork 自己被卸载，
           任务记录（组件内 state）全丢，正在跑的任务也被打断。所以常驻挂载、只用 CSS 隐藏。

        隐藏态同时关掉 pointer-events：否则这层会盖在 Chat 上吃掉所有点击。
        首次切到 Cowork 前不挂载（coworkMounted），避免为一个多数人用不到的面板
        在启动时白付一次渲染。
      */}
      {coworkMounted && (
        <div
          className="absolute inset-0 z-40 bg-background"
          style={{
            opacity: coworkOpen ? 1 : 0,
            pointerEvents: coworkOpen ? "auto" : "none",
          }}
          aria-hidden={!coworkOpen}
        >
          {/* clientId 用固定值：Cowork 只有一个工作面（不像 Chat 有多 tab），
              固定值让它在覆盖层反复开关之间仍能对上同一条事件流。 */}
          <CoworkPanel
            clientId="cowork-main"
            connected={connected}
            send={send}
            onExit={() => setCoworkOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

export default App;
