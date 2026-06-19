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
  /** 获取滚动容器 DOM 元素 */
  getScrollContainer: () => HTMLDivElement | null;
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
      onScroll,
    },
    ref,
  ) {
    // ---- state ----
    const containerRef = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [clientHeight, setClientHeight] = useState(0);
    const heightMap = useRef(new Map<string, number>());
    const visibleRangeRef = useRef({ start: 0, end: 0 });
    const [measureVersion, setMeasureVersion] = useState(0);

    // ---- height tracking ----
    const recordHeight = useCallback((id: string, h: number) => {
      const prev = heightMap.current.get(id);
      if (prev === h) return;
      // 消息在视口上方 → 高度变化时补偿 scrollTop，消除视觉抖动
      const msgIndex = messages.findIndex((m) => m.id === id);
      const isAbove = msgIndex >= 0 && msgIndex < visibleRangeRef.current.start;
      heightMap.current.set(id, h);
      if (isAbove) {
        const delta = h - (prev ?? estimateHeight);
        const c = containerRef.current;
        if (c && delta !== 0) c.scrollTop += delta;
      }
      setMeasureVersion((n) => n + 1);
    }, [messages, estimateHeight]);

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

      visibleRangeRef.current = { start: startIdx, end: endIdx };

      return {
        totalHeight: total,
        visibleRange: { start: startIdx, end: endIdx },
        topPadding: topPad,
        bottomPadding: bottomPad,
      };
    }, [getHeights, scrollTop, clientHeight, overscan, measureVersion]);

    // ---- notify total height change ----
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
        // 虚拟列表中未测量消息使用预估值，scrollHeight 可能远小于真实高度。
        // 直接用极大值兜底——浏览器会自动 clamp 到实际最大可滚动位置。
        container.scrollTo({ top: 99999999, behavior });
      },
      scrollToIndex(index: number, behavior: ScrollBehavior = "smooth") {
        const container = containerRef.current;
        if (!container) return;
        // 先按预估偏移粗定位（把所有未测量消息按预估值算），再用 DOM scrollIntoView 精确落点。
        // 直接 scrollIntoView 在虚拟列表中可能因为目标不在 DOM 中而失败，
        // 所以先 scrollTo 保证目标进入渲染窗口，再 scrollIntoView 微调。
        let top = 0;
        for (let i = 0; i < Math.min(index, messages.length); i++) {
          top += heightMap.current.get(messages[i].id) ?? estimateHeight;
        }
        container.scrollTo({ top, behavior: "instant" });
        // 等虚拟列表渲染出目标后，用 DOM 精确定位
        const targetId = messages[index]?.id;
        if (targetId) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const el = container.querySelector(`[data-msg-id="${targetId}"]`);
              if (el) {
                el.scrollIntoView({ block: "start", behavior });
              } else {
                // 兜底：DOM 没出来就用预估位置
                container.scrollTo({ top, behavior });
              }
            });
          });
        }
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
      getScrollContainer() {
        return containerRef.current;
      },
    }), [messages, estimateHeight]);

    // ---- render ----
    const visibleMessages = messages.slice(visibleRange.start, visibleRange.end);

    return (
      <div ref={containerRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {/* 虚拟滚动区域：高度由消息 + 占位撑开 */}
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
        </div>

        {/* footer 在虚拟区域之外、正常文档流中：内容变化（思考过程出现/消失等）
            会自然影响容器的 scrollHeight，不会留下空白 */}
        {footer}
      </div>
    );
  },
);

// #endregion
