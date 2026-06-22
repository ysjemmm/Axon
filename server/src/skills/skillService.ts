/**
 * Skill 业务服务层 - 把原先散落在 index.ts 路由回调里的 skill 业务逻辑收敛到此处。
 *
 * 对齐项目分层规范（Controller → Service）：路由层只做请求解析与响应包装，
 * 所有业务（发现、启用/禁用、生成、安装、文件 CRUD）都在 Service 层，
 * 每个方法职责单一、便于复用与测试。
 *
 * 约定：Service 方法抛出 Error 表示业务失败，由路由层统一转成 4xx/5xx 响应。
 */

import { writeFile, rm, mkdir } from "node:fs/promises";
import { join as pathJoin } from "node:path";
import { homedir } from "node:os";
import OpenAI from "openai";
import { globalSkillsDir, parseFrontmatter, SkillRegistry, ZHIPU_PROVIDER, type SkillMeta } from "@axon/core";
import { createNodeAgentHost } from "@axon/host-node";
import {
  resolveSkillDir,
  getSkillTree,
  readSkillFile,
  writeSkillFile,
  createSkillEntry,
  deleteSkillEntry,
  type FileTreeNode,
} from "./skillFiles.js";

/** 列表项视图（裁掉内部字段，只给前端需要的） */
export interface SkillListItem {
  name: string;
  description: string;
  source: SkillMeta["source"];
  dir: string;
  disabled: boolean;
}

/** SKILL.md 生成用的系统提示（从 index.ts 内联字符串提炼为常量，便于维护） */
const SKILL_GENERATOR_SYSTEM_PROMPT = `你是一个 Skill 生成器。根据用户的需求描述，生成一个完整的 SKILL.md 文件内容。

SKILL.md 格式要求：
1. 以 YAML frontmatter 开头，包含 name（英文短横线命名）、description（中文，描述这个 skill 是做什么的）、when（中文，描述应该在什么场景自动触发它，用于自动匹配）
2. 正文用 Markdown 编写，包含：
   - "这个 Skill 负责什么"：列出应该/不应该触发的场景
   - "执行步骤"：详细的分步指令
   - "输出重点"：结果的关键字段说明
   - "失败处理"：异常情况的处理方式
   - "关键坑点"：容易出错的注意事项

直接输出 SKILL.md 的完整内容，不要加任何解释或代码围栏。`;

export class SkillService {
  /** 列出所有已发现的 skill（全局 + 工作区两级） */
  async list(workspace?: string): Promise<SkillListItem[]> {
    const registry = new SkillRegistry(workspace ? [workspace] : [], createNodeAgentHost(), homedir());
    const metas = await registry.discover();
    return metas.map((m) => ({
      name: m.name,
      description: m.description,
      source: m.source,
      dir: m.dir,
      disabled: m.disabled,
    }));
  }

  /** 启用/禁用 skill（创建/删除 .disabled 标记文件）。skill 不存在时抛错。 */
  async toggle(name: string, disabled: boolean): Promise<void> {
    const registry = new SkillRegistry([], createNodeAgentHost(), homedir());
    const metas = await registry.discover();
    const meta = metas.find((m) => m.name === name);
    if (!meta) throw new Error(`skill 不存在: ${name}`);
    if (meta.source === "builtin") {
      throw new Error(`"${name}" 是 Axon 内置方法论，不能禁用。如需替换，可在工作区或全局放一个同名 skill 覆盖它。`);
    }
    const markerPath = pathJoin(meta.dir, ".disabled");
    if (disabled) {
      await writeFile(markerPath, "", "utf-8");
    } else {
      await rm(markerPath, { force: true });
    }
  }

  /**
   * 用 LLM 生成 SKILL.md 内容（Skill Creator），走智谱免费模型。
   */
  async generate(prompt: string): Promise<string> {
    if (!prompt || typeof prompt !== "string") {
      throw new Error("prompt（skill 需求描述）必填");
    }
    const providerName = ZHIPU_PROVIDER;
    const modelName = "glm-4-flash";
    const apiKey = process.env[`PROVIDER_${providerName.toUpperCase()}_API_KEY`];
    const baseURL = process.env[`PROVIDER_${providerName.toUpperCase()}_BASE_URL`];
    if (!apiKey) {
      throw new Error(`未配置 provider "${providerName}" 的 API Key`);
    }
    const client = new OpenAI({ apiKey, baseURL });
    const completion = await client.chat.completions.create({
      model: modelName,
      temperature: 0.3,
      messages: [
        { role: "system", content: SKILL_GENERATOR_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    });
    return completion.choices[0]?.message?.content || "";
  }

  /**
   * 上传 SKILL.md 安装一个 skill。
   * 传 workspace 则装到项目级（<workspace>/.axon/skills），否则装到全局。
   * @returns 安装后的 skill 名称与目录
   */
  async upload(content: string, workspace?: string): Promise<{ name: string; dir: string }> {
    if (!content || typeof content !== "string") {
      throw new Error("content（SKILL.md 文件内容）必填");
    }
    const { name } = parseFrontmatter(content);
    if (!name) {
      throw new Error("SKILL.md 缺少 frontmatter 中的 name 字段");
    }
    const baseDir = workspace ? pathJoin(workspace, ".axon", "skills") : globalSkillsDir(homedir());
    const skillDir = pathJoin(baseDir, name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(pathJoin(skillDir, "SKILL.md"), content, "utf-8");
    return { name, dir: skillDir };
  }

  /** 返回某个 skill 目录的完整文件树。skill 不存在时抛错。 */
  async tree(name: string, workspace?: string): Promise<{ dir: string; tree: FileTreeNode[] }> {
    const skillDir = await this.requireSkillDir(name, workspace);
    return { dir: skillDir, tree: await getSkillTree(skillDir) };
  }

  /** 读取 skill 目录下指定文件内容 */
  async readFile(name: string, relPath: string, workspace?: string): Promise<string> {
    const skillDir = await this.requireSkillDir(name, workspace);
    return readSkillFile(skillDir, relPath);
  }

  /** 写入/更新 skill 目录下指定文件 */
  async writeFile(name: string, relPath: string, content: string, workspace?: string): Promise<void> {
    const skillDir = await this.requireSkillDir(name, workspace);
    await writeSkillFile(skillDir, relPath, content);
  }

  /** 新建 skill 目录下的文件或目录（relPath 以 "/" 结尾视为目录） */
  async createEntry(name: string, relPath: string, content: string, workspace?: string): Promise<void> {
    const skillDir = await this.requireSkillDir(name, workspace);
    await createSkillEntry(skillDir, relPath, content ?? "");
  }

  /** 删除 skill 目录下指定文件或目录 */
  async deleteEntry(name: string, relPath: string, workspace?: string): Promise<void> {
    const skillDir = await this.requireSkillDir(name, workspace);
    await deleteSkillEntry(skillDir, relPath);
  }

  /** 删除整个全局 skill 目录 */
  async deleteSkill(name: string): Promise<void> {
    const skillDir = pathJoin(globalSkillsDir(homedir()), name);
    await rm(skillDir, { recursive: true, force: true });
  }

  /** 定位 skill 目录，找不到统一抛错（供需要目录的方法复用） */
  private async requireSkillDir(name: string, workspace?: string): Promise<string> {
    // 内置方法论无磁盘目录，不支持文件级操作
    const registry = new SkillRegistry(workspace ? [workspace] : [], createNodeAgentHost(), homedir());
    const meta = (await registry.discover()).find((m) => m.name === name);
    if (meta?.source === "builtin") {
      throw new Error(`"${name}" 是 Axon 内置方法论，没有可编辑的文件。如需定制，请新建一个同名 skill 覆盖它。`);
    }
    const skillDir = await resolveSkillDir(name, workspace);
    if (!skillDir) throw new Error(`skill 不存在: ${name}`);
    return skillDir;
  }
}
