import { join } from "node:path";
import type { LoadedSkill } from "./skillLoader.js";
import type { AgentHost } from "../host/index.js";

/**
 * 自定义 Agent 加载器
 *
 * 从 workspace/.axon/agents/ 加载用户自定义的 Agent（JSON 格式），
 * 伪装成 LoadedSkill，复用现有 delegate_task + SubAgentRunner 基建。
 *
 * Agent JSON 格式：
 * {
 *   "name": "code-reviewer",
 *   "description": "代码审查专家，关注安全、性能、可读性",
 *   "systemPrompt": "你是资深代码审查专家...",
 *   "skills": [],       // 可选，限制可用 Skill（空=全部可用）
 *   "mcpServers": [],   // 可选，限制可用 MCP 服务器（空=全部可用）
 *   "powers": []        // 可选，限制可用 Power（空=全部可用）
 * }
 */

export interface CustomAgent {
  name: string;
  description: string;
  systemPrompt: string;
  skills?: string[];
  mcpServers?: string[];
  powers?: string[];
}

/** 自定义 Agent 目录名常量 */
const AGENTS_DIR = ".axon/agents";

/** 从工作区加载所有自定义 Agent 的元信息（用于列表展示和渐进式披露） */
export async function listCustomAgents(
  workspace: string,
  host: AgentHost,
): Promise<LoadedSkill[]> {
  const agentsDir = join(workspace, AGENTS_DIR);
  let entries;
  try {
    entries = await host.fs.readdir(agentsDir);
  } catch {
    return [];
  }

  const results: LoadedSkill[] = [];
  for (const entry of entries) {
    if (entry.isDir || !entry.name.endsWith(".json")) continue;
    const filePath = join(agentsDir, entry.name);
    try {
      const raw = await host.fs.read(filePath);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as CustomAgent;
      const name = parsed.name || entry.name.replace(".json", "");
      results.push({
        name,
        description: parsed.description || "",
        body: parsed.systemPrompt || parsed.description || "",
        skillFile: filePath,
        dir: agentsDir,
        source: "workspace",
        disabled: false,
      } as LoadedSkill);
    } catch {
      // 跳过损坏的 JSON 文件
    }
  }
  return results;
}

/** 加载指定名称的自定义 Agent，构造为 LoadedSkill 供 SubAgentRunner 使用 */
export async function loadCustomAgent(
  workspace: string,
  name: string,
  host: AgentHost,
): Promise<LoadedSkill | null> {
  const filePath = join(workspace, AGENTS_DIR, `${name}.json`);
  try {
    const raw = await host.fs.read(filePath);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CustomAgent;
    return {
      name: parsed.name || name,
      description: parsed.description || "",
      body: parsed.systemPrompt || parsed.description || "",
      skillFile: filePath,
      dir: join(workspace, AGENTS_DIR),
      source: "workspace",
      disabled: false,
    } as LoadedSkill;
  } catch {
    return null;
  }
}
