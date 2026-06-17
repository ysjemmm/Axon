/**
 * MCP（Model Context Protocol）核心类型与能力抽象 —— 零形态依赖
 *
 * 与 WebCapability 同构：core 只定义抽象 `McpCapability`，真正连接 MCP server、
 * 拉取/调用工具的运行时由 host 形态（host-node 用官方 SDK）实现并注入。
 *
 * 三层职责：
 *   · 配置解析（McpRegistry，core）：聚合 用户级/工作区级/Power 内嵌 三来源的 server 配置
 *   · 运行时连接（McpCapability，host 实现）：连接 server、tools/list、tools/call、生命周期
 *   · 编排（AgentSession，core）：把 MCP 工具并入工具集、路由调用、接审批门
 */

/** MCP server 传输类型：stdio（本地子进程）/ http（Streamable HTTP 或 SSE 远程） */
export type McpTransport = "stdio" | "http";

/** 配置来源：用户级 / 工作区级 / Power 内嵌 */
export type McpSource = "user" | "workspace" | "power";

/**
 * 归一化后的单个 MCP server 规格（多来源合并、命名空间去重后的统一形态）。
 * stdio 用 command/args/env；http 用 url/headers。两者二选一。
 */
export interface McpServerSpec {
  /** 全局唯一 id（命名空间）：`<source>:<serverName>`，Power 来源为 `power:<powerName>:<serverName>` */
  id: string;
  /** server 原始名（同一来源内唯一） */
  name: string;
  /** 配置来源 */
  source: McpSource;
  /** 传输类型 */
  transport: McpTransport;
  /** stdio：可执行命令 */
  command?: string;
  /** stdio：命令参数 */
  args?: string[];
  /** stdio：环境变量（在 server 进程注入） */
  env?: Record<string, string>;
  /** http：服务端点 URL */
  url?: string;
  /** http：附加请求头（鉴权等） */
  headers?: Record<string, string>;
  /** 是否禁用（禁用的不连接、不暴露工具） */
  disabled?: boolean;
  /** 自动批准的工具名白名单（命中则跳过人工审批） */
  autoApprove?: string[];
}

/** 一个 MCP 工具（来自某 server 的 tools/list） */
export interface McpToolInfo {
  /** 所属 server 的 id（命名空间） */
  serverId: string;
  /** 所属 server 原始名（展示用） */
  serverName: string;
  /** 工具原始名 */
  name: string;
  /** 工具描述 */
  description?: string;
  /** 入参 JSON Schema（直接透传给 LLM 作为 function parameters） */
  inputSchema?: Record<string, unknown>;
  /** 该工具是否在所属 server 的 autoApprove 白名单内（命中则免人工审批） */
  autoApprove: boolean;
}

/** 一次 MCP 工具调用的结果 */
export interface McpCallResult {
  /** 文本化结果（喂回模型） */
  text: string;
  /** 是否为错误结果（server 返回 isError 或调用抛错） */
  isError?: boolean;
}

/**
 * MCP 运行时能力（form-agnostic 抽象，由 host 实现并注入，注入方式同 WebCapability）。
 *
 * 生命周期由实现负责：syncServers 接收最新 specs（增量连接新增、断开移除/禁用的），
 * listTools 返回当前所有已连接 server 的工具，callTool 路由到对应 server。
 * 任一 server 连接失败应被隔离（不抛、不拖垮其它 server），其工具不出现在 listTools 即可。
 */
export interface McpCapability {
  /**
   * 同步目标 server 列表：连接新增的、断开已移除或禁用的。幂等，可重复调用。
   * AgentSession 在每轮用户输入前用最新解析出的 specs 调用一次。
   */
  syncServers(specs: McpServerSpec[]): Promise<void>;
  /** 列出当前所有已连接 server 暴露的工具 */
  listTools(): Promise<McpToolInfo[]>;
  /** 调用指定 server 的指定工具，返回文本化结果 */
  callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult>;
  /** 关闭所有连接（会话销毁时调用，可选） */
  dispose?(): Promise<void>;
}

/** MCP 工具名命名空间前缀：模型看到的工具名为 `mcp__<serverId>__<toolName>` */
export const MCP_TOOL_PREFIX = "mcp__";

/**
 * 把 serverId + toolName 编码为符合 OpenAI 工具名规范（仅 [a-zA-Z0-9_-]）的模型可见名。
 * serverId 含冒号等非法字符会被替换为下划线，因此【不可逆】——调用方必须维护
 * 「模型可见名 → {serverId, toolName}」的查找表来还原真实目标（见 AgentSession）。
 */
export function encodeMcpToolName(serverId: string, toolName: string): string {
  const safe = (s: string): string => s.replace(/[^a-zA-Z0-9]/g, "_");
  return `${MCP_TOOL_PREFIX}${safe(serverId)}__${safe(toolName)}`;
}
