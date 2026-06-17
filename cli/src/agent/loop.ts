/**
 * Agent 主循环 - 核心调度引擎
 *
 * 流程：用户输入 → 构建 messages → 调 LLM → 解析响应
 *       → 如果有 tool_calls → 执行工具 → 结果追加到 messages → 再调 LLM
 *       → 如果只有文本 → 输出给用户，等待下一轮输入
 */

import { LlmClient, type LlmConfig } from "../llm/client.js";
import { SessionManager } from "../session/manager.js";
import { getToolByName, getToolDefinitions } from "../tools/index.js";

const SYSTEM_PROMPT = `你是 Axon，一个 AI 编程助手。你可以：
1. 读取和修改用户的代码文件
2. 执行终端命令
3. 帮助用户理解和重构代码

规则：
- 使用中文回答
- 修改文件前先读取文件内容
- 每次只做用户要求的事情，不要多余操作
- 如果不确定，先问用户`;

export class AgentLoop {
  private llm: LlmClient;
  private session: SessionManager;
  private cwd: string;

  constructor(config: LlmConfig, cwd: string) {
    this.llm = new LlmClient(config);
    this.session = new SessionManager(SYSTEM_PROMPT);
    this.cwd = cwd;
  }

  /**
   * 处理一次用户输入，返回最终的 assistant 文本回复
   */
  async handleUserInput(input: string): Promise<string> {
    this.session.addUserMessage(input);

    // Agent 循环：可能多轮工具调用
    while (true) {
      const response = await this.llm.chat(
        this.session.getMessages(),
        getToolDefinitions(),
      );

      const choice = response.choices[0];
      if (!choice?.message) {
        return "(模型无响应)";
      }

      const assistantMessage = choice.message;
      this.session.addAssistantMessage(assistantMessage);

      // 无工具调用 → 返回文本
      if (!assistantMessage.tool_calls?.length) {
        return assistantMessage.content || "(无内容)";
      }

      // 执行所有工具调用
      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments);

        console.log(`  🔧 调用工具: ${toolName}`);

        const tool = getToolByName(toolName);
        let result: string;

        if (!tool) {
          result = `错误：未知工具 ${toolName}`;
        } else {
          try {
            result = await tool.execute(toolArgs, this.cwd);
          } catch (error: unknown) {
            const err = error as Error;
            result = `工具执行失败: ${err.message}`;
          }
        }

        this.session.addToolResult(toolCall.id, result);
      }

      // 工具执行完后继续循环，让模型基于结果继续回复
    }
  }

  /** 获取当前 session 状态（调试用） */
  getSessionInfo(): { messageCount: number; estimatedTokens: number } {
    return {
      messageCount: this.session.getMessageCount(),
      estimatedTokens: this.session.estimateTokens(),
    };
  }
}
