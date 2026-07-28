/**
 * Markdown 渲染组件
 *
 * - 基于 renderMarkdown (markdown-it + hljs + KaTeX) 产出 HTML
 * - 后处理：把 <code> 标签内的文件/目录路径转为可点击链接
 * - 点击路径通过 postMessage 通知扩展宿主打开文件
 * - 增强渲染：SVG / Mermaid / HTML 代码块内联渲染为图表
 */

import { useRef, useEffect, useLayoutEffect, useState, useCallback, memo } from "react";
import mermaid from "mermaid";
import { renderMarkdown } from "@/lib/markdown";
import { useThemeVersion } from "@/lib/theme";

/**
 * 匹配文件/目录路径——只认【绝对路径】（Windows `C:\...`、Unix `/...`）或【显式相对路径】（`./`、`../` 开头）。
 * 锚定整个字符串（^...$）：要求 <code> 内容【整体】就是一个路径，不能是"路径+其他文字"混在一起——
 * 否则会把无关文字一起当成路径去 stat 磁盘，文件必然不存在，点击后静默无反应。
 *
 * 只匹配绝对路径（Windows 盘符路径 + Unix 根路径）。
 * 故意不匹配相对路径（`./xxx`、`../xxx`、`packages/core` 等）：
 * 相对路径在对话里无法确定实际文件位置，渲染成可点击文件徽章反而造成误导和无效点击。
 */
const PATH_PATTERN = /^(?:[a-zA-Z]:[\\/][\w.\-\\/]*|\/[\w.\-/]+)$/;

/** 常见无扩展名的【文件】名（避免被误判成目录） */
const EXTENSIONLESS_FILE_NAMES = new Set([
  "dockerfile", "makefile", "readme", "license", "changelog",
  "gitignore", "gitattributes", "editorconfig", "procfile",
]);

/**
 * 路径是否指向目录。规则：
 * 1. 以 / 或 \ 结尾 —— 明确的目录写法（如 "packages/core/"）
 * 2. 否则看最后一段：没有扩展名（不含 "."），且不是已知的无扩展名文件（Dockerfile、README 等），
 *    也不是以 "." 开头的隐藏文件（.gitignore、.env 等）—— 视为目录（如 "web/src"）
 */
function isDirectoryPath(pathText: string): boolean {
  if (/[\\/]$/.test(pathText)) return true;
  const last = pathText.split(/[\\/]/).pop() || "";
  const lower = last.toLowerCase();
  if (lower.startsWith(".") && lower.length > 1) return false;
  if (EXTENSIONLESS_FILE_NAMES.has(lower)) return false;
  return !lower.includes(".");
}

/** 文件扩展名 → 徽章颜色（与 FileTypeIcon.tsx 保持一致） */
const PATH_BADGE_COLORS: Record<string, string> = {
  tsx: "#3178c6", jsx: "#d6a916", ts: "#3178c6", js: "#d6a916",
  mjs: "#d6a916", cjs: "#d6a916", json: "#e8821a", css: "#2563eb",
  scss: "#cf649a", html: "#e34f26", md: "#64748b", markdown: "#64748b",
  py: "#3776ab", java: "#ef4444", kt: "#7c3aed", go: "#00acd7",
  rs: "#b45309", vue: "#42b883", svelte: "#ff3e00", sql: "#0ea5e9",
  yml: "#dc2626", yaml: "#dc2626", xml: "#e8821a", svg: "#f59e0b",
  png: "#10b981", jpg: "#10b981", jpeg: "#10b981", gif: "#10b981",
  webp: "#10b981", sh: "#16a34a", bash: "#16a34a", ps1: "#2563eb",
};
const PATH_BADGE_SPECIAL: Record<string, { label: string; color: string }> = {
  dockerfile: { label: "DK", color: "#2496ed" },
  makefile: { label: "MK", color: "#475569" },
  "package.json": { label: "NPM", color: "#cb3837" },
};

/** 从路径中提取文件名/目录名（目录路径先去掉末尾的斜杠再取最后一段） */
function extractFileName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed || path;
}

/** 获取文件扩展名（小写） */
function getFileExt(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

/** 文件夹图标：与文件徽章形状统一（圆角矩形），但用文件夹轮廓图形而非字母，一眼可区分 */
const FOLDER_ICON_SVG = `<svg class="axon-path-icon" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" fill="#78909c"/><path d="M6.5 8.5h3.2l1.1 1.3h6.7a.9.9 0 0 1 .9.9v5.3a.9.9 0 0 1-.9.9h-11a.9.9 0 0 1-.9-.9V9.4a.9.9 0 0 1 .9-.9z" fill="#fff"/></svg>`;

/** 生成路径链接的内联 HTML：文件/文件夹图标徽章 + 名称 */
function buildPathLinkHTML(pathText: string): string {
  const isDir = isDirectoryPath(pathText);
  const fileName = extractFileName(pathText);
  const encoded = encodeURIComponent(pathText);
  const escapedTitle = pathText.replace(/"/g, "&quot;");

  if (isDir) {
    return `<code class="axon-path-link axon-path-dir" data-path="${encoded}" data-is-dir="1" title="${escapedTitle}">${FOLDER_ICON_SVG}<span class="axon-path-name">${fileName}</span></code>`;
  }

  const lowerName = fileName.toLowerCase();
  const ext = getFileExt(fileName);

  let label: string;
  let color: string;
  const special = PATH_BADGE_SPECIAL[lowerName];
  if (special) {
    label = special.label;
    color = special.color;
  } else {
    label = ext ? ext.slice(0, 3).toUpperCase() : (fileName.slice(0, 2).toUpperCase() || "?");
    color = PATH_BADGE_COLORS[ext] || "#94a3b8";
  }
  const fontSize = label.length >= 3 ? 10.5 : 12.5;

  return `<code class="axon-path-link" data-path="${encoded}" title="${escapedTitle}"><svg class="axon-path-icon" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" fill="${color}"/><text x="12" y="12" text-anchor="middle" dominant-baseline="central" font-size="${fontSize}" font-weight="700" fill="#fff" font-family="ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">${label}</text></svg><span class="axon-path-name">${fileName}</span></code>`;
}

/** 对 <code>...</code> 内容做路径链接化：仅当整段内容【就是】一个路径时才渲染为图标+名称 */
function linkifyPaths(html: string): string {
  return html.replace(/<code>([^<]+)<\/code>/g, (match, inner: string) => {
    const decoded = inner.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    const pathText = decoded.trim();
    // 必须包含路径分隔符（/ 或 \），否则单纯的文件名（如 `config`）不视为路径，避免误伤普通行内代码
    if (!/[\\/]/.test(pathText)) return match;
    if (!PATH_PATTERN.test(pathText)) return match;
    return buildPathLinkHTML(pathText);
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

function fallbackCopy(text: string): void {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try { document.execCommand("copy"); } catch { /* ignore */ }
  document.body.removeChild(textarea);
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

function setPreviewToggleButton(button: HTMLElement, mode: "preview" | "code" | "loading"): void {
  button.dataset.previewCode = mode;
  if (button instanceof HTMLButtonElement) button.disabled = mode === "loading";
  button.style.opacity = mode === "loading" ? "0.65" : "";
  const label = button.querySelector("span");
  if (label) label.textContent = mode === "preview" ? "预览" : mode === "code" ? "代码" : "预览中";
  const svg = button.querySelector("svg");
  if (svg) {
    svg.innerHTML = mode === "preview"
      ? '<polygon points="5 3 19 12 5 21 5 3"/>'
      : mode === "code"
        ? '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>'
        : '<circle cx="12" cy="12" r="8"/>';
  }
}

function waitForPreviewButtonPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

async function renderCodePreview(block: HTMLElement, button: HTMLElement): Promise<void> {
  if (button.dataset.previewCode === "loading") return;
  const lang = block.dataset.previewLang || "";
  const pre = block.querySelector("pre");
  const codeContent = (pre?.querySelector("code")?.textContent || "").trim();
  if (!codeContent || !pre) return;
  const renderToken = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  block.dataset.previewRenderToken = renderToken;
  block.dataset.axonCodeHtml = pre.outerHTML;
  delete block.dataset.enhancedLang;
  block.dataset.hydrated = "0";
  setPreviewToggleButton(button, "loading");
  await waitForPreviewButtonPaint();
  if (block.dataset.previewRenderToken !== renderToken) return;
  if (lang === "svg") hydrateSvg(block, codeContent);
  else if (lang === "html") hydrateHtml(block, codeContent);
  else if (lang === "mermaid") await hydrateMermaid(block, codeContent);
  if (block.dataset.previewRenderToken !== renderToken) return;
  const rendered = Boolean(block.querySelector("[data-axon-kind]"));
  setPreviewToggleButton(button, rendered ? "code" : "preview");
  delete block.dataset.previewRenderToken;
}

function restoreCodePreview(block: HTMLElement): void {
  const sourceHtml = block.dataset.axonCodeHtml;
  if (!sourceHtml) return;
  const live = block.querySelector<HTMLElement>("[data-axon-kind]");
  if (live) live.replaceWith(htmlToElement(sourceHtml));
  block.dataset.hydrated = "0";
  block.style.background = "var(--axon-code-bg,rgba(0,0,0,0.04))";
  block.style.border = "1px solid var(--axon-code-border,rgba(128,128,128,0.3))";
  const button = block.querySelector<HTMLElement>("[data-preview-code]");
  if (button) setPreviewToggleButton(button, "preview");
}

function htmlToElement(html: string): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild as HTMLElement;
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
  // setTimeout 句柄（早先叫 rafRef，但里面装的从来不是 requestAnimationFrame 的返回值）
  const parseTimerRef = useRef<number | null>(null);
  const pendingContentRef = useRef<string>(content);

  const computeHtml = useCallback((text: string): string => {
    return wrapTables(linkifyPaths(renderMarkdown(text)));
  }, []);

  const [html, setHtml] = useState<string>(() => {
    lastContentRef.current = content;
    return computeHtml(content);
  });

  const themeTick = useThemeVersion();

  // 重解析节流：窗口内的多次变更合并成一次，取窗口结束时的最新内容（尾沿触发）。
  //
  // ── 这个间隔决定的是"可见出字节奏"，不只是性能 ──
  // 打字机按 RAF 每帧出 5 个字（BASE_BATCH，见 useTypewriter：刻意压到个位数，让相邻两帧的
  // 增量小于一个视觉单元，避免"一簇字蹦出来"）。但字要变成像素，必须等这里重解析一次 DOM。
  // 节流窗口就是最终可见的更新周期：80ms 时一秒只更新 12.5 次、每次一口气冒出约 25 个字——
  // 打字机切好的细粒度在这一层被重新量化掉了，观感恰好回到它想避免的那种颗粒感。
  //
  // 降到 32ms（约 30fps，每次约 8 个字）。之所以现在敢降，是因为 markdown.ts 给
  // highlight.js 与 KaTeX 都加了按输入的缓存：流式重解析时靠前的代码块/公式逐字未变，
  // 直接命中缓存，重解析的成本基本只剩 markdown-it 的 token 化。在那之前每次重解析都要
  // 全量重跑高亮（无语言标注还要 highlightAuto 逐个试语言），80ms 是被成本逼出来的。
  //
  // 不再往 16ms 压：那样每帧都要重解析 + 重建整棵子树，token 化本身的成本会顶上来，
  // 而 30fps 对"字在流动"的观感已经够了——瓶颈重新变成打字机的出字量而非渲染频率。
  const PARSE_THROTTLE_MS = 32;

  useEffect(() => {
    pendingContentRef.current = content;
    if (content === lastContentRef.current) return;
    // 已有待触发的定时器 → 本次变更只更新 pendingContentRef，由那次定时器统一取最新值
    if (parseTimerRef.current !== null) return;
    parseTimerRef.current = window.setTimeout(() => {
      parseTimerRef.current = null;
      const text = pendingContentRef.current;
      lastContentRef.current = text;
      setHtml(computeHtml(text));
    }, PARSE_THROTTLE_MS);
  }, [content, computeHtml]);

  useEffect(() => {
    return () => { if (parseTimerRef.current !== null) { clearTimeout(parseTimerRef.current); parseTimerRef.current = null; } };
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
    const previewBtn = target.closest<HTMLElement>("[data-preview-code]");
    if (previewBtn) { e.preventDefault(); const block = previewBtn.closest<HTMLElement>(".axon-codeblock[data-preview-lang]"); if (!block) return; if (previewBtn.dataset.previewCode === "loading") return; if (previewBtn.dataset.previewCode === "code") { restoreCodePreview(block); return; } void renderCodePreview(block, previewBtn); return; }
    const copyBtn = target.closest<HTMLElement>("[data-copy-code]");
    if (copyBtn) { e.preventDefault(); const codeBlock = copyBtn.closest(".axon-codeblock")?.querySelector("code"); if (codeBlock) { const text = codeBlock.textContent || ""; const doFeedback = () => { const label = copyBtn.querySelector("span"); if (label) { label.textContent = "已复制"; setTimeout(() => { label.textContent = "复制"; }, 1500); } }; if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(doFeedback).catch(() => { fallbackCopy(text); doFeedback(); }); } else { fallbackCopy(text); doFeedback(); } } return; }
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
      // 首次 hydrate 延迟到防抖 useEffect，避免流式输出时反复 hydrate 闪烁
    });
  }, [html, themeTick]);

  // 防抖首次 hydration：流式输出时 html 每 80ms 变化，频繁 hydrate 导致闪烁。
  // 等 content 稳定 300ms 后再执行首次 SVG/HTML/Mermaid 渲染。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const timer = setTimeout(() => {
      el.querySelectorAll<HTMLElement>(".axon-codeblock[data-enhanced-lang]").forEach((block) => {
        if (block.dataset.hydrated === "1") return;
        if (block.dataset.previewRenderToken) return;
        const lang = block.dataset.enhancedLang || "";
        const codeEl = block.querySelector("code");
        const codeContent = (codeEl?.textContent || "").trim();
        if (!codeContent) return;
        const cacheKey = `${themeTick}::${lang}::${codeContent}`;
        if (lang === "svg") { hydrateSvg(block, codeContent, (r) => writeHydrateCache(cacheKey, r)); }
        else if (lang === "html") { hydrateHtml(block, codeContent, (r) => writeHydrateCache(cacheKey, r)); }
        else if (lang === "mermaid") { hydrateMermaid(block, codeContent, (r) => writeHydrateCache(cacheKey, r)); }
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [html, themeTick]);

  return (
    <div
      ref={ref}
      onClick={handleContentClick}
      className="text-[13px] leading-relaxed prose prose-sm dark:prose-invert prose-neutral max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-1 [&_h1]:mt-4 [&_h1]:mb-1.5 [&_h2]:mt-3 [&_h2]:mb-1 [&_h3]:mt-2.5 [&_h3]:mb-1 [&_h4]:mt-2 [&_h4]:mb-0.5 [&_h5]:mt-1.5 [&_h5]:mb-0.5 [&_h6]:mt-1.5 [&_h6]:mb-0.5 [&_ul]:my-0.5 [&_ol]:my-0.5 [&_li]:my-0 [&_li]:py-[1px] [&_li>p]:my-0 [&_ul_ul]:my-0 [&_ol_ol]:my-0 [&_blockquote]:my-2 [&_blockquote]:border-l-[3px] [&_blockquote]:border-blue-400/60 [&_blockquote]:dark:border-blue-500/40 [&_blockquote]:bg-blue-50/50 [&_blockquote]:dark:bg-blue-950/20 [&_blockquote]:rounded-r-md [&_blockquote]:pl-3.5 [&_blockquote]:pr-3 [&_blockquote]:py-2 [&_blockquote]:not-italic [&_blockquote]:text-foreground/85 [&_blockquote]:text-[12.5px] [&_blockquote_p]:my-0.5 [&_pre]:!my-2 [&_hr]:!my-3 [&_:not(pre)>code:not(.axon-path-link)]:bg-[rgba(0,0,0,0.04)] [&_:not(pre)>code:not(.axon-path-link)]:dark:bg-[rgba(255,255,255,0.04)] [&_:not(pre)>code:not(.axon-path-link)]:text-inherit [&_:not(pre)>code:not(.axon-path-link)]:px-1 [&_:not(pre)>code:not(.axon-path-link)]:py-[0.1em] [&_:not(pre)>code:not(.axon-path-link)]:rounded [&_:not(pre)>code:not(.axon-path-link)]:text-[0.95em] [&_code]:before:content-none [&_code]:after:content-none [&_.axon-path-link]:text-[var(--vscode-textLink-foreground,#3794ff)] [&_.axon-path-link]:cursor-pointer [&_.axon-path-link]:hover:underline [&_.axon-path-link]:bg-transparent"
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
  wrapper.className = "group/enhanced relative my-2 p-1 flex justify-center rounded-md overflow-hidden min-w-0";
  wrapper.style.color = "var(--foreground, currentColor)";
  wrapper.dataset.axonKind = "svg";
  wrapper.dataset.axonSource = encodeURIComponent(content);
  wrapper.innerHTML = content;
  const svg = wrapper.querySelector("svg");
  if (svg) {
    svg.style.background = "transparent";
    svg.style.maxWidth = "100%";
    svg.style.height = "auto";
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
  wrapper.className = "group/enhanced relative my-2 rounded-md axon-html-preview overflow-hidden min-w-0";
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

/** Mermaid 渲染序号 */
let mermaidRenderSeq = 0;

function cleanupMermaidRenderArtifacts(renderId: string): void {
  const escapeCss = typeof CSS !== "undefined" && CSS.escape ? CSS.escape : (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  document.getElementById(`d${renderId}`)?.remove();
  document.getElementById(`i${renderId}`)?.remove();
  document.getElementById(renderId)?.remove();
  document.querySelectorAll(`#${escapeCss(`d${renderId}`)}, #${escapeCss(`i${renderId}`)}, #${escapeCss(renderId)}`).forEach((el) => el.remove());
}

function cleanupMermaidErrorArtifacts(root: ParentNode = document): void {
  root.querySelectorAll("svg .error-icon, svg .error-text").forEach((el) => {
    const svg = el.closest("svg");
    const host = svg?.parentElement;
    if (host?.dataset.axonMermaidRenderHost) host.remove();
    else svg?.remove();
  });
  root.querySelectorAll<HTMLElement>("[data-axon-mermaid-render-host]").forEach((el) => {
    if (el.textContent?.includes("Syntax error in text") || el.querySelector(".error-icon,.error-text")) el.remove();
  });
}

async function hydrateMermaid(block: HTMLElement, content: string, onRendered?: (el: HTMLElement) => void): Promise<void> {
  block.dataset.hydrated = "1";
  let renderId = "";
  let renderHost: HTMLDivElement | null = null;
  try {
    // 用 neutral 主题（文字深色），背景由 CSS 控制为 transparent
    mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict", suppressErrorRendering: true });
    mermaid.setParseErrorHandler(() => { /* Mermaid syntax errors are intentionally silent in chat previews. */ });
    renderId = `axon-mmd-${Date.now()}-${mermaidRenderSeq++}`;

    renderHost = document.createElement("div");
    renderHost.dataset.axonMermaidRenderHost = renderId;
    renderHost.style.cssText = "position:absolute;overflow:hidden;width:0;height:0;top:0;left:0;pointer-events:none;z-index:-1";
    document.body.appendChild(renderHost);

    const { svg: svgText, bindFunctions } = await mermaid.render(renderId, content, renderHost);
    renderHost.remove();
    renderHost = null;
    cleanupMermaidRenderArtifacts(renderId);
    cleanupMermaidErrorArtifacts();
    if (!svgText) throw new Error("mermaid rendered but no SVG produced");

    const wrapper = document.createElement("div");
    wrapper.className = "group/enhanced relative my-2 p-2 w-full rounded-md overflow-hidden";
    wrapper.style.background = "transparent";
    wrapper.style.lineHeight = "0";  // 消除 wrapper 内残余行盒间隙（pre.mermaid 的 line-height 撑高 3-5px）
    wrapper.innerHTML = svgText;
    cleanupMermaidErrorArtifacts(wrapper);
    if (wrapper.querySelector(".error-icon,.error-text") || /Syntax error in text|mermaid version/i.test(wrapper.textContent || "")) {
      throw new Error("mermaid rendered error output");
    }
    const svg = wrapper.querySelector("svg");
    if (!svg) throw new Error("mermaid rendered but no SVG produced");
    svg.style.maxWidth = "100%";
    svg.style.width = "100%";
    svg.style.height = "auto";
    svg.style.background = "transparent";
    svg.style.display = "block";
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
    bindFunctions?.(wrapper);
    onRendered?.(wrapper);
  } catch {
    renderHost?.remove();
    if (renderId) cleanupMermaidRenderArtifacts(renderId);
    cleanupMermaidErrorArtifacts();
    block.dataset.hydrated = "0";
  }
}


