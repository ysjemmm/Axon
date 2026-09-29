/**
 * 悬浮滚动条（overlay scrollbar）—— 不占布局空间的滚动条。
 *
 * ── 为什么要自己画 ──
 * 原生滚动条要么占位、要么不显示，没有"浮在内容上"的第三种：
 *   · 默认隐藏、hover 显示（scrollbar-width: none ↔ thin）→ 显示的那一刻多占 6px，
 *     横向滚动条把下面的内容整体往下挤，纵向滚动条把内容挤窄、文字重新折行 —— 就是 hover 抖动；
 *   · 始终占位（始终 thin，只换颜色）→ 外面不再被撑高，但那 6px 始终算在布局里，
 *     iframe 预览里内容宽度被它吃掉一截，一旦有东西让它出现/消失，内容照样跳。
 * 浏览器原本有 `overflow: overlay` 专门做这件事，但 Chromium 114 起已把它当成 `auto`，不再浮层绘制。
 *
 * 所以这里彻底隐藏原生滚动条（不占任何空间），另画一个绝对定位的滑块浮在内容上：
 * 滑块不参与布局，出现、消失、拖动都不会让任何内容移动一个像素。
 *
 * ── 适用范围 ──
 *   · 图表滚动槽 `.axon-diagram-scroll`（SVG / Mermaid）：横向
 *   · HTML 预览 `.axon-html-preview` 里的 iframe：纵向 + 横向（滚的是 iframe 内部文档）
 *
 * ── 为什么按 hover 懒绑定 ──
 * 这些块由 hydrate 以 DOM 手术插入，还会从 hydrate 缓存里 cloneNode 出来复用——
 * 克隆不带事件监听器。在 document 上监听 pointerover、首次移入时再绑定，
 * 新挂载的、从缓存克隆的都能覆盖到，也不必改动每条 hydrate 路径。
 * 滑块本就只在 hover 时显示，懒绑定没有可见代价。
 */

const THICKNESS = 6;
const INSET = 2;
const MIN_THUMB = 24;
/** 滚动时（例如滚轮）即便指针不在块上，也短暂显示滑块 */
const ACTIVE_MS = 800;

type Axis = "x" | "y";

interface Source {
  /** 真正在滚动的元素（iframe 时是其文档的 scrollingElement） */
  scroller: Element;
  /** 监听 scroll 的目标（iframe 时是其 document：视口滚动在 document 上派发） */
  scrollTarget: EventTarget;
  /** 内容尺寸可能变化的元素 */
  resizeTargets: Element[];
}

interface Bar {
  axis: Axis;
  track: HTMLDivElement;
  thumb: HTMLDivElement;
}

interface Binding {
  refresh(): void;
}

const bindings = new WeakMap<HTMLElement, Binding>();

function createBar(host: HTMLElement, axis: Axis): Bar {
  const track = document.createElement("div");
  track.className = `axon-ovsb axon-ovsb-${axis}`;
  track.setAttribute("aria-hidden", "true");
  const thumb = document.createElement("div");
  thumb.className = "axon-ovsb-thumb";
  track.appendChild(thumb);
  host.appendChild(track);
  return { axis, track, thumb };
}

function metrics(s: Element, axis: Axis): { client: number; size: number; pos: number } {
  return axis === "x"
    ? { client: s.clientWidth, size: s.scrollWidth, pos: s.scrollLeft }
    : { client: s.clientHeight, size: s.scrollHeight, pos: s.scrollTop };
}

function setScroll(s: Element, axis: Axis, value: number): void {
  if (axis === "x") s.scrollLeft = value;
  else s.scrollTop = value;
}

/**
 * 在 host 上挂两条悬浮滚动条，跟随 resolve() 给出的滚动源。
 * resolve 可重复调用（iframe 每次 load 都是新文档，需要换源）。
 */
function bind(host: HTMLElement, resolve: () => Source | null): Binding & { reattach(): void } {
  // 清掉从 hydrate 缓存克隆过来的旧滑块：克隆不带监听器，是死的
  host.querySelectorAll(":scope > .axon-ovsb").forEach((n) => n.remove());
  host.classList.add("axon-ovsb-host");
  const bars: [Bar, Bar] = [createBar(host, "x"), createBar(host, "y")];

  let src: Source | null = null;
  let ro: ResizeObserver | null = null;
  let frame: number | null = null;
  let activeTimer: number | null = null;

  const place = (bar: Bar, m: { client: number; size: number; pos: number }) => {
    const trackLen = bar.axis === "x" ? bar.track.clientWidth : bar.track.clientHeight;
    const len = Math.min(trackLen, Math.max(MIN_THUMB, Math.round((trackLen * m.client) / m.size)));
    const max = m.size - m.client;
    const off = max > 0 ? Math.round(((trackLen - len) * m.pos) / max) : 0;
    if (bar.axis === "x") {
      bar.thumb.style.width = `${len}px`;
      bar.thumb.style.transform = `translateX(${off}px)`;
    } else {
      bar.thumb.style.height = `${len}px`;
      bar.thumb.style.transform = `translateY(${off}px)`;
    }
  };

  const update = () => {
    frame = null;
    if (!src || !host.isConnected) return;
    const [bx, by] = bars;
    const mx = metrics(src.scroller, "x");
    const my = metrics(src.scroller, "y");
    const showX = mx.size > mx.client + 1;
    const showY = my.size > my.client + 1;
    bx.track.style.display = showX ? "" : "none";
    by.track.style.display = showY ? "" : "none";
    // 两条同时出现时各自让出右下角，避免交叠
    bx.track.style.right = `${showY ? THICKNESS + INSET * 2 : INSET}px`;
    by.track.style.bottom = `${showX ? THICKNESS + INSET * 2 : INSET}px`;
    if (showX) place(bx, mx);
    if (showY) place(by, my);
  };

  const schedule = () => {
    if (frame === null) frame = requestAnimationFrame(update);
  };

  const onScroll = () => {
    schedule();
    bars.forEach((b) => b.track.classList.add("is-active"));
    if (activeTimer !== null) window.clearTimeout(activeTimer);
    activeTimer = window.setTimeout(() => {
      activeTimer = null;
      bars.forEach((b) => b.track.classList.remove("is-active"));
    }, ACTIVE_MS);
  };

  // ── 拖动滑块 / 点击轨道翻页 ──
  for (const bar of bars) {
    bar.thumb.addEventListener("pointerdown", (e) => {
      if (!src) return;
      e.preventDefault();
      e.stopPropagation();
      const scroller = src.scroller;
      const m = metrics(scroller, bar.axis);
      const trackLen = bar.axis === "x" ? bar.track.clientWidth : bar.track.clientHeight;
      const thumbLen = bar.axis === "x" ? bar.thumb.offsetWidth : bar.thumb.offsetHeight;
      // 滑块移动 1px 对应内容滚动多少
      const ratio = (m.size - m.client) / Math.max(1, trackLen - thumbLen);
      const start = bar.axis === "x" ? e.clientX : e.clientY;
      const startPos = m.pos;
      bar.thumb.setPointerCapture(e.pointerId);
      host.classList.add("axon-ovsb-dragging");
      const move = (ev: PointerEvent) => {
        const d = (bar.axis === "x" ? ev.clientX : ev.clientY) - start;
        setScroll(scroller, bar.axis, startPos + d * ratio);
      };
      const end = () => {
        bar.thumb.removeEventListener("pointermove", move);
        bar.thumb.removeEventListener("pointerup", end);
        bar.thumb.removeEventListener("pointercancel", end);
        host.classList.remove("axon-ovsb-dragging");
      };
      bar.thumb.addEventListener("pointermove", move);
      bar.thumb.addEventListener("pointerup", end);
      bar.thumb.addEventListener("pointercancel", end);
    });
    bar.track.addEventListener("pointerdown", (e) => {
      if (e.target !== bar.track || !src) return;
      e.preventDefault();
      const thumbRect = bar.thumb.getBoundingClientRect();
      const before = bar.axis === "x" ? e.clientX < thumbRect.left : e.clientY < thumbRect.top;
      const m = metrics(src.scroller, bar.axis);
      setScroll(src.scroller, bar.axis, m.pos + (before ? -1 : 1) * m.client * 0.9);
    });
  }

  const detach = () => {
    src?.scrollTarget.removeEventListener("scroll", onScroll);
    ro?.disconnect();
    ro = null;
    src = null;
  };

  const reattach = () => {
    detach();
    src = resolve();
    if (!src) return;
    src.scrollTarget.addEventListener("scroll", onScroll, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(schedule);
      ro.observe(host);
      src.resizeTargets.forEach((t) => ro!.observe(t));
    }
    schedule();
  };

  reattach();
  return { refresh: schedule, reattach };
}

function bindDiagram(slot: HTMLElement): void {
  const host = slot.parentElement;
  if (!host) return;
  const existing = bindings.get(host);
  if (existing) { existing.refresh(); return; }
  bindings.set(host, bind(host, () => ({
    scroller: slot,
    scrollTarget: slot,
    resizeTargets: slot.firstElementChild ? [slot, slot.firstElementChild] : [slot],
  })));
}

function bindIframe(host: HTMLElement, iframe: HTMLIFrameElement): void {
  const existing = bindings.get(host);
  if (existing) { existing.refresh(); return; }
  const b = bind(host, () => {
    const doc = iframe.contentDocument;
    const se = doc?.scrollingElement ?? doc?.documentElement;
    if (!doc || !se) return null;
    return { scroller: se, scrollTarget: doc, resizeTargets: doc.body ? [se, doc.body] : [se] };
  });
  // srcdoc 每次加载都是新文档，旧文档上的监听已失效，需要换源
  iframe.addEventListener("load", () => b.reattach());
  bindings.set(host, b);
}

let installed = false;

/** 全局安装一次（幂等）：首次 hover 到图表 / HTML 预览时为其挂上悬浮滚动条 */
export function installOverlayScrollbars(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("pointerover", (e) => {
    const t = e.target as Element | null;
    if (!t || typeof t.closest !== "function") return;
    const slot = t.closest<HTMLElement>(".axon-diagram-scroll");
    if (slot) { bindDiagram(slot); return; }
    const preview = t.closest<HTMLElement>(".axon-html-preview");
    const iframe = preview?.querySelector("iframe");
    if (preview && iframe) bindIframe(preview, iframe);
  }, { passive: true });
}
