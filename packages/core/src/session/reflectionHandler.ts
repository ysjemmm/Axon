/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ReflectionHandler -- 卡住时的反思/摘要重启/重读真实状态（从 AgentSession 解耦）
 *
 * 职责：当 agent loop 检测到连续失败（卡住）时，分两级干预--
 * - 反思·换路（轻量）：重读卡住文件的最新内容 + 注入复盘引导，给一次换路机会；
 * - 深度复盘（重量）：反思后仍失败时，注入更强的复盘引导（逐条排查失败原因），
 *   保留完整上下文--失败原文是避免重蹈覆辙的关键依据，不压缩、不清除。
 *
 * 状态字段仍留在 session（@internal），本类通过构造注入的 session 引用读写。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { LLMStrategy } from "../llm/types.js";
import { executeToolCall } from "../tools/index.js";
import { buildReflectionPrompt, buildSummaryRestartPrompt, type StuckTarget, type LoopGuard } from "../agentGuards.js";
import type { AgentSession } from "../agentSession.js";

export class ReflectionHandler {
  constructor(private readonly s: AgentSession) {}

  /** 反思·换路（轻量层）。 */
  async injectReflection(stuck: StuckTarget | null, guard: LoopGuard): Promise<void> {
    this.s.send("status", { content: "重新理清思路...", phase: "thinking" });
    const freshState = await this.readStuckTargetState(stuck);
    this.s.messages.push({ role: "system", content: buildReflectionPrompt(stuck) + freshState, _tailInjected: true, _ephemeralInjected: true } as ChatCompletionMessageParam);
    guard.noteReflected();
    this.s.loopGuardSnapshot = guard.snapshot();
    this.s.persistMessages();
  }

  /** 深度复盘（重量层）。不压缩上下文--注入更强的复盘引导，保留完整历史作为判断依据。 */
  async injectSummaryRestart(stuck: StuckTarget | null, guard: LoopGuard, strategy: LLMStrategy): Promise<void> {
    this.s.send("status", { content: "深度复盘，逐条排查...", phase: "thinking" });
    const freshState = await this.readStuckTargetState(stuck);
    this.s.messages.push({ role: "system", content: buildSummaryRestartPrompt(stuck) + freshState, _tailInjected: true, _ephemeralInjected: true } as ChatCompletionMessageParam);
    guard.noteSummaryRestart();
    this.s.loopGuardSnapshot = guard.snapshot();
    this.s.persistMessages();
  }

  /** 重读卡住目标的最新真实内容（仅当卡在某个文件上时）；失败不阻塞，返回空串。 */
  async readStuckTargetState(stuck: StuckTarget | null): Promise<string> {
    if (!stuck?.path) return "";
    try {
      const content = await executeToolCall("read_file", { path: stuck.path }, this.s.cwd, this.s.host, {}, this.s.workspaces);
      return `\n\n以下是 ${stuck.path} 的最新真实内容，请基于它（而不是你记忆中的旧状态）重新规划：\n${content}`;
    } catch {
      return "";
    }
  }
}
