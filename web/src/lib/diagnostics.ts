/**
 * 前端"飞行记录仪"（diagnostics）—— 捕获偶发的主线程长时间阻塞。
 *
 * 要解决的故障：AI 回复过程中界面整片变灰、失去响应，但后端仍在继续输出。
 * 这类故障的两个难点：
 *   ① 无法稳定复现，靠人工盯着看不出触发条件；
 *   ② 最关键的是——一旦主线程被占满，渲染进程**已经没有机会再执行任何代码去记录现场**。
 *
 * 所以这里不依赖"卡住时打日志"，而是靠两个互补手段：
 *
 * ── 手段一：卡死前留痕（唯一能在进程已死时留下证据的办法）──
 * 在"已知可能很慢的操作"开始【之前】把标记写进 localStorage，操作结束【之后】清除。
 * 如果进程在操作途中卡死，清不掉标记，它就留在了存储里；下次启动读到它，
 * 即可直接知道"上次是卡在哪个操作上、已经持续了多久"。
 * 配合 pagehide 在正常关闭时清标记，可把误报（正常退出）排除掉。
 *
 * ── 手段二：对未能预先标注的阻塞做兜底捕获 ──
 *   · longtask 观察：浏览器原生上报的 >150ms 长任务
 *   · 帧间隔检测：正常一帧约 16ms，间隔突增说明主线程被占用（并能立刻指出当时在跑哪个 span）
 *   · 错误捕获：uncaught error / unhandledrejection
 *
 * 诊断本身绝不能反过来影响功能：所有存储读写、观察器注册都包在 try/catch 里，失败静默忽略。
 */

/** 历史事件记录（环形缓冲，持久化） */
const RECORDS_KEY = "axon.diag.records";
/** 进行中操作的标记：卡死时唯一能保留下来的现场证据 */
const SPAN_KEY = "axon.diag.span";
/** 心跳：最后一次"进程还活着"的时间，用于判断卡死发生的时刻 */
const BEAT_KEY = "axon.diag.beat";

const MAX_RECORDS = 120;
/** 判定为长任务的阈值：低于此值属正常渲染抖动，不值得记录 */
const LONG_TASK_MS = 150;
/** 帧间隔超过此值说明主线程被明显阻塞（正常一帧约 16ms） */
const FRAME_GAP_MS = 600;
/** 单个操作耗时超过此值才单独记一条，避免刷屏 */
const SLOW_SPAN_MS = 200;
/**
 * 一轮结算里，同名操作累计耗时超过该值才记一条（ms）。
 * 用来发现"单次不慢、但反复执行把主线程占满"的慢性占用——滚动循环、
 * 流式期间的重复提交都属于这一类，它们永远不会触发 SLOW_SPAN_MS。
 */
const SPAN_TOTAL_MIN_MS = 100;
/** 同类事件的最小记录间隔，防止持续卡顿时刷爆存储 */
const SAME_KIND_THROTTLE_MS = 1000;
/** 判定"上次异常中断"的最小持续时长，用于滤掉正常关闭窗口造成的误报 */
const STUCK_MIN_MS = 3000;
/** 心跳间隔 */
const HEARTBEAT_MS = 3000;

export interface DiagRecord {
  /** 事件类型，如 long-task / frame-gap / slow:markdown-parse */
  kind: string;
  /** 耗时（毫秒） */
  ms: number;
  /** 发生时间戳 */
  at: number;
  /** 附加说明（当时的操作、DOM 规模等） */
  detail?: string;
}

/** 进行中的操作：名字 → 起始时间（performance.now） */
const activeSpans = new Map<string, number>();
const lastRecordAt = new Map<string, number>();
/**
 * 最近一次**已完成**的操作（名字 / 耗时 / 结束时刻）。
 *
 * 为什么需要它：frame-gap 与 long-task 都是在回调里判定的，而真正占满主线程的那段工作
 * 在回调触发前就已经跑完了——此时读 activeSpans 必然是空的，记录就只剩 "nodes=1234"
 * 这种没有归因的空壳（现存记录里绝大多数正是如此）。把"刚跑完的那一段"一并带上，
 * 卡顿才能指出是谁、花了多久。
 */
let lastCompletedSpan: { name: string; ms: number; at: number } | null = null;
/**
 * 按操作名累计耗时（自上次结算以来的总量与次数）。
 * 随心跳周期性结算并清零，见 flushSpanTotals。
 */
const spanTotals = new Map<string, { total: number; count: number }>();
let installed = false;
/** 上次运行残留的卡死标记（若有），随首次心跳上报给扩展宿主 */
let pendingStuckInfo: { name: string; detail?: string; seconds: number } | null = null;
/** 已上报过的记录时间戳：只发增量，避免每次都重传整表 */
let lastSentRecordAt = 0;
/** 前端自报状态（由组件更新），随心跳一起送出 */
const diagState: { streaming?: boolean } = {};

/**
 * 更新前端自报状态。目前只关心"AI 是否正在输出"——
 * 卡死时这个信息能把"界面挂了"与"后端仍在流式"对应起来。
 */
export function updateDiagState(patch: { streaming?: boolean }): void {
  Object.assign(diagState, patch);
}

/**
 * 取 webview 与扩展宿主通信的通道。
 * acquireVsCodeApi 每个会话只能调用一次，所以取到后写回 window 缓存
 * （与 transport.ts 的惰性获取保持同一份缓存，不会重复获取）。
 */
function vscodeApi(): { postMessage: (msg: unknown) => void } | null {
  try {
    const w = window as unknown as {
      __axonVSCode?: { postMessage: (msg: unknown) => void };
      acquireVsCodeApi?: () => { postMessage: (msg: unknown) => void };
    };
    if (w.__axonVSCode) return w.__axonVSCode;
    if (typeof w.acquireVsCodeApi === "function") {
      w.__axonVSCode = w.acquireVsCodeApi();
      return w.__axonVSCode;
    }
  } catch {
    /* 非 webview 环境 */
  }
  return null;
}

/**
 * 心跳上报：把"我还活着 + 当前在干什么"定期送给扩展宿主。
 *
 * 这是整个诊断里唯一能覆盖"渲染进程彻底卡死"的手段——页面自己已经无法执行任何代码时，
 * 扩展宿主（另一个进程）会发现心跳停了，从而记下"卡死发生在几点、当时在跑什么操作"。
 * 非 webview 环境（浏览器形态）没有宿主可发，直接跳过。
 */
function startHostHeartbeat(): void {
  const api = vscodeApi();
  if (!api) return;

  const send = (): void => {
    try {
      const all = readRecords();
      const fresh = all.filter((r) => r.at > lastSentRecordAt);
      if (fresh.length > 0) lastSentRecordAt = fresh[fresh.length - 1].at;
      api.postMessage({
        type: "diag_heartbeat",
        payload: {
          records: fresh.slice(-10),
          span: activeSpanSummary() || undefined,
          dom: domSummary(),
          state: { ...diagState },
          stuck: pendingStuckInfo,
        },
      });
      pendingStuckInfo = null; // 只需上报一次
    } catch {
      /* 上报失败不能影响主功能 */
    }
  };

  send();
  setInterval(send, HEARTBEAT_MS);
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 存储不可用（隐私模式/配额满）时忽略：诊断不能影响主功能 */
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 同上 */
  }
}

function readRecords(): DiagRecord[] {
  const raw = safeGet(RECORDS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DiagRecord[]) : [];
  } catch {
    return [];
  }
}

/** 当时正在执行的操作（帧间隔异常时用于定位是谁在阻塞） */
function activeSpanSummary(): string {
  if (activeSpans.size === 0) return "";
  const now = performance.now();
  return [...activeSpans.entries()]
    .map(([name, startedAt]) => `${name}=${Math.round(now - startedAt)}ms`)
    .join(",");
}

/**
 * 最近完成操作的摘要（供卡顿记录归因）。
 * 超过 5 秒的陈旧记录不再带上——那多半与本次卡顿无关，留着反而误导。
 */
function lastSpanSummary(): string {
  if (!lastCompletedSpan) return "";
  const ageMs = Date.now() - lastCompletedSpan.at;
  if (ageMs > 5000) return "";
  return `last=${lastCompletedSpan.name}(${Math.round(lastCompletedSpan.ms)}ms,${ageMs}ms前)`;
}

/** DOM 规模与"是否存在全屏遮罩"——用于一次性排除/坐实"灰色遮罩盖住整屏"这类猜想 */
function domSummary(): string {
  const parts: string[] = [];
  try {
    parts.push(`nodes=${document.querySelectorAll("*").length}`);
    const dialogOverlays = document.querySelectorAll('[data-slot="dialog-overlay"]').length;
    if (dialogOverlays > 0) parts.push(`dialogOverlay=${dialogOverlays}`);
  } catch {
    /* 忽略 */
  }
  return parts.join(" ");
}

/**
 * 记录一次异常事件：同时写 console 与持久化存储。
 * 持久化的意义在于——即使随后进程被卡死或崩溃，这次记录也已经在磁盘上。
 */
export function recordIncident(kind: string, ms: number, detail?: string): void {
  const now = Date.now();
  const prev = lastRecordAt.get(kind) ?? 0;
  if (now - prev < SAME_KIND_THROTTLE_MS) return;
  lastRecordAt.set(kind, now);

  const rounded = Math.round(ms);
  console.warn(`[axon-diag] ${kind} ${rounded}ms${detail ? ` · ${detail}` : ""}`);

  try {
    const list = readRecords();
    list.push({ kind, ms: rounded, at: now, detail });
    while (list.length > MAX_RECORDS) list.shift();
    safeSet(RECORDS_KEY, JSON.stringify(list));
  } catch {
    /* 忽略 */
  }
}

/**
 * 标记一个可能很慢的操作开始。
 * @param name 操作名（会出现在卡死报告中）
 * @param opts.persist 是否写入持久化标记。只有"重到可能把主线程卡死"的操作才需要，
 *                     否则高频调用会带来无谓的同步写开销
 * @param opts.detail 附加信息（如内容长度），用于事后判断规模
 */
export function beginSpan(name: string, opts: { persist?: boolean; detail?: string } = {}): void {
  activeSpans.set(name, performance.now());
  if (opts.persist) {
    safeSet(SPAN_KEY, JSON.stringify({ name, detail: opts.detail, startedAt: Date.now() }));
  }
}

/** 标记操作结束：清除标记，并在耗时异常时留一条记录 */
export function endSpan(name: string): void {
  const startedAt = activeSpans.get(name);
  activeSpans.delete(name);
  if (startedAt === undefined) return;

  // 只清除属于自己的标记，避免覆盖并行的其它 span
  const raw = safeGet(SPAN_KEY);
  if (raw) {
    try {
      const cur = JSON.parse(raw) as { name?: string };
      if (cur?.name === name) safeRemove(SPAN_KEY);
    } catch {
      safeRemove(SPAN_KEY);
    }
  }

  const ms = performance.now() - startedAt;
  lastCompletedSpan = { name, ms, at: Date.now() };
  if (ms >= SLOW_SPAN_MS) recordIncident(`slow:${name}`, ms);

  const bucket = spanTotals.get(name) ?? { total: 0, count: 0 };
  bucket.total += ms;
  bucket.count++;
  spanTotals.set(name, bucket);
}

/**
 * 结算各操作的累计耗时（由心跳周期性调用）。
 * 把"一轮里反复执行"的慢性开销也变成可读记录——这类占用单次都不到阈值，
 * 只有累加起来才看得出它是不是主线程的大头。
 */
function flushSpanTotals(): void {
  if (spanTotals.size === 0) return;
  const entries = [...spanTotals.entries()];
  spanTotals.clear();
  for (const [name, t] of entries) {
    if (t.total < SPAN_TOTAL_MIN_MS) continue;
    recordIncident(`total:${name}`, Math.round(t.total), `n=${t.count}`);
  }
}

/**
 * 读取上次运行留下的标记：若存在，说明上一次进程没走完那个操作就中断了
 * （卡死、被强杀、或直接崩溃），这正是我们要抓的现场。
 */
function reportPreviousStuck(): void {
  const raw = safeGet(SPAN_KEY);
  if (!raw) return;
  safeRemove(SPAN_KEY);
  try {
    const span = JSON.parse(raw) as { name?: string; detail?: string; startedAt?: number };
    const elapsed = Date.now() - (span.startedAt ?? Date.now());
    if (elapsed < STUCK_MIN_MS) return; // 正常关闭的残留，忽略
    const where = `${span.name ?? "未知操作"}${span.detail ? ` · ${span.detail}` : ""}`;
    console.error(
      `[axon-diag] ⚠️ 上次运行疑似在「${where}」期间卡死/中断：该操作已持续 ${(elapsed / 1000).toFixed(1)}s 仍未结束。` +
      `这是判断卡死根因最直接的证据。`,
    );
    recordIncident("last-run-stuck", elapsed, where);
    pendingStuckInfo = { name: span.name ?? "未知操作", detail: span.detail, seconds: elapsed / 1000 };
  } catch {
    /* 标记损坏，已清除 */
  }
}

/** 长任务观察：浏览器原生上报的主线程长任务 */
function startLongTaskObserver(): void {
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < LONG_TASK_MS) continue;
        const attribution = (entry as unknown as {
          attribution?: Array<{ name?: string; containerType?: string; containerSrc?: string }>;
        }).attribution;
        const who = attribution?.[0];
        const detail = [who?.name, who?.containerType, activeSpanSummary(), lastSpanSummary()].filter(Boolean).join(" ");
        recordIncident("long-task", entry.duration, detail || undefined);
      }
    });
    observer.observe({ type: "longtask", buffered: true } as PerformanceObserverInit);
  } catch {
    /* 环境不支持 longtask（部分内核不暴露），退回帧间隔检测 */
  }
}

/** 帧间隔检测：能发现 longtask 未覆盖的持续占用，并能立刻指出当时在跑哪个操作 */
function startFrameGapDetector(): void {
  let lastFrameAt = performance.now();
  const tick = (): void => {
    const now = performance.now();
    const gap = now - lastFrameAt;
    lastFrameAt = now;
    // 不可见时浏览器会主动降频/停帧，此时的大间隔不是"卡死"
    if (document.visibilityState === "visible" && gap >= FRAME_GAP_MS) {
      const detail = [activeSpanSummary(), lastSpanSummary(), domSummary()].filter(Boolean).join(" | ");
      recordIncident("frame-gap", gap, detail || undefined);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // 重新可见时重置基准，否则会把"隐藏期间"的整段时间算成一次卡顿
  document.addEventListener("visibilitychange", () => {
    lastFrameAt = performance.now();
  });
}

/**
 * 心跳：记录"进程最后一次活着"的时刻，便于和用户看到卡灰的时间点对上；
 * 顺带周期性结算累计耗时。放在这里而不是宿主心跳里——后者在非 webview 环境不启动。
 */
function startHeartbeat(): void {
  const beat = (): void => {
    safeSet(BEAT_KEY, String(Date.now()));
    flushSpanTotals();
  };
  beat();
  setInterval(beat, HEARTBEAT_MS);
}

/** 捕获未处理的异常（React 渲染错误之外的那些，往往才是把界面搞死的原因） */
function startErrorCapture(): void {
  window.addEventListener("error", (event) => {
    // 浏览器在"一帧内 ResizeObserver 回调又改了被观察元素的尺寸"时抛这条，
    // 意思是剩下的通知挪到下一帧再送，不是异常，也不会丢数据（规范行为）。
    // 虚拟列表开了 skipAnimationFrameInResizeObserver（同步上报尺寸以消除滚动时的一帧错位）后
    // 必然偶发，库文档明确说明它无害（react-virtuoso #1049）。它没有 error 对象、也没有栈，
    // 记成 error 只会刷屏并掩盖真正的错误，所以这里单独放过。
    if (!event.error && /^ResizeObserver loop/.test(event.message || "")) {
      event.stopImmediatePropagation();
      return;
    }
    const err = event.error as Error | undefined;
    recordIncident("error", 0, `${event.message}${err?.stack ? ` @ ${err.stack.split("\n")[1]?.trim() ?? ""}` : ""}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason as { message?: string; stack?: string } | undefined;
    recordIncident("unhandled-rejection", 0, reason?.message ?? String(event.reason));
  });
}

/** 生成可读的完整报告（供用户复制反馈） */
export function diagReport(): string {
  const records = readRecords();
  const beat = Number(safeGet(BEAT_KEY) ?? 0);
  const lines: string[] = [];
  lines.push("=== Axon 前端诊断报告 ===");
  lines.push(`生成时间：${new Date().toLocaleString()}`);
  lines.push(`上次心跳：${beat ? new Date(beat).toLocaleString() : "无"}`);
  lines.push(`页面地址：${location.href.slice(0, 120)}`);
  lines.push(`DOM 规模：${domSummary()}`);
  lines.push(`进行中的操作：${activeSpanSummary() || "无"}`);
  lines.push(`刚完成的操作：${lastSpanSummary() || "无"}`);
  lines.push(`记录条数：${records.length}`);
  lines.push("");
  lines.push("近段时间线（越靠后越新）：");
  for (const r of records.slice(-40)) {
    lines.push(`  ${new Date(r.at).toLocaleTimeString()}  ${r.kind}  ${r.ms}ms  ${r.detail ?? ""}`);
  }
  return lines.join("\n");
}

/** 清空诊断记录 */
export function diagClear(): void {
  safeRemove(RECORDS_KEY);
  safeRemove(SPAN_KEY);
}

/** 挂载诊断：应在应用渲染前尽早调用（幂等） */
export function installDiagnostics(): void {
  if (installed) return;
  installed = true;

  reportPreviousStuck();
  startErrorCapture();
  startLongTaskObserver();
  startFrameGapDetector();
  startHeartbeat();
  startHostHeartbeat();

  // 正常关闭/刷新时清掉进行中标记：这样"残留的标记"才等价于"异常中断"
  window.addEventListener("pagehide", () => safeRemove(SPAN_KEY));

  (window as unknown as { __axonDiag?: unknown }).__axonDiag = {
    report: () => {
      const text = diagReport();
      // 同时打进 console 并复制到剪贴板，方便直接贴给我
      console.warn(text);
      try {
        void navigator.clipboard?.writeText(text);
      } catch {
        /* 忽略 */
      }
      return text;
    },
    records: readRecords,
    clear: diagClear,
  };

  console.info("[axon-diag] 诊断已启用：卡灰后执行 __axonDiag.report() 可导出报告（会自动复制到剪贴板）");
}
