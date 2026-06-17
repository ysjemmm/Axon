/**
 * NodeMcpCapability —— MCP 运行时（host-node 实现，注入给 @axon/core 的 AgentSession）
 *
 * 用官方 @modelcontextprotocol/sdk 连接 MCP server：
 *   · stdio：本地子进程（command/args/env），用受控环境变量，避免把全部 env 泄给第三方 server
 *   · http：远程 Streamable HTTP（含 headers 鉴权）；URL 以 /sse 结尾时回退 SSE 传输
 *
 * 设计要点（商业化健壮性）：
 *   · 错误隔离：单个 server 连接/列举失败只记日志、跳过，不抛、不拖垮其它 server 与主流程
 *   · 连接超时：避免坏 server 卡住每轮的工具预取
 *   · 幂等同步：syncServers 比对 spec，新增则连、移除/变更则断后重连
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpCapability, McpServerSpec, McpToolInfo, McpCallResult } from "@axon/core";

/** 单个 server 的连接状态 */
interface McpConnection {
  spec: McpServerSpec;
  client: Client;
  tools: McpToolInfo[];
}

/** 连接/列举工具的超时（ms）：坏 server 不应卡住每轮工具预取 */
const CONNECT_TIMEOUT_MS = 15_000;

/** 给 Promise 套超时；超时 reject，避免无限等待 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)),
  ]);
}

/** 把 MCP 工具返回的 content 块数组文本化（喂回模型） */
function textifyContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : JSON.stringify(content);
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block?.type === "image") parts.push("[图片内容]");
    else if (block?.type === "resource") parts.push(`[资源：${JSON.stringify(block.resource ?? {})}]`);
    else parts.push(JSON.stringify(block));
  }
  return parts.join("\n") || "(无输出)";
}

export class NodeMcpCapability implements McpCapability {
  private conns = new Map<string, McpConnection>();

  /** 幂等同步目标 server：断开已移除/禁用/变更的，连接新增/变更的（并发 + 错误隔离） */
  async syncServers(specs: McpServerSpec[]): Promise<void> {
    const wanted = new Map(specs.filter((s) => !s.disabled).map((s) => [s.id, s]));
    // 断开：不再需要的，或配置已变更的
    for (const [id, conn] of [...this.conns]) {
      const next = wanted.get(id);
      if (!next || JSON.stringify(next) !== JSON.stringify(conn.spec)) {
        await this.close(id);
      }
    }
    // 连接：尚未连接的目标。单个失败被隔离，不影响其它
    await Promise.all(
      [...wanted.values()].map((spec) =>
        this.ensureConnected(spec).catch((err) => {
          console.warn(`[mcp] 连接 server "${spec.id}" 失败（已隔离）:`, (err as Error).message);
        }),
      ),
    );
  }

  /** 确保某 server 已连接并已拉取工具；已连接则跳过 */
  private async ensureConnected(spec: McpServerSpec): Promise<void> {
    if (this.conns.has(spec.id)) return;
    const client = await this.connectClient(spec);
    const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `列举 ${spec.id} 工具`);
    const auto = new Set(spec.autoApprove ?? []);
    const tools: McpToolInfo[] = (listed.tools ?? []).map((t) => ({
      serverId: spec.id,
      serverName: spec.name,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
      autoApprove: auto.has(t.name) || auto.has("*"),
    }));
    this.conns.set(spec.id, { spec, client, tools });
    console.log(`[mcp] server "${spec.id}" 已连接，暴露 ${tools.length} 个工具`);
  }

  /**
   * 建立到 server 的连接并返回已连接的 Client。
   * - stdio：直接用子进程传输连接
   * - http：先试新的 Streamable HTTP；连接失败则回退到旧的 SSE（兼容只支持 SSE 的旧 server）。
   *   回退必须用全新 Client——连接失败的 Client/transport 已被消费，不能复用。
   */
  private async connectClient(spec: McpServerSpec): Promise<Client> {
    if (spec.transport === "stdio") {
      if (!spec.command) throw new Error(`server ${spec.id} 是 stdio 传输但缺少 command`);
      const client = this.newClient();
      // Windows 上 spawn 不走 shell,npm/npx/pnpm/uvx 等需要加 .cmd 后缀才能找到
      const command = this.resolveCommand(spec.command);
      // 受控环境：默认安全子集 + spec.env，避免把全部 process.env（含密钥）暴露给第三方 server
      const transport = new StdioClientTransport({
        command,
        args: spec.args ?? [],
        env: { ...getDefaultEnvironment(), ...(spec.env ?? {}) },
      });
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `连接 ${spec.id}`);
      return client;
    }

    if (!spec.url) throw new Error(`server ${spec.id} 是 http 传输但缺少 url`);
    const url = new URL(spec.url);
    const requestInit = spec.headers ? { headers: spec.headers } : undefined;
    try {
      const client = this.newClient();
      await withTimeout(
        client.connect(new StreamableHTTPClientTransport(url, { requestInit })),
        CONNECT_TIMEOUT_MS, `连接 ${spec.id} (Streamable HTTP)`,
      );
      return client;
    } catch (err) {
      console.warn(`[mcp] server "${spec.id}" Streamable HTTP 失败，回退 SSE：`, (err as Error).message);
      return this.connectSse(spec.id, url, requestInit);
    }
  }

  /**
   * 回退连接：旧的 HTTP+SSE 传输。SSE 已被 SDK 标记 @deprecated，但官方说明仍有 server 只支持它，
   * 故保留为回退路径——废弃用法收敛在此一处，按需动态加载并显式抑制告警。
   */
  private async connectSse(id: string, url: URL, requestInit?: { headers: Record<string, string> }): Promise<Client> {
    const client = this.newClient();
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    await withTimeout(client.connect(new SSEClientTransport(url, { requestInit })), CONNECT_TIMEOUT_MS, `连接 ${id} (SSE 回退)`);
    return client;
  }

  /** 新建一个 MCP 客户端实例 */
  private newClient(): Client {
    return new Client({ name: "axon", version: "0.1.0" }, { capabilities: {} });
  }

  /**
   * Windows 平台 spawn 不走 shell,npx/npm/pnpm/uvx 等脚本命令需要加 .cmd 后缀。
   * 其他平台（macOS/Linux）或已带后缀/绝对路径的命令原样返回。
   */
  private resolveCommand(command: string): string {
    if (process.platform !== "win32") return command;
    // 已是绝对路径或已带 .cmd/.exe/.bat 后缀 → 不修改
    if (/\.(cmd|exe|bat)$/i.test(command)) return command;
    if (/[/\\]/.test(command)) return command;
    // 常见需要 .cmd 后缀的脚本命令
    const needsCmd = ["npx", "npm", "pnpm", "yarn", "uvx", "uv", "bunx"];
    if (needsCmd.includes(command.toLowerCase())) return `${command}.cmd`;
    return command;
  }

  /** 列出当前所有已连接 server 的工具 */
  async listTools(): Promise<McpToolInfo[]> {
    return [...this.conns.values()].flatMap((c) => c.tools);
  }

  /** 调用指定 server 的工具；server 未连接或调用抛错都返回 isError 结果（不抛，交编排层处理） */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const conn = this.conns.get(serverId);
    if (!conn) return { text: `MCP server "${serverId}" 未连接（可能启动失败或已断开）`, isError: true };
    try {
      const res = await conn.client.callTool({ name: toolName, arguments: args });
      return { text: textifyContent((res as { content?: unknown }).content), isError: (res as { isError?: boolean }).isError === true };
    } catch (err) {
      return { text: `调用 MCP 工具失败：${(err as Error).message}`, isError: true };
    }
  }

  /** 关闭单个连接 */
  private async close(id: string): Promise<void> {
    const conn = this.conns.get(id);
    if (!conn) return;
    this.conns.delete(id);
    try {
      await conn.client.close();
    } catch { /* 关闭出错忽略 */ }
  }

  /** 关闭所有连接（会话销毁时） */
  async dispose(): Promise<void> {
    await Promise.all([...this.conns.keys()].map((id) => this.close(id)));
  }
}

/** 工厂：创建 NodeMcpCapability（注入给 SessionHub.mcp） */
export function createNodeMcpCapability(): NodeMcpCapability {
  return new NodeMcpCapability();
}
