/**
 * useStickToBottom —— 普通滚动容器的「贴底跟随」
 *
 * Cowork 的任务列表是普通 div 滚动（不是虚拟列表），所以不能直接用
 * VirtualMessageList 那套 Virtuoso 实现，但判据应当完全一致 —— 复用
 * chat/scrollAnchor 的纯函数，那两条规则是滚动体感的全部依据，已经在 Code 侧
 * 验证过，不重新发明。
 *
 * 行为：
 *   · 贴底（距底 ≤10px）→ 内容增长时持续钉在底部
 *   · 用户手动上滚      → 停止跟随，视界不动
 *   · 再滚回底部        → 恢复跟随
 *
 * ⚠️ 为什么不能简单写成「内容变就 scrollTo(bottom)」：那样用户往上翻看历史时会被
 * 流式输出不断拽回底部，根本没法读。也不能简单写成「不贴底就停止跟随」—— 内容变化
 * 期间浏览器重排会产生位置中间态，一次误读就永久关掉跟随（Code 侧踩过这个坑，
 * 表现为滚动条莫名漂走）。所以必须区分「用户手势」和「测量中间态」，见 resolveAtBottom。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isAtBottom, resolveAtBottom, USER_GESTURE_WINDOW_MS } from "@/components/chat/scrollAnchor";

/**
 * 内容变化后继续钉底的时长（ms）。
 * 不能为 0：DOM 变化到浏览器算完布局之间有若干帧，这段时间要持续钉住，
 * 否则新内容撑高容器的那一刻会露出一截。与 Code 侧取同一个值。
 */
const SETTLE_MS = 400;

export function useStickToBottom<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  // 列表在第一条任务出现后才挂载；用 callback ref 通知 effect 重新绑定观察器。
  const [scrollElement, setScrollElement] = useState<T | null>(null);
  const attachScrollElement = useCallback((element: T | null) => {
    ref.current = element;
    setScrollElement(element);
  }, []);
  /** 当前是否处于跟随状态。用 ref 而非 state：每帧都要读，不能触发重渲染。 */
  const atBottomRef = useRef(true);
  /** 是否显示「回到底部」按钮 = 用户已离开底部 */
  const [showScrollButton, setShowScrollButton] = useState(false);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = ref.current;
    if (!el) return;
    atBottomRef.current = true;
    setShowScrollButton(false);
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    const el = scrollElement;
    if (!el) return;

    let frame: number | null = null;
    let settleUntil = 0;
    /** 用户手势窗口：判定「不贴底」是用户主动离开还是测量中间态的唯一依据 */
    let lastGestureAt = 0;
    let pointerIsDown = false;

    const markGesture = () => { lastGestureAt = performance.now(); };
    const onPointerDown = () => { pointerIsDown = true; };
    const onPointerUp = () => { pointerIsDown = false; };

    const pinIfSticky = () => {
      if (!atBottomRef.current) return;
      const node = ref.current;
      if (!node) return;
      // 已在精确底部就不动：多余的 scrollTo 会触发 scroll 事件 → 又被当成变化 →
      // 自我触发循环。（阈值 0 判「精确贴底」，与 10px 的「算贴底」是两个问题。）
      if (isAtBottom(node.scrollTop, node.scrollHeight, node.clientHeight, 0)) return;
      node.scrollTop = node.scrollHeight;
    };

    const tick = () => {
      frame = null;
      pinIfSticky();
      if (performance.now() < settleUntil) frame = requestAnimationFrame(tick);
    };

    const onContentChanged = () => {
      settleUntil = performance.now() + SETTLE_MS;
      if (frame === null) frame = requestAnimationFrame(tick);
    };

    const onScroll = () => {
      // 按住指针时的滚动 = 正在拖动（含拖滚动条）→ 算用户意图。
      // 拖原生滚动条不派发 wheel/touch，只有 scroll，光靠手势事件会漏判。
      if (pointerIsDown) markGesture();
      const now = performance.now();
      const next = resolveAtBottom({
        positionAtBottom: isAtBottom(el.scrollTop, el.scrollHeight, el.clientHeight),
        hasUserGesture: now - lastGestureAt < USER_GESTURE_WINDOW_MS,
        contentSettling: now < settleUntil,
        previous: atBottomRef.current,
      });
      atBottomRef.current = next;
      setShowScrollButton((prev) => (prev === !next ? prev : !next));
    };

    const passive = { passive: true } as const;
    el.addEventListener("scroll", onScroll, passive);
    el.addEventListener("wheel", markGesture, passive);
    el.addEventListener("touchstart", markGesture, passive);
    el.addEventListener("touchmove", markGesture, passive);
    el.addEventListener("keydown", markGesture);
    el.addEventListener("pointerdown", onPointerDown);
    // pointerup 可能落在容器外，挂 window 才能可靠清除按下状态
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    // 流式增量、卡片展开、图片测量完成都会改内容高度
    const observer = new MutationObserver(onContentChanged);
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    const content = el.firstElementChild;
    const resizeObserver = content && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(onContentChanged)
      : null;
    if (content && resizeObserver) resizeObserver.observe(content);

    // 首次挂载时把任务带进可视区域；只对新挂载的容器执行，不打断用户上滚。
    onContentChanged();

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
  }, [scrollElement]);

  return { ref: attachScrollElement, showScrollButton, scrollToBottom };
}
