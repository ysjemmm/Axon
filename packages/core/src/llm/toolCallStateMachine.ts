/**
 * ToolCallStateMachine —— 单次工具调用的状态机（纯逻辑，可测试）
 *
 * 背景：
 * - 旧实现里工具调用的状态推进（pending/executing/success/error/cancelled）散落在
 *   agentSession 的执行循环里，前后端各自猜状态，语义不统一、无法单测。
 * - 本状态机把“单次工具调用的合法阶段流转 + 对应 ToolEvent 产出”收敛成一个可测原语。
 *
 * 设计要点：
 * - 纯逻辑：不执行真实工具、不发事件、不碰 DOM；每次状态推进返回对应的 ToolEvent。
 * - 合法性校验：非法流转（如从终态再执行）直接抛错，避免状态被悄悄改坏。
 * - stage 由 phase 自动推导（planned/executing=runtime；completed/failed/cancelled=committed），
 *   不再让调用方各自决定，避免语义分散。
 */

import type { ToolEventBase, ToolPhase, ToolKind, ToolOutcomeKind, ToolGateState } from "./toolEventModel.js";
import type { RequestId, TurnId, EventStage } from "./eventModel.js";

/** 工具调用状态机的构造归属信息（一次工具调用内共享）。 */
export interface ToolCallContext {
  requestId: RequestId;
  turnId?: TurnId;
  callId: string;
  toolName: string;
  toolKind: ToolKind;
  /** 可选时间戳来源（便于测试注入固定时间）；默认取当前时间。 */
  now?: () => string;
}

/** 由工具阶段推导事件层级：运行中为 runtime，终态为 committed。 */
export function toolPhaseToStage(phase: ToolPhase): EventStage {
  switch (phase) {
    case "planned":
    case "executing":
      return "runtime";
    case "completed":
    case "failed":
    case "cancelled":
      return "committed";
  }
}

/** 终态集合：进入后不允许再推进。 */
const TERMINAL_PHASES: ReadonlySet<ToolPhase> = new Set<ToolPhase>(["completed", "failed", "cancelled"]);

/** 合法流转表：key 为当前阶段，value 为允许进入的下一阶段集合。 */
const ALLOWED_TRANSITIONS: Record<ToolPhase, ReadonlySet<ToolPhase>> = {
  planned: new Set<ToolPhase>(["executing", "cancelled"]),
  executing: new Set<ToolPhase>(["completed", "failed", "cancelled"]),
  completed: new Set<ToolPhase>(),
  failed: new Set<ToolPhase>(),
  cancelled: new Set<ToolPhase>(),
};

export class ToolCallStateMachine {
  private phase: ToolPhase = "planned";
  private started = false;
  /** 当前门控状态：仅在 planned 阶段有意义，确认/放行后回到 none。 */
  private gateState: ToolGateState = "none";

  constructor(private readonly ctx: ToolCallContext) {}

  /** 当前阶段。 */
  currentPhase(): ToolPhase {
    return this.phase;
  }

  /** 当前门控状态。 */
  currentGateState(): ToolGateState {
    return this.gateState;
  }

  /** 是否处于等待用户处理的门控中（confirm/input）。 */
  isWaitingGate(): boolean {
    return this.gateState === "waiting_confirm" || this.gateState === "waiting_input";
  }

  /** 是否已进入终态。 */
  isTerminal(): boolean {
    return TERMINAL_PHASES.has(this.phase);
  }

  private nowIso(): string {
    return this.ctx.now ? this.ctx.now() : new Date().toISOString();
  }

  private assertTransition(next: ToolPhase): void {
    // planned 是初始态，首次产出 plan 事件不算“流转”，单独处理。
    if (!this.started) return;
    if (!ALLOWED_TRANSITIONS[this.phase].has(next)) {
      throw new Error(`非法工具状态流转：${this.phase} -> ${next}（callId=${this.ctx.callId}, tool=${this.ctx.toolName}）`);
    }
  }

  private buildEvent(phase: ToolPhase, extra: Partial<ToolEventBase>): ToolEventBase {
    return {
      type: "tool.phase",
      ts: this.nowIso(),
      requestId: this.ctx.requestId,
      turnId: this.ctx.turnId,
      source: "tool",
      stage: toolPhaseToStage(phase),
      callId: this.ctx.callId,
      toolName: this.ctx.toolName,
      toolKind: this.ctx.toolKind,
      phase,
      ...extra,
    };
  }

  /**
   * 进入 planned：模型已决定调用该工具，但尚未执行。
   * 这是初始状态，产出第一条 ToolEvent。
   */
  plan(rawArgsText?: string, gateState?: ToolGateState): ToolEventBase {
    this.assertTransition("planned");
    this.phase = "planned";
    this.started = true;
    if (gateState) this.gateState = gateState;
    return this.buildEvent("planned", { rawArgsText, gateState: this.gateState });
  }

  /**
   * 挂起门控：工具需要等待用户确认/补充输入才能执行。
   * 仅允许在 planned 阶段挂门控；产出一条仍处于 planned、但带 gateState 的事件。
   */
  requireGate(gateState: Extract<ToolGateState, "waiting_confirm" | "waiting_input">): ToolEventBase {
    if (this.phase !== "planned") {
      throw new Error(`门控只能在 planned 阶段挂起，当前阶段：${this.phase}（callId=${this.ctx.callId}, tool=${this.ctx.toolName}）`);
    }
    this.gateState = gateState;
    return this.buildEvent("planned", { gateState });
  }

  /**
   * 用户通过门控（确认/补齐输入）：清除门控，回到无门控的 planned，允许后续 execute。
   */
  approveGate(): ToolEventBase {
    if (!this.isWaitingGate()) {
      throw new Error(`没有待处理的门控可放行（gateState=${this.gateState}, callId=${this.ctx.callId}）`);
    }
    this.gateState = "none";
    return this.buildEvent("planned", { gateState: "none" });
  }

  /**
   * 门控被安全策略直接拦截：置为 blocked 并作为取消终态收尾（工具未执行）。
   */
  block(reason?: string): ToolEventBase {
    if (this.phase !== "planned") {
      throw new Error(`拦截只能发生在 planned 阶段，当前阶段：${this.phase}（callId=${this.ctx.callId}, tool=${this.ctx.toolName}）`);
    }
    this.gateState = "blocked";
    this.phase = "cancelled";
    return this.buildEvent("cancelled", {
      gateState: "blocked",
      aiPayload: { ok: false, error: reason },
    });
  }

  /** 进入 executing：参数已就绪，宿主开始真正执行工具。 */
  execute(parsedArgs?: Record<string, unknown>): ToolEventBase {
    if (this.isWaitingGate()) {
      throw new Error(`工具仍在等待门控处理，不能执行（gateState=${this.gateState}, callId=${this.ctx.callId}, tool=${this.ctx.toolName}）`);
    }
    this.assertTransition("executing");
    this.phase = "executing";
    return this.buildEvent("executing", { parsedArgs });
  }

  /** 进入 completed：工具执行成功。 */
  complete(result?: string, outcomeKind: ToolOutcomeKind = "normal"): ToolEventBase {
    this.assertTransition("completed");
    this.phase = "completed";
    return this.buildEvent("completed", {
      outcomeKind,
      aiPayload: { ok: true, result },
      tracePayload: result !== undefined ? { rawResult: result } : undefined,
    });
  }

  /** 进入 failed：工具执行失败。 */
  fail(error: string, outcomeKind: ToolOutcomeKind = "normal"): ToolEventBase {
    this.assertTransition("failed");
    this.phase = "failed";
    return this.buildEvent("failed", {
      outcomeKind,
      aiPayload: { ok: false, error },
      tracePayload: { rawError: error },
    });
  }

  /** 进入 cancelled：工具在完成前被取消。 */
  cancel(reason?: string): ToolEventBase {
    this.assertTransition("cancelled");
    this.phase = "cancelled";
    return this.buildEvent("cancelled", {
      aiPayload: { ok: false, error: reason },
    });
  }
}
