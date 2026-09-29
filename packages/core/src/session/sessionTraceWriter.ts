/**
 * SessionTraceWriter —— 每个 session 一份 JSONL trace 文件。
 *
 * ── 为什么必须有「等级 + 聚合」 ──
 * 实测一份 963 MB 的 trace：90.1% 的体积来自 reasoning.delta —— 474 万行、867 MB。
 * 平均每行 191 字节，而真正的内容只有约 11 字节，其余全是逐行重复的 JSON 外壳
 * （ts / sessionId / type / 嵌套 payload）。也就是说体积问题不是"记了太多内容"，
 * 而是"把内容切成了太多行"。
 *
 * 所以默认等级（normal）按块聚合：同一 turn 内连续的同类增量合并成一条
 * reasoning.block / text.block —— 内容一字不少，外壳只付一次。同样的会话从 867 MB
 * 降到十几 MB，而排障真正依赖的时序（思考 / 正文 / 工具谁先谁后）完整保留。
 * 逐条原始 delta 只在 full 等级下写，那是要复现流式细节（打字机节奏等）时才需要的。
 *
 * ── 为什么落盘在用户目录 ──
 * trace 是"我这台机器上跑过什么"的痕迹，对团队、对下一个 clone 仓库的人毫无价值。
 * 早先它写在 <workspace>/.axon/traces/，于是**每个执行过/读过的项目**都会留下一个
 * .axon 目录（还会进 git status）。现在落到 ~/.axon/projects/<项目>/traces/，
 * 工作区只在用户显式放了配置/能力时才出现 .axon。
 */

import { join, resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import type { AgentHost } from "../host/index.js";

/** 一条 session trace 事件（存 JSONL，一行一条）。 */
export interface SessionTraceEvent {
  ts: string;
  sessionId: string;
  /** 事件类别（如 session.start / user.input / tool.result / turn.end）。 */
  type: string;
  /** 当前 turn（可选；session.start / loaded 等会话级事件可省略）。 */
  turn?: number;
  /** 任意结构化载荷；由调用方控制内容。 */
  payload?: unknown;
}

/** 文本截断工具：防止 trace 文件无限膨胀。 */
export function truncateForTrace(value: string, max = 4000): { text: string; truncated: boolean; originalLength: number } {
  const text = value || "";
  if (text.length <= max) return { text, truncated: false, originalLength: text.length };
  return { text: text.slice(0, max), truncated: true, originalLength: text.length };
}

// ─── 输出等级 ────────────────────────────────────────────────────────────────

/**
 * trace 记录深度。
 * - off      不记录（连目录都不会创建）
 * - summary  只留骨架：turn 边界 / 工具调用与结果 / 错误 / 耗时。**不记思考与正文**，KB 级。
 * - normal   骨架 + 思考与正文（按块聚合）。默认值，数 MB 级。
 * - full     骨架 + 逐条原始增量。数百 MB 级，仅复现流式细节时临时开启。
 */
export type TraceLevel = "off" | "summary" | "normal" | "full";

export interface TraceConfig {
  level: TraceLevel;
  /** 单个 trace 文件上限（MB），达到后停止写入并在文件尾留一条说明 */
  maxFileMB: number;
  /** 每个项目保留最近多少份 trace，更旧的自动清理 */
  keepRecentFiles: number;
}

export const DEFAULT_TRACE_CONFIG: TraceConfig = {
  level: "normal",
  maxFileMB: 64,
  keepRecentFiles: 30,
};

/** 把外部传入（设置项 / 环境变量）的散值收敛成合法配置，非法项一律回退默认 */
export function normalizeTraceConfig(partial?: Partial<TraceConfig> | null): TraceConfig {
  const p = partial || {};
  const level: TraceLevel =
    p.level === "off" || p.level === "summary" || p.level === "normal" || p.level === "full" ? p.level : DEFAULT_TRACE_CONFIG.level;
  const maxFileMB = typeof p.maxFileMB === "number" && p.maxFileMB > 0 ? p.maxFileMB : DEFAULT_TRACE_CONFIG.maxFileMB;
  const keepRecentFiles = typeof p.keepRecentFiles === "number" && p.keepRecentFiles > 0 ? Math.floor(p.keepRecentFiles) : DEFAULT_TRACE_CONFIG.keepRecentFiles;
  return { level, maxFileMB, keepRecentFiles };
}

/** 逐 token 的内容型事件 —— 体积元凶，也是聚合的对象 */
const CONTENT_EVENT_TYPES = new Set(["reasoning.delta", "text.delta"]);

/** 聚合块的最大字符数：避免单个思考过长时攒出一条几十 MB 的行 */
const MAX_BLOCK_CHARS = 20_000;

/**
 * 项目级机器产物目录：~/.axon/projects/<可读名>-<路径哈希>/
 *
 * 用路径哈希而非路径本身：路径含盘符/中文/空格，直接当目录名既不可移植也不好看；
 * 哈希保证同一项目稳定映射到同一目录。保留可读名只为方便人肉辨认。
 * 意图与「工作区级的 .axon」相反 —— 这里放的是一切不应随仓库共享的机器产物。
 */
export function projectDataDir(homeDir: string, workspacePath: string): string {
  const hash = createHash("sha1").update(workspacePath).digest("hex").slice(0, 12);
  const name = basename(workspacePath).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
  return join(homeDir, ".axon", "projects", `${name}-${hash}`);
}

/** trace 目录（项目级机器产物目录下的 traces/） */
export function projectTraceDir(homeDir: string, workspacePath: string): string {
  return join(projectDataDir(homeDir, workspacePath), "traces");
}

/**
 * 清理过旧的 trace，只保留最近 N 份。
 *
 * 文件名里带创建时间戳（trace-<epochMs>-<sessionId>.jsonl），于是**按文件名排序即按时间排序**，
 * 无需 stat 拿 mtime —— host 的 StatInfo 只有 isFile/isDir，没有时间与大小，
 * 靠文件系统元信息做淘汰在这层抽象下根本做不到。
 */
export async function pruneOldTraces(host: AgentHost, dir: string, keep: number): Promise<number> {
  let entries;
  try {
    entries = await host.fs.readdir(dir);
  } catch {
    return 0; // 目录不存在：没什么可清理，也不必创建它
  }
  const traces = entries
    .filter((e) => !e.isDir && /^trace-\d+-.*\.jsonl$/.test(e.name))
    .map((e) => e.name)
    .sort(); // 文件名前缀是定长时间戳，字典序 = 时间序
  const stale = traces.slice(0, Math.max(0, traces.length - keep));
  let removed = 0;
  for (const name of stale) {
    try {
      await host.fs.remove(join(dir, name));
      removed++;
    } catch {
      /* 单个删除失败不影响其余 */
    }
  }
  return removed;
}

/** TraceWriter 依赖：文件系统、落盘根目录、记录等级由上层注入。 */
export interface SessionTraceWriterDeps {
  host: AgentHost;
  /** trace 目录绝对路径（由上层用 projectTraceDir 算好） */
  rootDir: string;
  /** 初始配置（后续可用 setConfig 热更新） */
  config?: Partial<TraceConfig>;
}

/** 聚合缓冲：同一 turn 内连续的同类增量攒在一起，攒满或被打断时落成一条 block */
interface BlockBuffer {
  kind: "reasoning" | "text";
  turn?: number;
  ts: string;
  text: string;
  chunks: number;
  truncated: boolean;
}

/**
 * SessionTraceWriter —— 每个 session 一份 JSONL trace 文件。
 *
 * 职责：
 * - 按配置的等级决定记什么、怎么记（聚合 or 逐条）；
 * - 惰性建目录：只有真的要写第一条时才创建，保证"只是读过"的项目不留痕；
 * - 单文件到达上限即停写（不再无限膨胀）。
 */
export class SessionTraceWriter {
  private sessionId = "";
  private filePath = "";
  private writeChain: Promise<void> = Promise.resolve();
  private enabled = false;
  private dirReady = false;
  private bytesWritten = 0;
  private capped = false;
  private buf: BlockBuffer | null = null;
  private config: TraceConfig;

  constructor(private readonly deps: SessionTraceWriterDeps) {
    this.config = normalizeTraceConfig(deps.config);
  }

  /** 热更新配置（用户在设置里改等级后，无需重启会话） */
  setConfig(config?: Partial<TraceConfig> | null): void {
    this.config = normalizeTraceConfig({ ...this.config, ...(config || {}) });
  }

  /**
   * 绑定 session（可多次调用；同 id 重入无害）。
   *
   * 注意这里**不做 mkdirp**：早先无条件建 <cwd>/.axon/traces 正是"每个读过的项目
   * 都留下一个 .axon"的来源。目录改由首次真正写盘时惰性创建。
   */
  async init(sessionId: string): Promise<void> {
    if (!sessionId || !this.deps.rootDir) return;
    if (this.config.level === "off") return;
    this.sessionId = sessionId;
    // 文件名内嵌创建时间戳：淘汰时按名排序即可判新旧，不必依赖 host 的 stat（它没有 mtime）
    this.filePath = resolve(this.deps.rootDir, `trace-${Date.now()}-${sessionId}.jsonl`);
    this.enabled = true;
    // 清理过旧 trace；失败不影响本次记录
    void pruneOldTraces(this.deps.host, this.deps.rootDir, this.config.keepRecentFiles).catch(() => {});
    await this.append({ ts: new Date().toISOString(), sessionId, type: "session.trace_ready", payload: { filePath: this.filePath, level: this.config.level } });
  }

  getPath(): string {
    return this.filePath;
  }

  /** 当前是否在记录（供上层判断要不要做昂贵的 payload 组装） */
  isEnabled(): boolean {
    return this.enabled && !this.capped && this.config.level !== "off";
  }

  /**
   * 追加一条事件。
   *
   * 必须用宿主的追加写，不能 read + write 模拟：trace 是一条会话写满全程的日志。
   * 若每条事件都把整个文件读进内存再整个写回，累计 I/O 是 O(n²)，
   * 而且任何一次写入中断都是整文件损坏，不是丢一行。
   *
   * writeChain 保留：appendFile 的多次调用各自 open/write/close，并发时行序不保证，
   * 而 trace 的全部价值就在于"谁先谁后"。串行化是功能需求，不是性能取舍。
   */
  async append(event: SessionTraceEvent): Promise<void> {
    if (!this.enabled || !this.filePath || this.capped) return;
    const level = this.config.level;
    if (level === "off") return;

    const isContent = CONTENT_EVENT_TYPES.has(event.type);

    // summary：只要骨架，内容流全部丢弃
    if (isContent && level === "summary") return;

    // normal：内容流攒进缓冲，按块落盘
    if (isContent && level === "normal") {
      this.accumulate(event);
      return;
    }

    // full（逐条）或任何骨架事件：先把缓冲冲掉，保证行序与真实时序一致
    this.flushBuffer();
    await this.writeLine(event);
  }

  /**
   * 把缓冲里剩余的增量落盘（会话结束 / 轮次收尾时调用，避免最后一段内容只留在内存里）。
   *
   * 返回 Promise 并等待写链：落盘本身是异步的，若只同步取走缓冲就返回，
   * 调用方（或测试）读文件时可能什么都还没写下去。
   */
  async flush(): Promise<void> {
    this.flushBuffer();
    await this.writeChain;
  }

  /** 攒一批内容增量到当前缓冲 */
  private accumulate(event: SessionTraceEvent): void {
    const payload = event.payload as { text?: { text?: string; truncated?: boolean } } | undefined;
    const text = typeof payload?.text?.text === "string" ? payload.text.text : "";
    if (!text) return;
    const kind: BlockBuffer["kind"] = event.type === "reasoning.delta" ? "reasoning" : "text";

    // 换类（思考↔正文）或换轮 → 先把上一段落盘，再开新块。
    // 这一步必须在同一 tick 内同步完成，否则"思考/正文交替"的先后关系会错位。
    if (this.buf && (this.buf.kind !== kind || this.buf.turn !== event.turn)) {
      this.flushBuffer();
    }
    if (!this.buf) {
      this.buf = { kind, turn: event.turn, ts: event.ts, text: "", chunks: 0, truncated: false };
    }
    this.buf.text += text;
    this.buf.chunks++;
    if (payload?.text?.truncated) this.buf.truncated = true;
    if (this.buf.text.length >= MAX_BLOCK_CHARS) this.flushBuffer();
  }

  /** 把当前缓冲落成一条 `*.block` 事件（同步取出缓冲，异步写盘） */
  private flushBuffer(): void {
    const b = this.buf;
    this.buf = null;
    if (!b || !b.text) return;
    void this.writeLine({
      ts: b.ts,
      sessionId: this.sessionId,
      type: `${b.kind}.block`,
      turn: b.turn,
      payload: { text: b.text, chunks: b.chunks, truncated: b.truncated },
    });
  }

  /** 落一行（含体积上限检查与惰性建目录） */
  private async writeLine(event: SessionTraceEvent): Promise<void> {
    if (this.capped) return;
    const line = JSON.stringify(event) + "\n";
    const bytes = Buffer.byteLength(line, "utf8");
    const limit = this.config.maxFileMB * 1024 * 1024;
    if (this.bytesWritten + bytes > limit) {
      // 到顶：留一条说明，然后彻底停写（而不是截断当前这行、留下半截 JSON）
      this.capped = true;
      const notice = JSON.stringify({
        ts: new Date().toISOString(),
        sessionId: this.sessionId,
        type: "trace.capped",
        payload: { reason: `已达单文件上限 ${this.config.maxFileMB}MB，后续事件不再记录`, bytesWritten: this.bytesWritten },
      }) + "\n";
      this.writeChain = this.writeChain
        .then(async () => {
          await this.ensureDir();
          await this.deps.host.fs.append(this.filePath, notice);
        })
        .catch((err) => console.warn("[trace] 写入上限说明失败（忽略）:", (err as Error).message));
      await this.writeChain;
      return;
    }
    this.bytesWritten += bytes;
    this.writeChain = this.writeChain
      .then(async () => {
        await this.ensureDir();
        await this.deps.host.fs.append(this.filePath, line);
      })
      .catch((err) => {
        console.warn("[trace] 追加 session trace 失败（忽略）:", (err as Error).message);
      });
    await this.writeChain;
  }

  /** 惰性建目录：只在真的要写盘时创建，读路径绝不建 */
  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    await this.deps.host.fs.mkdirp(this.deps.rootDir);
    this.dirReady = true;
  }
}
