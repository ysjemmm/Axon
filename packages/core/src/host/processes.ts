/**
 * HostProcessManager —— 后台常驻进程能力（执行端 ① 的一部分）
 *
 * 与 HostCommandRunner 的区别：
 * - HostCommandRunner.exec：跑「会结束的短命令」（build/test/脚本验证），同步等待退出并回收全部输出。
 * - HostProcessManager：跑「常驻/长时间进程」（开发服务器、watch、交互式命令）。start 立即返回
 *   一个 terminalId，不阻塞 agent loop；输出在后台持续累积，可随时 getOutput 读取、stop 终止。
 *
 * 职责边界：只负责把进程「跑起来 / 读输出 / 停掉 / 列举」。危险命令检测（detectDangerousCommand）
 * 与命令信任门属于与形态无关的安全策略，留在 core，在调用本接口之前完成；本实现不做安全判断。
 *
 * 两种实现：
 *   · NodeProcessManager   —— child_process.spawn（detached），按 id 维护进程表（web/cli/server 形态）
 *   · VSCodeProcessManager —— 每个进程一个可见的 vscode.Terminal + Shell Integration 流式读取
 */

/** 后台进程当前状态 */
export type BackgroundProcessStatus = "running" | "exited" | "stopped";

/** 启动后台进程的选项 */
export interface StartProcessOptions {
  /** 工作目录（绝对路径） */
  cwd: string;
}

/** 启动结果 */
export interface StartProcessResult {
  /** 进程句柄 id，用于后续 getOutput / stop */
  terminalId: string;
  /** 是否复用了一个「相同命令 + 相同 cwd」且仍在运行的已有进程（避免重复起服务器） */
  reused: boolean;
}

/** 读取输出的结果 */
export interface ProcessOutputResult {
  /** 累积输出（stdout + stderr 合并，已去除 ANSI 控制字符）。lines 指定时仅返回最近若干行 */
  output: string;
  /** 当前状态 */
  status: BackgroundProcessStatus;
  /** 进程退出码（仅 exited 时有意义；running/stopped 为 null） */
  exitCode: number | null;
}

/** 进程列表项 */
export interface BackgroundProcessInfo {
  terminalId: string;
  command: string;
  cwd: string;
  status: BackgroundProcessStatus;
}

/** Agent 可用的后台进程管理能力 */
export interface HostProcessManager {
  /**
   * 启动一个后台常驻进程，立即返回（不等待退出）。
   * 若已存在「相同命令 + 相同 cwd」且仍在运行的进程，应复用它并在结果中标记 reused=true。
   */
  start(command: string, opts: StartProcessOptions): Promise<StartProcessResult>;

  /**
   * 读取指定后台进程的累积输出与状态。
   * @param lines 可选：仅返回最近 N 行（用于控制 token 消耗）。省略则返回全部已缓冲输出。
   * @returns 找不到该 terminalId 时返回 null。
   */
  getOutput(terminalId: string, lines?: number): Promise<ProcessOutputResult | null>;

  /**
   * 终止指定后台进程并回收资源。
   * @returns 成功终止返回 true；找不到该 id 返回 false。
   */
  stop(terminalId: string): Promise<boolean>;

  /** 列出当前由本管理器维护的所有后台进程（含已退出但尚未清理的）。 */
  list(): Promise<BackgroundProcessInfo[]>;
}
