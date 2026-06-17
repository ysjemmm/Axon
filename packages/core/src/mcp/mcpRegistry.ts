/**
 * MCP 配置注册表 —— 聚合三来源的 server 配置，产出归一化的 McpServerSpec[]（零形态依赖）
 *
 * 三来源（同 id 后者覆盖前者，优先级 user < workspace < power）：
 *   · 用户级：  ~/.axon/settings/mcp.json
 *   · 工作区级：<workspace>/.axon/settings/mcp.json（多根工作区逐个读）
 *   · Power 内嵌：各启用 Power 的 mcp.json（经 PowerRegistry.getActiveMcpServers 聚合）
 *
 * 只负责"读配置 + 归一化 + 去重 + 过滤禁用"，不负责连接（连接是 McpCapability 的事）。
 * 读文件走注入的 host.fs，保持形态无关。
 */

import { join } from "node:path";
import type { AgentHost } from "../host/index.js";
import type { PowerRegistry } from "../powers/powerLoader.js";
import type { McpServerSpec, McpSource } from "./types.js";

/** 单个 server 的原始配置（mcp.json 内的形态，stdio 与 http 字段共存，二选一填） */
interface RawMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  autoApprove?: string[];
}

/** mcp.json 文件结构（与 Kiro/VS Code 的 mcp.json 一致） */
interface RawMcpConfig {
  mcpServers?: Record<string, RawMcpServer>;
}

/** 用户级 MCP 配置路径：~/.axon/settings/mcp.json */
export function userMcpConfigPath(homeDir: string): string {
  return join(homeDir, ".axon", "settings", "mcp.json");
}

/** 工作区级 MCP 配置路径：<workspace>/.axon/settings/mcp.json */
export function workspaceMcpConfigPath(workspace: string): string {
  return join(workspace, ".axon", "settings", "mcp.json");
}

/**
 * MCP 配置注册表：聚合用户级 + 工作区级 + Power 内嵌三来源，产出去重后的 server 规格列表。
 */
export class McpRegistry {
  constructor(
    private workspaces: string[],
    private host: AgentHost,
    private homeDir: string,
    private powers: PowerRegistry | null,
  ) {}

  /** 更新工作区列表（切换会话/换工作区时调用） */
  setWorkspaces(workspaces: string[]): void {
    this.workspaces = workspaces;
  }

  /**
   * 解析出所有 MCP server 规格。同 id 后者覆盖前者。
   * @param includeDisabled true 时保留禁用项（供管理 UI 展示并可重新启用）；默认 false（仅启用项，供运行时连接）
   */
  async resolve(includeDisabled = false): Promise<McpServerSpec[]> {
    const collected: McpServerSpec[] = [];

    // 用户级
    collected.push(...await this.fromFile(userMcpConfigPath(this.homeDir), "user"));
    // 工作区级（多根逐个）
    for (const ws of this.workspaces) {
      collected.push(...await this.fromFile(workspaceMcpConfigPath(ws), "workspace"));
    }
    // Power 内嵌（key 形如 "powerName:serverName"）
    if (this.powers) {
      const active = await this.powers.getActiveMcpServers();
      for (const [key, server] of Object.entries(active)) {
        const serverName = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
        collected.push(this.toSpec(`power:${key}`, serverName, "power", server));
      }
    }

    // 去重（后者覆盖前者）+ 过滤禁用
    const byId = new Map<string, McpServerSpec>();
    for (const spec of collected) byId.set(spec.id, spec);
    const all = [...byId.values()];
    return includeDisabled ? all : all.filter((s) => !s.disabled);
  }

  /** 从一个 mcp.json 文件读取并归一化为 specs；文件不存在/解析失败返回空数组 */
  private async fromFile(path: string, source: McpSource): Promise<McpServerSpec[]> {
    const raw = await this.host.fs.read(path);
    if (!raw) return [];
    let config: RawMcpConfig;
    try {
      config = JSON.parse(raw);
    } catch {
      return []; // 配置损坏不应炸掉整个解析，静默跳过该来源
    }
    const out: McpServerSpec[] = [];
    for (const [name, server] of Object.entries(config.mcpServers || {})) {
      out.push(this.toSpec(`${source}:${name}`, name, source, server));
    }
    return out;
  }

  /** 把原始 server 配置归一化为 McpServerSpec（自动按有无 url 判定 stdio/http） */
  private toSpec(id: string, name: string, source: McpSource, server: RawMcpServer): McpServerSpec {
    return {
      id,
      name,
      source,
      transport: server.url ? "http" : "stdio",
      command: server.command,
      args: server.args,
      env: server.env,
      url: server.url,
      headers: server.headers,
      disabled: server.disabled,
      autoApprove: server.autoApprove,
    };
  }
}
