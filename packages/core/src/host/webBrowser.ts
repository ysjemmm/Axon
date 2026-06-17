/**
 * HostWebBrowser —— 网页浏览器能力（CDP/Playwright 驱动，执行端 ① 的一部分）
 *
 * 目的：让 Agent 能"看见"前端运行时——打开 dev server 页面，读取控制台日志、未捕获异常、
 * 失败的网络请求，并截图。配合 start_process 起开发服务器，形成
 * 「改代码 → 看控制台/报错 → 截图确认 → 继续修」的闭环。
 *
 * 与 DirectoryBrowser（host.browser，目录下钻选择器）完全不同，故命名 webBrowser 以区分。
 *
 * 实现：基于 playwright-core 驱动一个真实 Chromium（优先复用系统 Chrome，channel="chrome"），
 * 通过 CDP 订阅 console / pageerror / requestfailed / 4xx-5xx 响应。不支持的形态为 undefined。
 */

/** 控制台日志级别 */
export type BrowserLogLevel = "log" | "info" | "warn" | "error" | "debug";

/** 一条控制台日志 */
export interface BrowserConsoleEntry {
  level: BrowserLogLevel;
  text: string;
  /** 来源位置（file:line:col），可空 */
  location?: string;
  ts: number;
}

/** 一条未捕获的页面异常 / Promise rejection */
export interface BrowserPageError {
  message: string;
  stack?: string;
  ts: number;
}

/** 一条失败/异常状态的网络请求（请求失败，或响应 >= 400） */
export interface BrowserNetworkFailure {
  url: string;
  method: string;
  /** HTTP 状态码（请求彻底失败时为空） */
  status?: number;
  /** 失败原因（如 net::ERR_CONNECTION_REFUSED），仅 requestfailed 时有 */
  failure?: string;
  ts: number;
}

/** 一条完整的网络请求记录（含成功与失败） */
export interface BrowserNetworkEntry {
  url: string;
  method: string;
  status: number | null;
  /** 资源类型（xhr/fetch/document/stylesheet/script/image/font/websocket 等） */
  resourceType: string;
  /** 耗时 ms（从发起到响应完成）；未完成时为 null */
  duration: number | null;
  /** 响应大小（字节，近似）；无法获取时为 null */
  size: number | null;
  /** 失败原因（仅请求彻底失败时）*/
  failure?: string;
  ts: number;
}

/** 网络请求过滤条件 */
export interface NetworkFilter {
  /** URL 包含（子串匹配，不区分大小写） */
  urlContains?: string;
  /** HTTP 方法（GET/POST/...，不区分大小写） */
  method?: string;
  /** 状态码范围：只返回 status >= min 的 */
  statusMin?: number;
  /** 状态码范围：只返回 status <= max 的 */
  statusMax?: number;
  /** 资源类型过滤（xhr/fetch/document/stylesheet/script/image 等） */
  resourceType?: string;
  /** 最多返回条数（默认 50） */
  limit?: number;
}

/** 打开/导航结果 */
export interface OpenBrowserResult {
  url: string;
  title?: string;
  /** 是否复用了已打开的浏览器实例 */
  reused: boolean;
}

/** 日志快照 */
export interface BrowserLogsSnapshot {
  url: string;
  console: BrowserConsoleEntry[];
  pageErrors: BrowserPageError[];
  networkFailures: BrowserNetworkFailure[];
}

/** 截图结果 */
export interface ScreenshotResult {
  /** data:image/png;base64,... 形式，便于直接喂给多模态模型 */
  dataUrl: string;
}

/** Agent 可用的网页浏览器能力 */
export interface HostWebBrowser {
  /**
   * 打开（或导航到）指定 URL。已有打开的浏览器则复用并导航，reused=true。
   * 启动失败（如无可用 Chrome）应抛错，由 core 转成清晰的工具错误反馈给模型。
   */
  open(url: string): Promise<OpenBrowserResult>;

  /**
   * 读取自上次 clear（或打开以来）累积的控制台日志 / 页面异常 / 网络失败。
   * @param clear 读取后是否清空缓冲（默认 false）。
   * @returns 浏览器未打开时返回 null。
   */
  getLogs(clear?: boolean): Promise<BrowserLogsSnapshot | null>;

  /**
   * 读取全量网络请求记录，支持过滤。AI 可按 URL/方法/状态码/资源类型精确查询想看的请求。
   * @param filter 过滤条件（全部可选，不传则返回最近 50 条）。
   * @param clear 读取后是否清空缓冲（默认 false）。
   * @returns 浏览器未打开时返回 null。
   */
  getNetworkRequests(filter?: NetworkFilter, clear?: boolean): Promise<BrowserNetworkEntry[] | null>;

  /**
   * 对当前页面截图。
   * @param fullPage 是否整页截图（默认 false，只截可视区）。
   * @returns 浏览器未打开时返回 null。
   */
  screenshot(fullPage?: boolean): Promise<ScreenshotResult | null>;

  /** 关闭浏览器并回收资源。未打开返回 false。 */
  close(): Promise<boolean>;

  /** 把浏览器窗口/页面带到前台（前端"点击聚焦"用）。未打开返回 false。 */
  focus(): Promise<boolean>;

  /** 点击页面上的元素。selector 为 CSS 选择器或 Playwright 文本选择器（如 "text=登录"）。 */
  click(selector: string): Promise<void>;

  /** 在输入框中填入文本（先清空再输入）。 */
  fill(selector: string, text: string): Promise<void>;

  /** 模拟键盘按键（如 Enter、Tab、Escape）。 */
  press(key: string): Promise<void>;

  /** 选择下拉框选项（select 元素）。 */
  select(selector: string, value: string): Promise<void>;

  /** 滚动页面。direction: up/down/top/bottom。 */
  scroll(direction: "up" | "down" | "top" | "bottom"): Promise<void>;

  /** 刷新当前页面。 */
  reload(): Promise<void>;

  /**
   * 读取页面存储（localStorage / sessionStorage / cookies）。
   * @param type 存储类型
   * @param keyContains 可选：只返回 key 包含此子串的条目
   */
  getStorage(type: "localStorage" | "sessionStorage" | "cookies", keyContains?: string): Promise<Record<string, string> | null>;

  /** 在页面上下文中执行任意 JavaScript 并返回结果（序列化为字符串）。 */
  evaluate(js: string): Promise<string | null>;

  /** 悬停在指定元素上（触发 tooltip/hover 效果）。 */
  hover(selector: string): Promise<void>;

  /** 等待条件满足：传 selector 则等该元素出现；传 ms 则等固定时间；都传则先等元素再等时间。 */
  wait(selector?: string, ms?: number): Promise<void>;

  /** 读取页面指定区域的 outerHTML（不传 selector 读整个 body）。 */
  getHtml(selector?: string): Promise<string | null>;

  /** 设置浏览器视口大小（测试响应式布局）。 */
  setViewport(width: number, height: number): Promise<void>;

  /** 浏览器后退。 */
  goBack(): Promise<void>;

  /** 浏览器前进。 */
  goForward(): Promise<void>;

  /** 当前是否有打开的浏览器。 */
  isOpen(): boolean;
}
