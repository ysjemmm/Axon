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

import { displaySessionTitle, editableSessionTitle } from "@/lib/sessionTitle";
import { useState, useRef, useEffect, useCallback } from "react";
import { ChevronDown, Plus, History, X, Check, Loader2, MessagesSquare, CodeXml, Table2, GitFork } from "lucide-react";
import type { SessionTab } from "./SessionContainer";

/**
 * 标题栏里留给当前对话面板的按钮位（目前是「提问目录」）。
 * 对话面板由 SessionContainer 管理、可能同时挂着多个，只有可见的那个通过 portal 往这里渲染，
 * 标题栏不用知道面板内部的状态。
 */
export const SESSION_HEADER_SLOT_ID = "axon-session-header-slot";

/**
 * 顶部栏图标按钮的统一样式：26px 见方，与右侧模式切换器（22px 按钮 + 2px 内边距）同高；
 * 图标统一 15px、线宽 1.75。往 SESSION_HEADER_SLOT_ID 里挂按钮的地方也用它，整行才协调。
 */
export const HEADER_ICON_BUTTON = "inline-flex h-[26px] w-[26px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground";
export const HEADER_ICON = "h-[15px] w-[15px]";
export const HEADER_ICON_STROKE = 1.75;

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
  // 是否显示徽章看「后台有没有会话在跑」：当前会话在跑，正文里已经有流式光标在动了。
  const backgroundRunning = tabs.filter((t) => t.key !== activeKey && runningKeys.has(t.key)).length;
  // 徽章上的数字是「正在运行的会话总数」（含当前这个）：用户数的是一共几个在跑。
  // 只有当前会话在跑时不显示徽章 —— 正文里已经有流式光标，不必重复告知。
  const totalRunning = tabs.filter((t) => runningKeys.has(t.key)).length;

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
      <div className="flex h-10 items-center gap-1 border-b border-border/70 px-2">
        {renaming && current ? (
          <input
            autoFocus
            defaultValue={editableSessionTitle(current.title)}
            className="flex-1 min-w-0 bg-transparent border-b border-primary text-[13px] outline-none px-1"
            onBlur={(e) => {
              // 没改动就不提交：输入框里是去掉省略号的版本，直接提交会把标题改短
              if (e.target.value.trim() !== editableSessionTitle(current.title)) onRename(current.key, e.target.value);
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <button
            onClick={() => setOpen((v) => !v)}
            onDoubleClick={() => { if (current) { setOpen(false); setRenaming(true); } }}
            title={current ? `${displaySessionTitle(current.title)}（点击切换会话，双击重命名）` : "会话"}
            className="flex h-[26px] min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[13px] text-foreground transition-colors hover:bg-foreground/[0.06]"
          >
            <span className="truncate font-medium">{displaySessionTitle(current?.title) || "新对话"}</span>
            {backgroundRunning > 0 && (
              <span
                title={`${totalRunning} 个会话正在运行（其中 ${backgroundRunning} 个在后台）`}
                className="ml-0.5 inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full bg-emerald-500/10 pl-1.5 pr-2 text-[10.5px] font-medium tabular-nums text-emerald-700 ring-1 ring-inset ring-emerald-500/25 dark:text-emerald-400"
              >
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500/60 motion-reduce:hidden" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                </span>
                {totalRunning}
              </span>
            )}
            <ChevronDown strokeWidth={HEADER_ICON_STROKE} className={`h-3.5 w-3.5 shrink-0 text-muted-foreground/80 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        )}

        {/* 新建 / 历史快捷入口（下拉底部也有，这里省掉一次展开） */}
        <button
          onClick={onNewTab}
          className={HEADER_ICON_BUTTON}
          title="新建对话"
          aria-label="新建对话"
        >
          <Plus className={HEADER_ICON} strokeWidth={HEADER_ICON_STROKE} />
        </button>
        <button
          onClick={onOpenHistory}
          className={HEADER_ICON_BUTTON}
          title="历史会话"
          aria-label="历史会话"
        >
          <History className={HEADER_ICON} strokeWidth={HEADER_ICON_STROKE} />
        </button>
        {/* 分叉：从当前会话派生一个新会话，只带走「记忆」而不带对话历史。
            未落盘的空白会话没有可分叉的内容，故不显示。 */}
        {current?.id && (
          <button
            onClick={onForkSession}
            className={HEADER_ICON_BUTTON}
            title="分叉会话（只继承记忆，不复制对话历史）"
            aria-label="分叉会话"
          >
            <GitFork className={HEADER_ICON} strokeWidth={HEADER_ICON_STROKE} />
          </button>
        )}
        <div id={SESSION_HEADER_SLOT_ID} className="flex shrink-0 items-center gap-1 empty:hidden" />

        {/* 操作按钮与模式切换之间一条细分隔线：两组控件性质不同，分开看更整齐 */}
        <span className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden="true" />

        {/* Chat / Code / Cowork 模式切换：IDE 形态下原本挂在辅助侧栏标题栏，那行已隐藏，由这里接管 */}
        {/* 样式见 index.css 的 .axon-mode-switch（配色与原生标题栏那版一致） */}
        <div className="axon-mode-switch shrink-0" data-mode={mode} role="group" aria-label="对话模式">
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
              <Icon className={HEADER_ICON} strokeWidth={HEADER_ICON_STROKE} />
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
                <span className="flex-1 truncate">{displaySessionTitle(t.title)}</span>
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
