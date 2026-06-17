/**
 * Session 管理器 - 维护消息列表、token 计数、持久化
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

const MAX_TOKENS = 180_000;
const COMPACT_THRESHOLD = 0.85;

export class SessionManager {
  private messages: ChatCompletionMessageParam[] = [];

  constructor(systemPrompt: string) {
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  /** 获取当前完整消息列表（传给 LLM 用） */
  getMessages(): ChatCompletionMessageParam[] {
    return [...this.messages];
  }

  /** 追加用户消息 */
  addUserMessage(content: string): void {
    this.messages.push({ role: "user", content });
  }

  /** 追加 assistant 消息（含工具调用） */
  addAssistantMessage(message: ChatCompletionMessageParam): void {
    this.messages.push(message);
  }

  /** 追加工具执行结果 */
  addToolResult(toolCallId: string, content: string): void {
    this.messages.push({ role: "tool", tool_call_id: toolCallId, content });
  }

  /** 获取消息数量 */
  getMessageCount(): number {
    return this.messages.length;
  }

  /** 估算 token 数（粗略：1 字符 ≈ 0.4 token） */
  estimateTokens(): number {
    const totalChars = this.messages.reduce((sum, msg) => {
      const content = typeof msg.content === "string" ? msg.content : "";
      return sum + content.length;
    }, 0);
    return Math.ceil(totalChars * 0.4);
  }

  /** 检查是否需要压缩 */
  needsCompaction(): boolean {
    return this.estimateTokens() > MAX_TOKENS * COMPACT_THRESHOLD;
  }
}
