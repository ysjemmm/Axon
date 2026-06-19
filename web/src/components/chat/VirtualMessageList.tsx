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

// #endregion

// #region Component

export const VirtualMessageList = forwardRef<VirtualMessageListHandle, VirtualMessageListProps>(
  function VirtualMessageList(
    {
      messages,
      renderMessage,
      estimateHeight = 200,
      overscan = 300,
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
        // scrollToIndex 只滚到最后一条消息，footer（思考中/loading）在消息列表之外，
        // 需要额外把容器滚到真正底部，把 footer 也带进视口。
        const scrollContainerToBottom = () => {
          const el = scrollContainerRef.current;
          if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
        };
        if (smooth) {
          // 平滑模式：等 virtuoso 渲染末尾后再滚容器，保留动画
          requestAnimationFrame(scrollContainerToBottom);
        } else {
          // instant 模式：多帧兜底，确保虚拟列表测量滞后时也能到底
          scrollContainerToBottom();
          requestAnimationFrame(scrollContainerToBottom);
        }
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

    // 渲染单条消息
    const itemContent = useCallback((index: number) => {
      const msg = messages[index];
      if (!msg) return null;
      return (
        <div className="py-1" data-msg-id={msg.id} data-msg-role={msg.role}>
          {renderMessage(msg, index)}
        </div>
      );
    }, [messages, renderMessage]);

    // Header/Footer 用 useCallback 包裹。footer/header 引用变化时 useCallback 更新，
    // 但由于 SVG 改用了 CSS animation（不受 DOM patch 影响），即使 Virtuoso 更新
    // Footer 内容也不会导致旋转动画重置。
    const HeaderComponent = useCallback(() => {
      if (!header) return null;
      return <>{header}</>;
    }, [header]);

    const FooterComponent = useCallback(() => {
      if (!footer) return null;
      return <>{footer}</>;
    }, [footer]);

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
        components={{
          Header: HeaderComponent,
          Footer: FooterComponent,
        }}
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
