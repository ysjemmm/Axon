export class LLMProtocolError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(`LLM 协议错误：${message}`);
    this.name = "LLMProtocolError";
    this.retryable = retryable;
  }
}

export function isRetryableProtocolError(error: unknown): boolean {
  return error instanceof LLMProtocolError && error.retryable;
}
