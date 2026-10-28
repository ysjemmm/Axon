/**
 * Axon 内置的 MCP server：在宿主进程内运行（InMemoryTransport），给连接器用。
 * 连接器里 transport: "builtin" + builtin: "<名字>" 指向这里。
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMailServer, verifyMail } from "./mail.js";

interface BuiltinServer {
  create: (env: Record<string, string>) => Server;
  /** 测试连接时真正验证一次凭证（可选） */
  verify?: (env: Record<string, string>) => Promise<void>;
}

const BUILTIN_SERVERS: Record<string, BuiltinServer> = {
  mail: { create: createMailServer, verify: verifyMail },
};

export function getBuiltinServer(name: string | undefined): BuiltinServer {
  const builtin = name ? BUILTIN_SERVERS[name] : undefined;
  if (!builtin) throw new Error(`未知的内置服务：${name ?? "（空）"}`);
  return builtin;
}
