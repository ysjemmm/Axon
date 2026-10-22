/**
 * SessionSwitcher —— 顶部会话切换器（替代原先的横向 tab 条）
 *
 * 为什么不是 tab 条：本面板挂在 secondarySidebar，宽度常见 300~500px，一排 tab 最多塞得下
 * 2~3 个，第 4 个起就要横向滚动去找——"一眼看全部"本来就没做到，却常驻占掉 35px 高度、
 * 把顶部搞得很挤。这里改成单行「当前会话名 + ▾」，列表收进下拉浮层。
 *
 * 保留的能力（原 tab 条有的都不能丢）：
 * - 多会话后台运行：面板挂载与保活仍由 SessionContainer 负责，这里只是它的一个视图。
 * - 切换 / 新建 / 关闭 / 重命名：分别走下拉项、+ 按钮、下拉项内的 ×、双击标题。
 * - 后台运行可见性：tab 条原本用"多个 tab 并排"隐含表达"还有会话在跑"，收成单行后这个
 *   信息会丢，所以标题右侧补一个运行中计数圆点，否则多会话并行变成黑箱。
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { ChevronDown, Plus, History, X, Check, Loader2, MessagesSquare, CodeXml, Table2, GitFork } from "lucide-react";
import type { SessionTab } from "./SessionContainer";

/**
 * 切换器上的三个档位。
 * agent/quest 是同一套界面的两种系统提示与工具集；cowork 会整页接管（面向办公文档），
 * 由上层 App 决定渲染哪一侧，这里只负责发出切换意图。
 */
type SwitchMode = "agent" | "quest" | "cowork";

interface SessionSwitcherProps {
  /** 当前模式下的会话（已由上层按 mode 过滤） */
  tabs: SessionTab[];
  activeKey: string | null;
  /** 正在流式输出的 tab key 集合，用于运行中指示 */
  runningKeys: ReadonlySet<string>;
  onSelect: (key: string) => void;
  onNewTab: () => void;
  /** 从当前会话分叉出一个新会话（只继承记忆，不复制对话历史） */
  onForkSession: () => void;
  onCloseTab: (key: string, e: React.MouseEvent) => void;
  onRename: (key: string, title: string) => void;
  /** 打开完整历史会话面板 */
  onOpenHistory: () => void;
  /** 当前模式：agent=Code，quest=Chat */
  mode: SwitchMode;
  onModeChange: (mode: SwitchMode) => void;
}

export function SessionSwitcher({
  tabs,
  activeKey,
  runningKeys,
  onSelect,
  onNewTab,
  onForkSession,
  onCloseTab,
  onRename,
  onOpenHistory,
  mode,
  onModeChange,
}: SessionSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = tabs.find((t) => t.key === activeKey) || tabs[0] || null;
  // 运行中计数只算"当前不可见的那些"：当前会话在跑，正文里已经有流式光标在动了，
  // 再在标题上计一次数属于重复告知。
  const backgroundRunning = tabs.filter((t) => t.key !== activeKey && runningKeys.has(t.key)).length;

  // 点击外部 / Escape 关闭下拉
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = useCallback((key: string) => {
    onSelect(key);
    setOpen(false);
  }, [onSelect]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <div className="flex items-center gap-1 h-9 px-2 border-b border-border">
        {renaming && current ? (
          <input
            autoFocus
            defaultValue={current.title}
            className="flex-1 min-w-0 bg-transparent border-b border-primary text-[13px] outline-none px-1"
            onBlur={(e) => { onRename(current.key, e.target.value); setRenaming(false); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <button
            onClick={() => setOpen((v) => !v)}
            onDoubleClick={() => { if (current) { setOpen(false); setRenaming(true); } }}
            title={current ? `${current.title}（点击切换会话，双击重命名）` : "会话"}
            className="flex-1 min-w-0 flex items-center gap-1 px-1.5 py-1 rounded text-[13px] text-foreground hover:bg-muted/50 transition-colors cursor-pointer"
          >
            <span className="truncate font-medium">{current?.title || "新对话"}</span>
            {backgroundRunning > 0 && (
              <span
                title={`另有 ${backgroundRunning} 个会话正在运行`}
                className="shrink-0 inline-flex items-center gap-0.5 px-1 rounded-full bg-primary/15 text-primary text-[10px] leading-4"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                {backgroundRunning}
              </span>
            )}
            <ChevronDown className={`w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        )}

        {/* 新建 / 历史快捷入口（下拉底部也有，这里省掉一次展开） */}
        <button
          onClick={onNewTab}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer shrink-0"
          title="新建对话"
          aria-label="新建对话"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onOpenHistory}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer shrink-0"
          title="历史会话"
          aria-label="历史会话"
        >
          <History className="w-3.5 h-3.5" />
        </button>
        {/* 分叉：从当前会话派生一个新会话，只带走「记忆」而不带对话历史。
            未落盘的空白会话没有可分叉的内容，故不显示。 */}
        {current?.id && (
          <button
            onClick={onForkSession}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors cursor-pointer shrink-0"
            title="分叉会话（只继承记忆，不复制对话历史）"
            aria-label="分叉会话"
          >
            <GitFork className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Chat / Code / Cowork 模式切换：IDE 形态下原本挂在辅助侧栏标题栏，那行已隐藏，由这里接管 */}
        {/* 样式见 index.css 的 .axon-mode-switch（配色与原生标题栏那版一致） */}
        <div className="axon-mode-switch shrink-0 ml-1" data-mode={mode} role="group" aria-label="对话模式">
          <span className="axon-mode-switch__indicator" aria-hidden="true" />
          {([
            { value: "quest", label: "Chat：仅聊天", Icon: MessagesSquare },
            { value: "agent", label: "Code：智能体", Icon: CodeXml },
            { value: "cowork", label: "Cowork：文档处理", Icon: Table2 },
          ] as const).map(({ value, label, Icon }) => (
            <button
              key={value}
              onClick={() => onModeChange(value)}
              title={label}
              aria-label={label}
              aria-pressed={mode === value}
              className="axon-mode-switch__btn"
            >
              <Icon className="w-4 h-4" />
            </button>
          ))}
        </div>

      </div>

      {open && (
        <div className="absolute left-1 right-1 top-full mt-1 z-[60] rounded-md border border-border bg-popover shadow-lg py-1 max-h-[320px] overflow-y-auto">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
            打开的对话
          </div>
          {tabs.map((t) => {
            const isActive = t.key === activeKey;
            const isRunning = runningKeys.has(t.key);
            return (
              <div
                key={t.key}
                onClick={() => pick(t.key)}
                className={`group flex items-center gap-1.5 mx-1 px-1.5 py-1.5 rounded cursor-pointer text-xs transition-colors ${
                  isActive ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <span className="w-3.5 shrink-0 flex items-center justify-center">
                  {isRunning ? (
                    <Loader2 className="w-3 h-3 animate-spin text-primary" />
                  ) : isActive ? (
                    <Check className="w-3 h-3 text-primary" />
                  ) : null}
                </span>
                <span className="flex-1 truncate">{t.title}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); onCloseTab(t.key, e); }}
                  title="关闭对话"
                  className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-destructive transition-all"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
          <div className="mt-1 pt-1 border-t border-border/60">
            <button
              onClick={() => { setOpen(false); onNewTab(); }}
              className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
            >
              <Plus className="w-3 h-3" />新建对话
            </button>
            <button
              onClick={() => { setOpen(false); onOpenHistory(); }}
              className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
            >
              <History className="w-3 h-3" />浏览全部历史会话
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
