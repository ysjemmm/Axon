/**
 * SessionHub 依赖契约（呈现端 ② 的会话编排层）
 *
 * SessionHub 把原先写死在 server/index.ts 里 ws.on("message") 的会话生命周期逻辑
 * （加载/切换/新建/重置会话、工作区绑定、编辑确认、用户消息处理、持久化、标题生成）
 * 收敛成与传输无关的编排器：消费 ControlCommand，产出 AgentEvent（经 channel）。
 *
 * 它依赖的 server 侧能力（会话存储、目录校验、工作区组解析、host 工厂、web 能力）
 * 全部通过本契约注入，使 SessionHub 同样可服务 VS Code 进程内形态。
 */

import type { AgentChannel } from "../channel/index.js";
import type { AgentHost } from "../host/index.js";
import type { SessionStorage } from "../storage/types.js";
import type { WebCapability, TrustRule } from "../tools/index.js";
import type { McpCapability } from "../mcp/types.js";

/** 工作区组（迁自 server/config.ts 的纯类型部分） */
export interface WorkspaceGroup {
  id: string;
  name: string;
  paths: string[];
}

/**
 * 命令信任存储（形态无关）：load 读出某工作区已信任的模式串，save 持久化新批准的规则。
 * - VS Code 形态：load 读 `axon.trustedCommands` 配置，save 走 config.update。
 * - web/server 形态：load/save 走 JSON 文件存储。
 * 不注入时：会话仅用 CommandGate 内置只读默认集，且批准仅本会话有效（不跨重启）。
 */
export interface CommandTrustStore {
  load: (workspace: string) => string[];
  save: (workspace: string, rule: TrustRule, target?: "user" | "workspace") => void;
}

/** SessionHub 的注入依赖 */
export interface SessionHubDeps {
  /** 会话存储（列表/读写/删除） */
  storage: SessionStorage;
  /** 出站通道（推送 AgentEvent 给 UI） */
  channel: AgentChannel;
  /**
   * 为一个会话创建独立的 AgentHost 实例（每个 AgentSession 独占一个 host，
   * 因为 edits 暂存区是有状态的）。Node 形态用 createNodeAgentHost。
   */
  createHost: () => AgentHost;
  /** 校验某路径是否为有效目录（工作区绑定前校验） */
  isValidDir: (path: string) => Promise<boolean>;
  /** 按 id 解析工作区组；不存在返回 null */
  resolveWorkspaceGroup: (groupId: string) => Promise<WorkspaceGroup | null>;
  /** 默认工作区（未指定时使用） */
  defaultWorkspace: string;
  /** 所有工作区路径（多根工作区场景；activate 时传入全部文件夹） */
  workspaces?: string[];
  /** 用户主目录（用于 SkillRegistry 定位 ~/.axon/skills） */
  homeDir: string;
  /** 可选：web 能力（注入给 AgentSession 的 web_search/web_fetch） */
  web?: WebCapability;
  /** 可选：MCP 运行时能力（注入给 AgentSession，连接/调用 MCP server 暴露的工具） */
  mcp?: McpCapability;
  /** 可选：命令信任白名单存储（不注入则仅用内置默认集 + 会话级批准） */
  commandTrust?: CommandTrustStore;
}
