/**
 * VirtualMessageList —— 聊天消息虚拟滚动容器
 *
 * 在消息列表外层做 turn 级虚拟化：只渲染可视区 + 少量 overscan 的消息，
 * 离屏消息用占位高度替代。每条消息首次渲染后通过 ResizeObserver 测量真实高度，
 * 后续使用已测量高度计算偏移，避免滚动跳动。
 */

import { useState, useRef, useEffect, useMemo, useCallback, useImperativeHandle, forwardRef, type ReactNode } from "react";

// #region Types

interface MeasuredItem {
  id: string;
  height: number;
}

export interface VirtualMessageListHandle {
  /** 滚动到列表底部 */
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** 滚动到指定 index 的消息 */
  scrollToIndex: (index: number, behavior?: ScrollBehavior) => void;
  /** 获取当前滚动状态 */
  getScrollState: () => { scrollTop: number; scrollHeight: number; clientHeight: number };
  /** 强制重新测量所有已渲染项 */
  remeasure: () => void;
  /** 获取指定消息 id 的累积偏移（从列表顶部算起） */
  getMessageOffset: (id: string) => number | undefined;
}

interface VirtualMessageListProps {
  messages: readonly { id: string; role?: string }[];
  renderMessage: (msg: { id: string }, index: number) => ReactNode;
  /** 未测量消息的预估高度（px） */
  estimateHeight?: number;
  /** 视口外额外渲染的条数 */
  overscan?: number;
  /** 列表底部插槽（reasoning / loading / bottomRef 等） */
  footer?: ReactNode;
  /** 列表顶部插槽（断开连接提示等） */
  header?: ReactNode;
  /** 内容高度变化回调（供自动跟随底部用） */
  onTotalHeightChange?: (totalHeight: number) => void;
  /** 滚动事件回调 */
  onScroll?: (scrollTop: number) => void;
}

// #endregion

// #region Item Measurer

/** 单条消息的高度测量包装器 */
function MeasureWrapper({
  id,
  onHeight,
  children,
}: {
  id: string;
  onHeight: (id: string, height: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const prevHeight = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        if (h > 0 && h !== prevHeight.current) {
          prevHeight.current = h;
          onHeight(id, h);
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [id, onHeight]);

  return <div ref={ref}>{children}</div>;
}

// #endregion

// #region Component

const DEFAULT_ESTIMATE = 200;
const DEFAULT_OVERSCAN = 5;

export const VirtualMessageList = forwardRef<VirtualMessageListHandle, VirtualMessageListProps>(
  function VirtualMessageList(
    {
      messages,
      renderMessage,
      estimateHeight = DEFAULT_ESTIMATE,
      overscan = DEFAULT_OVERSCAN,
      footer,
      header,
      onTotalHeightChange,
      onScroll,
    },
    ref,
  ) {
    // ---- state ----
    const containerRef = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [clientHeight, setClientHeight] = useState(0);
    const heightMap = useRef(new Map<string, number>());
    const [measureVersion, setMeasureVersion] = useState(0);

    // ---- height tracking ----
    const recordHeight = useCallback((id: string, h: number) => {
      const prev = heightMap.current.get(id);
      if (prev !== h) {
        heightMap.current.set(id, h);
        setMeasureVersion((n) => n + 1);
      }
    }, []);

    /** 预先计算的每条消息偏移量数组（含兜底预估值） */
    const getHeights = useCallback((): MeasuredItem[] => {
      const result: MeasuredItem[] = [];
      for (let i = 0; i < messages.length; i++) {
        const id = messages[i].id;
        result.push({ id, height: heightMap.current.get(id) ?? estimateHeight });
      }
      return result;
    }, [messages, estimateHeight]);

    // ---- compute visible range & offsets ----
    const { totalHeight, visibleRange, topPadding, bottomPadding } = useMemo(() => {
      const heights = getHeights();

      let total = 0;
      for (const h of heights) total += h.height;

      // find start index
      let offset = 0;
      let startIdx = 0;
      for (let i = 0; i < heights.length; i++) {
        if (offset + heights[i].height >= scrollTop) {
          startIdx = i;
          break;
        }
        offset += heights[i].height;
        startIdx = i + 1;
      }
      startIdx = Math.max(0, startIdx - overscan);

      // find end index
      offset = 0;
      let endIdx = heights.length;
      const limit = scrollTop + (clientHeight || window.innerHeight);
      for (let i = 0; i < heights.length; i++) {
        if (offset > limit) {
          endIdx = i + overscan;
          break;
        }
        offset += heights[i].height;
      }
      endIdx = Math.min(heights.length, endIdx);

      // padding
      let topPad = 0;
      for (let i = 0; i < startIdx; i++) topPad += heights[i].height;
      let bottomPad = 0;
      for (let i = endIdx; i < heights.length; i++) bottomPad += heights[i].height;

      return {
        totalHeight: total,
        visibleRange: { start: startIdx, end: endIdx },
        topPadding: topPad,
        bottomPadding: bottomPad,
      };
    }, [getHeights, scrollTop, clientHeight, overscan, measureVersion]);

    // ---- notify total height change ----
    useEffect(() => {
      onTotalHeightChange?.(totalHeight);
    }, [totalHeight, onTotalHeightChange]);

    // ---- scroll & resize listeners ----
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      let prevWidth = container.clientWidth;

      const handleScroll = () => {
        setScrollTop(container.scrollTop);
        onScroll?.(container.scrollTop);
      };
      const handleResize = () => {
        const w = container.clientWidth;
        // 宽度变化时仅触发重算（clientHeight 可能变了），不清理高度缓存。
        // 内容重排带来的高度变化由每条消息自己的 ResizeObserver 精确捕获，
        // 清空全部缓存只会让离屏消息回退到预估值，造成空白/跳动。
        if (w !== prevWidth) {
          prevWidth = w;
          setMeasureVersion((n) => n + 1);
        }
        setClientHeight(container.clientHeight);
      };

      // observe with ResizeObserver for more accurate sizing
      const ro = new ResizeObserver(() => {
        handleResize();
      });
      ro.observe(container);

      container.addEventListener("scroll", handleScroll, { passive: true });
      handleResize(); // initial

      return () => {
        container.removeEventListener("scroll", handleScroll);
        ro.disconnect();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ---- imperative handle ----
    useImperativeHandle(ref, () => ({
      scrollToBottom(behavior: ScrollBehavior = "instant") {
        const container = containerRef.current;
        if (!container) return;
        // 用 DOM scrollHeight（含 footer），避免计算高度遗漏 footer 导致滚不到底
        container.scrollTo({ top: container.scrollHeight, behavior });
        // 双保险：smooth 动画可能被后续高度变化"甩开"，下一帧再补一次到绝对底部
        if (behavior === "smooth") {
          requestAnimationFrame(() => {
            const c = containerRef.current;
            if (c) c.scrollTo({ top: c.scrollHeight, behavior: "instant" });
          });
        }
      },
      scrollToIndex(index: number, behavior: ScrollBehavior = "smooth") {
        const container = containerRef.current;
        if (!container) return;
        let top = 0;
        for (let i = 0; i < Math.min(index, messages.length); i++) {
          top += heightMap.current.get(messages[i].id) ?? estimateHeight;
        }
        container.scrollTo({ top, behavior });
      },
      getScrollState() {
        const c = containerRef.current;
        if (!c) return { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
        return { scrollTop: c.scrollTop, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight };
      },
      remeasure() {
        heightMap.current.clear();
        setMeasureVersion((n) => n + 1);
      },
      getMessageOffset(id: string) {
        let offset = 0;
        for (let i = 0; i < messages.length; i++) {
          if (messages[i].id === id) return offset;
          offset += heightMap.current.get(messages[i].id) ?? estimateHeight;
        }
        return undefined;
      },
    }), [messages, estimateHeight]);

    // ---- render ----
    const visibleMessages = messages.slice(visibleRange.start, visibleRange.end);

    return (
      <div ref={containerRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {/* 占位高度：撑出完整滚动区域 */}
        <div style={{ height: totalHeight, position: "relative" }}>
          {/* 顶部占位（离屏消息的虚拟高度） */}
          {topPadding > 0 && <div style={{ height: topPadding }} />}

          {/* header（断开连接提示等）——紧贴第一条可见消息上方 */}
          {header && visibleRange.start === 0 && header}

          {visibleMessages.map((msg, i) => {
            const realIndex = visibleRange.start + i;
            return (
              <MeasureWrapper key={msg.id} id={msg.id} onHeight={recordHeight}>
                <div className="py-1" data-msg-id={msg.id} data-msg-role={msg.role}>
                  {renderMessage(msg, realIndex)}
                </div>
              </MeasureWrapper>
            );
          })}

          {/* 底部占位 */}
          {bottomPadding > 0 && <div style={{ height: bottomPadding }} />}

          {/* footer：reasoning / loading / bottomRef 放在虚拟内容区域内 */}
          {footer}
        </div>
      </div>
    );
  },
);

// #endregion
