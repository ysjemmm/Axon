/**
 * VirtualMessageList —— 基于 react-virtuoso 的聊天消息虚拟滚动容器
 *
 * 替代原手写虚拟列表，利用 react-virtuoso 的成熟能力解决：
 * - 加载后自动定位底部（initialTopMostItemIndex）
 * - 流式输出自动追底（followOutput）
 * - scrollToIndex 精确跳转
 * - 不定高动态测量无跳动
 */

import { useRef, useCallback, useImperativeHandle, forwardRef, type ReactNode } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

// #region Types

export interface VirtualMessageListHandle {
  /** 滚动到列表底部 */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** 滚动到指定 index 的消息 */
  scrollToIndex: (index: number, behavior?: ScrollBehavior) => void;
  /** 获取当前滚动状态 */
  getScrollState: () => { scrollTop: number; scrollHeight: number; clientHeight: number };
  /** 获取滚动容器 DOM 元素 */
  getScrollContainer: () => HTMLElement | null;
}

interface VirtualMessageListProps {
  messages: readonly { id: string; role?: string }[];
  renderMessage: (msg: { id: string }, index: number) => ReactNode;
  /** 未测量消息的预估高度（px）—— 传给 virtuoso 的 defaultItemHeight */
  estimateHeight?: number;
  /** 视口外额外渲染的条数（映射为 increaseViewportBy） */
  overscan?: number;
  /** 列表底部插槽（reasoning / loading / bottomRef 等） */
  footer?: ReactNode;
  /** 列表顶部插槽（断开连接提示等） */
  header?: ReactNode;
  /** 滚动事件回调 */
  onScroll?: (scrollTop: number) => void;
  /** 可见范围变化回调（顶部可见消息的 index） */
  onTopItemChange?: (topIndex: number) => void;
  /** 是否自动追随新内容滚动到底部（流式输出时启用） */
  followOutput?: boolean;
  /** 初始显示底部（加载历史后定位到最后一条消息） */
  initialBottom?: boolean;
}

/** Header / Footer 插槽的动态内容，经 Virtuoso 的 context 下发（理由见 HeaderSlot 注释）。 */
interface SlotContext {
  header?: ReactNode;
  footer?: ReactNode;
}

/**
 * 模块级、引用恒定的插槽组件。
 *
 * ⚠️ 不要改回 `useCallback(() => <>{footer}</>, [footer])`。
 *
 * `components.Header` / `components.Footer` 传给 React 的是**组件类型**。每次传入新的函数
 * 引用，diff 时就认定类型变了，于是卸载整棵插槽子树、再重新挂载一遍。而 header/footer 是
 * ChatPanel 内联的 JSX，每次 ChatPanel 重渲染都是新引用——「AI 还没开始回复」那段时间
 * status / token_usage / reasoning_delta 事件密集到达，每个 setState 都触发一轮重挂载：
 *   · `animate-fade-in`（0.2s，opacity 0→1）被反复重放 → 这就是肉眼看到的闪烁
 *   · 插槽内 SVG 的 CSS animation 每次从头重启 → 伸缩动画被不断打断
 *
 * 早先这里的注释断言「SVG 改用 CSS animation 后不受 DOM patch 影响，所以 Footer 更新不会
 * 重置动画」——前半句对，结论错：CSS animation 确实不受 patch 影响，但**重挂载**会让它归零，
 * 而依赖变化导致的正是重挂载而非 patch。
 *
 * 把类型钉成模块级常量后，内容变化只让插槽走一次普通 patch，DOM 节点保持原样。
 */
const HeaderSlot = ({ context }: { context?: SlotContext }) => <>{context?.header ?? null}</>;
const FooterSlot = ({ context }: { context?: SlotContext }) => <>{context?.footer ?? null}</>;

/** components 映射也保持恒定引用：两个插槽都是模块级常量，没有任何需要重建的理由。 */
const SLOT_COMPONENTS = { Header: HeaderSlot, Footer: FooterSlot };

// #endregion

// #region Component

export const VirtualMessageList = forwardRef<VirtualMessageListHandle, VirtualMessageListProps>(
  function VirtualMessageList(
    {
      messages,
      renderMessage,
      estimateHeight = 200,
      overscan = 600,
      footer,
      header,
      onScroll,
      onTopItemChange,
      followOutput = false,
      initialBottom = false,
    },
    ref,
  ) {
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const scrollContainerRef = useRef<HTMLElement | null>(null);

    // 暴露命令式 API（兼容现有 ChatPanel 调用方式）
    useImperativeHandle(ref, () => ({
      scrollToBottom(behavior: ScrollBehavior = "instant") {
        const smooth = behavior === "smooth";
        virtuosoRef.current?.scrollToIndex({
          index: "LAST",
          align: "end",
          behavior: smooth ? "smooth" : "auto",
        });
      },
      scrollToIndex(index: number, behavior: ScrollBehavior = "smooth") {
        virtuosoRef.current?.scrollToIndex({
          index,
          align: "start",
          behavior: behavior === "instant" ? "auto" : "smooth",
        });
      },
      getScrollState() {
        const el = scrollContainerRef.current;
        if (!el) return { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
        return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      },
      getScrollContainer() {
        return scrollContainerRef.current;
      },
    }), []);

    // 滚动事件：通知外部
    const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
      if (onScroll) {
        const target = e.target as HTMLElement;
        onScroll(target.scrollTop);
      }
    }, [onScroll]);

    // 可见范围变化：通知外部顶部可见消息的 index（供 sticky 检测）
    const handleRangeChanged = useCallback((range: { startIndex: number; endIndex: number }) => {
      onTopItemChange?.(range.startIndex);
    }, [onTopItemChange]);

    // followOutput 回调：决定是否追底
    const handleFollowOutput = useCallback((_isAtBottom: boolean) => {
      // 外部通过 prop 控制是否追底
      return followOutput ? "smooth" : false;
    }, [followOutput]);

    // 渲染单条消息（带 fade-in 入场动画，避免虚拟列表卸载/重挂载时闪烁）
    const itemContent = useCallback((index: number) => {
      const msg = messages[index];
      if (!msg) return null;
      return (
        <div className="py-1 animate-fade-in" data-msg-id={msg.id} data-msg-role={msg.role}>
          {renderMessage(msg, index)}
        </div>
      );
    }, [messages, renderMessage]);

    // 插槽内容走 context 下发。这个对象每次重建无妨：它只是 prop，变化只让插槽 patch，
    // 而组件类型（HeaderSlot / FooterSlot）恒定，所以不会重挂载。
    const slotContext: SlotContext = { header, footer };

    return (
      <Virtuoso
        ref={virtuosoRef}
        totalCount={messages.length}
        itemContent={itemContent}
        defaultItemHeight={estimateHeight}
        increaseViewportBy={overscan}
        overscan={overscan}
        followOutput={handleFollowOutput}
        initialTopMostItemIndex={initialBottom && messages.length > 0 ? messages.length - 1 : undefined}
        components={SLOT_COMPONENTS}
        context={slotContext}
        scrollerRef={(el) => {
          scrollContainerRef.current = el as HTMLElement;
        }}
        onScroll={handleScroll as any}
        rangeChanged={handleRangeChanged}
        className="flex-1 min-h-0"
        style={{ height: "100%", overflowX: "hidden" }}
      />
    );
  },
);

// #endregion
