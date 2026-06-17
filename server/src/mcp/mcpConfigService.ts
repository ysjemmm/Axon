/**
 * 独立 MCP 配置服务（Service 层）—— 读写 .axon/settings/mcp.json（用户级 / 工作区级）
 *
 * 与 Power 内嵌的 mcp.json 互补：这是不依赖 Power 的全局/项目级 MCP 配置。
 * 路径约定与 core 的 McpRegistry 完全一致：
 *   · 用户级：  ~/.axon/settings/mcp.json
 *   · 工作区级：<workspace>/.axon/settings/mcp.json
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export type McpLevel = "user" | "workspace";

/** 单个 server 原始配置（与 Kiro/VS Code mcp.json 一致） */
export interface RawMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  autoApprove?: string[];
}

export interface RawMcpConfig {
  mcpServers: Record<string, RawMcpServer>;
}

const EMPTY: RawMcpConfig = { mcpServers: {} };

export class McpConfigService {
  /** 解析某 level 的 mcp.json 绝对路径 */
  private configPath(level: McpLevel, workspace?: string): string {
    if (level === "workspace") {
      if (!workspace) throw new Error("工作区级配置需要 workspace 参数");
      return join(workspace, ".axon", "settings", "mcp.json");
    }
    return join(homedir(), ".axon", "settings", "mcp.json");
  }

  /** 读取某 level 的配置（文件不存在/损坏返回空配置，不抛） */
  async read(level: McpLevel, workspace?: string): Promise<RawMcpConfig> {
    const path = this.configPath(level, workspace);
    try {
      const raw = await fs.readFile(path, "utf8");
      const parsed = JSON.parse(raw) as RawMcpConfig;
      return { mcpServers: parsed.mcpServers || {} };
    } catch {
      return { mcpServers: {} };
    }
  }

  /** 同时读取用户级 + 工作区级（供管理 UI 一次拉全） */
  async readAll(workspace?: string): Promise<{ user: RawMcpConfig; workspace: RawMcpConfig }> {
    const user = await this.read("user");
    const ws = workspace ? await this.read("workspace", workspace) : EMPTY;
    return { user, workspace: ws };
  }

  /** 覆盖写入某 level 的完整配置（自动创建 settings 目录）。校验 JSON 结构合法 */
  async write(level: McpLevel, config: RawMcpConfig, workspace?: string): Promise<void> {
    if (!config || typeof config !== "object" || typeof config.mcpServers !== "object") {
      throw new Error("配置非法：必须是 { mcpServers: { ... } } 结构");
    }
    const path = this.configPath(level, workspace);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify({ mcpServers: config.mcpServers }, null, 2), "utf8");
  }

  /** 新增/覆盖一个 server */
  async addServer(level: McpLevel, name: string, server: RawMcpServer, workspace?: string): Promise<void> {
    if (!name.trim()) throw new Error("server 名称不能为空");
    if (!server.command && !server.url) throw new Error("server 必须提供 command（stdio）或 url（http）");
    const config = await this.read(level, workspace);
    config.mcpServers[name] = server;
    await this.write(level, config, workspace);
  }

  /** 删除一个 server */
  async removeServer(level: McpLevel, name: string, workspace?: string): Promise<void> {
    const config = await this.read(level, workspace);
    if (!(name in config.mcpServers)) throw new Error(`server 不存在：${name}`);
    delete config.mcpServers[name];
    await this.write(level, config, workspace);
  }
}
