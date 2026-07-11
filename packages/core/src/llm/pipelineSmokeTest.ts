import {
  DefaultLLMHandler,
  DefaultOutputHandler,
  DefaultPipelineOrchestrator,
  DefaultRequestContextHandler,
  DefaultToolDispatchHandler,
  DefaultTurnContextHandler,
} from "./index.js";
import type { PipelineOrchestratorOutput } from "./index.js";

/**
 * PipelineSmokeTestResult
 *
 * 第一阶段最小 smoke test 结果结构：用于在不接入真实 provider / tool host 的前提下，
 * 验证五段式责任链骨架是否可以顺序执行并给出稳定阶段输出。
 */
export interface PipelineSmokeTestResult {
  ok: boolean;
  output: PipelineOrchestratorOutput;
}

/**
 * 运行第一阶段最小 smoke test。
 *
 * 用途：
 * - 供后续更高层的自检/命令/评估逻辑直接调用
 * - 避免每次只靠测试框架断言，保留一个可程序化消费的最小自检入口
 */
export async function runPipelineSmokeTest(): Promise<PipelineSmokeTestResult> {
  const orchestrator = new DefaultPipelineOrchestrator(
    new DefaultRequestContextHandler(),
    new DefaultTurnContextHandler(),
    new DefaultLLMHandler(),
    new DefaultToolDispatchHandler(),
    new DefaultOutputHandler(),
  );

  const output = await orchestrator.run({
    requestId: "smoke-req-1",
    turnId: "smoke-turn-1",
    startedAt: new Date().toISOString(),
    userInput: "smoke test",
  });

  const ok =
    output.requestStage === "base_messages_built" &&
    output.turnStage === "turn_context_ready" &&
    output.llmStage === "prepared" &&
    output.toolStage === "dispatching" &&
    output.outputStage === "ready_to_commit" &&
    output.shouldContinue === false;

  return { ok, output };
}
