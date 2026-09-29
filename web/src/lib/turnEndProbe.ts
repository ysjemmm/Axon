/**
 * 【临时诊断】定位"回复完成 / 取消时偶发闪一下"的剩余来源。定位后连同调用点一起删除。
 *
 * ── 为什么只在收尾窗口里跑 ──
 * 前几轮的主因已修掉，剩下的是**偶发**的：常驻探针要么刷屏、要么自己制造强制重排把现象搅乱。
 * 这里只在 markTurnEnd() 之后的 WINDOW_MS 内工作，窗口外完全不运行，平时零开销。
 *
 * ── 记什么 ──
 *   · 高度跳变：ResizeObserver 盯住当前可见面板里的每条消息及其内部大块，
 *     记下"谁、从多高变到多高"（观察器回调本身不强制重排，读数来自浏览器已算好的布局）
 *   · 视口空白：每帧检查视口顶/中/底三条线是否落在某条消息上（elementFromPoint 不强制重排）
 *   · scrollTop 跳变：相邻两帧差超过 JUMP_PX
 *   · 透明度：视口中心元素的祖先链上是否有 opacity < 1
 * 窗口结束时打一段汇总，没有异常就只打一行"无异常"。
 */

const WINDOW_MS = 2500;
const JUMP_PX = 40;
const MIN_RESIZE_PX = 8;

let active = false;

/** 当前可见面板的滚动容器（隐藏面板带 content-visibility:hidden / aria-hidden） */
function visibleScroller(): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>("[data-virtuoso-scroller]"));
  return all.find((el) => !el.closest("[aria-hidden='true']")) ?? null;
}

function describe(el: Element): string {
  const cls = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 2).join(".");
  const id = (el as HTMLElement).dataset?.msgId;
  return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}${id ? `[${id}]` : ""}`;
}

export function markTurnEnd(label: string): void {
  if (active || typeof window === "undefined" || typeof ResizeObserver === "undefined") return;
  const scroller = visibleScroller();
  if (!scroller) return;
  active = true;

  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const events: string[] = [];

  // ── 高度跳变 ──
  const lastH = new WeakMap<Element, number>();
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const h = Math.round(e.contentRect.height);
      const prev = lastH.get(e.target);
      lastH.set(e.target, h);
      if (prev !== undefined && Math.abs(h - prev) >= MIN_RESIZE_PX) {
        events.push(`+${at()}ms 高度 ${prev}→${h}px (${h > prev ? "+" : ""}${h - prev}) ${describe(e.target)}`);
      }
    }
  });
  const observeAll = () => {
    scroller.querySelectorAll("[data-msg-id], [data-msg-id] > * > *, .axon-codeblock, .axon-diagram-scroll")
      .forEach((el) => ro.observe(el));
  };
  observeAll();
  // 收尾期间可能新挂上节点（统计行、换装后的图），晚到的也要盯上
  const mo = new MutationObserver(observeAll);
  mo.observe(scroller, { childList: true, subtree: true });

  // ── 每帧：空白 / scrollTop / 透明度 ──
  let lastTop = scroller.scrollTop;
  let blankFrames = 0;
  let fadeLogged = false;
  const rect = scroller.getBoundingClientRect();
  // 顶部探测线避开覆盖在列表上方的提问条（约 32px，不是消息），否则每帧都被误判为空白
  const probeYs = [rect.top + 44, rect.top + rect.height / 2, rect.bottom - 8];
  const x = rect.left + rect.width / 2;
  // 列表起始位置（firstItemIndex）= 渲染项的绝对索引 - 局部索引。变了说明头部被折叠 / 展开
  const firstIndex = (): number | null => {
    const el = scroller.querySelector("[data-item-index][data-index]");
    if (!el) return null;
    return Number(el.getAttribute("data-item-index")) - Number(el.getAttribute("data-index"));
  };
  let lastFirst = firstIndex();

  const tick = () => {
    const t = at();
    const top = scroller.scrollTop;
    if (Math.abs(top - lastTop) >= JUMP_PX) events.push(`+${t}ms scrollTop 跳变 ${Math.round(lastTop)}→${Math.round(top)}`);
    lastTop = top;
    const fi = firstIndex();
    if (fi !== null && lastFirst !== null && fi !== lastFirst) events.push(`+${t}ms 列表起始位置变化 ${lastFirst}→${fi}（头部被折叠/展开）`);
    if (fi !== null) lastFirst = fi;

    const blanks = probeYs.filter((y) => !document.elementFromPoint(x, y)?.closest("[data-msg-id]"));
    if (blanks.length > 0) {
      blankFrames++;
      if (blankFrames <= 3) events.push(`+${t}ms 视口空白 ${blanks.length}/3 条探测线没落在消息上`);
    }

    if (!fadeLogged) {
      let n: Element | null = document.elementFromPoint(x, probeYs[1]);
      while (n && n !== scroller) {
        const op = parseFloat(getComputedStyle(n).opacity);
        if (op < 0.99) {
          events.push(`+${t}ms 视口中心有半透明祖先 opacity=${op.toFixed(2)} ${describe(n)}`);
          fadeLogged = true;
          break;
        }
        n = n.parentElement;
      }
    }

    if (t < WINDOW_MS) {
      requestAnimationFrame(tick);
      return;
    }
    ro.disconnect();
    mo.disconnect();
    active = false;
    if (blankFrames > 3) events.push(`（视口空白共 ${blankFrames} 帧）`);
    if (events.length === 0) {
      console.log(`[turn-end] ${label}：收尾 ${WINDOW_MS}ms 内无异常（无高度跳变 / 空白 / 滚动跳变 / 半透明）`);
    } else {
      console.warn(`[turn-end] ${label}：收尾 ${WINDOW_MS}ms 内记录到 ${events.length} 条\n  ${events.join("\n  ")}`);
    }
  };
  requestAnimationFrame(tick);
}
