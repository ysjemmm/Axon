/**
 * AI 的临时文件（.axon/tmp/ 下的一次性验证脚本）：不算用户的改动，改动面板和计数里都不列。
 * 后端用 create_file(temporary=true) 写这类文件，见 core 的 tools/axonTmp.ts。
 */

import type { ChatMessage } from "@/components/chat/types";

export function isTempFilePath(path: string | undefined | null): boolean {
  return !!path && /(^|[\\/])\.axon[\\/]tmp[\\/]/.test(path);
}

/** 本会话里 AI 写过的临时文件（去重后的文件名），给改动面板底部的一行说明用 */
export function collectTempFiles(chatHistory: ChatMessage[]): string[] {
  const names = new Set<string>();
  for (const msg of chatHistory) {
    if (msg.role !== "assistant" || !msg.segments) continue;
    for (const seg of msg.segments) {
      if (seg.type !== "tool" || seg.status !== "success") continue;
      const path = typeof seg.args?.path === "string" ? (seg.args.path as string) : "";
      const temp = (seg.name === "create_file" && seg.args?.temporary === true) || isTempFilePath(path) || isTempFilePath(seg.diff?.path);
      if (temp) names.add((seg.diff?.path || path).replace(/\\/g, "/").split("/").pop() || path);
    }
  }
  return [...names];
}
