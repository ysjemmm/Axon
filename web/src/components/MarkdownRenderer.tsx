/**
 * Markdown 渲染组件
 *
 * - 基于 renderMarkdown (markdown-it + hljs + KaTeX) 产出 HTML
 * - 后处理：把 <code> 标签内的文件/目录路径转为可点击链接
 * - 点击路径通过 postMessage 通知扩展宿主打开文件
 * - 增强渲染：SVG / Mermaid / HTML 代码块内联渲染为图表
 */

import { useRef, useEffect, useLayoutEffect, useState, useCallback, memo } from "react";
import { renderMarkdown } from "@/lib/markdown";
import { useThemeVersion } from "@/lib/theme";

/** 匹配常见文件/目录路径（Windows 绝对路径、Unix 绝对路径、相对路径） */
const PATH_PATTERN = /(?:[a-zA-Z]:\\[\w.\-\\/ ]+|\/[\w.\-/]+|\.\.?\/[\w.\-/]+)/g;

/** 对 <code>...</code> 内容做路径链接化 */
function linkifyPaths(html: string): string {
  return html.replace(/<code>([^<]+)<\/code>/g, (match, inner: string) => {
    const decoded = inner.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    if (!PATH_PATTERN.test(decoded)) return match;
    PATH_PATTERN.lastIndex = 0;
    const pathText = decoded.trim();
    const encoded = encodeURIComponent(pathText);
    return `<code class="axon-path-link" data-path="${encoded}">${inner}</code>`;
  });
}

/** 给 <table> 包一层可横向滚动的容器 */
function wrapTables(html: string): string {
  return html
    .replace(/<table>/g, '<div class="axon-table-wrap"><table>')
    .replace(/<\/table>/g, "</table></div>");
}

// ── 增强渲染结果的模块级缓存 ──
// 虚拟列表向上滚动会卸载视口外的消息（连同 MarkdownRenderer 实例及其 useRef 缓存），
// 重新进入视口时是全新实例。模块级缓存跨实例存活，重挂载时能命中，配合 useLayoutEffect 同步恢复。
const MAX_HYDRATE_CACHE = 100;
const enhancedRenderCache = new Map<string, HTMLElement>();

function readHydrateCache(key: string): HTMLElement | undefined {
  const el = enhancedRenderCache.get(key);
  if (el) {
    enhancedRenderCache.delete(key);
    enhancedRenderCache.set(key, el);
  }
  return el;
}

function writeHydrateCache(key: string, liveEl: HTMLElement): void {
  const snapshot = liveEl.cloneNode(true) as HTMLElement;
  snapshot.style.opacity = "1";
  snapshot.style.transition = "";
  enhancedRenderCache.set(key, snapshot);
  while (enhancedRenderCache.size > MAX_HYDRATE_CACHE) {
    const oldest = enhancedRenderCache.keys().next().value;
    if (oldest === undefined) break;
    enhancedRenderCache.delete(oldest);
  }
}

// ── 增强块悬浮菜单（事件委托版） ──
const ICON_DOTS = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>`;
const ICON_COPY = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const ICON_DOWNLOAD = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

type EnhancedKind = "svg" | "mermaid" | "html";
interface MenuActionItem { label: string; action: string; icon: string; }
const MENU_ITEMS: Record<EnhancedKind, MenuActionItem[]> = {
  svg: [
    { label: "复制源码", action: "copy-source", icon: ICON_COPY },
    { label: "下载 SVG", action: "download-svg", icon: ICON_DOWNLOAD },
    { label: "下载 PNG", action: "download-png", icon: ICON_DOWNLOAD },
  ],
  mermaid: [
    { label: "复制源码", action: "copy-source", icon: ICON_COPY },
    { label: "下载 SVG", action: "download-svg", icon: ICON_DOWNLOAD },
    { label: "下载 PNG", action: "download-png", icon: ICON_DOWNLOAD },
  ],
  html: [
    { label: "复制源码", action: "copy-source", icon: ICON_COPY },
    { label: "下载 HTML", action: "download-html", icon: ICON_DOWNLOAD },
  ],
};

function createEnhancedMenu(kind: EnhancedKind, rightClass: string): HTMLElement {
  const menuRoot = document.createElement("div");
  menuRoot.dataset.axonMenu = "1";
  menuRoot.className = `absolute top-1 ${rightClass} opacity-0 group-hover/enhanced:opacity-100 transition-opacity z-10`;
  const trigger = document.createElement("button");
  trigger.dataset.axonMenuTrigger = "1";
  trigger.className = "w-7 h-7 flex items-center justify-center rounded-md bg-background/80 backdrop-blur border border-border/60 text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer";
  trigger.innerHTML = ICON_DOTS;
  menuRoot.appendChild(trigger);
  const dropdown = document.createElement("div");
  dropdown.dataset.axonMenuDropdown = "1";
  dropdown.className = "hidden absolute top-8 right-0 min-w-[160px] py-1 rounded-md border border-border bg-popover shadow-lg text-xs";
  for (const it of MENU_ITEMS[kind]) {
    const item = document.createElement("button");
    item.dataset.axonAction = it.action;
    item.className = "w-full flex items-center gap-2 px-3 py-1.5 text-left cursor-pointer transition-colors hover:bg-[rgba(0,0,0,0.06)] dark:hover:bg-[rgba(255,255,255,0.08)]";
    item.style.color = "var(--popover-foreground, #374151)";
    item.innerHTML = `${it.icon}<span>${it.label}</span>`;
    dropdown.appendChild(item);
  }
  menuRoot.appendChild(dropdown);
  return menuRoot;
}

function closeAllEnhancedMenus(): void {
  document.querySelectorAll<HTMLElement>("[data-axon-menu-dropdown]:not(.hidden)").forEach((d) => d.classList.add("hidden"));
}

function downloadTextFile(text: string, mime: string, filename: string): void {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); URL.revokeObjectURL(a.href);
}

function downloadSvgAsPng(wrapper: HTMLElement): void {
  const svgEl = wrapper.querySelector("svg");
  if (!svgEl) return;
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  const rect = svgEl.getBoundingClientRect();
  if (!clone.getAttribute("width")) clone.setAttribute("width", String(rect.width));
  if (!clone.getAttribute("height")) clone.setAttribute("height", String(rect.height));
  const svgData = new XMLSerializer().serializeToString(clone);
  const svgBase64 = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgData)));
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = rect.width * scale; canvas.height = rect.height * scale;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  const img = new Image();
  img.onload = () => { ctx.drawImage(img, 0, 0, rect.width, rect.height); const a = document.createElement("a"); a.href = canvas.toDataURL("image/png"); a.download = "diagram.png"; a.click(); };
  img.src = svgBase64;
}

function runEnhancedMenuAction(action: string, wrapper: HTMLElement | null): void {
  if (!wrapper) return;
  const source = wrapper.dataset.axonSource ? decodeURIComponent(wrapper.dataset.axonSource) : "";
  const kind = wrapper.dataset.axonKind as EnhancedKind | undefined;
  switch (action) {
    case "copy-source": navigator.clipboard.writeText(source); break;
    case "download-svg": { const svgText = kind === "mermaid" ? (wrapper.querySelector("svg")?.outerHTML || source) : source; downloadTextFile(svgText, "image/svg+xml", "diagram.svg"); break; }
    case "download-png": downloadSvgAsPng(wrapper); break;
    case "download-html": downloadTextFile(source, "text/html", "preview.html"); break;
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest?.("[data-axon-menu]")) closeAllEnhancedMenus();
  });
}

interface MarkdownRendererProps { content: string; }


export const MarkdownRenderer = memo(function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const ref = useRef<HTMLDivElement>(null);
  const lastContentRef = useRef<string>("");
  const rafRef = useRef<number | null>(null);
  const pendingContentRef = useRef<string>(content);

  const computeHtml = useCallback((text: string): string => {
    return wrapTables(linkifyPaths(renderMarkdown(text)));
  }, []);

  const [html, setHtml] = useState<string>(() => {
    lastContentRef.current = content;
    return computeHtml(content);
  });

  const themeTick = useThemeVersion();

  useEffect(() => {
    pendingContentRef.current = content;
    if (content === lastContentRef.current) return;
    if (rafRef.current !== null) return;
    rafRef.current = window.setTimeout(() => {
      rafRef.current = null;
      const text = pendingContentRef.current;
      lastContentRef.current = text;
      setHtml(computeHtml(text));
    }, 80);
  }, [content, computeHtml]);

  useEffect(() => {
    return () => { if (rafRef.current !== null) { clearTimeout(rafRef.current); rafRef.current = null; } };
  }, []);

  // 事件委托（React 合成事件）
  const handleContentClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const trigger = target.closest<HTMLElement>("[data-axon-menu-trigger]");
    if (trigger) { e.preventDefault(); const dropdown = trigger.parentElement?.querySelector<HTMLElement>("[data-axon-menu-dropdown]"); if (dropdown) { const willOpen = dropdown.classList.contains("hidden"); closeAllEnhancedMenus(); if (willOpen) dropdown.classList.remove("hidden"); } return; }
    const actionEl = target.closest<HTMLElement>("[data-axon-action]");
    if (actionEl) { e.preventDefault(); runEnhancedMenuAction(actionEl.dataset.axonAction || "", actionEl.closest<HTMLElement>("[data-axon-kind]")); closeAllEnhancedMenus(); return; }
    const extLink = target.closest<HTMLAnchorElement>("a[data-external-link]");
    if (extLink) { e.preventDefault(); const url = extLink.dataset.externalLink || extLink.getAttribute("href") || ""; if (!url) return; const vscode = (window as any).__axonVSCode || (typeof (window as any).acquireVsCodeApi === "function" ? (window as any).acquireVsCodeApi() : null); if (vscode) { vscode.postMessage({ type: "open_external", url }); } else { window.open(url, "_blank", "noopener,noreferrer"); } return; }
    const pathTarget = target.closest<HTMLElement>(".axon-path-link");
    if (pathTarget) { e.preventDefault(); const path = decodeURIComponent(pathTarget.dataset.path || ""); if (!path) return; const vscode = (window as any).__axonVSCode || (typeof (window as any).acquireVsCodeApi === "function" ? (window as any).acquireVsCodeApi() : null); if (vscode) { vscode.postMessage({ type: "open_file", path }); } else { console.log("[axon] open file:", path); } return; }
    const copyBtn = target.closest<HTMLElement>("[data-copy-code]");
    if (copyBtn) { e.preventDefault(); const codeBlock = copyBtn.closest(".axon-codeblock")?.querySelector("code"); if (codeBlock) { navigator.clipboard.writeText(codeBlock.textContent || "").then(() => { const label = copyBtn.querySelector("span"); if (label) { label.textContent = "已复制"; setTimeout(() => { label.textContent = "复制"; }, 1500); } }); } return; }
  }, []);

  // ── 增强渲染 hydration ──
  // useLayoutEffect: 缓存命中恢复 + SVG/HTML 同步首次渲染（paint 前完成，无跳动）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.querySelectorAll<HTMLElement>(".axon-codeblock[data-enhanced-lang]").forEach((block) => {
      if (block.dataset.hydrated === "1") return;
      const lang = block.dataset.enhancedLang || "";
      const codeEl = block.querySelector("code");
      const codeContent = (codeEl?.textContent || "").trim();
      if (!codeContent) return;
      const cacheKey = `${themeTick}::${lang}::${codeContent}`;
      const cached = readHydrateCache(cacheKey);
      if (cached) {
        const clone = cached.cloneNode(true) as HTMLElement;
        const pre = block.querySelector("pre");
        if (pre) pre.replaceWith(clone);
        block.dataset.hydrated = "1";
        block.style.background = "transparent";
        block.style.border = "none";
        return;
      }
      // 同步渲染类型
      if (lang === "svg") { hydrateSvg(block, codeContent, (r) => writeHydrateCache(cacheKey, r)); }
      else if (lang === "html") { hydrateHtml(block, codeContent, (r) => writeHydrateCache(cacheKey, r)); }
    });
  }, [html, themeTick]);

  // useEffect: mermaid 异步首次渲染
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.querySelectorAll<HTMLElement>(".axon-codeblock[data-enhanced-lang]").forEach((block) => {
      if (block.dataset.hydrated === "1") return;
      if (block.dataset.enhancedLang !== "mermaid") return;
      const codeEl = block.querySelector("code");
      const codeContent = (codeEl?.textContent || "").trim();
      if (!codeContent) return;
      const cacheKey = `${themeTick}::mermaid::${codeContent}`;
      hydrateMermaid(block, codeContent, (r) => writeHydrateCache(cacheKey, r));
    });
  }, [html, themeTick]);

  return (
    <div
      ref={ref}
      onClick={handleContentClick}
      className="text-[13px] leading-relaxed prose prose-sm dark:prose-invert prose-neutral max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-1.5 [&_h1]:mt-4 [&_h1]:mb-1.5 [&_h2]:mt-4 [&_h2]:mb-1.5 [&_h3]:mt-3 [&_h3]:mb-1 [&_h4]:mt-2 [&_h4]:mb-1 [&_h5]:mt-2 [&_h5]:mb-1 [&_h6]:mt-1.5 [&_h6]:mb-0.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0 [&_li]:py-[2px] [&_li>p]:my-0 [&_ul_ul]:my-1 [&_ol_ol]:my-1 [&_blockquote]:my-2 [&_blockquote]:border-l-[3px] [&_blockquote]:border-blue-400/60 [&_blockquote]:dark:border-blue-500/40 [&_blockquote]:bg-blue-50/50 [&_blockquote]:dark:bg-blue-950/20 [&_blockquote]:rounded-r-md [&_blockquote]:pl-3.5 [&_blockquote]:pr-3 [&_blockquote]:py-2 [&_blockquote]:not-italic [&_blockquote]:text-foreground/85 [&_blockquote]:text-[12.5px] [&_blockquote_p]:my-0.5 [&_pre]:!my-2 [&_hr]:!my-3 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:bg-[rgba(200,200,200,0.15)] [&_:not(pre)>code]:dark:bg-[rgba(200,200,200,0.13)] [&_:not(pre)>code]:text-[#ab5726] [&_:not(pre)>code]:dark:text-[#e8ab6a] [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:rounded [&_:not(pre)>code]:text-[0.85em] [&_:not(pre)>code]:font-medium [&_:not(pre)>code]:border [&_:not(pre)>code]:border-[rgba(150,150,150,0.25)] [&_:not(pre)>code]:dark:border-[rgba(200,200,200,0.25)] [&_code]:before:content-none [&_code]:after:content-none [&_.axon-path-link]:text-[var(--vscode-textLink-foreground,#3794ff)] [&_.axon-path-link]:cursor-pointer [&_.axon-path-link]:hover:underline [&_.axon-path-link]:bg-transparent"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});


// ── Hydrate 函数 ──

function isSafeSvg(content: string): boolean {
  const dangerous = /<script|<iframe|<object|<embed|on\w+\s*=|javascript:/i;
  return !dangerous.test(content) && /<svg[\s>]/i.test(content);
}

function hydrateSvg(block: HTMLElement, content: string, onRendered?: (el: HTMLElement) => void): void {
  if (!isSafeSvg(content)) return;
  block.dataset.hydrated = "1";
  const wrapper = document.createElement("div");
  wrapper.className = "group/enhanced relative my-2 p-1 flex justify-center rounded-md";
  wrapper.style.color = "var(--foreground, currentColor)";
  wrapper.dataset.axonKind = "svg";
  wrapper.dataset.axonSource = encodeURIComponent(content);
  wrapper.innerHTML = content;
  const svg = wrapper.querySelector("svg");
  if (svg) {
    svg.style.background = "transparent";
    // 移除 AI 生成的大背景矩形（浅色硬编码 fill，在深色主题下太亮）
    const firstRect = svg.querySelector("rect");
    if (firstRect) {
      const rw = parseFloat(firstRect.getAttribute("width") || "0");
      const rh = parseFloat(firstRect.getAttribute("height") || "0");
      const svgW = parseFloat(svg.getAttribute("width") || svg.getAttribute("viewBox")?.split(/\s+/)[2] || "0");
      const svgH = parseFloat(svg.getAttribute("height") || svg.getAttribute("viewBox")?.split(/\s+/)[3] || "0");
      if (svgW > 0 && svgH > 0 && rw >= svgW * 0.9 && rh >= svgH * 0.9) {
        firstRect.setAttribute("fill", "transparent");
      }
    }
  }
  wrapper.appendChild(createEnhancedMenu("svg", "right-1"));
  wrapper.style.opacity = "0";
  wrapper.style.transition = "opacity 0.3s ease-in";
  const pre = block.querySelector("pre");
  if (pre) pre.replaceWith(wrapper);
  block.style.background = "transparent";
  block.style.border = "none";
  requestAnimationFrame(() => { wrapper.style.opacity = "1"; });
  onRendered?.(wrapper);
}

function hydrateHtml(block: HTMLElement, content: string, onRendered?: (el: HTMLElement) => void): void {
  block.dataset.hydrated = "1";
  const wrapper = document.createElement("div");
  wrapper.className = "group/enhanced relative my-2 rounded-md axon-html-preview";
  wrapper.dataset.axonKind = "html";
  wrapper.dataset.axonSource = encodeURIComponent(content);
  const iframe = document.createElement("iframe");
  iframe.className = "w-full border-0 rounded-md";
  iframe.style.cssText = "height:400px;display:block";
  iframe.sandbox.add("allow-scripts");
  const scrollStyle = `<style>html{overflow-y:auto;scrollbar-width:none}html:hover{scrollbar-width:thin;scrollbar-color:#d1d5db transparent}html::-webkit-scrollbar{width:6px}html::-webkit-scrollbar-thumb{background:transparent;border-radius:9999px}html:hover::-webkit-scrollbar-thumb{background:#d1d5db}</style>`;
  iframe.srcdoc = scrollStyle + content;
  wrapper.appendChild(iframe);
  wrapper.appendChild(createEnhancedMenu("html", "right-3"));
  const pre = block.querySelector("pre");
  if (pre) pre.replaceWith(wrapper);
  block.style.background = "transparent";
  block.style.border = "none";
  onRendered?.(wrapper);
}

/** Mermaid 单例加载 */
let _mermaidPromise: Promise<(typeof import("mermaid"))["default"]> | null = null;
function loadMermaid() {
  if (_mermaidPromise) return _mermaidPromise;
  _mermaidPromise = (async () => {
    const mermaid = await import("mermaid");
    return mermaid.default;
  })();
  return _mermaidPromise;
}

async function hydrateMermaid(block: HTMLElement, content: string, onRendered?: (el: HTMLElement) => void): Promise<void> {
  block.dataset.hydrated = "1";
  try {
    const mermaid = await loadMermaid();
    // 用 neutral 主题（文字深色），背景由 CSS 控制为 transparent
    mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });
    const wrapper = document.createElement("div");
    wrapper.className = "group/enhanced relative my-2 p-2 w-full rounded-md overflow-hidden";
    wrapper.style.background = "transparent";
    wrapper.style.position = "absolute";
    wrapper.style.visibility = "hidden";
    wrapper.innerHTML = `<pre class="mermaid not-prose" style="display:block;width:100%;background:transparent">${content}</pre>`;
    document.body.appendChild(wrapper);
    await mermaid.run({ nodes: [wrapper.querySelector<HTMLElement>(".mermaid")!] });
    const svg = wrapper.querySelector("svg");
    if (!svg) throw new Error("mermaid rendered but no SVG produced");
    svg.style.maxWidth = "100%";
    svg.style.width = "100%";
    svg.style.height = "auto";
    svg.style.background = "transparent";
    // 注入 style 覆盖文字/线条颜色，用 CSS 变量跟随主题
    // 用 SVG id 做作用域前缀，确保只影响该 mermaid 图，不泄漏到页面其他 SVG
    const svgId = svg.id || `axon-mmd-${Date.now()}`;
    if (!svg.id) svg.id = svgId;
    const scope = `#${svgId}`;
    const overrideStyle = document.createElementNS("http://www.w3.org/2000/svg", "style");
    overrideStyle.textContent = `
      ${scope} text, ${scope} tspan, ${scope} .messageText, ${scope} .labelText, ${scope} .loopText, ${scope} .noteText, ${scope} .sectionTitle,
      ${scope} .sectionTitle > tspan, ${scope} .actor > tspan, ${scope} .labelText > tspan, ${scope} .loopText > tspan {
        fill: var(--foreground, #333) !important;
        stroke: none !important;
      }
      ${scope} .messageLine0, ${scope} .messageLine1, ${scope} .loopLine, ${scope} .actor-line, ${scope} line.loopLine {
        stroke: var(--foreground, #666) !important;
      }
      ${scope} rect.actor {
        fill: var(--muted, #f4f4f5) !important;
        stroke: var(--border, #e4e4e7) !important;
      }
      ${scope} .labelBox {
        fill: var(--muted, #f4f4f5) !important;
        stroke: var(--border, #e4e4e7) !important;
      }
    `;
    svg.appendChild(overrideStyle);
    // 移入正确位置
    wrapper.style.position = "";
    wrapper.style.visibility = "";
    wrapper.style.background = "transparent";
    document.body.removeChild(wrapper);
    wrapper.dataset.axonKind = "mermaid";
    wrapper.dataset.axonSource = encodeURIComponent(content);
    wrapper.appendChild(createEnhancedMenu("mermaid", "right-1"));
    wrapper.style.opacity = "0";
    wrapper.style.transition = "opacity 0.3s ease-in";
    const pre = block.querySelector("pre");
    if (pre) pre.replaceWith(wrapper);
    block.style.background = "transparent";
    block.style.border = "none";
    requestAnimationFrame(() => { wrapper.style.opacity = "1"; });
    onRendered?.(wrapper);
  } catch {
    block.dataset.hydrated = "0";
  }
}


