import { describe, expect, it } from "vitest";
import {
  DefaultLLMHandler,
  DefaultOutputHandler,
  DefaultPipelineOrchestrator,
  DefaultRequestContextHandler,
  DefaultToolDispatchHandler,
  DefaultTurnContextHandler,
} from "./index.js";

describe("DefaultPipelineOrchestrator", () => {
  it("应能打通五段式责任链最小空链路", async () => {
    const orchestrator = new DefaultPipelineOrchestrator(
      new DefaultRequestContextHandler(),
      new DefaultTurnContextHandler(),
      new DefaultLLMHandler(),
      new DefaultToolDispatchHandler(),
      new DefaultOutputHandler(),
    );

    const result = await orchestrator.run({
      requestId: "req-1",
      turnId: "turn-1",
      startedAt: new Date().toISOString(),
      userInput: "帮我看看 GPT 为什么回复到一半自己断了。",
    });

    expect(result.requestStage).toBe("base_messages_built");
    expect(result.turnStage).toBe("turn_context_ready");
    expect(result.llmStage).toBe("prepared");
    expect(result.toolStage).toBe("dispatching");
    expect(result.outputStage).toBe("ready_to_commit");
    expect(result.shouldContinue).toBe(false);
    expect(result.finalContent).toBeUndefined();
  });
});
