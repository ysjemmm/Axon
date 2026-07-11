/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ReflectionHandler -- 卡住时的反思/摘要重启/重读真实状态（从 AgentSession 解耦）
 *
 * 职责：当 agent loop 检测到连续失败（卡住）时，分两级干预--
 * - 反思·换路（轻量）：重读卡住文件的最新内容 + 注入复盘引导，给一次换路机会；
 * - 摘要重启（重量）：把反复失败的过程压成复盘摘要、清除噪声原文，再重读真实状态，换条路重来。
 *
 * 状态字段仍留在 session（@internal），本类通过构造注入的 session 引用读写。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { LLMStrategy } from "../llm/types.js";
import { reflectiveCompact } from "../compactor.js";
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

  /** 摘要重启（重量层）。 */
  async injectSummaryRestart(stuck: StuckTarget | null, guard: LoopGuard, strategy: LLMStrategy): Promise<void> {
    this.s.send("status", { content: "整理思路，换个方式重来...", phase: "thinking" });
    this.s.messages = await reflectiveCompact(this.s.messages, strategy, this.s.model);
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
