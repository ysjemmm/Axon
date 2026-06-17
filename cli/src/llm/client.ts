/**
 * LLM 客户端 - 封装模型 API 调用
 *
 * 支持流式输出和工具调用（Function Calling）。
 * 通过 OpenAI 兼容接口，可对接 OpenAI / Claude / 通义等。
 */

import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export class LlmClient {
  private client: OpenAI;
  private model: string;

  constructor(config: LlmConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    this.model = config.model;
  }

  /**
   * 非流式调用（带工具定义）
   */
  async chat(
    messages: ChatCompletionMessageParam[],
    tools?: ChatCompletionTool[],
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    return this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: tools?.length ? tools : undefined,
    });
  }

  /**
   * 流式调用（返回 AsyncIterable）
   */
  async *chatStream(
    messages: ChatCompletionMessageParam[],
    tools?: ChatCompletionTool[],
  ): AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages,
      tools: tools?.length ? tools : undefined,
      stream: true,
    });

    for await (const chunk of stream) {
      yield chunk;
    }
  }
}
