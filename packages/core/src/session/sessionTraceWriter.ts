import { resolve } from "node:path";
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

/** TraceWriter 依赖：文件系统与根目录由上层注入。 */
export interface SessionTraceWriterDeps {
  host: AgentHost;
  cwd: string;
}

/** 文本截断工具：防止 trace 文件无限膨胀。 */
export function truncateForTrace(value: string, max = 4000): { text: string; truncated: boolean; originalLength: number } {
  const text = value || "";
  if (text.length <= max) return { text, truncated: false, originalLength: text.length };
  return { text: text.slice(0, max), truncated: true, originalLength: text.length };
}

/**
 * SessionTraceWriter —— 每个 session 一份 JSONL trace 文件。
 *
 * 目标：
 * - 把“本次 session 到底先有文字还是先有工具、tool_result 发了什么、turn 如何结束”落成可回放证据；
 * - 只做最小、稳定、低风险的追加写，不介入业务逻辑；
 * - 每条事件单独一行 JSON，异常中断也尽量保全已写部分。
 */
export class SessionTraceWriter {
  private sessionId = "";
  private filePath = "";
  private writeChain: Promise<void> = Promise.resolve();
  private enabled = false;

  constructor(private readonly deps: SessionTraceWriterDeps) {}

  /** 初始化一个 session 的 trace 文件路径（可多次调用；同 id 重入无害）。 */
  async init(sessionId: string): Promise<void> {
    if (!sessionId) return;
    this.sessionId = sessionId;
    const dir = resolve(this.deps.cwd, ".axon", "traces");
    this.filePath = resolve(dir, `trace-${sessionId}.jsonl`);
    await this.deps.host.fs.mkdirp(dir);
    this.enabled = true;
    await this.append({ ts: new Date().toISOString(), sessionId, type: "session.trace_ready", payload: { filePath: this.filePath } });
  }

  getPath(): string {
    return this.filePath;
  }

  /** 追加一条事件。内部串行化写入，避免并发 append 打乱顺序。 */
  async append(event: SessionTraceEvent): Promise<void> {
    if (!this.enabled || !this.filePath) return;
    const line = JSON.stringify(event) + "\n";
    this.writeChain = this.writeChain.then(async () => {
      const prev = (await this.deps.host.fs.read(this.filePath)) || "";
      await this.deps.host.fs.write(this.filePath, prev + line);
    }).catch((err) => {
      console.warn("[trace] 追加 session trace 失败（忽略）:", (err as Error).message);
    });
    await this.writeChain;
  }
}
