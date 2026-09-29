import type {
  ToolDispatchHandler,
  ToolDispatchHandlerContract,
  ToolDispatchHandlerInput,
  ToolDispatchHandlerOutputDraft,
  ToolContext,
  InternalEvent,
  ToolEvent,
} from "./index.js";
import { ToolCallStateMachine } from "./toolCallStateMachine.js";
import type { ToolExecutor } from "./toolExecutor.js";
import type { ToolGateDecider } from "./toolGateDecider.js";

export interface ToolDispatchBatch {
  parallel: boolean;
  drafts: ToolEvent[];
}

/**
 * 按执行语义规划批次：连续 command 并行，其它工具保持串行。
 * waitingFor 记录每个调用开始前必须完成的工具，供前端展示真实阻塞关系。
 */
export function planToolDispatch(drafts: readonly ToolEvent[]): {
  batches: ToolDispatchBatch[];
  waitingFor: Map<string, string[]>;
} {
  const batches: ToolDispatchBatch[] = [];
  const waitingFor = new Map<string, string[]>();
  let index = 0;
  let previousBatchIds: string[] = [];

  while (index < drafts.length) {
    const parallel = drafts[index].toolKind === "command";
    const group: ToolEvent[] = [];
    while (index < drafts.length && (drafts[index].toolKind === "command") === parallel) {
      group.push(drafts[index]);
      index++;
    }

    const earlierInGroup: string[] = [];
    for (const draft of group) {
      waitingFor.set(draft.callId, parallel
        ? [...previousBatchIds]
        : [...previousBatchIds, ...earlierInGroup]);
      earlierInGroup.push(draft.callId);
    }
    batches.push({ parallel, drafts: group });
    previousBatchIds = group.map((draft) => draft.callId);
  }

  return { batches, waitingFor };
}

/**
 * ToolDispatchHandler 实现：用 ToolCallStateMachine 驱动每个工具调用的完整流转。
 *
 * 说明：
 * - 不注入 executor 时退回为“骨架模式”：不真正执行，只按草案回显上下文（保持向后兼容、零风险）。
 * - 注入 executor 时：对每个工具草案跑一遍 plan ->（门控）-> execute -> complete/fail，
 *   把状态机产出的 ToolEvent 收集进 runtimeEvents，并把最终快照写回 toolContexts。
 * - 可选注入 gateDecider（方案 B）：在 execute 前统一做门控决策（放行/拦截/改写参数）；
 *   不注入时默认全部放行，行为与方案 A 完全一致（零回退）。
 * - 本层只负责“驱动状态流转 + 产出统一事件”，真正执行委托给 ToolExecutor，不耦合宿主细节。
 */
export class DefaultToolDispatchHandler implements ToolDispatchHandler, ToolDispatchHandlerContract {
  constructor(
    private readonly executor?: ToolExecutor,
    private readonly gateDecider?: ToolGateDecider,
  ) {}

  async handle(input: ToolDispatchHandlerInput): Promise<ToolDispatchHandlerOutputDraft> {
    // 无草案：无事可做，保持 dispatching 空转语义。
    if (input.toolDrafts.length === 0) {
      return {
        runtimeEvents: [],
        toolContexts: input.toolContexts,
        toolResultsReady: false,
        stage: "dispatching",
      };
    }

    // 未注入执行器：仅收到草案，尚不具备执行能力（骨架模式）。
    if (!this.executor) {
      return {
        runtimeEvents: [],
        toolContexts: input.toolContexts,
        toolResultsReady: false,
        stage: "draft_received",
      };
    }

    const runtimeEvents: InternalEvent[] = [];
    const toolContexts: ToolContext[] = [];
    const executor = this.executor;
    let anyFailed = false;

    const runDraft = async (draft: ToolEvent): Promise<{ events: InternalEvent[]; context: ToolContext; failed: boolean }> => {
      const machine = new ToolCallStateMachine({
        requestId: input.requestId,
        turnId: input.turnId,
        callId: draft.callId,
        toolName: draft.toolName,
        toolKind: draft.toolKind,
      });

      // plan：登记本次工具调用（携带原始参数文本，便于 trace/调试）。
      const events: InternalEvent[] = [machine.plan(draft.rawArgsText)];

      // 门控决策（方案 B）：execute 之前统一决定放行/拦截/改写参数。
      // 未注入决策器时默认放行，行为与方案 A 完全一致。
      let execArgs = draft.parsedArgs;
      if (this.gateDecider) {
        let decision;
        try {
          decision = await this.gateDecider.decide({
            callId: draft.callId,
            toolName: draft.toolName,
            toolKind: draft.toolKind,
            parsedArgs: draft.parsedArgs,
            rawArgsText: draft.rawArgsText,
          });
        } catch (err) {
          // 决策器自身异常：保守拦截，避免在门控不确定时放行（安全优先）。
          decision = { action: "block" as const, reason: `门控决策异常：${(err as Error).message || "unknown"}` };
        }
        if (decision.action === "block") {
          // 拦截：工具不执行，收敛为 cancelled 终态（block 内部置 gateState=blocked）。
          const blocked = machine.block(decision.reason) as ToolEvent;
          events.push(blocked);
          return {
            events,
            failed: true,
            context: {
            requestId: input.requestId,
            turnId: input.turnId,
            callId: draft.callId,
            toolName: draft.toolName,
            toolKind: draft.toolKind,
            partialToolEvent: blocked,
            },
          };
        }
        // 放行：可能携带改写后的参数（如用户编辑过的命令）。
        if (decision.editedArgs) execArgs = decision.editedArgs;
      }

      // execute：宿主开始真正执行（用门控放行后的实际参数）。
      events.push(machine.execute(execArgs));

      let finalEvent: ToolEvent;
      let failed = false;
      try {
        const res = await executor.execute({
          callId: draft.callId,
          toolName: draft.toolName,
          parsedArgs: execArgs,
          rawArgsText: draft.rawArgsText,
        });
        finalEvent = res.ok
          ? machine.complete(res.result)
          : machine.fail(res.error ?? "工具执行失败");
        if (!res.ok) failed = true;
      } catch (err) {
        // 执行器抛异常同样收敛为 fail 事件，绝不静默吞掉。
        finalEvent = machine.fail((err as Error).message || "工具执行异常");
        failed = true;
      }
      events.push(finalEvent);
      return {
        events,
        failed,
        context: {
          requestId: input.requestId,
          turnId: input.turnId,
          callId: draft.callId,
          toolName: draft.toolName,
          toolKind: draft.toolKind,
          partialToolEvent: finalEvent,
        },
      };
    };

    // 命令工具彼此独立：一个命令超时或长时间运行时，不能阻塞同一批里的其他命令。
    // 其他工具仍按原顺序执行，避免文件编辑、诊断和上下文操作之间的隐式依赖被打乱。
    const { batches } = planToolDispatch(input.toolDrafts);
    for (const batch of batches) {
      const results = batch.parallel
        ? await Promise.all(batch.drafts.map(runDraft))
        : await batch.drafts.reduce<Promise<Awaited<ReturnType<typeof runDraft>>[]>>(async (chain, item) => {
          const completed = await chain;
          completed.push(await runDraft(item));
          return completed;
        }, Promise.resolve([]));
      for (const result of results) {
        runtimeEvents.push(...result.events);
        toolContexts.push(result.context);
        anyFailed = anyFailed || result.failed;
      }
    }

    return {
      runtimeEvents,
      toolContexts,
      toolResultsReady: true,
      stage: anyFailed ? "tool_failed" : "tool_completed",
    };
  }
}
