/**
 * Power 加载器 - 能力扩展套件包的发现与加载
 *
 * Power 是 Axon 的能力扩展单元，打包了：
 *   - 一组 MCP 服务器（通过 mcp.json 配置）
 *   - 一组 Skills（power 目录下的 skills/ 子目录，每个含 SKILL.md）
 *   - 配套文档（POWER.md 正文）
 *   - 可选的 steering 工作流引导
 *
 * 安装一个 Power 后，其内含的 MCP 服务器会自动注册，Skills 会自动发现。
 * 禁用 Power 时，其下所有 MCP 和 Skills 一起失效。
 *
 * 目录约定（两级，工作区级覆盖全局级同名 power）：
 *   - 全局：~/.axon/powers/<power-name>/POWER.md
 *   - 工作区：<workspace>/.axon/powers/<power-name>/POWER.md
 *
 * Power 目录结构：
 *   <power-name>/
 *     POWER.md          # 必需：frontmatter(name/description/keywords) + 文档正文
 *     mcp.json          # 可选：MCP 服务器配置（格式同 Kiro/VS Code 的 mcp.json）
 *     skills/           # 可选：捆绑的 Skills（每个子目录含 SKILL.md）
 *       skill-a/SKILL.md
 *       skill-b/SKILL.md
 *     steering/         # 可选：工作流引导文件
 *       getting-started.md
 */

import { join } from "node:path";
import type { AgentHost } from "../host/index.js";

/** Power 元信息（轻量层，列表展示用） */
export interface PowerMeta {
  /** power 唯一名称（取自 frontmatter.name，回退到目录名） */
  name: string;
  /** 显示名称（可含中文空格） */
  displayName: string;
  /** 功能描述 */
  description: string;
  /** 关键词列表（用于自动匹配激活） */
  keywords: string[];
  /** POWER.md 文件绝对路径 */
  powerFile: string;
  /** power 目录绝对路径 */
  dir: string;
  /** 来源：global（用户级）/ workspace（工作区级） */
  source: "global" | "workspace";
  /** 是否已启用 */
  enabled: boolean;
  /** 包含的 MCP 服务器数量 */
  mcpServerCount: number;
  /** 包含的 Skill 数量 */
  skillCount: number;
  /** 是否包含 steering 文件 */
  hasSteering: boolean;
}

/** MCP 服务器配置（power 内嵌） */
export interface PowerMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  autoApprove?: string[];
}

/** Power 的 MCP 配置文件结构 */
export interface PowerMcpConfig {
  mcpServers: Record<string, PowerMcpServer>;
}

/** Power 内捆绑的 Skill 元信息 */
export interface PowerSkillMeta {
  name: string;
  description: string;
  dir: string;
}

/** 加载后的完整 Power（含正文和配置） */
export interface LoadedPower extends PowerMeta {
  /** POWER.md 完整正文（不含 frontmatter） */
  body: string;
  /** MCP 服务器配置（如果有） */
  mcpConfig: PowerMcpConfig | null;
  /** 捆绑的 Skills 列表 */
  skills: PowerSkillMeta[];
  /** steering 文件列表（相对路径） */
  steeringFiles: string[];
}

/** 全局 power 根目录：~/.axon/powers */
export function globalPowersDir(homeDir: string): string {
  return join(homeDir, ".axon", "powers");
}

/** 工作区 power 根目录：<workspace>/.axon/powers */
export function workspacePowersDir(workspace: string): string {
  return join(workspace, ".axon", "powers");
}

/**
 * 解析 POWER.md 的 frontmatter，提取元信息。
 */
export function parsePowerFrontmatter(raw: string): {
  name?: string;
  displayName?: string;
  description?: string;
  keywords?: string[];
  body: string;
} {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { body: raw };

  const fmBlock = match[1];
  const body = raw.slice(match[0].length);
  const fields: Record<string, string> = {};

  let currentKey = "";
  let multilineBuffer = "";
  for (const line of fmBlock.split("\n")) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (kv) {
      if (currentKey && multilineBuffer) {
        fields[currentKey] = multilineBuffer.trim();
      }
      currentKey = kv[1].toLowerCase().replace(/-/g, "_");
      let value = kv[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value === ">-" || value === "|") {
        multilineBuffer = "";
      } else {
        fields[currentKey] = value;
        currentKey = "";
        multilineBuffer = "";
      }
    } else if (currentKey) {
      multilineBuffer += (multilineBuffer ? " " : "") + line.trim();
    }
  }
  if (currentKey && multilineBuffer) {
    fields[currentKey] = multilineBuffer.trim();
  }

  let keywords: string[] | undefined;
  const kwRaw = fields.keywords;
  if (kwRaw) {
    keywords = kwRaw
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((k) => k.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  return {
    name: fields.name,
    displayName: fields.display_name || fields.displayname,
    description: fields.description,
    keywords,
    body,
  };
}

/** 安全地判断路径是否为目录 */
async function isDir(host: AgentHost, p: string): Promise<boolean> {
  const st = await host.fs.stat(p);
  return st?.isDir ?? false;
}

/** 安全地判断文件是否存在 */
async function fileExists(host: AgentHost, p: string): Promise<boolean> {
  const st = await host.fs.stat(p);
  return st !== null && !st.isDir;
}

/**
 * 扫描 power 目录下捆绑的 skills（skills/ 子目录）。
 */
async function scanPowerSkills(host: AgentHost, powerDir: string): Promise<PowerSkillMeta[]> {
  const skillsDir = join(powerDir, "skills");
  if (!(await isDir(host, skillsDir))) return [];

  let entries: import("../host/index.js").DirChild[];
  try {
    entries = await host.fs.readdir(skillsDir);
  } catch {
    return [];
  }

  const results: PowerSkillMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDir) continue;
    const dir = join(skillsDir, entry.name);
    const skillFile = join(dir, "SKILL.md");
    const raw = await host.fs.read(skillFile);
    if (raw === null) continue;
    // 快速提取 description（不做完整 frontmatter 解析）
    const descMatch = raw.match(/^description\s*:\s*(.+)$/m);
    results.push({
      name: entry.name,
      description: descMatch ? descMatch[1].trim().replace(/^["']|["']$/g, "") : "",
      dir,
    });
  }
  return results;
}

/**
 * 计算 MCP 服务器数量（解析 mcp.json）。
 */
async function countMcpServers(host: AgentHost, powerDir: string): Promise<number> {
  const mcpPath = join(powerDir, "mcp.json");
  const raw = await host.fs.read(mcpPath);
  if (!raw) return 0;
  try {
    const config = JSON.parse(raw) as PowerMcpConfig;
    return Object.keys(config.mcpServers || {}).length;
  } catch {
    return 0;
  }
}

/**
 * 扫描单个 powers 根目录下的所有 power，返回元信息列表。
 */
async function scanPowersDir(
  host: AgentHost,
  rootDir: string,
  source: PowerMeta["source"],
): Promise<PowerMeta[]> {
  if (!(await isDir(host, rootDir))) return [];

  let entries: import("../host/index.js").DirChild[];
  try {
    entries = await host.fs.readdir(rootDir);
  } catch {
    return [];
  }

  const metas: PowerMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDir) continue;
    const dir = join(rootDir, entry.name);
    const powerFile = join(dir, "POWER.md");
    const raw = await host.fs.read(powerFile);
    if (raw === null) continue;

    const fm = parsePowerFrontmatter(raw);
    const disabled = await fileExists(host, join(dir, ".disabled"));
    const mcpServerCount = await countMcpServers(host, dir);
    const skills = await scanPowerSkills(host, dir);
    const hasSteering = await isDir(host, join(dir, "steering"));

    metas.push({
      name: (fm.name || entry.name).trim(),
      displayName: (fm.displayName || fm.name || entry.name).trim(),
      description: (fm.description || "").trim(),
      keywords: fm.keywords || [],
      powerFile,
      dir,
      source,
      enabled: !disabled,
      mcpServerCount,
      skillCount: skills.length,
      hasSteering,
    });
  }
  return metas;
}

/**
 * Power 注册表：聚合全局 + 工作区两级 power，提供发现与加载能力。
 */
export class PowerRegistry {
  constructor(
    private workspaces: string[],
    private host: AgentHost,
    private homeDir: string,
  ) {}

  /** 更新工作区列表 */
  setWorkspaces(workspaces: string[]): void {
    this.workspaces = workspaces;
  }

  /**
   * 发现所有可用 power（仅元信息）。
   * 优先级：global < workspace。同名后者覆盖前者。
   */
  async discover(): Promise<PowerMeta[]> {
    const globalMetas = await scanPowersDir(this.host, globalPowersDir(this.homeDir), "global");
    const wsMetasArrays = await Promise.all(
      this.workspaces.map((ws) => scanPowersDir(this.host, workspacePowersDir(ws), "workspace")),
    );

    const byName = new Map<string, PowerMeta>();
    for (const m of globalMetas) byName.set(m.name, m);
    for (const arr of wsMetasArrays) {
      for (const m of arr) byName.set(m.name, m);
    }
    return [...byName.values()];
  }

  /** 按名称加载完整 power（含正文、MCP 配置、Skills 列表），找不到或已禁用返回 null */
  async load(name: string): Promise<LoadedPower | null> {
    const metas = await this.discover();
    // 精确匹配优先；回退到大小写不敏感匹配（用户命名不一致时仍能找到）
    let meta = metas.find((m) => m.name === name);
    if (!meta) meta = metas.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (!meta) return null;
    // 已禁用的 power 不可激活（即便 AI 凭记忆调用 activate_power 也挡掉）
    if (!meta.enabled) return null;

    // 加载 POWER.md 正文
    const raw = await this.host.fs.read(meta.powerFile);
    if (raw === null) return null;
    const { body } = parsePowerFrontmatter(raw);

    // 加载 MCP 配置
    let mcpConfig: PowerMcpConfig | null = null;
    const mcpPath = join(meta.dir, "mcp.json");
    const mcpRaw = await this.host.fs.read(mcpPath);
    if (mcpRaw) {
      try {
        mcpConfig = JSON.parse(mcpRaw);
      } catch { /* 解析失败忽略 */ }
    }

    // 加载捆绑的 Skills
    const skills = await scanPowerSkills(this.host, meta.dir);

    // 加载 steering 文件列表
    let steeringFiles: string[] = [];
    if (meta.hasSteering) {
      const steeringDir = join(meta.dir, "steering");
      try {
        const entries = await this.host.fs.readdir(steeringDir);
        steeringFiles = entries
          .filter((e) => !e.isDir && e.name.endsWith(".md"))
          .map((e) => e.name);
      } catch { /* 忽略 */ }
    }

    return { ...meta, body, mcpConfig, skills, steeringFiles };
  }

  /** 读取指定 power 的 steering 文件内容 */
  async readSteering(name: string, steeringFile: string): Promise<string | null> {
    const metas = await this.discover();
    const meta = metas.find((m) => m.name === name);
    if (!meta) return null;
    const filePath = join(meta.dir, "steering", steeringFile);
    return this.host.fs.read(filePath);
  }

  /**
   * 获取所有已启用 power 的聚合 MCP 配置（用于合并到全局 MCP 服务器列表）。
   * 自动跳过禁用的 power 和 power 内标记 disabled 的 server。
   */
  async getActiveMcpServers(): Promise<Record<string, PowerMcpServer>> {
    const metas = await this.discover();
    const enabled = metas.filter((m) => m.enabled && m.mcpServerCount > 0);
    const merged: Record<string, PowerMcpServer> = {};

    for (const meta of enabled) {
      const mcpRaw = await this.host.fs.read(join(meta.dir, "mcp.json"));
      if (!mcpRaw) continue;
      try {
        const config = JSON.parse(mcpRaw) as PowerMcpConfig;
        for (const [key, server] of Object.entries(config.mcpServers || {})) {
          if (server.disabled) continue;
          // 用 "power:server" 命名空间避免冲突
          merged[`${meta.name}:${key}`] = server;
        }
      } catch { /* 忽略 */ }
    }
    return merged;
  }

  /**
   * 获取所有已启用 power 捆绑的 skill 目录列表（供 SkillRegistry 发现时追加扫描）。
   */
  async getActiveSkillDirs(): Promise<string[]> {
    const metas = await this.discover();
    const enabled = metas.filter((m) => m.enabled && m.skillCount > 0);
    const dirs: string[] = [];
    for (const meta of enabled) {
      const skillsDir = join(meta.dir, "skills");
      if (await isDir(this.host, skillsDir)) {
        dirs.push(skillsDir);
      }
    }
    return dirs;
  }

  /**
   * 生成注入主 agent 系统提示的 Power 清单（轻量层，供 AI 判断何时激活）。
   * 无已启用 Power 时返回 null。
   */
  async buildPowersPrompt(): Promise<string | null> {
    const metas = await this.discover();
    const enabled = metas.filter((m) => m.enabled);
    if (enabled.length === 0) return null;
    const lines = enabled.map((m) => {
      const parts: string[] = [];
      if (m.mcpServerCount > 0) parts.push(`${m.mcpServerCount} MCP`);
      if (m.skillCount > 0) parts.push(`${m.skillCount} Skills`);
      const badge = parts.length > 0 ? ` (${parts.join(", ")})` : "";
      const kw = m.keywords.length > 0 ? ` [关键词: ${m.keywords.join(", ")}]` : "";
      return `- ${m.displayName || m.name}${badge}：${m.description}${kw}`;
    });
    return (
      `你可以激活以下"能力包（Power）"来获取额外的工具和方法论。每个 Power 捆绑了一组 MCP 服务器和 Skills：\n` +
      `${lines.join("\n")}\n\n` +
      `⚡ 关键词触发纪律：在处理用户请求前，先扫一遍上面的 Power 关键词——\n` +
      `如果用户的请求明显匹配某个 Power 的关键词，你【应该】先 activate_power 激活它，\n` +
      `然后根据返回的文档和工具列表来完成任务。\n\n` +
      `使用方式：activate_power(name) → 获得 Power 文档 + 工具清单 → 按文档指引执行。\n` +
      `一个会话内同一个 Power 只需激活一次。`
    );
  }
}
