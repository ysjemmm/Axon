/**
 * IDE 主题跟随 —— 通用能力（单例，零依赖，可被任意组件/工具复用）
 *
 * 在 VS Code webview 中，宿主会在 <body> 上注入：
 * - 主题类名：vscode-light / vscode-dark / vscode-high-contrast / vscode-high-contrast-light
 * - 主题标识：data-vscode-theme-id / data-vscode-theme-kind
 * - 大量 --vscode-* CSS 变量（颜色、字体等）
 *
 * 本模块统一封装主题相关的探测与订阅，避免各处重复实现：
 * - 明暗 / 种类判定：{@link getThemeKind} / {@link isDarkTheme}
 * - 变化订阅：{@link subscribeThemeChange} / {@link useThemeVersion} / {@link useThemeKind} / {@link useIsDark}
 * - CSS 变量颜色解析：{@link readCssVar} / {@link resolveCssColor} / {@link pickCssColor}
 *
 * 设计原则：单例 MutationObserver 懒初始化（首个订阅者触发），主题切换时递增版本号并通知，
 * 消费方据此重渲染或重算颜色。独立运行（非 webview）时回退到 .dark / prefers-color-scheme。
 */

import { useSyncExternalStore } from "react";

export type ThemeKind = "light" | "dark" | "hc-dark" | "hc-light";

/** 判定当前 IDE 主题种类。 */
export function getThemeKind(): ThemeKind {
  if (typeof document === "undefined") return "light";
  const b = document.body.classList;
  if (b.contains("vscode-high-contrast") && !b.contains("vscode-high-contrast-light")) return "hc-dark";
  if (b.contains("vscode-high-contrast-light")) return "hc-light";
  if (b.contains("vscode-dark")) return "dark";
  if (b.contains("vscode-light")) return "light";
  if (document.documentElement.classList.contains("dark")) return "dark";
  // webview 兜底：直接解析 --vscode-editor-background（VS Code webview 一定会注入）
  // 或面板实际背景色亮度。不依赖 OS 的 prefers-color-scheme（它读的是系统主题而非 IDE）。
  const lum = inferLuminance();
  if (lum !== null) return lum < 0.4 ? "dark" : "light";
  if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "dark";
  return "light";
}

/** 当前是否暗色主题（含高对比暗色）。 */
export function isDarkTheme(): boolean {
  const k = getThemeKind();
  return k === "dark" || k === "hc-dark";
}

/** 从 CSS 变量或实际背景色推断亮度（0=黑, 1=白），取不到返回 null。 */
function inferLuminance(): number | null {
  if (typeof document === "undefined") return null;
  // 优先读 --vscode-editor-background（webview 里必有）
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-background").trim()
    || getComputedStyle(document.body).getPropertyValue("--vscode-editor-background").trim();
  if (raw) {
    const rgb = cssColorToRgb(raw);
    if (rgb) return relativeLuminance(rgb.r, rgb.g, rgb.b);
  }
  // 次选：读 body 背景色
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const rgb2 = parseRgb(bodyBg);
  if (rgb2 && rgb2.a > 0.1) return relativeLuminance(rgb2.r, rgb2.g, rgb2.b);
  return null;
}

/** 把 CSS 颜色值（hex/rgb/命名色）解析成 r/g/b（0-255）。 */
function cssColorToRgb(value: string): { r: number; g: number; b: number } | null {
  // 先尝试直接解析
  const direct = parseRgb(value);
  if (direct) return direct;
  // hex
  const hex = value.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    if (h.length >= 6) {
      return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) };
    }
  }
  // 用探针元素让浏览器计算
  if (typeof document === "undefined") return null;
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.color = value;
  document.body.appendChild(probe);
  try {
    return parseRgb(getComputedStyle(probe).color);
  } finally {
    probe.remove();
  }
}

/** 解析 rgb/rgba 字符串为分量。 */
function parseRgb(value: string): { r: number; g: number; b: number; a: number } | null {
  const m = value.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/);
  if (!m) return null;
  return {
    r: parseInt(m[1], 10),
    g: parseInt(m[2], 10),
    b: parseInt(m[3], 10),
    a: m[4] !== undefined ? parseFloat(m[4]) : 1,
  };
}

/** 相对亮度（0=黑, 1=白）。 */
function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255);
}

/** 读取 documentElement / body 上的 CSS 变量原始值（已 trim）。 */
export function readCssVar(name: string): string {
  if (typeof document === "undefined") return "";
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    getComputedStyle(document.body).getPropertyValue(name).trim()
  );
}

/** 把任意 CSS 颜色值（含 var(...)）交给浏览器计算成 hex 颜色字符串。 */
export function resolveCssColor(cssValue: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.color = cssValue;
  document.body.appendChild(probe);
  try {
    const c = getComputedStyle(probe).color;
    if (!c) return undefined;
    return rgbToHex(c) || undefined;
  } finally {
    probe.remove();
  }
}

/** 把浏览器 computed color（rgb/rgba 格式）转换为 #rrggbb(aa) hex。 */
function rgbToHex(value: string): string | undefined {
  const match = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (!match) return undefined;
  const r = parseInt(match[1], 10);
  const g = parseInt(match[2], 10);
  const b = parseInt(match[3], 10);
  const a = match[4] !== undefined ? Math.round(parseFloat(match[4]) * 255) : 255;
  const hex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0");
  return a < 255 ? `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}` : `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * 按优先级取第一个真实存在的 CSS 变量并解析为颜色。
 * 注意：先确认变量存在，否则 `style.color = 'var(--missing)'` 会被静默丢弃，
 * 探针回退到继承色，从而掩盖后续候选。
 */
export function pickCssColor(...names: string[]): string | undefined {
  for (const n of names) {
    if (!readCssVar(n)) continue;
    const c = resolveCssColor(`var(${n})`);
    if (c) return c;
  }
  return undefined;
}

// ── 主题变化订阅（单例） ──
let _version = 0;
const _listeners = new Set<() => void>();
let _observer: MutationObserver | null = null;

function ensureObserver(): void {
  if (_observer || typeof document === "undefined") return;
  let _lastKind = getThemeKind();
  _observer = new MutationObserver(() => {
    // 只在主题真正切换时才递增版本（忽略右键菜单等导致的 body class 微小变化）
    const kind = getThemeKind();
    if (kind === _lastKind) return;
    _lastKind = kind;
    _version++;
    _listeners.forEach((l) => l());
  });
  _observer.observe(document.body, {
    attributes: true,
    attributeFilter: ["class", "data-vscode-theme-id", "data-vscode-theme-kind"],
  });
}

/** 当前主题版本号（每次主题变化递增）。用作 useSyncExternalStore 的快照。 */
export function getThemeVersion(): number {
  return _version;
}

/** 订阅主题变化。返回取消订阅函数。首个订阅者会懒启动单例 MutationObserver。 */
export function subscribeThemeChange(listener: () => void): () => void {
  ensureObserver();
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

/** React Hook：返回主题版本号，主题切换时触发组件重渲染。 */
export function useThemeVersion(): number {
  return useSyncExternalStore(subscribeThemeChange, getThemeVersion, getThemeVersion);
}

/** React Hook：当前主题种类，随主题切换更新。 */
export function useThemeKind(): ThemeKind {
  useThemeVersion();
  return getThemeKind();
}

/** React Hook：当前是否暗色主题，随主题切换更新。 */
export function useIsDark(): boolean {
  useThemeVersion();
  return isDarkTheme();
}
