/**
 * VirtualMessageList —— 基于 react-virtuoso 的聊天消息虚拟滚动容器
 *
 * 替代原手写虚拟列表，利用 react-virtuoso 的成熟能力解决：
 * - 加载后自动定位底部（initialTopMostItemIndex）
 * - 流式输出自动追底（followOutput）
 * - scrollToIndex 精确跳转
 * - 不定高动态测量无跳动
 */

import { useRef, useCallback, useImperativeHandle, forwardRef, useEffect, useState, type ReactNode } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { isAtBottom, resolveAtBottom, USER_GESTURE_WINDOW_MS } from "./scrollAnchor";
import { beginSpan, endSpan } from "@/lib/diagnostics";

/**
 * 内容变化后继续"钉住底部"的时长（ms）。
 *
 * 为什么不是"变化后钉一帧就够"：Virtuoso 的高度测量与偏移校正跨帧完成——
 * 变化那一帧钉到底，下一帧它按新测出的高度又会把自己挪开，而末尾这段没人管，
 * 滚动条最终停在离底部一小段（或干脆跑掉）。连续钉一段时间，覆盖到测量收敛为止。
 */
const STICK_SETTLE_MS = 400;

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
  /** 当前视口是否贴底（距底部 ≤ BOTTOM_THRESHOLD_PX） */
  isAtBottom: () => boolean;
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
  /**
   * 贴底状态变化回调（仅在翻转时触发）。
   * 供外部决定"要不要做会影响布局的动作"——不在底部时不做，否则从头部折叠消息
   * 会让整屏内容位移。
   */
  onAtBottomChange?: (atBottom: boolean) => void;
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
      onAtBottomChange,
    },
    ref,
  ) {
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const scrollContainerRef = useRef<HTMLElement | null>(null);
    /** 滚动容器 state 化：scrollerRef 回调拿到元素后，贴底监听要等元素确定再挂 */
    const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
    /**
     * 是否贴底 —— "跟随底部 / 保持视界"的唯一判据。
     *
     * 由容器的 scroll 事件实时更新：滚轮、拖动滚动条、键盘翻页、触控都会触发。
     * 早先是用 wheel 事件反推用户意图（向上滚=离开底部），那只覆盖滚轮一种操作，
     * 拖动滚动条与键盘翻页完全检测不到，于是"我明明滚上去了它还在往下追"。
     */
    const atBottomRef = useRef(true);
    /** 已上报给外部的贴底状态，用于只在翻转时回调 */
    const reportedAtBottomRef = useRef(true);
    const onAtBottomChangeRef = useRef(onAtBottomChange);
    onAtBottomChangeRef.current = onAtBottomChange;

    /** 读一次真实滚动位置，判定是否贴底 */
    const readAtBottom = useCallback((el: HTMLElement | null): boolean => {
      if (!el) return atBottomRef.current;
      return isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    }, []);

    /**
     * 把视口直接钉到容器底部。
     * 刻意不走 Virtuoso 的 scrollToIndex：消息高度是动态测量的，
     * "滚到最后一项"算出的落点常与实际底部差一截，原生 scrollTo 更准。
     */
    const scrollToBottomNow = useCallback((behavior: ScrollBehavior = "instant") => {
      const el = scrollContainerRef.current;
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior: behavior === "smooth" ? "smooth" : "auto" });
        return;
      }
      const smooth = behavior === "smooth";
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: smooth ? "smooth" : "auto" });
    }, []);

    /** scrollerRef 回调保持恒定引用，避免每次渲染都重挂（顺带把元素同步到 state） */
    const handleScrollerRef = useCallback((el: HTMLElement | Window | null) => {
      const node = (el as HTMLElement | null) ?? null;
      scrollContainerRef.current = node;
      setScrollerEl((prev) => (prev === node ? prev : node));
    }, []);

    // 暴露命令式 API（兼容现有 ChatPanel 调用方式）
    useImperativeHandle(ref, () => ({
      scrollToBottom(behavior: ScrollBehavior = "instant") {
        scrollToBottomNow(behavior);
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
      isAtBottom() {
        return readAtBottom(scrollContainerRef.current);
      },
    }), [scrollToBottomNow, readAtBottom]);

    /**
     * 贴底跟随控制器 —— 滚动体感的核心。
     *
     * 规则只有两条：
     *   ① 贴底（距底部 ≤ 10px）：会话区无论增加什么，都持续定位到最底部；
     *   ② 不贴底：什么都不做，保持当前视界不变。
     *
     * 为什么"不贴底就什么都不做"才是对的：向末尾追加内容并不改变 scrollTop，
     * 浏览器（以及虚拟列表自身的偏移维护）本来就能保住视界；此时任何一次 scrollTo
     * 都是多余的，而那些多余的调用正是"看着看着内容跳变"的来源。
     *
     * 早先的实现把跟随绑在 session.isLoading 上，于是回合结束那一刻（isLoading 转 false）
     * 监听被摘掉，可收尾那几帧的布局变化（占位头部消失、Credits 行出现、折叠窗口变化）
     * 恰恰发生在摘掉之后——滚动条就停在随机位置，忽上忽下。
     *
     * ⚠️ "是否贴底"不能直接采信每次读到的位置：虚拟列表在内容变化后重测量时会临时调整
     * scrollTop，那期间的读数不代表用户意图。"位置不贴底就停止跟随"曾让一次这样的中间态
     * 永久关掉跟随（取消会话时底部连续变化，最容易被命中）——滚动条就停在那次中间态的位置。
     * 现在只在"位置不贴底 **且** 有用户手势"时才翻转，见 resolveAtBottom。
     */
    useEffect(() => {
      const el = scrollerEl;
      if (!el) return;

      let frame: number | null = null;
      /** 持续钉到该时刻：每次内容变化都把窗口往后推，变化停止后再多钉一段以覆盖测量收敛 */
      let settleUntil = 0;
      /**
       * 用户手势追踪 —— 判定"不贴底"是用户主动离开、还是测量中间态的唯一依据。
       *
       * · 滚轮 / 触控 / 键盘翻页：进入手势窗口，之后一小段时间内的读数都算用户意图
       * · 指针按住并产生滚动（拖滚动条）：按住期间持续算作用户意图
       * · 单纯点击（按下即抬起、期间无滚动）不算 —— 否则流式期间点一下消息里的按钮，
       *   就会把随后的测量中间态误判成"用户离开了底部"而关掉跟随
       */
      let lastGestureAt = 0;
      let pointerIsDown = false;
      const markGesture = () => { lastGestureAt = performance.now(); };
      const onPointerDown = () => { pointerIsDown = true; };
      const onPointerUp = () => { pointerIsDown = false; };

      const pinIfSticky = () => {
        if (!atBottomRef.current) return;
        const el2 = scrollContainerRef.current;
        // 已经落在精确底部就不动：否则每帧一次多余的 scrollTo 会触发滚动事件 →
        // Virtuoso 重渲染 → DOM 变化 → 又延长跟随窗口，形成无意义的自我触发循环。
        // （用阈值 0 判"精确贴底"，与上面 10px 的"算贴底"是两个不同的问题。）
        if (el2 && isAtBottom(el2.scrollTop, el2.scrollHeight, el2.clientHeight, 0)) return;
        scrollToBottomNow("instant");
      };

      const tick = () => {
        frame = null;
        // 归因埋点：贴底跟随的每帧"读布局 + 回写 scrollTop"。流式期间这个循环一直在跑，
        // 且每次读 scrollHeight 都会强制同步布局——它是不是主线程的大头，需要被量出来。
        beginSpan("scroll-pin");
        try {
          pinIfSticky();
        } finally {
          endSpan("scroll-pin");
        }
        if (performance.now() < settleUntil) frame = requestAnimationFrame(tick);
      };

      const onContentChanged = () => {
        settleUntil = performance.now() + STICK_SETTLE_MS;
        if (frame === null) frame = requestAnimationFrame(tick);
      };

      const onScroll = () => {
        // 按住指针时发生的滚动 = 正在拖动（含滚动条）→ 视为用户意图
        if (pointerIsDown) markGesture();
        const now = performance.now();
        const next = resolveAtBottom({
          positionAtBottom: readAtBottom(el),
          hasUserGesture: now - lastGestureAt < USER_GESTURE_WINDOW_MS,
          // 内容仍在收敛（刚变化完的一小段）→ 此刻的位置读数是测量中间态，不足以判定用户意图
          contentSettling: now < settleUntil,
          previous: atBottomRef.current,
        });
        atBottomRef.current = next;
        if (next !== reportedAtBottomRef.current) {
          reportedAtBottomRef.current = next;
          onAtBottomChangeRef.current?.(next);
        }
      };

      const passive = { passive: true } as const;
      el.addEventListener("scroll", onScroll, passive);
      el.addEventListener("wheel", markGesture, passive);
      el.addEventListener("touchstart", markGesture, passive);
      el.addEventListener("touchmove", markGesture, passive);
      el.addEventListener("keydown", markGesture);
      el.addEventListener("pointerdown", onPointerDown);
      // pointerup 可能落在容器之外，挂到 window 才能可靠清除按下状态
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
      onScroll();

      // DOM 增删改（流式增量、工具卡片展开）+ 内容高度变化（图片/图表测量完成）
      const observer = new MutationObserver(onContentChanged);
      observer.observe(el, { childList: true, subtree: true, characterData: true });
      const content = el.firstElementChild;
      const resizeObserver = content && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(onContentChanged)
        : null;
      if (content && resizeObserver) resizeObserver.observe(content);

      return () => {
        el.removeEventListener("scroll", onScroll);
        el.removeEventListener("wheel", markGesture);
        el.removeEventListener("touchstart", markGesture);
        el.removeEventListener("touchmove", markGesture);
        el.removeEventListener("keydown", markGesture);
        el.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        observer.disconnect();
        resizeObserver?.disconnect();
        if (frame !== null) cancelAnimationFrame(frame);
      };
    }, [scrollerEl, readAtBottom, scrollToBottomNow]);

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
        scrollerRef={handleScrollerRef}
        onScroll={handleScroll as any}
        rangeChanged={handleRangeChanged}
        className="flex-1 min-h-0"
        style={{ height: "100%", overflowX: "hidden" }}
      />
    );
  },
);

// #endregion
