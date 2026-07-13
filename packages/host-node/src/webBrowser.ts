/**
 * PlaywrightBrowser —— 基于 playwright-core 的 HostWebBrowser 实现
 *
 * 驱动一个真实 Chromium（优先复用系统已装的 Chrome/Edge，channel 方式不下载二进制），
 * 通过 CDP 订阅控制台、未捕获异常、失败网络请求，并支持截图。headful 运行，用户可见页面。
 *
 * 设计：
 * - 单浏览器单页：再次 open 同一实例导航即可（避免开一堆窗口）。
 * - playwright-core 运行时动态 import：未用到浏览器能力时零开销，缺依赖时给清晰报错。
 * - 日志/异常/网络失败进环形缓冲，getLogs 可选清空。
 */

import type { Browser, Page, ConsoleMessage, Request, Response } from "playwright-core";
import type {
  HostWebBrowser,
  OpenBrowserResult,
  BrowserLogsSnapshot,
  BrowserConsoleEntry,
  BrowserPageError,
  BrowserNetworkFailure,
  BrowserNetworkEntry,
  NetworkFilter,
  BrowserLogLevel,
  ScreenshotResult,
} from "@axon/core";

const MAX_CONSOLE = 500;
const MAX_ERRORS = 200;
const MAX_NETWORK = 200;
const MAX_NETWORK_ENTRIES = 1000;

export class PlaywrightBrowser implements HostWebBrowser {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private console: BrowserConsoleEntry[] = [];
  private pageErrors: BrowserPageError[] = [];
  private networkFailures: BrowserNetworkFailure[] = [];
  private networkEntries: BrowserNetworkEntry[] = [];
  /** 请求开始时间（用于计算 duration） */
  private requestStartTimes = new Map<Request, number>();

  isOpen(): boolean {
    return !!this.page && !this.page.isClosed();
  }

  async open(url: string): Promise<OpenBrowserResult> {
    const reused = this.isOpen();
    const page = await this.ensurePage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    let title: string | undefined;
    try { title = await page.title(); } catch { /* 忽略 */ }
    return { url, title, reused };
  }

  async getLogs(clear = false): Promise<BrowserLogsSnapshot | null> {
    if (!this.isOpen()) return null;
    const snapshot: BrowserLogsSnapshot = {
      url: this.page!.url(),
      console: [...this.console],
      pageErrors: [...this.pageErrors],
      networkFailures: [...this.networkFailures],
    };
    if (clear) {
      this.console = [];
      this.pageErrors = [];
      this.networkFailures = [];
    }
    return snapshot;
  }

  async getNetworkRequests(filter?: NetworkFilter, clear = false): Promise<BrowserNetworkEntry[] | null> {
    if (!this.isOpen()) return null;
    let entries = [...this.networkEntries];
    if (filter) {
      if (filter.urlContains) {
        const lower = filter.urlContains.toLowerCase();
        entries = entries.filter((e) => e.url.toLowerCase().includes(lower));
      }
      if (filter.method) {
        const m = filter.method.toUpperCase();
        entries = entries.filter((e) => e.method.toUpperCase() === m);
      }
      if (typeof filter.statusMin === "number") entries = entries.filter((e) => e.status !== null && e.status >= filter.statusMin!);
      if (typeof filter.statusMax === "number") entries = entries.filter((e) => e.status !== null && e.status <= filter.statusMax!);
      if (filter.resourceType) {
        const rt = filter.resourceType.toLowerCase();
        entries = entries.filter((e) => e.resourceType.toLowerCase() === rt);
      }
    }
    const limit = filter?.limit ?? 50;
    entries = entries.slice(-limit);
    if (clear) this.networkEntries = [];
    return entries;
  }

  async screenshot(fullPage = false): Promise<ScreenshotResult | null> {
    if (!this.isOpen()) return null;
    const buf = await this.page!.screenshot({ fullPage, type: "png" });
    const rawDataUrl = `data:image/png;base64,${buf.toString("base64")}`;
    // 截图可能超过多模态模型的尺寸上限（Claude 多图请求限制 2000px，超出会 400）。
    // 在浏览器页面上下文里用 canvas 等比缩小到 2000px 以内，避免下游报错。
    const resized = await this.downscaleDataUrl(rawDataUrl, 2000).catch(() => rawDataUrl);
    return { dataUrl: resized };
  }

  /** 在页面上下文用 canvas 把超尺寸截图等比缩小（≤maxDim），返回 JPEG data URL。失败则原样返回。 */
  private async downscaleDataUrl(dataUrl: string, maxDim: number): Promise<string> {
    if (!this.isOpen()) return dataUrl;
    // 回调体在浏览器页面上下文执行（有 DOM API）；Node 侧类型库不含 DOM，
    // 故用 Function 构造 + any 规避编译期的 Image/document 未定义报错。
    const browserFn = new Function("arg", `
      return (async () => {
        const { src, max } = arg;
        const img = new Image();
        await new Promise((resolve, reject) => {
          img.onload = () => resolve(undefined);
          img.onerror = () => reject(new Error("image load failed"));
          img.src = src;
        });
        const width = img.width, height = img.height;
        if (width <= max && height <= max) return src;
        const scale = max / Math.max(width, height);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return src;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.85);
      })();
    `) as (arg: { src: string; max: number }) => Promise<string>;
    return await this.page!.evaluate(browserFn, { src: dataUrl, max: maxDim });
  }

  async close(): Promise<boolean> {
    if (!this.browser) return false;
    try { await this.browser.close(); } catch { /* 忽略 */ }
    this.browser = null;
    this.page = null;
    return true;
  }

  async focus(): Promise<boolean> {
    if (!this.isOpen()) return false;
    try { await this.page!.bringToFront(); return true; } catch { return false; }
  }

  async click(selector: string): Promise<void> {
    if (!this.isOpen()) throw new Error("浏览器未打开");
    await this.page!.click(selector, { timeout: 10_000 });
  }

  async fill(selector: string, text: string): Promise<void> {
    if (!this.isOpen()) throw new Error("浏览器未打开");
    await this.page!.fill(selector, text, { timeout: 10_000 });
  }

  async press(key: string): Promise<void> {
    if (!this.isOpen()) throw new Error("浏览器未打开");
    await this.page!.keyboard.press(key);
  }

  async select(selector: string, value: string): Promise<void> {
    if (!this.isOpen()) throw new Error("浏览器未打开");
    await this.page!.selectOption(selector, value, { timeout: 10_000 });
  }

  async scroll(direction: "up" | "down" | "top" | "bottom"): Promise<void> {
    if (!this.isOpen()) throw new Error("浏览器未打开");
    switch (direction) {
      case "down": await this.page!.mouse.wheel(0, 600); break;
      case "up": await this.page!.mouse.wheel(0, -600); break;
      case "bottom": await this.page!.evaluate("window.scrollTo(0, document.body.scrollHeight)"); break;
      case "top": await this.page!.evaluate("window.scrollTo(0, 0)"); break;
    }
  }

  async reload(): Promise<void> {
    if (!this.isOpen()) throw new Error("浏览器未打开");
    await this.page!.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
  }

  async getStorage(type: "localStorage" | "sessionStorage" | "cookies", keyContains?: string): Promise<Record<string, string> | null> {
    if (!this.isOpen()) return null;
    let entries: Record<string, string>;
    if (type === "cookies") {
      const cookies = await this.page!.context().cookies();
      entries = {};
      for (const c of cookies) entries[c.name] = c.value;
    } else {
      // localStorage / sessionStorage: 在页面上下文里 evaluate 取全量
      entries = await this.page!.evaluate((storageType: string) => {
        const s = storageType === "localStorage" ? localStorage : sessionStorage;
        const result: Record<string, string> = {};
        for (let i = 0; i < s.length; i++) {
          const key = s.key(i);
          if (key !== null) result[key] = s.getItem(key) ?? "";
        }
        return result;
      }, type);
    }
    // 按 key 过滤
    if (keyContains) {
      const lower = keyContains.toLowerCase();
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(entries)) {
        if (k.toLowerCase().includes(lower)) filtered[k] = v;
      }
      return filtered;
    }
    return entries;
  }

  async evaluate(js: string): Promise<string | null> {
    if (!this.isOpen()) return null;
    const result = await this.page!.evaluate(js);
    if (result === undefined || result === null) return "undefined";
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  }

  async hover(selector: string): Promise<void> {
    if (!this.isOpen()) throw new Error("浏览器未打开");
    await this.page!.hover(selector, { timeout: 10_000 });
  }

  async wait(selector?: string, ms?: number): Promise<void> {
    if (!this.isOpen()) throw new Error("浏览器未打开");
    if (selector) await this.page!.waitForSelector(selector, { timeout: 30_000 });
    if (ms && ms > 0) await this.page!.waitForTimeout(Math.min(ms, 30_000));
  }

  async getHtml(selector?: string): Promise<string | null> {
    if (!this.isOpen()) return null;
    if (selector) {
      const el = await this.page!.$(selector);
      if (!el) return null;
      return await el.evaluate((e) => (e as any).outerHTML as string);
    }
    return await this.page!.evaluate("document.body.outerHTML");
  }

  async setViewport(width: number, height: number): Promise<void> {
    if (!this.isOpen()) throw new Error("浏览器未打开");
    await this.page!.setViewportSize({ width, height });
  }

  async goBack(): Promise<void> {
    if (!this.isOpen()) throw new Error("浏览器未打开");
    await this.page!.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
  }

  async goForward(): Promise<void> {
    if (!this.isOpen()) throw new Error("浏览器未打开");
    await this.page!.goForward({ waitUntil: "domcontentloaded", timeout: 15_000 });
  }

  /** 确保浏览器与页面就绪，并挂好事件监听（只挂一次） */
  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    const { chromium } = await import("playwright-core");
    // 优先复用系统已装浏览器（不下载二进制）：Chrome → Edge → 回退到 playwright 自带 chromium
    let browser: Browser | null = null;
    const attempts: Array<{ channel?: string }> = [{ channel: "chrome" }, { channel: "msedge" }, {}];
    let lastErr: unknown;
    for (const opt of attempts) {
      try {
        browser = await chromium.launch({ headless: false, ...opt });
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!browser) {
      throw new Error(
        `无法启动浏览器：未找到可用的 Chrome/Edge，playwright 自带 Chromium 也未安装。` +
        `请安装 Chrome，或运行 \`npx playwright install chromium\`。原始错误：${(lastErr as Error)?.message || lastErr}`,
      );
    }
    this.browser = browser;
    const page = await browser.newPage();
    this.page = page;
    this.attachListeners(page);
    // 用户手动关闭窗口时清理
    browser.on("disconnected", () => { this.browser = null; this.page = null; });
    return page;
  }

  private attachListeners(page: Page): void {
    page.on("console", (msg: ConsoleMessage) => {
      const type = msg.type();
      const level: BrowserLogLevel =
        type === "error" ? "error" : type === "warning" ? "warn" : type === "debug" ? "debug" : type === "info" ? "info" : "log";
      const loc = msg.location();
      this.push(this.console, {
        level,
        text: msg.text(),
        location: loc?.url ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : undefined,
        ts: Date.now(),
      }, MAX_CONSOLE);
    });
    page.on("pageerror", (err: Error) => {
      this.push(this.pageErrors, { message: err.message, stack: err.stack, ts: Date.now() }, MAX_ERRORS);
    });
    page.on("requestfailed", (req: Request) => {
      this.push(this.networkFailures, {
        url: req.url(),
        method: req.method(),
        failure: req.failure()?.errorText,
        ts: Date.now(),
      }, MAX_NETWORK);
      // 也记入全量网络日志
      const start = this.requestStartTimes.get(req);
      this.push(this.networkEntries, {
        url: req.url(),
        method: req.method(),
        status: null,
        resourceType: req.resourceType(),
        duration: start ? Date.now() - start : null,
        size: null,
        failure: req.failure()?.errorText,
        ts: Date.now(),
      }, MAX_NETWORK_ENTRIES);
      this.requestStartTimes.delete(req);
    });
    page.on("request", (req: Request) => {
      this.requestStartTimes.set(req, Date.now());
    });
    page.on("response", (res: Response) => {
      const status = res.status();
      const req = res.request();
      const start = this.requestStartTimes.get(req);
      this.requestStartTimes.delete(req);
      // 全量网络日志
      this.push(this.networkEntries, {
        url: res.url(),
        method: req.method(),
        status,
        resourceType: req.resourceType(),
        duration: start ? Date.now() - start : null,
        size: Number(res.headers()["content-length"] || 0) || null,
        ts: Date.now(),
      }, MAX_NETWORK_ENTRIES);
      // 失败请求也进 networkFailures（保持向后兼容）
      if (status >= 400) {
        this.push(this.networkFailures, {
          url: res.url(),
          method: req.method(),
          status,
          ts: Date.now(),
        }, MAX_NETWORK);
      }
    });
  }

  private push<T>(arr: T[], item: T, max: number): void {
    arr.push(item);
    if (arr.length > max) arr.splice(0, arr.length - max);
  }
}
