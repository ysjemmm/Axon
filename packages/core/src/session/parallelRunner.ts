/**
 * ParallelRunner —— parallel_research / parallel_execute 并行子 Agent 编排（从 AgentSession 解耦）
 *
 * 职责单一：把一个大任务拆成多个互不依赖的子任务，派发并发子 Agent（调研只读 / 执行带文件作用域），
 * 实时转发各路事件、收集执行回滚快照、累加 token，最后聚合结论回填。
 *
 * 通过构造注入的 session 引用访问运行时状态与能力（@internal）：会话标识/工作区/host/中止信号/
 * 并发计数器/活动 Relay 任务/并行回滚快照存储/子 Agent token 累加等。
 */

import { getStrategy, getClient } from "../providers.js";
import { deriveSubAgentHost } from "../host/index.js";
import { runParallelResearch, aggregateResearchResults, type ResearchTask } from "../relay/parallelResearch.js";
import { runParallelExecution, aggregateExecutionResults, type ExecutionTask } from "../relay/parallelExecution.js";
import type { EditSnapshot } from "../host/scopedHost.js";
import type { SubAgentEmit } from "../skills/subAgentRunner.js";
import type { AgentSession } from "../agentSession.js";

export class ParallelRunner {
  constructor(private readonly s: AgentSession) {}

  /**
   * 执行 parallel_research：派发多个只读子 Agent 并发调研，聚合结论回填。
   * 每路子 Agent 的事件用 sub_agent_event 包装（带独立 delegateId），前端各自渲染卡片。
   */
  async research(args: Record<string, unknown>, toolCallId: string): Promise<string> {
    const intent = typeof args.intent === "string" ? args.intent : "";
    const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
    if (rawTasks.length === 0) throw new Error("parallel_research 需要至少一个调研子任务");

    const batchId = `research-${Date.now()}-${++this.s.researchSeq}`;
    const tasks: ResearchTask[] = rawTasks.map((t, i) => {
      const obj = (t || {}) as Record<string, unknown>;
      return {
        id: `${batchId}-${i + 1}`,
        intent: typeof obj.intent === "string" ? obj.intent : `调研 ${i + 1}`,
        prompt: typeof obj.prompt === "string" ? obj.prompt : "",
      };
    }).filter((t) => t.prompt.trim());
    if (tasks.length === 0) throw new Error("parallel_research 的子任务都缺少 prompt");

    // 通知前端：并行调研开始（携带各子任务的 delegateId 与 intent，供渲染并列卡片）
    this.s.send("parallel_research_start", {
      batchId,
      toolCallId,
      intent,
      tasks: tasks.map((t) => ({ delegateId: t.id, intent: t.intent, prompt: t.prompt })),
    });

    // 为每个子任务生成绑定其 delegateId 的事件发射器
    const emitFor = (taskId: string): SubAgentEmit => {
      return (type, data) => this.s.send("sub_agent_event", { delegateId: taskId, event: { type, ...data } });
    };

    const results = await runParallelResearch(tasks, {
      strategy: getStrategy(this.s.provider, this.s.model),
      model: this.s.model,
      cwd: this.s.cwd,
      workspaces: this.s.workspaces,
      host: deriveSubAgentHost(this.s.host),
      signal: this.s.abortSignal,
      skillLoader: this.s.loadSkillForTool,
      web: this.s.web,
      emitFor,
      client: getClient(this.s.provider, this.s.model),
      maxConcurrency: 3,
    });

    // 通知前端：各路调研结束
    for (const r of results) {
      this.s.send("sub_agent_end", { delegateId: r.id, result: r.text });
    }
    // 累加所有调研子 Agent 的 token 到会话总量
    this.s.addSubAgentTokens(results.reduce((sum, r) => sum + (r.tokens || 0), 0));
    this.s.send("parallel_research_end", { batchId, results: results.map((r) => ({ delegateId: r.id, ok: r.ok })) });

    return aggregateResearchResults(results);
  }

  /**
   * 执行 parallel_execute：派发多个子 Agent 并行执行写任务，各自有文件作用域隔离。
   * 每路子 Agent 的事件用 sub_agent_event 包装（带独立 delegateId），前端各自渲染卡片。
   */
  async execute(args: Record<string, unknown>, toolCallId: string): Promise<string> {
    const intent = typeof args.intent === "string" ? args.intent : "";
    const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
    if (rawTasks.length === 0) throw new Error("parallel_execute 需要至少一个执行子任务");

    const batchId = `exec-${Date.now()}-${++this.s.executionSeq}`;
    const tasks: ExecutionTask[] = rawTasks.map((t, i) => {
      const obj = (t || {}) as Record<string, unknown>;
      return {
        id: `${batchId}-${i + 1}`,
        intent: typeof obj.intent === "string" ? obj.intent : `任务 ${i + 1}`,
        prompt: typeof obj.prompt === "string" ? obj.prompt : "",
        fileScope: Array.isArray(obj.fileScope) ? obj.fileScope.filter((s): s is string => typeof s === "string") : [],
      };
    }).filter((t) => t.prompt.trim());
    if (tasks.length === 0) throw new Error("parallel_execute 的子任务都缺少 prompt");

    // 通知前端：并行执行开始（携带各子任务的 delegateId、intent、fileScope）
    // 如果在 Relay 上下文中调用，附带 relayId 供前端关联跳转
    const relayId = this.s.activeRelayTask?.relayId || undefined;
    this.s.send("parallel_execute_start", {
      batchId,
      toolCallId,
      intent,
      relayId,
      tasks: tasks.map((t) => ({ delegateId: t.id, intent: t.intent, fileScope: t.fileScope, prompt: t.prompt })),
    });

    // 为每个子任务生成绑定其 delegateId 的事件发射器
    const emitFor = (taskId: string): SubAgentEmit => {
      return (type, data) => this.s.send("sub_agent_event", { delegateId: taskId, event: { type, ...data } });
    };

    const startTime = Date.now();
    const batchSnapshots = new Map<string, EditSnapshot>();
    const results = await runParallelExecution(tasks, {
      strategy: getStrategy(this.s.provider, this.s.model),
      model: this.s.model,
      cwd: this.s.cwd,
      workspaces: this.s.workspaces,
      host: this.s.host,
      signal: this.s.abortSignal,
      skillLoader: this.s.loadSkillForTool,
      web: this.s.web,
      emitFor,
      client: getClient(this.s.provider, this.s.model),
      maxConcurrency: 3,
      snapshotStore: batchSnapshots,
    });
    const elapsed = Date.now() - startTime;

    // 收集本批次的回滚快照（按 AI 路径索引，供前端"一键回滚"）
    for (const snap of batchSnapshots.values()) {
      this.s.parallelSnapshots.set(snap.path, snap);
    }

    // 通知前端：各路执行结束
    for (const r of results) {
      this.s.send("sub_agent_end", { delegateId: r.id, result: r.text });
    }
    // 累加所有子 Agent 的 token 到会话总量
    const totalTokens = results.reduce((sum, r) => sum + (r.tokens || 0), 0);
    this.s.addSubAgentTokens(totalTokens);
    this.s.send("parallel_execute_end", {
      batchId,
      results: results.map((r) => ({ delegateId: r.id, ok: r.ok })),
      elapsed,
      totalTokens,
    });

    return aggregateExecutionResults(results);
  }
}
