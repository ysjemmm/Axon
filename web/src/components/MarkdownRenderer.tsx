/**
 * Markdown 渲染组件
 *
 * - 基于 renderMarkdown (markdown-it + hljs) 产出 HTML
 * - 后处理：把 <code> 标签内的文件/目录路径转为可点击链接
 * - 点击路径通过 postMessage 通知扩展宿主打开文件
 * - 增强渲染：SVG / Mermaid / HTML 代码块内联渲染为图表
 */

import { useRef, useEffect, useLayoutEffect, useMemo, useState, useCallback, memo } from "react";
import mermaid from "mermaid";
import { renderMarkdown } from "@/lib/markdown";
import { fitSvgToContainer, readSvgIntrinsicSize } from "@/lib/diagramFit";
import {
  attachHtmlPreviewAutoHeight,
  HTML_PREVIEW_MIN_HEIGHT,
  HTML_PREVIEW_PRELUDE,
  HTML_PREVIEW_SANDBOX,
} from "@/lib/htmlPreviewResize";
import { useThemeVersion } from "@/lib/theme";
import { beginSpan, endSpan, recordIncident } from "@/lib/diagnostics";
import { createRoot, type Root } from "react-dom/client";
import { FormPanel } from "./chat/FormPanel";
import { useInlineForm } from "./chat/inlineFormContext";
import type { FormSpecData } from "./chat/formTypes";

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

/**
 * 本机已知的工作区根集合（多面板取并集）。
 *
 * 用途：路径徽章只对"落在某个工作区根之下"的路径渲染——只有这类路径才可能真的被打开；
 * 容器 / 远端路径（如 `/app/.cache/git_repos/...`）不属于任何根，渲染成可点徽章纯属误导。
 *
 * ⚠️ 刻意用模块级集合，而不是 props / context：
 * computeHtml 是空依赖（useCallback [..., ]）的稳定回调，被 useState 初始化器与 32ms
 * 节流重解析复用。一旦把根列表接进它的依赖，列表引用一变就会换掉它的身份、触发整条消息的
 * 全量重解析（实测单次正则扫描 0.316ms 起，流式期间约每 32ms 一次）。模块级集合的读写
 * 不产生任何 React 依赖，额外重解析为 0 次；新增的前缀比较实测仅 0.0139ms/次（12 候选 × 17 根）。
 */
const knownWorkspaceRoots = new Set<string>();

/** 路径归一化：Windows 大小写不敏感，且 `/` 与 `\` 会混用 */
function normalizeForCompare(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 登记一组工作区根（并集累加）。由会话侧在拿到工作区列表时调用。
 * 未登记任何根时判定放行（fail-open）——避免登记链路没接上时把正常徽章全挡掉。
 */
export function registerPathBadgeRoots(roots: string[]): void {
  for (const r of roots) {
    if (!r) continue;
    const normalized = normalizeForCompare(r);
    if (normalized) knownWorkspaceRoots.add(normalized);
  }
}

/** 该路径是否可能存在于本机（落在任一已知工作区根之下） */
function isUnderKnownRoot(pathText: string): boolean {
  if (knownWorkspaceRoots.size === 0) return true;
  const p = normalizeForCompare(pathText);
  for (const root of knownWorkspaceRoots) {
    if (p === root || p.startsWith(root + "/")) return true;
  }
  return false;
}

/** 对 <code>...</code> 内容做路径链接化：仅当整段内容【就是】一个路径时才渲染为图标+名称 */
function linkifyPaths(html: string): string {
  return html.replace(/<code>([^<]+)<\/code>/g, (match, inner: string) => {
    const decoded = inner.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    const pathText = decoded.trim();
    // 必须包含路径分隔符（/ 或 \），否则单纯的文件名（如 `config`）不视为路径，避免误伤普通行内代码
    if (!/[\\/]/.test(pathText)) return match;
    if (!PATH_PATTERN.test(pathText)) return match;
    // 末段是省略号占位（`/app/.cache/git_repos/...`）→ 这是"后面还有内容"的截断写法，不是真实路径。
    // PATH_PATTERN 会放行它（`.` 与 `-` 都在字符集里），于是渲染出一个名字叫 "..." 的假文件徽章。
    // 这类路径通常来自容器/远端日志，本地既不可打开也不存在，正是本函数最该拦掉的"误导性徽章"。
    const lastName = pathText.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
    if (lastName === "" || /^\.{2,}$/.test(lastName) || lastName === "…") return match;
    // 必须落在已知工作区根之下：容器/远端路径（如 `/app/.cache/git_repos/x.ts`）形状像绝对路径、
    // 却不可能在本机打开，渲染成可点徽章只会让用户白点一次。
    if (!isUnderKnownRoot(pathText)) return match;
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

// ── 增强块 hydrate 后的【整体高度】缓存（与 DOM 快照分开） ──
//
// 为什么需要它：DOM 快照缓存是 LRU（MAX_HYDRATE_CACHE 条），长会话里会被淘汰。
// 一旦某个含图的块被淘汰，消息再次滚进视口时只能走完整的 mermaid 渲染（异步，几百毫秒）。
// 而虚拟列表在消息挂载那一刻就按"源码块"的高度（几十 px）把它量好、排好位；
// 等图渲染完换装，这一项会瞬间长高上千 px —— 虚拟列表据此校正偏移，把视口整体挪走
// （实测单次最多 +1544px）。用户看到的正是"滚动条跳到别的位置，画面与上一秒不一样"。
//
// 有了实测高度，这条路径就不再产生位移：块一挂载就先把这个高度占住（min-height），
// 后续图换装时高度不变，虚拟列表无需校正。
//
// key 刻意【不含 themeTick】：高度由图的固有尺寸决定，与主题几乎无关；
// 去掉 themeTick 后，主题切换（DOM 快照会因 key 变化而整体未命中）也仍能保留高度。
const hydrateHeightCache = new Map<string, number>();
const MAX_HYDRATE_HEIGHT_CACHE = 1000;

function readHydrateHeight(key: string): number | undefined {
  const h = hydrateHeightCache.get(key);
  if (h !== undefined) {
    hydrateHeightCache.delete(key);
    hydrateHeightCache.set(key, h);
  }
  return h;
}

function writeHydrateHeight(key: string, height: number): void {
  if (!Number.isFinite(height) || height <= 0) return;
  hydrateHeightCache.set(key, Math.round(height));
  while (hydrateHeightCache.size > MAX_HYDRATE_HEIGHT_CACHE) {
    const oldest = hydrateHeightCache.keys().next().value;
    if (oldest === undefined) break;
    hydrateHeightCache.delete(oldest);
  }
}

/** 高度缓存的 key：只由语言 + 源码决定（见上方说明，刻意不含 themeTick） */
function hydrateHeightKey(lang: string, codeContent: string): string {
  return `${lang}::${codeContent}`;
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

/**
 * 淡入动画时长。与 index.css 的 `.axon-chunk` 保持一致（那里是兜底值，这里以内联样式为准）。
 * 取打字机批节奏 PACE_BEAT_MS(80ms) 的 3 倍：前一批还没淡完、后一批已经开始，连续覆盖。
 * ⚠️ 与 useTypewriter 的 PACE_BEAT_MS 是一对，调一个要跟着调另一个。
 */
const CHUNK_FADE_MS = 240;

/**
 * 图片加载失败 → 换成一行可点击的文件名胶囊。
 *
 * 正文里的图片地址多半是本地绝对路径（AI 引用本机截图 / 产物文件）或已失效的外链，
 * 在 webview 里必然加载失败。原样渲染会露出破图图标 + alt 文字，看起来像页面坏了。
 * 换成胶囊后至少能看出"这是哪个文件"，点一下还能打开它。
 */
function degradeBrokenImage(img: HTMLImageElement): void {
  if (!img.isConnected) return;
  const rawSrc = img.dataset.axonSrc || img.getAttribute("src") || "";
  // markdown 渲染会把这个地址做 URL 编码（%5C 之类），点击时要交回宿主真实路径，
  // 所以在这里解回来；解不开（含非法转义）就保留原值，不能因此丢掉地址。
  let src = rawSrc;
  try {
    src = decodeURIComponent(rawSrc);
  } catch {
    // 保留原值
  }
  // alt 优先：模型写的 alt 通常就是这张图是什么（如产物标题），比裸路径好读
  const label = (img.getAttribute("alt") || "").trim() || src;
  const pill = document.createElement("span");
  pill.className = "axon-image-fallback";
  if (src) pill.dataset.src = src;
  pill.textContent = label;
  pill.title = src ? `图片未能显示：${src}（点击打开）` : "图片未能显示";
  img.replaceWith(pill);
}

/**
 * 扫描并挂钩尚未处理过的图片。
 *
 * 增量 patch 会在流式过程中不断插入新 <img>，所以每次写 DOM 后都要过一遍；
 * dataset 标记保证同一张图只挂一次监听。已经失败过的图（error 在挂监听前就触发完了）
 * 靠 complete + naturalWidth 补一次判断，否则它会一直停在破图状态。
 */
function watchBrokenImages(root: HTMLElement): void {
  root.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    if (img.dataset.axonImgBound === "1") return;
    img.dataset.axonImgBound = "1";
    img.addEventListener("error", () => degradeBrokenImage(img), { once: true });
    if (img.complete && img.naturalWidth === 0) degradeBrokenImage(img);
  });
}

/** 解开一个淡入包裹：把文字放回原位、合并相邻文本节点 */
function unwrapChunk(s: Element): void {
  const parent = s.parentNode;
  if (!parent) return;
  while (s.firstChild) parent.insertBefore(s.firstChild, s);
  parent.removeChild(s);
  parent.normalize();
}

/**
 * 解开淡入包裹。
 *
 * @param onlyFinished 为 true 时只解开**动画已播完**的（流式期间用）；
 *   为 false 时全部解开（终态用：此后内容不再追加，残留的 span 会让下一次
 *   patchChildren 的前缀比对在它所在的节点提前失配，把已 hydrate 的图一起刷回源码块）。
 *
 * ── 为什么流式期间不能"每次提交都全部解开" ──
 * 这正是"淡入效果一直没有"的原因。渲染层每 32ms 提交一次，旧实现每次提交开头都把
 * 所有 span 解开，再给新增文字包一个新的——于是每个 span 只活一个提交周期。
 * 验证脚本（逐字照搬这三段逻辑，按真实节奏模拟 1.6 秒流式）实测：
 *   创建 19 个 span，平均存活 32ms，活满 240ms 淡入时长的 0 个。
 * 动画刚播了八分之一，span 被拆掉、文字直接 opacity:1 —— 肉眼看不出任何淡入。
 */
function unwrapChunks(el: HTMLElement, onlyFinished: boolean): void {
  // 整块淡入（axon-chunk-block）：播完就摘掉 class 与内联动画属性，让块回到"原样"。
  // 必须摘干净——前缀比对按 outerHTML 判等，残留的 class / style 会让已稳定的块被当成"变了"而整块重建。
  const now0 = performance.now();
  el.querySelectorAll<HTMLElement>(".axon-chunk-block").forEach((b) => {
    const born = Number(b.dataset.chunkBorn);
    if (onlyFinished && Number.isFinite(born) && now0 - born < CHUNK_FADE_MS) return;
    b.classList.remove("axon-chunk-block");
    if (!b.className) b.removeAttribute("class");
    b.style.removeProperty("animation-duration");
    if (!b.getAttribute("style")) b.removeAttribute("style");
    delete b.dataset.chunkBorn;
  });
  const spans = el.querySelectorAll<HTMLElement>("span.axon-chunk");
  if (spans.length === 0) return;
  const now = performance.now();
  spans.forEach((s) => {
    if (onlyFinished) {
      const born = Number(s.dataset.born);
      if (Number.isFinite(born) && now - born < CHUNK_FADE_MS) return;
    }
    unwrapChunk(s);
  });
}

/** 节点的纯文本，把淡入 span 视为透明（span 只是动画外壳，不代表内容变化） */
function sameIgnoringChunks(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (!(a instanceof HTMLElement && b instanceof HTMLElement)) return a.nodeValue === b.nodeValue;
  const isFadingBlock = a.classList.contains("axon-chunk-block");
  if (!isFadingBlock && !a.querySelector("span.axon-chunk")) return a.outerHTML === b.outerHTML;
  // 旧节点里有正在播的淡入（行内 span 或整块动画）：克隆后还原再比，原节点不动
  const clone = a.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("span.axon-chunk").forEach(unwrapChunk);
  if (isFadingBlock) {
    clone.classList.remove("axon-chunk-block");
    if (!clone.className) clone.removeAttribute("class");
    clone.style.removeProperty("animation-duration");
    if (!clone.getAttribute("style")) clone.removeAttribute("style");
    delete clone.dataset.chunkBorn;
  }
  clone.normalize();
  return clone.outerHTML === b.outerHTML;
}

/**
 * 旧节点 a 与新节点 b 是否"只是末尾多了一段纯文本"——是的话返回多出来的文本，否则 null。
 *
 * 这是流式最常见的形态（最后一个段落在变长）。命中时只需往 a 里追加一个文本节点，
 * 不用整体替换 —— 于是 a 里那个正在播淡入的 span 能活下来，动画播得完。
 *
 * 判据刻意收得很窄：去掉 span 后 a 的 outerHTML，要等于 b 的 outerHTML 去掉尾部那段文本。
 * 也就是说 b 只能比 a 多出**末尾的纯文本**，任何标签变化（加粗闭合、新开行内代码、
 * 链接成形……）都不命中，回退到整体替换，保证正确性优先。
 */
function appendedTail(a: Node, b: Node): string | null {
  if (!(a instanceof HTMLElement && b instanceof HTMLElement) || a.tagName !== b.tagName) return null;
  const oldText = a.textContent ?? "";
  const newText = b.textContent ?? "";
  if (newText.length <= oldText.length || !newText.startsWith(oldText)) return null;
  // b 的最后一个节点必须是文本，且去掉多出来的尾巴后，结构与 a（解包后）逐字节相同
  const lastB = b.lastChild;
  if (!lastB || lastB.nodeType !== Node.TEXT_NODE) return null;
  const tail = newText.slice(oldText.length);
  const lastBText = lastB.nodeValue ?? "";
  if (!lastBText.endsWith(tail)) return null;
  const bTrimmed = b.cloneNode(true) as HTMLElement;
  const trimmedLast = bTrimmed.lastChild as Text;
  trimmedLast.nodeValue = lastBText.slice(0, lastBText.length - tail.length);
  if (!trimmedLast.nodeValue) bTrimmed.removeChild(trimmedLast);
  const aClone = a.cloneNode(true) as HTMLElement;
  aClone.querySelectorAll("span.axon-chunk").forEach(unwrapChunk);
  if (aClone.classList.contains("axon-chunk-block")) {
    aClone.classList.remove("axon-chunk-block");
    if (!aClone.className) aClone.removeAttribute("class");
    aClone.style.removeProperty("animation-duration");
    if (!aClone.getAttribute("style")) aClone.removeAttribute("style");
    delete aClone.dataset.chunkBorn;
  }
  aClone.normalize();
  bTrimmed.normalize();
  return aClone.outerHTML === bTrimmed.outerHTML ? tail : null;
}

/**
 * 把 `html` 增量应用到 `el` 的子节点上，**只改真正变化的部分**。
 *
 * ── 为什么不能直接 `el.innerHTML = html` ──
 * 那一行的语义是「清空容器 → 重新解析整段 → 重建所有子节点」，即使 99% 的内容一个字节都没变。
 * 流式期间每 PARSE_THROTTLE_MS(32ms) 就跑一次，于是每 32ms 整棵子树被推平重建一次。
 * MutationObserver 实测（流式输出中，只统计 ≥200 字或 ≥3 子节点的大块）：
 *   移除 5/新增 5、移除 6/新增 6、移除 6/新增 6 …… 每 30~70ms 一批，增删数量相等。
 * 三个后果：
 *   · 重建期间浏览器可能渲染到空容器 → 肉眼「白屏闪一下」（取消时整段一次性灌入，最明显）
 *   · hydrateMermaid / hydrateSvg 用 pre.replaceWith 做的 DOM 手术产物被丢弃 → 图退回源码
 *   · 每批重建后紧跟贴底跟随读布局 → [Violation] Forced reflow
 * 组件里的 appliedHtmlRef 只能挡住「内容完全没变」的提交；流式期间内容每次都多几个字，
 * 那道去重永远命中不了，所以必须在这一层做增量。
 *
 * ── 为什么一个简单的前缀比对就够 ──
 * 流式追加的形态很固定：**末尾节点在变长，它前面的兄弟节点逐字节不变**。
 * 因此按顺序逐个比对 outerHTML，跳过完全相同的前缀节点（这部分 DOM 原地保留、连属性都不碰），
 * 只对第一个不同的节点起做替换/新增，尾部多余的删掉。
 * 典型情况下只有最后 1~2 个节点被替换，规模与"整段长度"无关。
 *
 * 刻意不引入 morphdom：这里的变更形态单一，而它与 hydrate 产物（React 不知情的 DOM 手术）
 * 的交互需要额外配置钩子去保护，成本高于收益。
 *
 * ⚠️ 不做跨节点的移动/key 匹配：markdown 全量重解析的输出是稳定有序的，
 * 中间插入节点的情形（如新开一个段落）会让该位置之后的节点被重建一次，这是可接受的
 * ——它只发生在段落边界，而不是每 32ms 都发生。
 */
/**
 * @returns 本次真正"新出现"的节点，调用方给它们挂淡入：
 *   · appended —— 末尾块走了原地追加时，新追加的那个文本节点
 *   · inserted —— 从差异点起被替换 / 新增进来的块级节点（段落、标题、列表、表格……）
 *
 * ⚠️ 必须把 inserted 全部交出去，而不是只让调用方"找最后一个文本节点包起来"。
 * 打字机收尾 / 排空时一批能倒出上百字，常常一口气新开好几个块（标题 + 段落 + 表格）：
 * 只包最后一段的话，同一批里其余新块全部硬出现——肉眼就是"前面还在淡入，后面唰地整段出来"。
 */
/**
 * 一个被替换 / 新增进来的节点。
 * prevText：它替换掉的旧节点的文字（新增的为 null）。据此区分两种完全不同的情况：
 *   · 真新块（prevText 为 null，或文字不是在旧文字后面接着长）→ 整块淡入
 *   · 原地变长的块（新文字以旧文字开头）→ **绝不能整块淡入**，只淡入末尾新增的那段
 * 后者最典型的是正在流式输出的代码块：它每一批都被整块替换（高亮后的 HTML 不是简单的
 * 尾部追加，走不了 appendedTail），若当成新块，整个代码块每 30~80ms 就从透明重淡一次——
 * 就是"中间内容一直闪、颜色发白"。
 */
interface InsertedNode {
  node: Node;
  prevText: string | null;
}

function patchChildren(el: HTMLElement, html: string): { appended: Text | null; inserted: InsertedNode[] } {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const next = Array.from(tpl.content.childNodes);
  const prev = Array.from(el.childNodes);

  // 找到第一个不同的位置：之前的节点全部原地复用
  let i = 0;
  while (i < prev.length && i < next.length) {
    // 元素比 outerHTML（淡入 span 视为透明），文本/注释比 nodeValue —— 都能逐字节判等
    if (!sameIgnoringChunks(prev[i], next[i])) break;
    i++;
  }

  // 差异点是正在变长的那个块，且只是末尾多了文本 → 原地追加。
  // ⚠️ 它通常**不是**最后一个节点：markdown-it 每个块后面都跟一个 "\n" 文本节点，
  // 所以要求的是"差异点之后新旧两边剩下的节点数相同、且逐个相等"，而不是 i 恰好在末尾。
  const restPrev = prev.length - 1 - i;
  if (i < prev.length && i < next.length && restPrev === next.length - 1 - i) {
    let restSame = true;
    for (let k = 1; k <= restPrev; k++) {
      if (!sameIgnoringChunks(prev[i + k], next[i + k])) { restSame = false; break; }
    }
    const tail = restSame ? appendedTail(prev[i], next[i]) : null;
    if (tail !== null) {
      const node = document.createTextNode(tail);
      prev[i].appendChild(node);
      return { appended: node, inserted: [] };
    }
  }

  const inserted: InsertedNode[] = [];
  // 从第一个差异点起：替换重叠部分
  while (i < prev.length && i < next.length) {
    // 被替换进来的节点里，和旧节点文字完全相同的不算"新出现"（只是标签结构变了，
    // 例如加粗刚闭合），给它挂淡入会让已经显示过的字重新闪一次
    const oldText = prev[i].textContent ?? "";
    if (oldText !== (next[i].textContent ?? "")) {
      // 同一位置、同一标签 = 同一个块在变长（prevText 非 null），不是新块。
      // ⚠️ 只看位置与标签，不看文字前缀：代码块的文字是"语言标签 + 代码"，高亮还会插换行，
      // 新文字常常不以旧文字开头——早先靠 startsWith 判断，流式代码块每批都被误判成新块、
      // 整块从 0 重淡（实测最低透明度 0.08），就是"中间内容一直闪、颜色发白"。
      // 标签不同（例如段落变成了标题）才算新块。
      const sameTag = prev[i] instanceof HTMLElement && next[i] instanceof HTMLElement
        && (prev[i] as HTMLElement).tagName === (next[i] as HTMLElement).tagName;
      inserted.push({ node: next[i], prevText: sameTag ? oldText : null });
    }
    el.replaceChild(next[i], prev[i]);
    i++;
  }
  // next 更长 → 追加剩余的新节点
  for (let j = i; j < next.length; j++) {
    el.appendChild(next[j]);
    inserted.push({ node: next[j], prevText: null });
  }
  // prev 更长 → 删掉多余的旧节点（从后往前，避免索引位移）
  for (let j = prev.length - 1; j >= i; j--) el.removeChild(prev[j]);
  return { appended: null, inserted };
}

if (typeof document !== "undefined") {
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest?.("[data-axon-menu]")) closeAllEnhancedMenus();
  });
}

/**
 * "重渲染提交"耗时超过该值才记一条归因（ms）。
 * 取 80ms 而非诊断模块默认的 200ms：提交每轮流式要跑几十次，
 * 阈值太高会漏掉"单次不致命、连续叠起来把主线程占满"的那类提交。
 */
const SLOW_COMMIT_MS = 80;

interface MarkdownRendererProps {
  content: string;
  /**
   * 本条内容是否仍在流式生成中。
   *
   * 为 true 时【完全不做增强渲染 hydration】：svg / mermaid / html 的可视化预览只在内容到达
   * 终态（正常结束 / 取消 / 出错）后才渲染。原因——流式期间本渲染器每 32ms 就把整条消息重解析
   * 一次，而 hydration 会把 <pre> 就地替换成预览节点；一旦中途 hydrate 出"半截内容"的预览，
   * 下一次重解析就会把它连同 DOM 子树一起换掉、再重新 hydrate（并重放一次淡入动画），
   * 表现为边输出边闪烁。终态之后内容不再变化，是唯一稳定的渲染时机。
   */
  streaming?: boolean;
}


export const MarkdownRenderer = memo(function MarkdownRenderer({ content, streaming = false }: MarkdownRendererProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inlineForm = useInlineForm();
  /**
   * 上一次真正写进 DOM 的 html 串。
   *
   * ⚠️ 这里刻意不用 `dangerouslySetInnerHTML`：React 19 在**每次 commitUpdate** 都会重放它，
   * _即使 `__html` 逐字节没变_。此前逐帧实测：83 次写入里 **69 次与上一次完全相同**。
   * 后果是整个内层 DOM 被推平重建 —— 其中包含 hydrateMermaid / hydrateSvg 用 `pre.replaceWith`
   * 做的 DOM 手术产物 —— 于是回复完成 / 取消那一刻整块重画一下，
   * 而且**与回复内容无关**（普通文字回复同样发生）。
   *
   * 改成自己写 innerHTML 并用这个 ref 去重：内容没变就一个字节都不碰，
   * 已 hydrate 的图能在后续多次重渲染中存活。
   */
  const appliedHtmlRef = useRef<string | null>(null);
  const lastContentRef = useRef<string>("");
  // setTimeout 句柄（早先叫 rafRef，但里面装的从来不是 requestAnimationFrame 的返回值）
  const parseTimerRef = useRef<number | null>(null);
  const pendingContentRef = useRef<string>(content);
  /** 归因埋点：请求重渲染的时刻（提交完成后在 layout effect 里结算） */
  const commitStartRef = useRef(0);

  const computeHtml = useCallback((text: string): string => {
    // 这条链路是整条消息的全量重解析 + 两次整段 HTML 正则扫描（linkifyPaths / wrapTables），
    // 成本随内容长度增长，而流式期间每约 32ms 就要重来一次。
    // 内容较大时写入持久化标记：万一主线程卡死在这一步，下次启动即可从标记读出规模与耗时。
    beginSpan("markdown-parse", { persist: text.length > 8000, detail: `${(text.length / 1024).toFixed(0)}KB` });
    try {
      return wrapTables(linkifyPaths(renderMarkdown(text)));
    } finally {
      endSpan("markdown-parse");
    }
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
  // highlight.js 加了按输入的缓存：流式重解析时靠前的代码块逐字未变，
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
      // 归因埋点起点：记下"请求重渲染"的时刻，提交完成后在下面结算。
      // 用 per-instance 的 ref 而非 beginSpan/endSpan —— 同一个提交里可能有多个
      // MarkdownRenderer 同时更新，而 beginSpan 按名字索引，会互相覆盖。
      commitStartRef.current = performance.now();
      setHtml(computeHtml(text));
    }, PARSE_THROTTLE_MS);
  }, [content, computeHtml]);

  useEffect(() => {
    return () => { if (parseTimerRef.current !== null) { clearTimeout(parseTimerRef.current); parseTimerRef.current = null; } };
  }, []);

  /**
   * 归因埋点：结算"请求重渲染 → DOM 提交完成"这段耗时。
   *
   * 这段（React 渲染 + 协调 + DOM 变更 + 大内容的同步布局）是此前完全没有覆盖的区间，
   * 而卡顿诊断里那批没有归因的长任务正落在它里面。
   */
  useLayoutEffect(() => {
    const startedAt = commitStartRef.current;
    if (startedAt <= 0) return;
    commitStartRef.current = 0;
    const commitMs = performance.now() - startedAt;
    if (commitMs >= SLOW_COMMIT_MS) {
      recordIncident("slow:md-commit", commitMs, `html=${(html.length / 1024).toFixed(0)}KB`);
    }
    // 大内容时顺带量一次强制同步布局：HTML 字符串换成 DOM 子树后，浏览器要重算样式与布局，
    // 这段同样没有归因。只在内容较大时量，避免给常态渲染加开销。
    const el = ref.current;
    if (el && html.length > 20000) {
      const t0 = performance.now();
      void el.offsetHeight;
      const layoutMs = performance.now() - t0;
      if (layoutMs >= SLOW_COMMIT_MS) {
        recordIncident("slow:md-layout", layoutMs, `html=${(html.length / 1024).toFixed(0)}KB`);
      }
    }
  }, [html]);

  // 事件委托（React 合成事件）
  const handleContentClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    // 加载失败的图片已降级成这段文字，点它按原始地址分流：外链走浏览器，其余交给宿主打开
    const brokenImage = target.closest<HTMLElement>(".axon-image-fallback");
    if (brokenImage) {
      e.preventDefault();
      const src = brokenImage.dataset.src || "";
      if (!src) return;
      const vscode = (window as any).__axonVSCode;
      if (/^https?:\/\//i.test(src)) {
        if (vscode) vscode.postMessage({ type: "open_external", url: src });
        else window.open(src, "_blank", "noopener,noreferrer");
      } else if (vscode) {
        vscode.postMessage({ type: "open_file", path: src });
      }
      return;
    }
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

  // ── 写入 html ──
  // 必须排在下面 hydration 之前：hydration 要对"刚写进去"的 DOM 做手术，
  // 而 layout effect 是按声明顺序执行的。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 只解开播完的：前缀比对已把 span 视为透明，残留的 span 不会再让 patch 失配，
    // 所以终态也不必"一次性全解开"——那样会把最后一批正在播的淡入掐断。
    // 播不完也没有后续提交的那几个，由下面的延时 effect 收尾。
    unwrapChunks(el, true);
    // 内容没变、且 DOM 里已经有东西 → 一个字节都不碰（这正是本改动的全部意义）
    if (appliedHtmlRef.current === html && el.firstChild) return;
    const prevTextLen = el.textContent?.length ?? 0;
    appliedHtmlRef.current = html;
    const { appended, inserted } = patchChildren(el, html);
    // 图片降级必须在 patch 之后：新插入的 <img> 才在 DOM 里
    watchBrokenImages(el);
    // ── 流式吐字：只给"这一批新到的字"挂淡入 ──
    // 增量取【渲染后纯文本】的长度差，而不是 markdown 源文的长度差：
    // 源文里的 **、#、- 等语法在渲染后不占文本，用源文长度会错位。
    //
    // ⚠️ 判据是"本次有没有新增文本"，而**不是** streaming 标志。
    // 曾经写成 `if (streaming)`，于是收尾那一帧（stream_end 把 streaming 置为 false、
    // 同时打字机 ending 模式正把最后一批字倒出来）走不进这里：最后一批字直接硬出现，
    // 而且上面刚把前一批的 .axon-chunk 包裹解开 —— 正文最后一下永远是"唰"的，没有过渡。
    // 改用 delta > 0 后，收尾批与流式批走同一条淡入路径；终态重渲染（delta === 0）天然不受影响。
    {
      const delta = (el.textContent?.length ?? 0) - prevTextLen;
      // prevTextLen === 0 说明是整段首次写入（切会话/历史消息挂载/Raw 切换），
      // 不是"逐批吐字"，包住整段会让历史消息每次挂载都整体闪一下。
      if (delta > 0 && prevTextLen > 0) {
        const born = String(performance.now());
        // ① 原地追加：只包本次新追加的那段文字（前面的已有自己的 span 在播，不能重包让它重播）。
        //    代码块里的文本不能包 span：会破坏 pre 的空白与换行语义。
        if (appended && appended.length > 0 && !appended.parentElement?.closest("pre, code")) {
          const span = document.createElement("span");
          span.className = "axon-chunk";
          span.style.animationDuration = `${CHUNK_FADE_MS}ms`;
          span.dataset.born = born;
          appended.parentNode?.replaceChild(span, appended);
          span.appendChild(appended);
        }
        // ② 被替换 / 新增进来的块，分两种处理（理由见 InsertedNode）。
        //    块之间的 "\n" 文本节点看不见，跳过。
        for (const { node: n, prevText } of inserted) {
          if (!(n instanceof HTMLElement)) continue;
          const text = n.textContent ?? "";
          if (prevText === null) {
            // 真新块：整块淡入（给元素本身挂动画类，不拆它里面的文字）。
            // 要覆盖到本批**所有**新块——只挑最后一个包，其余新块就会硬出现。
            n.classList.add("axon-chunk-block");
            n.style.animationDuration = `${CHUNK_FADE_MS}ms`;
            n.dataset.chunkBorn = born;
            continue;
          }
          // 原地变长的块：只淡入末尾新增的那段文字（文字变短 / 改写则什么都不挂）。
          // 代码块里的文本不能包 span（会破坏 pre 的空白与换行语义），直接跳过——代码逐字出现本就足够清楚。
          const addLen = text.length - prevText.length;
          if (addLen <= 0) continue;
          if (n.matches("pre, code") || n.querySelector("pre, code")) continue;
          let last: Text | null = null;
          const walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const t = walker.currentNode as Text;
            if (t.data.trim()) last = t;
          }
          if (!last) continue;
          const cut = Math.min(addLen, last.length);
          const tail = cut >= last.length ? last : last.splitText(last.length - cut);
          const span = document.createElement("span");
          span.className = "axon-chunk";
          span.style.animationDuration = `${CHUNK_FADE_MS}ms`;
          span.dataset.born = born;
          tail.parentNode?.replaceChild(span, tail);
          span.appendChild(tail);
        }
      }
    }
  }, [html, streaming]);

  // 流式结束后内容不再追加，但最后几批 span 可能还没播完、也没有下一次提交来解开它们。
  // 等最后一批播完再统一解开（解开要写 DOM，但此时没有 React 提交在跑，不会与 patch 冲突）。
  useEffect(() => {
    if (streaming) return;
    const el = ref.current;
    if (!el || !el.querySelector("span.axon-chunk, .axon-chunk-block")) return;
    const t = window.setTimeout(() => unwrapChunks(el, false), CHUNK_FADE_MS + 20);
    return () => window.clearTimeout(t);
  }, [streaming, html]);

  /**
   * 内联表单：把 ```form axon-render 块挂载成可交互面板。
   *
   * 与 svg/mermaid/html 的 hydrate 分开管理 root 生命周期：那几个是一次性生产静态节点，
   * 这个是长期存活的 React 组件（用户要在里面打字、拖滑块），DOM 被 patch 掉之后必须卸载，
   * 否则 root 会挂在已脱离文档的节点上，状态与事件一起泄漏。
   *
   * 与增强渲染同一判断：流式期间不挂载。流式时这段 JSON 还没写完、解析必然失败，
   * 更要紧的是本渲染器每 32ms 重解析一次，中途挂载出来的面板会被下一批 DOM 换掉。
   */
  const inlineFormRoots = useRef(new Map<HTMLElement, Root>());
  const inlineFormValueRef = useRef(inlineForm);
  inlineFormValueRef.current = inlineForm;

  useEffect(() => {
    if (streaming) return;
    const el = ref.current;
    if (!el) return;

    // 回收已脱离文档的 root（重渲染/虚拟列表回收都可能把节点换掉）
    for (const [node, root] of inlineFormRoots.current) {
      if (!node.isConnected) {
        root.unmount();
        inlineFormRoots.current.delete(node);
      }
    }

    el.querySelectorAll<HTMLElement>("[data-inline-form]").forEach((block) => {
      if (inlineFormRoots.current.has(block)) return;
      const raw = (block.querySelector("code")?.textContent || "").trim();
      if (!raw) return;
      let spec: FormSpecData;
      try {
        spec = JSON.parse(raw) as FormSpecData;
      } catch {
        return; // JSON 没写完或写错 → 保持源码可见，等下一次重解析再试
      }
      if (!spec || !Array.isArray(spec.fields) || spec.fields.length === 0) return;

      const mount = document.createElement("div");
      block.appendChild(mount);
      const pre = block.querySelector("pre");
      if (pre) pre.style.display = "none";

      const root = createRoot(mount);
      root.render(
        <FormPanel spec={spec} onSubmit={(payload) => inlineFormValueRef.current.submit(spec, payload)} />,
      );
      inlineFormRoots.current.set(block, root);
    });
  }, [html, streaming]);

  // 组件卸载（消息被删除 / 面板重挂）时统一回收，避免 root 泄漏
  useEffect(() => {
    const roots = inlineFormRoots.current;
    return () => {
      for (const root of roots.values()) root.unmount();
      roots.clear();
    };
  }, []);

  // 流式时已经闭合的图表块（见 closedFenceKeys）：这些块可以先渲染
  const closedBlocks = useMemo(() => (streaming ? closedFenceKeys(content) : null), [streaming, content]);

  // ── 增强渲染 hydration ──
  // useLayoutEffect: 缓存命中恢复 + SVG/HTML 同步首次渲染（paint 前完成，无跳动）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 流式期间只恢复已闭合的图表块（缓存里的成品）；没闭合的块内容还在变，保持源码，避免边输出边闪烁。
    if (streaming && (!closedBlocks || closedBlocks.size === 0)) return;
    el.querySelectorAll<HTMLElement>(".axon-codeblock[data-enhanced-lang]").forEach((block) => {
      if (block.dataset.hydrated === "1" || block.dataset.hydrating === "1") return;
      const lang = block.dataset.enhancedLang || "";
      const codeEl = block.querySelector("code");
      const codeContent = (codeEl?.textContent || "").trim();
      if (!codeContent) return;
      if (streaming && !closedBlocks?.has(`${lang}::${codeContent}`)) return;
      const cacheKey = `${themeTick}::${lang}::${codeContent}`;
      const heightKey = hydrateHeightKey(lang, codeContent);
      const cached = readHydrateCache(cacheKey);
      if (cached) {
        const clone = cached.cloneNode(true) as HTMLElement;
        const pre = block.querySelector("pre");
        if (pre) pre.replaceWith(clone);
        block.dataset.hydrated = "1";
        block.style.background = "transparent";
        block.style.border = "none";
        // 顺手补记高度：只在该 key 还没有记录时量一次（避免每次提交都强制同步布局）
        if (readHydrateHeight(heightKey) === undefined) writeHydrateHeight(heightKey, block.offsetHeight);
        return;
      }
      // 已知实测高度 → 先把高度占住，等图异步换装时这一项不会再长高，虚拟列表无需校正偏移。
      const knownHeight = readHydrateHeight(heightKey);
      if (knownHeight !== undefined && !block.style.minHeight) {
        block.style.minHeight = `${knownHeight}px`;
      }
      // 首次 hydrate 延迟到防抖 useEffect，避免流式输出时反复 hydrate 闪烁
    });
    // ⚠️ 刻意【不写依赖数组】：本效果必须每次提交都跑一遍。
    //
    // hydrate 出来的图是"DOM 手术"的产物（pre.replaceWith(wrapper)），React 对此一无所知。
    // 而 React 19 在每次 commitUpdate 时都会重新执行 dangerouslySetInnerHTML —— 实测
    // （真实组件 + 真实 CSS，运行时给 innerHTML setter 打点）83 次写入里有 69 次写的是
    // 与上一次逐字节相同的字符串，调用栈一律是 updateProperties → setProp → setInnerHTML。
    // 也就是说：组件只要重渲染一次，整棵内层 DOM 就被推平重建，已 hydrate 的图退回源码代码块。
    //
    // 这个"推平"本身难以避免（图必须在 React 之外渲染），窗口只能靠这里补：
    // 缓存里有成品就当场换回去。如果本效果仍按 [html, themeTick, streaming] 触发，
    // 那么"内容变了但 html 还没跟上"的那一次重渲染（节流窗口内）会推平 DOM 而本效果不重跑，
    // 图就一直停在源码代码块上，直到下一次 html 变化才被换回来——肉眼就是整块刷新一下。
    // 每次提交都跑，推平与还原落在同一次提交里，浏览器只会画最终态，中间态不可见。
    // 代价可忽略：流式期间第一行的 early return 就挡住了，终态后提交本就稀疏。
  });

  // 流式中：已经闭合的图表块（结束围栏 ``` 已到）内容不会再变，立刻渲染，不等整段输出完。
  // 渲染结果进缓存；之后每次重解析即便把这块推平，上面每次提交都跑的 layout effect 也会在同一次提交里
  // 从缓存换回去，所以不会闪。还没闭合的那一块照旧显示源码。
  useEffect(() => {
    const el = ref.current;
    if (!el || !streaming || !closedBlocks || closedBlocks.size === 0) return;
    el.querySelectorAll<HTMLElement>(".axon-codeblock[data-enhanced-lang]").forEach((block) => {
      if (block.dataset.hydrated === "1" || block.dataset.hydrating === "1" || block.dataset.previewRenderToken) return;
      const lang = block.dataset.enhancedLang || "";
      const codeContent = (block.querySelector("code")?.textContent || "").trim();
      if (!codeContent || !closedBlocks.has(`${lang}::${codeContent}`)) return;
      const cacheKey = `${themeTick}::${lang}::${codeContent}`;
      if (readHydrateCache(cacheKey)) return; // 已有成品：layout effect 会换上
      const heightKey = hydrateHeightKey(lang, codeContent);
      const onRendered = (r: HTMLElement) => {
        writeHydrateCache(cacheKey, r);
        writeHydrateHeight(heightKey, block.offsetHeight);
      };
      if (lang === "svg") hydrateSvg(block, codeContent, onRendered);
      else if (lang === "html") hydrateHtml(block, codeContent, onRendered);
      else if (lang === "mermaid") hydrateMermaid(block, codeContent, onRendered);
    });
  }, [html, themeTick, streaming, closedBlocks]);

  // 防抖首次 hydration：流式输出时 html 每 80ms 变化，频繁 hydrate 导致闪烁。
  // 等 content 稳定 300ms 后再执行首次 SVG/HTML/Mermaid 渲染。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 同上：只在终态渲染。streaming 由 true 翻 false 时本效果重跑，此时才真正 hydrate。
    if (streaming) return;
    const timer = setTimeout(() => {
      el.querySelectorAll<HTMLElement>(".axon-codeblock[data-enhanced-lang]").forEach((block) => {
        if (block.dataset.hydrated === "1" || block.dataset.hydrating === "1") return;
        if (block.dataset.previewRenderToken) return;
        const lang = block.dataset.enhancedLang || "";
        const codeEl = block.querySelector("code");
        const codeContent = (codeEl?.textContent || "").trim();
        if (!codeContent) return;
        const cacheKey = `${themeTick}::${lang}::${codeContent}`;
        const heightKey = hydrateHeightKey(lang, codeContent);
        // onRendered 里同时记下"换装后的整体高度"，供下次挂载时预留（见 hydrateHeightCache 说明）。
        const onRendered = (r: HTMLElement) => {
          writeHydrateCache(cacheKey, r);
          writeHydrateHeight(heightKey, block.offsetHeight);
        };
        if (lang === "svg") { hydrateSvg(block, codeContent, onRendered); }
        else if (lang === "html") { hydrateHtml(block, codeContent, onRendered); }
        else if (lang === "mermaid") { hydrateMermaid(block, codeContent, onRendered); }
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [html, themeTick, streaming]);

  // ⚠️ 正文里的行内代码 / 引用块 / 表格一律用 em，不要用 px。这个根节点的字号会被外层整体覆盖
  // （思考块把 .prose 压到 text-xs、工具卡片另有自己的字号），字号一旦用 px 写死，就会在这些
  // 更小的上下文里保持原尺寸、看起来比正文还大 —— 「思考过程里代码字体特别大」就是这么来的。
  // em 让它们永远跟着所在容器缩。数值按 14px 正文反算，主对话外观保持不变。
  return (
    <div
      ref={ref}
      onClick={handleContentClick}
      className="axon-prose-block axon-chat-prose text-[14px] leading-relaxed prose prose-sm dark:prose-invert prose-neutral max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:my-1 [&_h1]:mt-4 [&_h1]:mb-1.5 [&_h2]:mt-3 [&_h2]:mb-1 [&_h3]:mt-2.5 [&_h3]:mb-1 [&_h4]:mt-2 [&_h4]:mb-0.5 [&_h5]:mt-1.5 [&_h5]:mb-0.5 [&_h6]:mt-1.5 [&_h6]:mb-0.5 [&_ul]:my-0.5 [&_ol]:my-0.5 [&_li]:my-0 [&_li]:py-[1px] [&_li>p]:my-0 [&_ul_ul]:my-0 [&_ol_ol]:my-0 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3.5 [&_blockquote]:not-italic [&_blockquote]:text-foreground/75 [&_blockquote]:text-[1em] [&_blockquote_p]:my-0.5 [&_blockquote_p:last-child]:mb-0 [&_pre]:!my-2 [&_hr]:!my-3 [&_:not(pre)>code:not(.axon-path-link)]:bg-[rgba(0,0,0,0.04)] [&_:not(pre)>code:not(.axon-path-link)]:dark:bg-[rgba(255,255,255,0.04)] [&_:not(pre)>code:not(.axon-path-link)]:text-inherit [&_:not(pre)>code:not(.axon-path-link)]:px-1 [&_:not(pre)>code:not(.axon-path-link)]:py-[0.1em] [&_:not(pre)>code:not(.axon-path-link)]:rounded [&_code]:before:content-none [&_code]:after:content-none [&_.axon-path-link]:text-[var(--vscode-textLink-foreground,#3794ff)] [&_.axon-path-link]:cursor-pointer [&_.axon-path-link]:hover:underline [&_.axon-path-link]:bg-transparent"
    />
  );
});


/**
 * 找出 markdown 里已经闭合的围栏代码块（开头 ``` / ~~~ 与结束围栏都到了），返回「语言::内容」集合。
 * 流式时据此判断哪些图表块已经定稿、可以先渲染。
 */
function closedFenceKeys(markdown: string): Set<string> {
  const keys = new Set<string>();
  const lines = markdown.split("\n");
  let open: { fence: string; lang: string; body: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([\w-]*)/);
    if (!open) {
      if (m) open = { fence: m[1], lang: m[2].toLowerCase(), body: [] };
      continue;
    }
    const close = line.match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === open.fence[0] && close[1].length >= open.fence.length) {
      keys.add(`${open.lang}::${open.body.join("\n").trim()}`);
      open = null;
    } else {
      open.body.push(line);
    }
  }
  return keys;
}

// ── Hydrate 函数 ──

function isSafeSvg(content: string): boolean {
  const dangerous = /<script|<iframe|<object|<embed|on\w+\s*=|javascript:/i;
  return !dangerous.test(content) && /<svg[\s>]/i.test(content);
}

function hydrateSvg(block: HTMLElement, content: string, onRendered?: (el: HTMLElement) => void): void {
  if (!isSafeSvg(content)) return;
  block.dataset.hydrated = "1";
  const wrapper = document.createElement("div");
  wrapper.className = "group/enhanced relative my-2 rounded-md overflow-hidden min-w-0";
  wrapper.style.color = "var(--foreground, currentColor)";
  // SVG 是展示内容，不是可编辑文本；屏蔽宿主 WebView 的 Cut/Copy/Paste 右键菜单，
  // 避免用户点了无效的原生菜单。复制源码/下载图片统一走右上角 Axon 菜单。
  wrapper.oncontextmenu = (event) => event.preventDefault();
  wrapper.dataset.axonKind = "svg";
  wrapper.dataset.axonSource = encodeURIComponent(content);
  // 横向滚动槽：图表按固有尺寸显示，只有装不下且已到缩放下限时才滚动
  const slot = document.createElement("div");
  slot.className = "axon-diagram-scroll p-1";
  slot.innerHTML = content;
  wrapper.appendChild(slot);
  const svg = wrapper.querySelector("svg");
  if (svg) {
    const intrinsic = readSvgIntrinsicSize(svg);
    fitSvgToContainer(svg);
    // 移除 AI 生成的大背景矩形（浅色硬编码 fill，在深色主题下太亮）
    const firstRect = svg.querySelector("rect");
    if (firstRect && intrinsic) {
      const rw = parseFloat(firstRect.getAttribute("width") || "0");
      const rh = parseFloat(firstRect.getAttribute("height") || "0");
      if (rw >= intrinsic.width * 0.9 && rh >= intrinsic.height * 0.9) {
        firstRect.setAttribute("fill", "transparent");
      }
    }
  }
  wrapper.appendChild(createEnhancedMenu("svg", "right-1"));
  // ⚠️ 这里绝不能做「先 opacity:0 插入、再 rAF 置 1」的淡入。
  //
  // 换装是 `pre.replaceWith(wrapper)`：原代码块被移除、wrapper 顶上，只提交一次。
  // wrapper 若以 opacity:0 入场，则**换装后的第一帧整个图区是透明的**——透明的区域透出的是
  // 消息背景（浅色主题下即白色），随后再花约 0.3s 淡入；肉眼就是"换装瞬间刷白一下"。
  // 实测（真实组件 + 真实 CSS，逐帧采样 [data-axon-kind] 的 computed opacity）：
  // 换装帧 opacity=0，此后 18 帧 <0.95、到 ~300ms 才回到 1，而此刻 <pre> 已不在 DOM 中。
  //
  // 产物在插入前已由本函数完整渲染（同步），不存在需要用透明遮掩的中间态，
  // 直接以最终可见状态换入即可——这才是不产生空帧的做法。
  const pre = block.querySelector("pre");
  if (pre) pre.replaceWith(wrapper);
  block.style.background = "transparent";
  block.style.border = "none";
  onRendered?.(wrapper);
}

function hydrateHtml(block: HTMLElement, content: string, onRendered?: (el: HTMLElement) => void): void {
  block.dataset.hydrated = "1";
  const wrapper = document.createElement("div");
  wrapper.className = "group/enhanced relative my-2 rounded-md axon-html-preview overflow-hidden min-w-0";
  // HTML 预览同样是只读视觉内容，操作入口使用 Axon 三点菜单。
  wrapper.oncontextmenu = (event) => event.preventDefault();
  wrapper.dataset.axonKind = "html";
  wrapper.dataset.axonSource = encodeURIComponent(content);
  const iframe = document.createElement("iframe");
  iframe.className = "w-full border-0 rounded-md";
  // 初始取最小高度，真实高度在 load 后由父页量出（见 lib/htmlPreviewResize.ts）。
  // 早先写死 400px：内容短时那 400px 里绝大部分是空白，看着像"渲染坏了"。
  iframe.style.cssText = `height:${HTML_PREVIEW_MIN_HEIGHT}px;display:block`;
  // 开 allow-same-origin 让父页能读 contentDocument 自行测量；**不开 allow-scripts** ——
  // 沙箱 iframe 里本就执行不了任何脚本（CSP 与 vscode-webview 协议处理器双重封死，
  // 详见 lib/htmlPreviewResize.ts 头注释）。挂着它只会掩盖真实边界。
  iframe.setAttribute("sandbox", HTML_PREVIEW_SANDBOX);
  // 样式前奏放在内容之前：内容里的同名声明才能覆盖它（例如 AI 自己写的 body 外边距）
  iframe.srcdoc = HTML_PREVIEW_PRELUDE + content;
  // 先挂测量再插入文档：load 是插入后才触发的，顺序反了会漏掉首次测量。
  // 测量完成后再回调 onRendered —— 缓存必须存"量好高度之后"的快照，否则命中缓存的会是被裁的旧高度。
  attachHtmlPreviewAutoHeight(iframe, () => onRendered?.(wrapper));
  wrapper.appendChild(iframe);
  wrapper.appendChild(createEnhancedMenu("html", "right-3"));
  const pre = block.querySelector("pre");
  if (pre) pre.replaceWith(wrapper);
  block.style.background = "transparent";
  block.style.border = "none";
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
  // ⚠️ 这里只置「进行中」标记，绝不置 data-hydrated="1"。
  //
  // data-hydrated="1" 会立刻命中 index.css 的 `.axon-codeblock[data-hydrated="1"]`，
  // 把代码块的背景/边框/margin 全部抹掉（background:transparent !important 等）。
  // 而下面的 `await mermaid.render(...)` 是异步的（复杂图可达数秒）——在这整段时间里，
  // 卡片已被剥成透明、源码还挂在那儿，那块地方就露出页面底色（浅色主题即白色），
  // 直到渲染完成把图换上去才恢复。肉眼就是"刷白一下"。
  // 而且因为流式期间不 hydrate，这个窗口永远落在"回复刚结束"那一刻。
  // 所以 data-hydrated 必须推迟到换装那一刻再置，只与换装同一次提交（见下方换装处）。
  block.dataset.hydrating = "1";
  // mermaid 的图布局计算是同步重活（复杂图可达数秒），且流式期间每次内容变化都可能被重新触发。
  // 持久化标记：如果卡死发生在这里，它就是判断根因最直接的证据。
  beginSpan("mermaid-render", { persist: true, detail: `${(content.length / 1024).toFixed(1)}KB` });
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
    wrapper.className = "group/enhanced relative my-2 w-full rounded-md overflow-hidden";
    wrapper.style.background = "transparent";
    wrapper.style.lineHeight = "0";  // 消除 wrapper 内残余行盒间隙（pre.mermaid 的 line-height 撑高 3-5px）
    // Mermaid 已经渲染成 SVG，只读展示不应出现宿主的文本编辑菜单。
    wrapper.oncontextmenu = (event) => event.preventDefault();
    // 横向滚动槽：图表按固有尺寸显示，只有装不下且已到缩放下限时才滚动
    const slot = document.createElement("div");
    slot.className = "axon-diagram-scroll p-2";
    slot.innerHTML = svgText;
    wrapper.appendChild(slot);
    cleanupMermaidErrorArtifacts(wrapper);
    if (wrapper.querySelector(".error-icon,.error-text") || /Syntax error in text|mermaid version/i.test(wrapper.textContent || "")) {
      throw new Error("mermaid rendered error output");
    }
    const svg = wrapper.querySelector("svg");
    if (!svg) throw new Error("mermaid rendered but no SVG produced");
    // 按固有尺寸显示：不放大、只适应，超出缩放下限则横向滚动（见 diagramFit）
    fitSvgToContainer(svg);
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
    // 同 hydrateSvg：换装必须一次性、不带透明中间态。
    // mermaid 的 SVG 是在 `await mermaid.render` 拿到后才换入的（<pre> 一直保留到那一刻），
    // 所以只要不以 opacity:0 入场，换装帧就是成品可见 —— 不会出现空白帧。
    // 实测（真实组件 + 真实 CSS）：此前换装帧 opacity=0、19 帧 <0.95、~300ms 才恢复到 1。
    const pre = block.querySelector("pre");
    // 与换装同一次提交里才让 CSS 剥掉卡片背景/边框/margin：此刻图已就位，
    // 剥背景与换装在同一任务内完成，浏览器只画最终态 —— 不存在"卡片没了、图还没来"的那一帧。
    block.dataset.hydrated = "1";
    delete block.dataset.hydrating;
    if (pre) pre.replaceWith(wrapper);
    block.style.background = "transparent";
    block.style.border = "none";
    bindFunctions?.(wrapper);
    onRendered?.(wrapper);
  } catch (err) {
    renderHost?.remove();
    if (renderId) cleanupMermaidRenderArtifacts(renderId);
    cleanupMermaidErrorArtifacts();
    block.dataset.hydrated = "0";
    delete block.dataset.hydrating;   // 解除「进行中」，允许后续重试
    // ⚠️ 这里绝不能静默：解析失败 / 渲染超时 / SVG 空产出都汇到这条路，
    // 而重试只由防抖 effect 的依赖（html / themeTick / streaming）变化触发 ——
    // 依赖不再变，这块就永远停在源码状态，用户看到的就是"图有时候不渲染"。
    // 没有这条日志，这件事就是零线索的黑盒。
    console.warn("[hydrate] mermaid 渲染失败，回退为源码块：", err);
  } finally {
    endSpan("mermaid-render");
  }
}


