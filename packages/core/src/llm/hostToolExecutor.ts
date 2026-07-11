/**
 * HostToolExecutor —— 把现网 executeToolCall 适配成新 pipeline 的 ToolExecutor（接现网桥接）
 *
 * 背景：
 * - 新 pipeline 的 ToolDispatchHandler 依赖 ToolExecutor 抽象真正执行一次工具调用。
 * - 现网工具执行由 tools/execute.ts 的 executeToolCall 承担（返回结果字符串，失败抛异常）。
 * - 本适配器把两者对接：调用 executeToolCall，把返回值/异常归一化成结构化 ToolExecuteResult。
 *
 * 设计要点：
 * - 不改动 executeToolCall 本身，只做“调用形状适配”，属于可零风险预制的桥接件。
 * - executeToolCall 成功返回结果文本 -> { ok: true, result }；抛异常 -> { ok: false, error }。
 * - 执行所需的 cwd / host / workspaces 等会话级依赖在构造时注入一次，execute 复用。
 */

import type { AgentHost } from "../host/index.js";
import type { SkillLoaderFn, PowerLoaderFn, WebCapability } from "../tools/index.js";
import { executeToolCall } from "../tools/index.js";
import type { ToolExecutor, ToolExecuteRequest, ToolExecuteResult } from "./toolExecutor.js";

/** 适配器构造参数：一次会话内相对稳定的执行环境依赖。 */
export interface HostToolExecutorOptions {
  cwd: string;
  host: AgentHost;
  workspaces?: string[];
  skillLoader?: SkillLoaderFn;
  web?: WebCapability;
  powerLoader?: PowerLoaderFn;
  signal?: AbortSignal;
}

/**
 * 基于现网 executeToolCall 的 ToolExecutor 实现。
 *
 * 说明：
 * - 只做形状适配，不引入新的业务判断，便于后续零风险接入主链路。
 * - 参数优先用 parsedArgs（已解析对象）；缺失时退回空对象，具体校验仍由 executeToolCall 内部完成。
 */
export class HostToolExecutor implements ToolExecutor {
  constructor(private readonly opts: HostToolExecutorOptions) {}

  async execute(req: ToolExecuteRequest): Promise<ToolExecuteResult> {
    try {
      const result = await executeToolCall(
        req.toolName,
        req.parsedArgs ?? {},
        this.opts.cwd,
        this.opts.host,
        undefined,
        this.opts.workspaces,
        this.opts.skillLoader,
        this.opts.web,
        this.opts.powerLoader,
        this.opts.signal,
      );
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: (err as Error).message || "工具执行失败" };
    }
  }
}
