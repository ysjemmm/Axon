/**
 * 后台任务追踪：给会话的进程管理器套一层，记住哪些进程要求「结束时通知 Agent」。
 *
 * ── 解决什么问题 ──
 * 跑一遍完整测试、打一次包、处理一批数据，动辄几分钟到几十分钟。以前 Agent 只能干等或反复
 * get_process_output 轮询，既费 token 又占着这一轮。现在 Agent 用 start_process(notify=true)
 * 启动后就可以去做别的事、甚至结束本轮；进程结束时系统自动发起一轮，把退出码和最后的输出交给它。
 *
 * ── 什么时候不通知 ──
 * · 没要求通知的进程（开发服务器、watch）：它们本就不该结束，崩了也由用户发现后再问。
 * · Agent 自己已经读到了结束状态（get_process_output 返回 exited）：它已经知道了。
 * · 被停止的（Agent 调 stop_process 或用户在面板里停）：停止是有意为之，不需要再告诉谁。
 */

import type {
  BackgroundProcessInfo,
  HostProcessManager,
  ProcessExitEvent,
  StartProcessOptions,
} from "../host/index.js";

export interface BackgroundTaskInfo extends BackgroundProcessInfo {
  /** 结束时是否通知 Agent */
  notify: boolean;
}

export interface BackgroundTaskNotice {
  terminalId: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  startedAt?: number;
  endedAt?: number;
  /** 最后若干行输出 */
  tail: string;
}

interface TaskMeta {
  notify: boolean;
  /** 进程还在跑（结束 / 停止事件到达后置 false） */
  running: boolean;
  /** Agent 已经知道它结束了（读到过结束状态、或是它自己停的），不再通知 */
  acknowledged: boolean;
}

/** 通知里带的输出行数：够看清成功/失败与报错，又不至于把一轮的上下文撑大 */
const NOTICE_TAIL_LINES = 40;

export class BackgroundTaskTracker {
  private readonly meta = new Map<string, TaskMeta>();
  /** Agent 正在本轮里 wait_process 等的任务：结束时结果由等待方交给它，不再另发通知 */
  private readonly waiting = new Set<string>();
  /** 需要通知 Agent 时调用（由 SessionHub 决定是立刻发起一轮还是等当前这轮结束） */
  onNotice?: (notice: BackgroundTaskNotice) => void;
  /** 任务列表有变化（启动 / 结束 / 停止），供界面刷新 */
  onChange?: () => void;

  constructor(private readonly inner: HostProcessManager) {
    inner.onExit?.((event) => { void this.handleExit(event); });
  }

  /** 是否能发结束通知（宿主支持进程结束事件） */
  get canNotify(): boolean {
    return typeof this.inner.onExit === "function";
  }

  /** 给会话用的进程管理器：行为与原实现一致，只是顺手记下元信息 */
  wrap(): HostProcessManager {
    const inner = this.inner;
    return {
      start: async (command: string, opts: StartProcessOptions) => {
        const result = await inner.start(command, opts);
        const existing = this.meta.get(result.terminalId);
        if (existing) {
          if (opts.notify) existing.notify = true;
        } else {
          this.meta.set(result.terminalId, { notify: !!opts.notify, running: true, acknowledged: false });
        }
        this.onChange?.();
        return result;
      },
      getOutput: async (terminalId: string, lines?: number) => {
        const out = await inner.getOutput(terminalId, lines);
        if (out && out.status !== "running") this.acknowledge(terminalId);
        return out;
      },
      stop: async (terminalId: string) => {
        this.acknowledge(terminalId);
        const ok = await inner.stop(terminalId);
        this.onChange?.();
        return ok;
      },
      list: () => inner.list(),
      ...(inner.onExit ? { onExit: (listener: (event: ProcessExitEvent) => void) => inner.onExit!(listener) } : {}),
    };
  }

  /** 列出本会话的后台任务（含是否通知） */
  async list(): Promise<BackgroundTaskInfo[]> {
    const procs = await this.inner.list();
    return procs.map((p) => ({ ...p, notify: this.meta.get(p.terminalId)?.notify ?? false }));
  }

  getOutput(terminalId: string, lines?: number) {
    return this.inner.getOutput(terminalId, lines);
  }

  /** 用户在面板里停止：同样不再通知 */
  async stop(terminalId: string): Promise<boolean> {
    this.acknowledge(terminalId);
    const ok = await this.inner.stop(terminalId);
    this.onChange?.();
    return ok;
  }

  /**
   * 本轮该等的任务：要求过通知、还在跑、Agent 还不知道结果。
   * Agent 想收尾时若还有这类任务，本轮不结束，先等它们跑完（见 AgentSession.waitProcesses）。
   */
  awaitedIds(): string[] {
    return [...this.meta].filter(([, m]) => m.notify && m.running && !m.acknowledged).map(([id]) => id);
  }

  /** 标记 / 取消标记「本轮正在等」 */
  beginWait(ids: string[]): void { for (const id of ids) this.waiting.add(id); }
  endWait(ids: string[]): void { for (const id of ids) this.waiting.delete(id); }

  /** 是否由本追踪器启动（wait_process 只等本会话的进程） */
  has(terminalId: string): boolean {
    return this.meta.has(terminalId);
  }

  private acknowledge(terminalId: string): void {
    const meta = this.meta.get(terminalId);
    if (meta) meta.acknowledged = true;
  }

  private async handleExit(event: ProcessExitEvent): Promise<void> {
    this.onChange?.();
    const meta = this.meta.get(event.terminalId);
    if (meta) meta.running = false;
    if (meta && this.waiting.has(event.terminalId)) { meta.acknowledged = true; return; }
    if (!meta?.notify || meta.acknowledged || event.status !== "exited") return;
    meta.acknowledged = true;
    const [out, info] = await Promise.all([
      this.inner.getOutput(event.terminalId, NOTICE_TAIL_LINES).catch(() => null),
      this.inner.list().then((all) => all.find((p) => p.terminalId === event.terminalId)).catch(() => undefined),
    ]);
    this.onNotice?.({
      terminalId: event.terminalId,
      command: info?.command ?? "",
      cwd: info?.cwd ?? "",
      exitCode: event.exitCode,
      startedAt: info?.startedAt,
      endedAt: info?.endedAt ?? Date.now(),
      tail: (out?.output ?? "").trimEnd(),
    });
  }
}

function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分 ${sec % 60} 秒`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}

/** 界面上那一行：「后台任务结束：npm test（退出码 0，用时 3 分 12 秒）」 */
export function backgroundNoticeLabel(n: BackgroundTaskNotice): string {
  const parts = [n.exitCode === null ? "退出码未知" : `退出码 ${n.exitCode}`];
  if (n.startedAt && n.endedAt) parts.push(`用时 ${formatDuration(n.endedAt - n.startedAt)}`);
  const command = n.command.length > 60 ? `${n.command.slice(0, 60)}…` : n.command;
  return `后台任务结束：${command}（${parts.join("，")}）`;
}

/** 交给模型的通知正文 */
export function formatBackgroundNotice(n: BackgroundTaskNotice): string {
  return [
    "【后台任务通知】这条消息由系统在后台任务结束时自动发出，不是用户输入。",
    backgroundNoticeLabel(n),
    `terminalId: ${n.terminalId}${n.cwd ? ` · 目录: ${n.cwd}` : ""}`,
    "",
    `最后 ${NOTICE_TAIL_LINES} 行输出：`,
    "```",
    n.tail || "（没有输出）",
    "```",
    "",
    "请根据结果继续：这是你在等的任务就向用户汇报结果或接着做下一步；失败了先看报错再决定是否修复。需要完整输出用 get_process_output。",
  ].join("\n");
}
