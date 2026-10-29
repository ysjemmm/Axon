/**
 * htmlPreviewResize —— 聊天里 HTML 预览 iframe 的脚本放行、隔离与高度自适应。
 *
 * ── 为什么之前点不动 ──
 * 插件页面的 CSP 只允许加载插件自己的脚本文件，而 srcdoc iframe 会继承父页面的 CSP，
 * 所以 AI 写的 <script> 和 onclick 一个都执行不了，HTML 预览只能看不能点。
 *
 * ── 现在的做法 ──
 * · 插件给页面 CSP 加一个随机 nonce（每次生成页面换一个），并通过 <meta name="axon-csp-nonce"> 告诉前端。
 *   预览内容里的每个 <script>（包括引用 CDN 的外部脚本）都补上这个 nonce，于是能运行。
 *   独立 Web 版没有 CSP，不需要 nonce，脚本本来就能跑。
 * · 内联事件（onclick="..."）没法用 nonce 放行。预览里先试一下内联事件能不能触发，
 *   不能的话就把 on* 属性转成 addEventListener（CSP 为此带了 'unsafe-eval'），包括之后动态插入的元素。
 * · 隔离：iframe 只开 allow-scripts，**不开 allow-same-origin**。预览是不透明源，
 *   脚本读不到主页面的 DOM、拿不到和插件通信的接口；能做的只有 postMessage。
 *   （同时开这两个等于让 AI 写的脚本拿到主页面全部权限，可以替用户执行命令，绝不能开。）
 * · 高度：不能再从父页读 contentDocument 了，改由预览里的引导脚本测量后 postMessage 上报，
 *   父页只认来自这个 iframe 的消息（比对 event.source）。
 * · 链接：沙箱里点链接会把 iframe 自己导航走，引导脚本拦下来交给父页用系统浏览器打开。
 */

/**
 * 样式前奏（放在内容之前，内容里的同名声明可覆盖它）。
 * · 滚动条：超出高度上限时 iframe 内部滚动，用细滚动条且始终保留位置，内容不会因为滚动条出现而抖动
 * · body 外边距归零：默认 8px 会与高度自适应形成正反馈 —— 内容用 vh 时每轮凭空涨 16px，一路顶到上限
 */
const PRELUDE_STYLE = `<style>html{overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(128,128,128,.4) transparent}body{margin:0}</style>`;

/** 预览里的引导脚本：上报高度、拦截链接、必要时把内联事件转成监听器 */
const BOOT_SCRIPT = `(function(){
var last=-1;
function report(){var d=document.documentElement,b=document.body;if(!d)return;
var h=Math.max(d.scrollHeight,b?b.scrollHeight:0,b?b.getBoundingClientRect().height:0);
if(h!==last){last=h;parent.postMessage({axonHtmlPreview:"height",height:h},"*");}}
var inlineOk=false;
try{var t=document.createElement("div");t.setAttribute("onclick","window.__axonInlineOk=1");t.click();inlineOk=!!window.__axonInlineOk;}catch(e){}
function fix(el){if(!el||el.nodeType!==1||!el.attributes)return;
for(var i=el.attributes.length-1;i>=0;i--){var a=el.attributes[i];if(!/^on[a-z]+$/i.test(a.name))continue;
var fn;try{fn=new Function("event",a.value);}catch(e){continue;}
var type=a.name.slice(2).toLowerCase();el.removeAttribute(a.name);
el.addEventListener(type,(function(f){return function(ev){if(f.call(this,ev)===false)ev.preventDefault();};})(fn));}}
function fixTree(root){fix(root);if(root.querySelectorAll){var all=root.querySelectorAll("*");for(var i=0;i<all.length;i++)fix(all[i]);}}
function start(){
if(!inlineOk){fixTree(document.documentElement);
new MutationObserver(function(ms){ms.forEach(function(m){if(m.type==="attributes")fix(m.target);else m.addedNodes.forEach(function(n){fixTree(n);});});})
.observe(document.documentElement,{subtree:true,childList:true,attributes:true});}
if(window.ResizeObserver){var ro=new ResizeObserver(report);ro.observe(document.documentElement);if(document.body)ro.observe(document.body);}
report();}
document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;
var href=a.getAttribute("href")||"";if(!href||href.charAt(0)==="#"||/^javascript:/i.test(href))return;
e.preventDefault();try{href=new URL(href,location.href).href;}catch(x){}
if(/^(https?|mailto):/i.test(href))parent.postMessage({axonHtmlPreview:"open",url:href},"*");});
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
window.addEventListener("load",report);
})();`;

/** 插件注入的 CSP nonce；独立 Web 版没有，返回空串 */
export function readCspNonce(): string {
  if (typeof document === "undefined") return "";
  return document.querySelector<HTMLMetaElement>('meta[name="axon-csp-nonce"]')?.content ?? "";
}

/** 给内容里所有没有 nonce 的 <script> 补上 nonce */
export function addScriptNonce(content: string, nonce: string): string {
  if (!nonce) return content;
  return content.replace(/<script\b(?![^>]*\bnonce\s*=)/gi, `<script nonce="${nonce}"`);
}

/** 组装预览文档：样式前奏 + 引导脚本 + 内容 */
export function buildHtmlPreviewDoc(content: string, nonce: string = readCspNonce()): string {
  const boot = `<script${nonce ? ` nonce="${nonce}"` : ""}>${BOOT_SCRIPT}</script>`;
  return PRELUDE_STYLE + boot + addScriptNonce(content, nonce);
}

/**
 * iframe 沙箱：允许脚本、表单、弹窗提示（alert/confirm）。
 * ⚠️ 不开 allow-same-origin（原因见文件头），也不开 allow-top-navigation / allow-popups。
 */
export const HTML_PREVIEW_SANDBOX = "allow-scripts allow-forms allow-modals";

/** 高度下限：内容极短时也留一点可视面积，免得看起来像没渲染出来 */
export const HTML_PREVIEW_MIN_HEIGHT = 48;

/** 高度上限：超出后交由 iframe 内部滚动 */
export const HTML_PREVIEW_MAX_HEIGHT = 600;

/**
 * 兜底高度：加载后一直收不到上报（脚本被拦，例如旧版插件没有下发 nonce）时用。
 * 可读优先于紧凑：宁可多留一点白，也不要把内容裁成一条。
 */
export const HTML_PREVIEW_FALLBACK_HEIGHT = 240;

/** 加载后等待高度上报的时间，超时就用兜底高度 */
const REPORT_TIMEOUT_MS = 1500;

/** 把上报的原始高度夹到可用区间；非法值退回下限（而非 0 —— 那会让预览消失） */
export function clampHtmlPreviewHeight(measured: number): number {
  if (!Number.isFinite(measured) || measured <= 0) return HTML_PREVIEW_MIN_HEIGHT;
  return Math.min(Math.max(Math.round(measured), HTML_PREVIEW_MIN_HEIGHT), HTML_PREVIEW_MAX_HEIGHT);
}

type PreviewMessage = { axonHtmlPreview: "height"; height: number } | { axonHtmlPreview: "open"; url: string };

const frames = new Map<Window, { frame: HTMLIFrameElement; onSized?: () => void; onOpen?: (url: string) => void }>();
let listening = false;

function onMessage(e: MessageEvent): void {
  const data = e.data as PreviewMessage | null;
  if (!data || typeof data !== "object" || !("axonHtmlPreview" in data) || !e.source) return;
  const entry = frames.get(e.source as Window);
  if (!entry) return;
  if (!entry.frame.isConnected) { frames.delete(e.source as Window); return; }
  entry.frame.dataset.previewReported = "1";
  if (data.axonHtmlPreview === "height") {
    const px = `${clampHtmlPreviewHeight(Number(data.height))}px`;
    if (entry.frame.style.height === px) return;
    entry.frame.style.height = px;
    entry.onSized?.();
  } else if (data.axonHtmlPreview === "open" && typeof data.url === "string" && /^(https?|mailto):/i.test(data.url)) {
    entry.onOpen?.(data.url);
  }
}

/**
 * 让预览 iframe 随内容自适应高度，并转交预览里点的链接。
 * 也用于从缓存克隆回来的 iframe（克隆会重新加载，需要重新登记）。
 *
 * @param onSized 每次高度变化后回调。调用方用它更新 hydrate 缓存 —— 必须等量好高度后再缓存
 * @param onOpen  预览里点了外部链接
 */
export function attachHtmlPreviewAutoHeight(frame: HTMLIFrameElement, onSized?: () => void, onOpen?: (url: string) => void): void {
  if (!listening && typeof window !== "undefined") {
    window.addEventListener("message", onMessage);
    listening = true;
  }
  const register = () => {
    // 已经从页面移除的 iframe 顺手清掉
    for (const [win, entry] of frames) if (!entry.frame.isConnected) frames.delete(win);
    if (frame.contentWindow) frames.set(frame.contentWindow, { frame, onSized, onOpen });
  };
  // contentWindow 在插入文档后才有，且每次重新加载可能换成新的
  frame.addEventListener("load", () => {
    register();
    setTimeout(() => {
      if (frame.isConnected && !frame.dataset.previewReported) frame.style.height = `${HTML_PREVIEW_FALLBACK_HEIGHT}px`;
    }, REPORT_TIMEOUT_MS);
  });
  if (frame.isConnected) register();
  else queueMicrotask(register);
}
