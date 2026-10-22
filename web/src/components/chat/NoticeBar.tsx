/**
 * NoticeBar —— 输入框上方的「满宽胶囊状态条」
 *
 * ── 为什么要有它 ──
 * 文件错误、撤销失败、命令风险、上下文超限、排队中、会话已迁移等提示，原先全部平铺在
 * 输入框容器【内部】（见 ChatPanel），每一条都是两三行的卡片。同时出现两三条时，输入框
 * 会被顶得很高、真正的编辑区被挤到下面，用户还没开始打字就先看到一屏提示。
 *
 * ── 现在的呈现 ──
 * 这些「提示类」信息统一收敛成输入框上方（吉祥物行之上）的一条满宽胶囊：
 * · 条本身恒为 34px（h-[34px] + overflow-hidden），**永远不随内容增高**；
 *   标题单行不换行、细节单行省略，全文放进 title 属性与「详情」浮层；
 * · 多条同时出现时只渲染一条汇总（按最高严重度定调色），细节行用「 · 」拼接各条标题；
 * · 「详情」浮层用绝对定位向【上】弹出（absolute bottom-full），不参与布局，
 *   所以展开/收起都不会推动输入框，也不会把编辑区挤走。
 *
 * ── 不在这里的东西 ──
 * 需要用户做决策的提示（MCP/Relay 确认、压缩选择、Credits 预算暂停）仍留在输入框内部，
 * 它们本来就是「挡住输入、等用户回答」的，内容也比一行长，不适用 34px 约束。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, AlertTriangle, Info, Square } from "lucide-react";
import { cn } from "@/lib/utils";

/** 提示语义：错误 / 警告 / 引导（需留意）/ 中性 */
export type NoticeTone = "error" | "warn" | "ask" | "info";

export interface NoticeAction {
  label: string;
  onClick: () => void;
  /** primary = 实心主按钮（默认）；secondary = 描边次按钮 */
  variant?: "primary" | "secondary";
}

export interface NoticeItem {
  /** 稳定 id，仅作 React key */
  id: string;
  tone: NoticeTone;
  /** 标题：单行、不换行、不缩略 */
  title: string;
  /** 细节：单行省略，全文进 title 属性与浮层 */
  detail?: string;
  /** 动作按钮，最多渲染两个 */
  actions?: NoticeAction[];
  /** 关闭回调；不传则不给关闭按钮 */
  onDismiss?: () => void;
  /** 浮层末尾的附加内容（如排队消息逐条列表，含「移除」按钮） */
  overlayExtra?: ReactNode;
  /**
   * 是否给「详情」按钮（默认：有 overlayExtra 才给）。
   * 单条提示的细节本来就单行省略 + title 兜底，只有文案长到需要完整阅读时才需要浮层。
   */
  expandable?: boolean;
}

interface ToneStyle {
  /** 胶囊容器配色 */
  bar: string;
  /** 浮层里图标的前景色（浮层是中性底，不能靠继承） */
  icon: string;
  /** 主按钮（实心） */
  primary: string;
  /** 次按钮（描边） */
  secondary: string;
  Icon: typeof AlertCircle;
}

/**
 * 四类配色沿用仓库现有色系（红 / 琥珀 / 蓝 / 中性），浅色底 + 深字，
 * 深色模式换成低透明度的深底 + 亮字，避免在深色面板上炸出一块白。
 */
const TONE_STYLES: Record<NoticeTone, ToneStyle> = {
  error: {
    bar: "bg-red-50 border-red-200 text-red-700 dark:bg-red-950/30 dark:border-red-900/60 dark:text-red-300",
    icon: "text-red-600 dark:text-red-400",
    primary: "bg-red-600 text-white hover:bg-red-700",
    secondary: "border border-red-300/70 text-red-700 hover:bg-red-100 dark:border-red-800/70 dark:text-red-300 dark:hover:bg-red-900/30",
    Icon: AlertCircle,
  },
  warn: {
    bar: "bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-950/25 dark:border-amber-900/60 dark:text-amber-300",
    icon: "text-amber-600 dark:text-amber-400",
    primary: "bg-amber-600 text-white hover:bg-amber-700",
    secondary: "border border-amber-300/70 text-amber-700 hover:bg-amber-100 dark:border-amber-800/70 dark:text-amber-300 dark:hover:bg-amber-900/30",
    Icon: AlertTriangle,
  },
  ask: {
    bar: "bg-blue-50 border-blue-200 text-blue-700 dark:bg-blue-950/25 dark:border-blue-900/60 dark:text-blue-300",
    icon: "text-blue-600 dark:text-blue-400",
    primary: "bg-blue-600 text-white hover:bg-blue-700",
    secondary: "border border-blue-300/70 text-blue-700 hover:bg-blue-100 dark:border-blue-800/70 dark:text-blue-300 dark:hover:bg-blue-900/30",
    Icon: Info,
  },
  info: {
    bar: "bg-muted/50 border-border text-foreground/70",
    icon: "text-muted-foreground",
    primary: "bg-foreground/85 text-background hover:bg-foreground",
    secondary: "border border-border text-foreground/70 hover:bg-muted",
    Icon: Square,
  },
};

/** 聚合时按最高严重度定调色：error > warn > ask > info */
const TONE_RANK: Record<NoticeTone, number> = { error: 3, warn: 2, ask: 1, info: 0 };

/** 汇总条标题：错误/警告有专名，引导与中性都叫「提示」 */
const TONE_LABEL: Record<NoticeTone, string> = { error: "错误", warn: "警告", ask: "提示", info: "提示" };

/** 条上的动作按钮：字号与胶囊同档，主按钮实心、次按钮描边 */
function ActionButton({ action, style }: { action: NoticeAction; style: ToneStyle }) {
  return (
    <button
      type="button"
      onClick={action.onClick}
      className={cn(
        "text-[11.5px] px-3 py-[3px] rounded-full whitespace-nowrap shrink-0 transition-colors",
        action.variant === "secondary" ? style.secondary : style.primary,
      )}
    >
      {action.label}
    </button>
  );
}

/** 浮层里单条提示的头部（图标 + 标题 + 该条自己的关闭） */
function PopupHead({ item }: { item: NoticeItem }) {
  const style = TONE_STYLES[item.tone];
  const Icon = style.Icon;
  return (
    <div className="flex items-center gap-1.5">
      <Icon className={cn("w-[13px] h-[13px] shrink-0", style.icon)} />
      <span className="font-semibold">{item.title}</span>
      {item.onDismiss && (
        <button
          type="button"
          onClick={item.onDismiss}
          title="关闭这条提示"
          className="ml-auto shrink-0 px-1 text-[13px] leading-none opacity-45 hover:opacity-90 transition-opacity"
        >
          ×
        </button>
      )}
    </div>
  );
}

export function NoticeBar({ items }: { items: NoticeItem[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 点外部 / Esc 关闭浮层。监听挂在 document 上：浮层是绝对定位的，
  // 点击目标通常落在它和状态条之外的任意位置，不需要 portal。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (items.length === 0) return null;

  // 排序：只影响「谁定调色」和浮层里的列出顺序；Array#sort 稳定，同级保持调用方给的顺序
  const sorted = [...items].sort((a, b) => TONE_RANK[b.tone] - TONE_RANK[a.tone]);
  const aggregated = sorted.length > 1;
  const single = aggregated ? null : sorted[0];
  const tone = sorted[0].tone;
  const style = TONE_STYLES[tone];
  const Icon = style.Icon;

  const title = aggregated ? `${sorted.length} 条${TONE_LABEL[tone]}` : single!.title;
  const detail = aggregated ? sorted.map((item) => item.title).join(" · ") : single!.detail;
  // 动作按钮最多两个：聚合时动作放浮层里逐条给，条上只留详情
  const actions = (single?.actions ?? []).slice(0, 2);
  const hasOverlay = aggregated || !!single?.overlayExtra || !!single?.expandable;
  // 悬停给全文：聚合时把各条标题+细节都铺开，单条时就是自己的细节
  const detailTitle = aggregated
    ? sorted.map((item) => (item.detail ? `${item.title}：${item.detail}` : item.title)).join("\n")
    : single?.detail;

  return (
    <div ref={rootRef} className="relative mb-1.5">
      {/* 详情浮层：向上弹出、绝对定位，不参与布局，所以展开时输入框不会被推动。
          z-20 盖过消息列表与改动汇总，left/right 拉满与胶囊同宽。 */}
      {open && hasOverlay && (
        <div className="absolute bottom-full left-0 right-0 z-20 mb-2 rounded-xl border border-border bg-background p-3 text-[11.5px] leading-relaxed text-foreground shadow-lg">
          {aggregated ? (
            <div className="space-y-2">
              {sorted.map((item, index) => (
                <div key={item.id} className={index > 0 ? "border-t border-border/60 pt-2" : ""}>
                  <PopupHead item={item} />
                  {item.detail && <p className="mt-1 break-all whitespace-pre-wrap opacity-80">{item.detail}</p>}
                  {item.overlayExtra}
                  {item.actions && item.actions.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {item.actions.slice(0, 2).map((action) => (
                        <ActionButton key={action.label} action={action} style={TONE_STYLES[item.tone]} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <>
              {single!.detail && <p className="break-all whitespace-pre-wrap opacity-80">{single!.detail}</p>}
              {single!.overlayExtra}
            </>
          )}
        </div>
      )}

      {/* 胶囊本体：h-[34px] 固定高度 + overflow-hidden，任何内容都撑不高它 */}
      <div className={cn("w-full h-[34px] px-4 rounded-full border flex items-center gap-2 overflow-hidden", style.bar)}>
        <Icon className="w-[15px] h-[15px] shrink-0" />
        <span className="text-[12.5px] font-semibold whitespace-nowrap shrink-0">{title}</span>
        {detail ? (
          <span className="flex-1 min-w-0 text-[11.5px] whitespace-nowrap truncate opacity-75" title={detailTitle}>
            {detail}
          </span>
        ) : (
          <span className="flex-1 min-w-0" />
        )}
        {actions.map((action) => (
          <ActionButton key={action.label} action={action} style={style} />
        ))}
        {hasOverlay && (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            title={open ? "收起详情" : "查看详情"}
            className="text-[11.5px] px-2 py-[3px] rounded-full whitespace-nowrap shrink-0 opacity-70 hover:opacity-100 transition-opacity"
          >
            详情
          </button>
        )}
        {single?.onDismiss && (
          <button
            type="button"
            onClick={single.onDismiss}
            title="关闭"
            className="shrink-0 px-1 text-[13px] leading-none opacity-45 hover:opacity-90 transition-opacity"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
