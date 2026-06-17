/**
 * Power 业务服务层 - Power 能力扩展包的 CRUD 与生命周期管理。
 *
 * 对齐项目分层规范：路由层只做请求解析与响应包装，业务逻辑收敛于此。
 */

import { writeFile, rm, mkdir } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import { homedir } from "node:os";
import { PowerRegistry, globalPowersDir, workspacePowersDir, type PowerMeta, type LoadedPower } from "@axon/core";
import { createNodeAgentHost } from "@axon/host-node";

/** 列表项视图（给前端展示用） */
export interface PowerListItem {
  name: string;
  displayName: string;
  description: string;
  keywords: string[];
  source: PowerMeta["source"];
  dir: string;
  enabled: boolean;
  mcpServerCount: number;
  skillCount: number;
  hasSteering: boolean;
}

export class PowerService {
  /** 列出所有已发现的 power（全局 + 工作区两级） */
  async list(workspace?: string): Promise<PowerListItem[]> {
    const registry = new PowerRegistry(workspace ? [workspace] : [], createNodeAgentHost(), homedir());
    const metas = await registry.discover();
    return metas.map((m) => ({
      name: m.name,
      displayName: m.displayName,
      description: m.description,
      keywords: m.keywords,
      source: m.source,
      dir: m.dir,
      enabled: m.enabled,
      mcpServerCount: m.mcpServerCount,
      skillCount: m.skillCount,
      hasSteering: m.hasSteering,
    }));
  }

  /** 获取完整 power 信息（含文档正文、MCP 配置、steering 列表） */
  async get(name: string, workspace?: string): Promise<LoadedPower | null> {
    const registry = new PowerRegistry(workspace ? [workspace] : [], createNodeAgentHost(), homedir());
    return registry.load(name);
  }

  /** 启用/禁用 power（创建/删除 .disabled 标记文件） */
  async toggle(name: string, enabled: boolean, workspace?: string): Promise<void> {
    const registry = new PowerRegistry(workspace ? [workspace] : [], createNodeAgentHost(), homedir());
    const metas = await registry.discover();
    const meta = metas.find((m) => m.name === name);
    if (!meta) throw new Error(`power 不存在: ${name}`);
    const markerPath = pathJoin(meta.dir, ".disabled");
    if (!enabled) {
      await writeFile(markerPath, "", "utf-8");
    } else {
      await rm(markerPath, { force: true });
    }
  }

  /** 读取 power 的 steering 文件内容 */
  async readSteering(name: string, steeringFile: string, workspace?: string): Promise<string | null> {
    const registry = new PowerRegistry(workspace ? [workspace] : [], createNodeAgentHost(), homedir());
    return registry.readSteering(name, steeringFile);
  }

  /**
   * 安装 power（从 POWER.md 内容创建目录结构）。
   * 传 workspace 则装到项目级，否则装到全局。
   */
  async install(content: string, workspace?: string): Promise<{ name: string; dir: string }> {
    if (!content || typeof content !== "string") {
      throw new Error("content（POWER.md 文件内容）必填");
    }
    const { parsePowerFrontmatter } = await import("@axon/core");
    const { name } = parsePowerFrontmatter(content);
    if (!name) {
      throw new Error("POWER.md 缺少 frontmatter 中的 name 字段");
    }
    // 重名校验：检查是否已存在同名 Power
    const registry = new PowerRegistry(workspace ? [workspace] : [], createNodeAgentHost(), homedir());
    const existing = await registry.discover();
    if (existing.some((m) => m.name === name)) {
      throw new Error(`Power「${name}」已存在，不能重复创建。如需更新请先删除旧版本`);
    }
    const baseDir = workspace ? workspacePowersDir(workspace) : globalPowersDir(homedir());
    const powerDir = pathJoin(baseDir, name);
    await mkdir(powerDir, { recursive: true });
    await writeFile(pathJoin(powerDir, "POWER.md"), content, "utf-8");
    return { name, dir: powerDir };
  }

  /** 删除整个 power 目录 */
  async remove(name: string, workspace?: string): Promise<void> {
    const registry = new PowerRegistry(workspace ? [workspace] : [], createNodeAgentHost(), homedir());
    const metas = await registry.discover();
    const meta = metas.find((m) => m.name === name);
    if (!meta) throw new Error(`power 不存在: ${name}`);
    await rm(meta.dir, { recursive: true, force: true });
  }

  /** 保存 power 的 MCP 配置 */
  async saveMcpConfig(name: string, config: object, workspace?: string): Promise<void> {
    const registry = new PowerRegistry(workspace ? [workspace] : [], createNodeAgentHost(), homedir());
    const metas = await registry.discover();
    const meta = metas.find((m) => m.name === name);
    if (!meta) throw new Error(`power 不存在: ${name}`);
    const mcpPath = pathJoin(meta.dir, "mcp.json");
    await writeFile(mcpPath, JSON.stringify(config, null, 2), "utf-8");
  }

  /** 在 Power 内添加一个 Skill（创建 skills/<skillName>/SKILL.md） */
  async addSkill(powerName: string, skillName: string, description?: string, workspace?: string): Promise<{ dir: string }> {
    if (!skillName || !skillName.trim()) throw new Error("skill 名称必填");
    const registry = new PowerRegistry(workspace ? [workspace] : [], createNodeAgentHost(), homedir());
    const metas = await registry.discover();
    const meta = metas.find((m) => m.name === powerName);
    if (!meta) throw new Error(`power 不存在: ${powerName}`);
    const slug = skillName.trim().toLowerCase().replace(/\s+/g, "-");
    const skillDir = pathJoin(meta.dir, "skills", slug);
    // 重名校验：检查 Power 内是否已存在同名 skill
    const { stat } = await import("node:fs/promises");
    try {
      const st = await stat(skillDir);
      if (st.isDirectory()) throw new Error(`Skill「${slug}」已存在于 Power「${powerName}」中，不能重复添加`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      // ENOENT 表示不存在，可以继续创建
    }
    await mkdir(skillDir, { recursive: true });
    const desc = description || `Power ${powerName} 提供的 ${slug} 能力`;
    const template = `---\nname: ${slug}\ndescription: ${desc}\n---\n\n# ${slug}\n\n## 执行步骤\n\n1. 待补充\n`;
    await writeFile(pathJoin(skillDir, "SKILL.md"), template, "utf-8");
    return { dir: skillDir };
  }

  /** 从 Power 内删除一个 Skill */
  async removeSkill(powerName: string, skillName: string, workspace?: string): Promise<void> {
    const registry = new PowerRegistry(workspace ? [workspace] : [], createNodeAgentHost(), homedir());
    const metas = await registry.discover();
    const meta = metas.find((m) => m.name === powerName);
    if (!meta) throw new Error(`power 不存在: ${powerName}`);
    const skillDir = pathJoin(meta.dir, "skills", skillName);
    await rm(skillDir, { recursive: true, force: true });
  }

  /** 覆盖写入 Power 内某个 Skill 的 SKILL.md 内容 */
  async saveSkillContent(powerName: string, skillName: string, content: string, workspace?: string): Promise<void> {
    const registry = new PowerRegistry(workspace ? [workspace] : [], createNodeAgentHost(), homedir());
    const metas = await registry.discover();
    const meta = metas.find((m) => m.name === powerName);
    if (!meta) throw new Error(`power 不存在: ${powerName}`);
    const skillDir = pathJoin(meta.dir, "skills", skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(pathJoin(skillDir, "SKILL.md"), content, "utf-8");
  }

  /** 添加 MCP 服务器到 Power 的 mcp.json（追加/覆盖单个 server） */
  async addMcpServer(powerName: string, serverName: string, server: { command: string; args?: string[] }, workspace?: string): Promise<void> {
    const registry = new PowerRegistry(workspace ? [workspace] : [], createNodeAgentHost(), homedir());
    const metas = await registry.discover();
    const meta = metas.find((m) => m.name === powerName);
    if (!meta) throw new Error(`power 不存在: ${powerName}`);
    const mcpPath = pathJoin(meta.dir, "mcp.json");
    let config: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
    try {
      const raw = await import("node:fs/promises").then((fs) => fs.readFile(mcpPath, "utf-8"));
      config = JSON.parse(raw);
    } catch { /* 文件不存在或解析失败，用空配置 */ }
    // 重名校验
    if (config.mcpServers[serverName]) {
      throw new Error(`MCP 服务器「${serverName}」已存在于 Power「${powerName}」中，不能重复添加`);
    }
    config.mcpServers[serverName] = server;
    await writeFile(mcpPath, JSON.stringify(config, null, 2), "utf-8");
  }

  /** 从 Power 中移除一个 MCP 服务器 */
  async removeMcpServer(powerName: string, serverName: string, workspace?: string): Promise<void> {
    const registry = new PowerRegistry(workspace ? [workspace] : [], createNodeAgentHost(), homedir());
    const metas = await registry.discover();
    const meta = metas.find((m) => m.name === powerName);
    if (!meta) throw new Error(`power 不存在: ${powerName}`);
    const mcpPath = pathJoin(meta.dir, "mcp.json");
    let config: { mcpServers: Record<string, unknown> } = { mcpServers: {} };
    try {
      const raw = await import("node:fs/promises").then((fs) => fs.readFile(mcpPath, "utf-8"));
      config = JSON.parse(raw);
    } catch { return; }
    delete config.mcpServers[serverName];
    await writeFile(mcpPath, JSON.stringify(config, null, 2), "utf-8");
  }
}
