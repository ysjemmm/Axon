/**
 * 并行调研编排器 - 同时派发多个只读子 Agent 探索工作区，聚合结论
 *
 * 对标业界 orchestrator-specialist 模式：主 Agent 当编排器，把一个大调研拆成
 * 若干个相互独立的子问题，每个交给一个【只读】子 Agent 并发执行，最后把各路结论汇总。
 *
 * 为什么只读：并行写同一工作区会互相覆盖文件（业界用 git worktree 隔离才敢并行写）。
 * 第一期先做并发安全的只读调研——零冲突、立刻可用；并行写任务留待 worktree 隔离落地后开放。
 *
 * 并发控制：限制最大并发数，避免一次派发过多子 Agent 打爆模型限流 / 本机资源。
 */

import { SubAgentRunner, type SubAgentResult, type SubAgentEmit } from "../skills/subAgentRunner.js";
import type { LLMStrategy } from "../llm/types.js";
import type { SkillLoaderFn, WebCapability } from "../tools/index.js";
import type { AgentHost } from "../host/index.js";
import type OpenAI from "openai";

/** 单个调研子任务 */
export interface ResearchTask {
  /** 子任务唯一标识（用于前端卡片路由与结果归集） */
  id: string;
  /** 一句话目的，展示给用户 */
  intent: string;
  /** 交给只读子 Agent 的完整调研描述（自包含） */
  prompt: string;
}

/** 单个调研结果 */
export interface ResearchResult {
  id: string;
  intent: string;
  ok: boolean;
  text: string;
  /** 该路调研子 Agent 消耗的 token */
  tokens: number;
}

/** 编排器依赖（由 AgentSession 注入） */
export interface ParallelResearchDeps {
  strategy: LLMStrategy;
  model: string;
  cwd: string;
  workspaces: string[];
  /** 执行端能力（透传给只读调研子 Agent） */
  host: AgentHost;
  signal?: AbortSignal;
  skillLoader?: SkillLoaderFn;
  /** web 能力（透传给调研子 Agent） */
  web?: WebCapability;
  /** LLM client（透传给子 Agent，用于卡住时的"摘要重启"；不传则子 Agent 跳过摘要重启层） */
  client?: OpenAI;
  /**
   * 事件发射器工厂：为某个调研子任务返回一个绑定其 id 的 emit，
   * 父级据此把不同子 Agent 的事件路由到各自的前端卡片。
   */
  emitFor: (taskId: string) => SubAgentEmit;
  /** 最大并发数（默认 3，避免限流） */
  maxConcurrency?: number;
}

/**
 * 以受控并发执行一组只读调研子任务，返回与输入顺序一致的结果数组。
 * 任一子任务失败不影响其它（各自独立 try/catch），失败项 ok=false 并附带原因。
 */
export async function runParallelResearch(
  tasks: ResearchTask[],
  deps: ParallelResearchDeps,
): Promise<ResearchResult[]> {
  const maxConcurrency = Math.max(1, deps.maxConcurrency ?? 3);
  const results: ResearchResult[] = new Array(tasks.length);
  let cursor = 0;

  /** 一个 worker 不断从队列取任务执行，直到取完 */
  async function worker(): Promise<void> {
    while (true) {
      if (deps.signal?.aborted) return;
      const idx = cursor++;
      if (idx >= tasks.length) return;
      const task = tasks[idx];

      const runner = new SubAgentRunner({
        strategy: deps.strategy,
        model: deps.model,
        cwd: deps.cwd,
        workspaces: deps.workspaces,
        host: deps.host,
        signal: deps.signal,
        emit: deps.emitFor(task.id),
        skillLoader: deps.skillLoader,
        web: deps.web,
        client: deps.client,
        readOnly: true, // 并行调研强制只读，保证并发安全
      });

      try {
        const res: SubAgentResult = await runner.run(task.prompt, null);
        results[idx] = { id: task.id, intent: task.intent, ok: res.ok, text: res.text, tokens: res.tokens };
      } catch (err) {
        results[idx] = {
          id: task.id,
          intent: task.intent,
          ok: false,
          text: `调研子任务中断或失败：${(err as Error).message}`,
          tokens: 0,
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
 * 把并行调研结果聚合成一段供主 Agent 消费的文本。
 * 明确区分成功/失败，让主 Agent 知道哪些结论可信、哪些要自己复核。
 */
export function aggregateResearchResults(results: ResearchResult[]): string {
  const blocks = results.map((r, i) => {
    const head = `## 调研 ${i + 1}：${r.intent}${r.ok ? "" : "（未完成，仅供参考）"}`;
    return `${head}\n\n${r.text}`;
  });
  const okCount = results.filter((r) => r.ok).length;
  const header =
    `已完成 ${results.length} 路并行调研（成功 ${okCount} 路）。以下是各路调研的结论汇总，` +
    `请基于它们综合判断；标注「未完成」的部分不可信，必要时你自己复核：\n\n`;
  return header + blocks.join("\n\n");
}
