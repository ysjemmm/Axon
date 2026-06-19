/**
 * 并行执行编排器 —— 同时派发多个子 Agent 执行互不重叠的写任务
 *
 * 与 parallelResearch.ts（只读调研）的核心区别：
 * - 子 Agent 允许写文件（readOnly: false）
 * - 每路 Agent 有明确的 fileScope（允许写入的路径 glob 列表）
 * - 通过 ScopedFileSystem 代理层强制文件分区隔离：越界写入 → 快速失败
 *
 * 隔离策略（第一期：文件分区锁）：
 * 主 Agent 拆任务时声明每个子 Agent 的 fileScope。编排器为每个子 Agent 注入
 * 一个 ScopedFileSystem，write/create/patch 操作会校验目标路径是否在 scope 内。
 * 越界 → 报 ToolError 并记录（不静默覆盖）。
 *
 * 第二期可升级为 git worktree 隔离（每路一个独立分支 + 自动合并）。
 *
 * 并发控制：与 parallelResearch 一致，worker 池模式 + maxConcurrency。
 */

import { SubAgentRunner, type SubAgentResult, type SubAgentEmit } from "../skills/subAgentRunner.js";
import { createScopedHost, type EditSnapshot } from "../host/scopedHost.js";
import type { LLMStrategy } from "../llm/types.js";
import type { SkillLoaderFn, WebCapability } from "../tools/index.js";
import type { AgentHost } from "../host/index.js";
import type OpenAI from "openai";

/** 单个执行子任务 */
export interface ExecutionTask {
  /** 子任务唯一标识（delegateId，用于前端卡片路由与结果归集） */
  id: string;
  /** 一句话任务描述（展示给用户） */
  intent: string;
  /** 交给子 Agent 的完整执行指令（自包含） */
  prompt: string;
  /** 允许写入的文件/目录 glob 列表（文件分区隔离） */
  fileScope: string[];
}

/** 单个执行结果 */
export interface ExecutionResult {
  id: string;
  intent: string;
  ok: boolean;
  text: string;
  /** 该路子 Agent 消耗的 token */
  tokens: number;
  /** 该路子 Agent 实际修改的文件列表 */
  changedFiles: string[];
}

/** 编排器依赖（由 AgentSession 注入） */
export interface ParallelExecutionDeps {
  strategy: LLMStrategy;
  model: string;
  cwd: string;
  workspaces: string[];
  host: AgentHost;
  signal?: AbortSignal;
  skillLoader?: SkillLoaderFn;
  web?: WebCapability;
  client?: OpenAI;
  /**
   * 事件发射器工厂：为某个子任务返回一个绑定其 id 的 emit，
   * 父级据此把不同子 Agent 的事件路由到各自的前端卡片。
   */
  emitFor: (taskId: string) => SubAgentEmit;
  /** 最大并发数（默认 3） */
  maxConcurrency?: number;
  /** 回滚快照收集器（key=absPath）：执行完由调用方读取，供批次级"一键回滚" */
  snapshotStore?: Map<string, EditSnapshot>;
}

/**
 * 以受控并发执行一组写任务，返回与输入顺序一致的结果数组。
 * 每路子 Agent 有独立的 fileScope，越界写入会被拦截。
 * 启动前校验 fileScope 交叉——有重叠时拒绝执行（快速失败）。
 * 任一子任务失败不影响其它（各自独立 try/catch），失败项 ok=false 并附带原因。
 */
export async function runParallelExecution(
  tasks: ExecutionTask[],
  deps: ParallelExecutionDeps,
): Promise<ExecutionResult[]> {
  // 前置校验：fileScope 交叉检测
  const overlap = detectScopeOverlap(tasks);
  if (overlap) {
    throw new Error(
      `文件作用域冲突：任务「${overlap.taskA}」和「${overlap.taskB}」的 fileScope 存在重叠（${overlap.pattern}）。` +
      `并行执行要求各子任务的文件作用域互不重叠，请调整拆分方案。`
    );
  }

  const maxConcurrency = Math.max(1, deps.maxConcurrency ?? 3);
  const results: ExecutionResult[] = new Array(tasks.length);
  let cursor = 0;

  /** 一个 worker 不断从队列取任务执行，直到取完 */
  async function worker(): Promise<void> {
    while (true) {
      if (deps.signal?.aborted) return;
      const idx = cursor++;
      if (idx >= tasks.length) return;
      const task = tasks[idx];

      // 构建文件作用域约束提示（注入子 Agent 的系统提示）
      const scopeHint = task.fileScope.length > 0
        ? `\n\n【文件作用域约束】你只能修改以下路径范围内的文件，越界写入会被系统拦截：\n${task.fileScope.map((s) => `  - ${s}`).join("\n")}\n其他路径的文件你可以读取，但不能修改。` +
          `\n\n【效率约束】如果目标文件/目录不存在，立即报告"目标不存在，无法执行"并结束。不要反复尝试不同路径。最多尝试 2 次定位，找不到就放弃。`
        : `\n\n【效率约束】如果目标文件/目录不存在，立即报告"目标不存在，无法执行"并结束。不要反复尝试不同路径。最多尝试 2 次定位，找不到就放弃。`;

      const fullPrompt = task.prompt + scopeHint;

      const runner = new SubAgentRunner({
        strategy: deps.strategy,
        model: deps.model,
        cwd: deps.cwd,
        workspaces: deps.workspaces,
        host: createScopedHost(deps.host, task.fileScope, deps.cwd, deps.snapshotStore),
        signal: deps.signal,
        emit: deps.emitFor(task.id),
        skillLoader: deps.skillLoader,
        web: deps.web,
        client: deps.client,
        readOnly: false, // 并行执行允许写（受 ScopedHost 文件作用域限制）
        maxRounds: 30, // 并行子 Agent 紧上限：30 轮（约 2-3 分钟），避免长时间空转
      });

      try {
        const res: SubAgentResult = await runner.run(fullPrompt, null);
        results[idx] = {
          id: task.id,
          intent: task.intent,
          ok: res.ok,
          text: res.text,
          tokens: res.tokens,
          changedFiles: [], // TODO: 从 SubAgentRunner 收集实际改动的文件
        };
      } catch (err) {
        results[idx] = {
          id: task.id,
          intent: task.intent,
          ok: false,
          text: `并行执行子任务中断或失败：${(err as Error).message}`,
          tokens: 0,
          changedFiles: [],
        };
      }
    }
  }

  // 启动不超过 maxConcurrency 个 worker 并发消费任务队列
  const workerCount = Math.min(maxConcurrency, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

/**
 * 把并行执行结果聚合成一段供主 Agent 消费的文本。
 */
export function aggregateExecutionResults(results: ExecutionResult[]): string {
  const blocks = results.map((r, i) => {
    const head = `## 任务 ${i + 1}：${r.intent}${r.ok ? " ✓" : " ✗（失败）"}`;
    const files = r.changedFiles.length > 0
      ? `\n修改的文件：${r.changedFiles.join(", ")}`
      : "";
    return `${head}${files}\n\n${r.text}`;
  });
  const okCount = results.filter((r) => r.ok).length;
  const header =
    `已完成 ${results.length} 路并行执行（成功 ${okCount} 路）。以下是各路执行的结论汇总：\n\n`;
  return header + blocks.join("\n\n---\n\n");
}


/**
 * 检测多个任务的 fileScope 是否存在交叉。
 * 简化逻辑：如果两个任务有完全相同的 scope 条目，或一个 scope 是另一个的前缀目录，视为冲突。
 * 返回第一个发现的冲突，无冲突返回 null。
 */
function detectScopeOverlap(tasks: ExecutionTask[]): { taskA: string; taskB: string; pattern: string } | null {
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const scopeA = tasks[i].fileScope;
      const scopeB = tasks[j].fileScope;
      for (const a of scopeA) {
        for (const b of scopeB) {
          if (scopesOverlap(a, b)) {
            return { taskA: tasks[i].intent, taskB: tasks[j].intent, pattern: `${a} ∩ ${b}` };
          }
        }
      }
    }
  }
  return null;
}

/** 判断两个 scope 模式是否可能重叠 */
function scopesOverlap(a: string, b: string): boolean {
  const normA = a.replace(/\\/g, "/").replace(/\/+$/, "");
  const normB = b.replace(/\\/g, "/").replace(/\/+$/, "");

  // 完全相同
  if (normA === normB) return true;

  // 去掉通配符后看前缀
  const dirA = normA.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
  const dirB = normB.replace(/\/\*\*$/, "").replace(/\/\*$/, "");

  // 如果都不含通配符，看是否是精确的同一文件
  if (!normA.includes("*") && !normB.includes("*")) {
    return normA === normB;
  }

  // 一个是另一个的前缀目录（如 "src/pages/**" 和 "src/pages/login/**"）
  if (dirA && dirB) {
    if (dirA.startsWith(dirB + "/") || dirB.startsWith(dirA + "/") || dirA === dirB) {
      return true;
    }
  }

  // 全通配 ** 与具体路径比较
  if (normA === "**" || normB === "**") return true;

  return false;
}
