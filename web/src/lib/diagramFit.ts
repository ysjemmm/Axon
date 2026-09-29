/**
 * diagramFit —— 内联图表（Mermaid / AI 生成的 SVG）的显示尺寸。
 *
 * ── 为什么需要它 ──
 * 图表 SVG 的「固有尺寸」由制图方决定，跨度极大：两个节点的流程图可能只有 276×222，
 * 八节点的横向流程图却有 1230×70。早先一律按容器宽度铺满（width:100%），于是
 * 小图被放大 2~3 倍成"巨字"、宽图又被压到 0.3~0.5 倍看不清，
 * 同一个会话里图与图之间毫无一致性——用户读到的"忽大忽小"就是这两个方向叠出来的。
 *
 * 特别提醒：mermaid 输出的是 width="100%" + style="max-width:<固有宽>px"，
 * 那个 max-width 才是它算好的固有宽度。任何 max-width:100% 的覆盖都会把这张图放大。
 *
 * ── 规则（不放大、只适应）──
 * - 固有宽 ≤ 容器宽 → 按固有尺寸显示，绝不放大；
 * - 固有宽 > 容器宽 → 等比缩小以适配，但缩放下限为 MIN_DIAGRAM_SCALE；
 *   再宽则交给外层 .axon-diagram-scroll 横向滚动，保证文字仍可辨识。
 *
 * 用 width / max-width / min-width 三条声明表达上述规则，不依赖 ResizeObserver ——
 * 容器变窄时浏览器自己重算，无需 JS 介入。
 */

/** 缩放下限：低于此值图表内文字会小到难以辨认，改为横向滚动 */
export const MIN_DIAGRAM_SCALE = 0.75;

/**
 * 读取 SVG 的固有像素尺寸。
 * 优先 width / height 数值属性；百分比（mermaid 默认输出 width="100%"）不算数，
 * 回退到 viewBox —— mermaid 与 AI 生成的图，viewBox 单位就是像素。
 */
export function readSvgIntrinsicSize(svg: SVGSVGElement): { width: number; height: number } | null {
  const px = (value: string | null): number | null => {
    if (!value) return null;
    const raw = value.trim();
    if (raw.endsWith("%")) return null;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const w = px(svg.getAttribute("width"));
  const h = px(svg.getAttribute("height"));
  if (w !== null && h !== null) return { width: w, height: h };

  const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { width: vb[2], height: vb[3] };

  // 只有宽度可用时退化成正方形，至少保住宽度方向的意图
  if (w !== null) return { width: w, height: w };
  return null;
}

/**
 * 按固有尺寸给图表 SVG 定显示尺寸。
 * 调用方需保证外层有横向滚动容器（.axon-diagram-scroll），否则缩放下限会真的溢出。
 */
export function fitSvgToContainer(svg: SVGSVGElement, minScale: number = MIN_DIAGRAM_SCALE): void {
  svg.style.background = "transparent";
  svg.style.display = "block";
  svg.style.height = "auto";

  const size = readSvgIntrinsicSize(svg);
  if (!size) {
    // 拿不到固有尺寸：只能约束上限，至少保证不横向溢出
    svg.style.maxWidth = "100%";
    return;
  }

  // 缺 viewBox 时补一个：宽度被 max-width 收窄时才能等比缩放，而不是被压扁
  if (!svg.getAttribute("viewBox")) {
    svg.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
  }

  svg.style.width = `${size.width}px`;
  svg.style.maxWidth = "100%";
  svg.style.minWidth = `${Math.round(size.width * minScale)}px`;
  // 窄于容器时居中；真的溢出时 auto 退化为 0，从左侧起完整可滚（居中会让左侧滚不到）
  svg.style.margin = "0 auto";
}
