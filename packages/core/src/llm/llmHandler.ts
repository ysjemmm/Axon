import type {
  LLMHandler,
  LLMHandlerContract,
  LLMHandlerInput,
  LLMHandlerOutputDraft,
  InternalEvent,
  ToolEvent,
} from "./index.js";
import { ReasoningStreamProcessor } from "./reasoningStreamProcessor.js";
import { toolPhaseToStage } from "./toolCallStateMachine.js";
import type { LLMTurnSource } from "./llmTurnSource.js";

/**
 * LLMHandler 实现：把一次回合的原始产物归一化成统一内部事件与草案。
 *
 * 说明：
 * - 不注入 source 时退回“骨架模式”：不真正跑回合，只返回 prepared 空草案（保持向后兼容、零风险）。
 * - 注入 source 时：跑一次回合，用 ReasoningStreamProcessor 把 reasoning 增量归一化成
 *   reasoning.delta 序列 + 一条 reasoning.commit，正文与工具草案一并整理进输出草案。
 * - 本层只负责“归一化编排”，真正的协议执行委托给 LLMTurnSource，不耦合 provider 细节。
 */
export class DefaultLLMHandler implements LLMHandler, LLMHandlerContract {
  constructor(private readonly source?: LLMTurnSource) {}

  async handle(input: LLMHandlerInput): Promise<LLMHandlerOutputDraft> {
    // 未注入回合来源：骨架模式，尚不具备执行能力。
    if (!this.source) {
      return {
        runtimeEvents: [],
        toolDrafts: [],
        contentDraft: "",
        finishReason: undefined,
        stage: "prepared",
      };
    }

    const raw = await this.source.run(input.effectiveMessages);

    const runtimeEvents: InternalEvent[] = [];

    // reasoning：逐条增量归一化成 reasoning.delta，收尾产出一条 reasoning.commit。
    const reasoning = new ReasoningStreamProcessor({
      requestId: input.requestId,
      turnId: input.turnId,
    });
    for (const delta of raw.reasoningDeltas) {
      const ev = reasoning.push(delta);
      if (ev) runtimeEvents.push(ev);
    }
    const commit = reasoning.commit();
    if (commit) runtimeEvents.push(commit);

    // 工具草案：归一化成 ToolEvent（planned 态），供后续 ToolDispatchHandler 消费。
    const toolDrafts: ToolEvent[] = raw.toolCalls.map((tc) => ({
      type: "tool.phase",
      ts: new Date().toISOString(),
      requestId: input.requestId,
      turnId: input.turnId,
      source: "tool",
      stage: toolPhaseToStage("planned"),
      phase: "planned",
      callId: tc.callId,
      toolName: tc.toolName,
      toolKind: tc.toolKind,
      parsedArgs: tc.parsedArgs,
      rawArgsText: tc.rawArgsText,
    }));

    // 结束阶段：有工具调用 → tool_calls_detected；失败 → failed；否则内容完成。
    const stage: LLMHandlerOutputDraft["stage"] =
      raw.finishReason === "error"
        ? "failed"
        : toolDrafts.length > 0
          ? "tool_calls_detected"
          : "content_completed";

    return {
      runtimeEvents,
      toolDrafts,
      contentDraft: raw.content,
      finishReason: raw.finishReason,
      // 透传真实 token 用量，供上层（canary 驱动 UI 时）精确计费/驱动压缩。
      usage: raw.usage,
      stage,
    };
  }
}
