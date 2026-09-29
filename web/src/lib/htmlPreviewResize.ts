/**
 * htmlPreviewResize —— HTML 预览 iframe 的高度自适应。
 *
 * 预览 iframe 最初写死 `height:400px`：内容短时（例如两个按钮加一行说明）那 400px 里
 * 绝大部分是空白，看着像"渲染出了一大片空隙" —— 而那与 AI 写的 HTML 无关，是容器高度固定所致。
 * 高度应当由内容决定。
 *
 * ── 为什么最终是「父页测量」，而不是「iframe 自己上报」 ──
 * 先试的是后者：往 srcdoc 注入测量脚本、量完经 postMessage 上报。它在真实 webview 里连撞两道墙：
 *   ① 内联脚本被 CSP 拦。webview 的 `script-src` 只有 cspSource、不含 'unsafe-inline'，
 *      而 srcdoc 会继承父文档的 CSP。
 *   ② 外部脚本同样到不了。`vscode-webview://` 的协议处理器只放行三个固定文件
 *      （/index.html、/fake.html、/service-worker.js —— 见
 *      vs/platform/webview/electron-main/webviewProtocolProvider.ts，其余一律 403）；
 *      扩展自身的资源实际由 service-worker.js 提供，而它只控制同源客户端 ——
 *      沙箱 iframe 是不透明源，不在其管辖内。CDN 脚本也被 CSP 挡着。
 * 两条合起来意味着：**沙箱 iframe 里根本执行不了任何脚本**。也就是说，此前挂在沙箱上的
 * `allow-scripts` 一直是空转的（demo 里的交互从未真正生效过）。
 *
 * 既然脚本这条路封死，就换成父页直接读 `contentDocument` 测量 —— 不注入任何脚本，
 * 于是不受 CSP、协议处理器、ServiceWorker 任何一环影响。
 *
 * ── 安全上为什么可以这么做 ──
 * 父页读 contentDocument 需要 iframe 开 `allow-same-origin`。与此同时把 `allow-scripts` 去掉：
 * iframe 内没有任何脚本可执行，那份同源访问权就无从被利用。净效果与今天（脚本本就跑不起来）
 * 一致，而隔离边界比"挂着 allow-scripts 其实跑不起来"更明确。
 */

/**
 * 注入预览文档的样式前奏（放在内容之前，内容里的同名声明可覆盖它）。
 *
 * 两部分都是测量所必需的：
 * · 滚动条：内容超过高度上限时由 iframe 内部滚动。原生滚动条**完全隐藏、不占位**，
 *   可见滑块由父页的 lib/overlayScrollbar.ts 浮在 iframe 上方绘制。
 *   ⚠️ 不能用"默认 none、hover 改 thin"：那会让 hover 时内容区突然少 6px，
 *   文字重新折行、整块内容抖一下（纵向滚动条挤宽度，横向滚动条挤高度）。
 * · body 外边距归零：默认 8px 会与高度自适应形成正反馈 ——
 *   内容若用 vh 这类视口单位，其高度等于 iframe 高度（正是待解的量），
 *   每轮再把 8+8 的外边距算进去，就是每轮凭空涨 16px，一路顶到上限。
 *   （测量侧也刻意不计外边距，两处必须一致。）
 */
export const HTML_PREVIEW_PRELUDE = `<style>html{overflow-y:auto;scrollbar-width:none}html::-webkit-scrollbar{display:none}body{margin:0}</style>`;

/**
 * iframe 沙箱属性。
 *
 * 只开 `allow-same-origin`（父页据此读 contentDocument 自行测量），**刻意不开 allow-scripts**：
 * 沙箱内本就执行不了任何脚本（见文件头），开着只会让"能执行脚本"这一前提显得成立，
 * 从而掩盖真实边界。不开 allow-forms / allow-popups / allow-top-navigation 等同理 —— 用不到就不给。
 */
export const HTML_PREVIEW_SANDBOX = "allow-same-origin";

/**
 * 高度下限：内容极短时也留一点可视面积，免得看起来像没渲染出来。
 * 取得很小是刻意的 —— 这个文件的初衷就是别浪费垂直空间。
 */
export const HTML_PREVIEW_MIN_HEIGHT = 48;

/**
 * 高度上限：超出后交由 iframe 内部滚动（前奏里已开 `html{overflow-y:auto}`）。
 * 用 600 而不是最初的 400：稍高一点的演示（表单、小布局）在 400 下会白白冒出内部滚动条。
 */
export const HTML_PREVIEW_MAX_HEIGHT = 600;

/**
 * 测量失败时使用的兜底高度。
 *
 * 可读优先于紧凑 —— 这条路径本就是异常路径：宁可多留一点白（超出可滚动），
 * 也不要把内容裁成一条。正常路径下测量是同步且可靠的（同源文档），兜底基本不会被用到。
 */
export const HTML_PREVIEW_FALLBACK_HEIGHT = 240;

/** 把测量到的原始高度夹到可用区间；非法值退回下限（而非 0 —— 那会让预览消失） */
export function clampHtmlPreviewHeight(measured: number): number {
  if (!Number.isFinite(measured) || measured <= 0) return HTML_PREVIEW_MIN_HEIGHT;
  return Math.min(Math.max(Math.round(measured), HTML_PREVIEW_MIN_HEIGHT), HTML_PREVIEW_MAX_HEIGHT);
}

/**
 * 让预览 iframe 随内容自适应高度。
 *
 * 测量在 `load` 之后进行，并在内容变化时（图片加载、`<details>` 展开、CSS :checked 切换等）
 * 通过 ResizeObserver 重测 —— 这些交互不依赖脚本，所以在无脚本的沙箱里照样会发生。
 *
 * 取 scrollHeight 而非只取矩形高度：内容用 vh 时矩形高度恒等于视口高度（正是待解的量），
 * 会与"按内容调整高度"形成正反馈；scrollHeight 反映内容真实占用，调整后能收敛。
 *
 * @param frame 预览 iframe（需已设 sandbox="allow-same-origin"，否则读不到 contentDocument）
 * @param onSized 每次量到新高度后回调。调用方用它更新 hydrate 缓存 ——
 *                必须等测量完成后再缓存，否则缓存里存的是初始高度。
 */
export function attachHtmlPreviewAutoHeight(frame: HTMLIFrameElement, onSized?: () => void): void {
  let observer: ResizeObserver | null = null;

  /** 量当前内容高度；文档尚未就绪时返回 null（区别于"高度为 0"） */
  const measure = (): number | null => {
    const doc = frame.contentDocument;
    const de = doc?.documentElement;
    if (!doc || !de) return null;
    const body = doc.body;
    // 刻意不加 body 外边距：它是常量，而视口单位内容会把高度反馈到自身，每轮再加一遍就是正反馈
    const raw = Math.max(
      de.scrollHeight,
      body ? body.scrollHeight : 0,
      body ? body.getBoundingClientRect().height : 0,
    );
    return raw > 0 ? raw : null;
  };

  const apply = (useFallback: boolean): void => {
    const raw = measure();
    if (raw === null) {
      // 量不到（文档未就绪 / 意外被拒）：退回可读高度，别停在初始的极小值上把内容裁掉
      if (useFallback && frame.isConnected) frame.style.height = `${HTML_PREVIEW_FALLBACK_HEIGHT}px`;
      return;
    }
    const px = `${clampHtmlPreviewHeight(raw)}px`;
    if (frame.style.height === px) return;
    frame.style.height = px;
    onSized?.();
  };

  frame.addEventListener("load", () => {
    // 重新挂观察器：srcdoc 每次加载都是新文档，旧文档上的观察目标已失效
    observer?.disconnect();
    const doc = frame.contentDocument;
    if (!doc?.documentElement) {
      // 读不到文档（未开 allow-same-origin、或加载被拒）：退回可读高度。
      // ⚠️ 这里不能直接 return —— 那会把兜底一并跳过，内容就被裁在初始的极小值上，
      // 正是兜底本该防住的情形（验证时由反例用例抓到过）。
      if (frame.isConnected) frame.style.height = `${HTML_PREVIEW_FALLBACK_HEIGHT}px`;
      return;
    }
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => apply(false));
      observer.observe(doc.documentElement);
      if (doc.body) observer.observe(doc.body);
    }
    apply(true);
  });
}
