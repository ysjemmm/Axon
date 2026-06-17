/**
 * Skill 加载器 - Anthropic Skills 风格的"能力包"发现与加载
 *
 * 渐进式披露（progressive disclosure）：
 * - 平时只把所有 skill 的 name + description 注入主 agent 上下文（省 token）
 * - 主 agent 判断匹配后，才由子 agent 加载完整 SKILL.md 正文和资源执行
 *
 * Skill 目录约定（两级，工作区级覆盖全局级同名 skill）：
 * - 全局：~/.axon/skills/<skill-name>/SKILL.md
 * - 工作区：<workspace>/.axon/skills/<skill-name>/SKILL.md
 *
 * SKILL.md 结构：YAML frontmatter（name + description）+ Markdown 正文。
 */

import { join } from "node:path";
import { BUILTIN_SKILLS, getBuiltinSkill } from "./builtinSkills.js";
import type { AgentHost } from "../host/index.js";

/** 一个已发现的 skill 的元信息（渐进式披露的"轻量层"） */
export interface SkillMeta {
  /** skill 唯一名称（取自 frontmatter.name，回退到目录名） */
  name: string;
  /** 触发描述：说明"什么时候该用我"，注入主 agent 上下文 */
  description: string;
  /** 可选：更具体的触发场景（frontmatter.when），用于自动触发判断，比 description 更聚焦 */
  when?: string;
  /** SKILL.md 文件绝对路径（builtin 来源为空串，正文从内存常量取） */
  skillFile: string;
  /** skill 目录绝对路径（scripts/references 等资源的基准；builtin 为空串） */
  dir: string;
  /** 来源：global（用户级）/ workspace（工作区级）/ builtin（Axon 内置方法论包） */
  source: "global" | "workspace" | "builtin";
  /** 是否被禁用（目录下存在 .disabled 文件） */
  disabled: boolean;
}

/** 加载后的完整 skill（含正文，注入子 agent 上下文的"重量层"） */
export interface LoadedSkill extends SkillMeta {
  /** SKILL.md 完整正文（不含 frontmatter） */
  body: string;
}

/** 全局 skill 根目录：~/.axon/skills */
export function globalSkillsDir(homeDir: string): string {
  return join(homeDir, ".axon", "skills");
}

/** 工作区 skill 根目录：<workspace>/.axon/skills */
export function workspaceSkillsDir(workspace: string): string {
  return join(workspace, ".axon", "skills");
}

/**
 * 解析 SKILL.md 的 frontmatter，提取 name、description、when。
 * 只支持简单的 `key: value` 单行字段（值可带引号），满足 Skills 规范即可。
 * 返回 { meta, body }，body 为去掉 frontmatter 后的正文。
 */
export function parseFrontmatter(raw: string): { name?: string; description?: string; when?: string; body: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { body: raw };

  const fmBlock = match[1];
  const body = raw.slice(match[0].length);
  const fields: Record<string, string> = {};

  for (const line of fmBlock.split("\n")) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    // 去掉成对的首尾引号
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[kv[1].toLowerCase()] = value;
  }

  return { name: fields.name, description: fields.description, when: fields.when, body };
}

/** 安全地判断路径是否为目录 */
async function isDir(host: AgentHost, p: string): Promise<boolean> {
  const st = await host.fs.stat(p);
  return st?.isDir ?? false;
}

/**
 * 扫描单个 skills 根目录下的所有 skill，返回元信息列表。
 * 每个子目录若含 SKILL.md 即视为一个 skill；无 frontmatter.name 时回退用目录名。
 */
async function scanSkillsDir(host: AgentHost, rootDir: string, source: SkillMeta["source"]): Promise<SkillMeta[]> {
  if (!(await isDir(host, rootDir))) return [];

  let entries: import("../host/index.js").DirChild[];
  try {
    entries = await host.fs.readdir(rootDir);
  } catch {
    return [];
  }

  const metas: SkillMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDir) continue;
    const dir = join(rootDir, entry.name);
    const skillFile = join(dir, "SKILL.md");
    const raw = await host.fs.read(skillFile);
    if (raw === null) continue; // 没有 SKILL.md，跳过
    const fm = parseFrontmatter(raw);
    // 检查是否被禁用（.disabled 标记文件存在即视为禁用）
    let disabled = false;
    if (await host.fs.stat(join(dir, ".disabled"))) {
      disabled = true;
    }
    metas.push({
      name: (fm.name || entry.name).trim(),
      description: (fm.description || "").trim(),
      when: fm.when?.trim() || undefined,
      skillFile,
      dir,
      source,
      disabled,
    });
  }
  return metas;
}

/**
 * Skill 注册表：聚合全局 + 工作区两级 skill，提供发现与加载能力。
 * 每次发现都实时扫描磁盘（skill 数量少，无需缓存，保证新增即生效）。
 */
export class SkillRegistry {
  constructor(private workspaces: string[], private host: AgentHost, private homeDir: string) {}

  /** 更新工作区列表（会话切换工作区组时调用） */
  setWorkspaces(workspaces: string[]): void {
    this.workspaces = workspaces;
  }

  /**
   * 发现所有可用 skill（仅元信息，用于渐进式披露）。
   * 优先级：builtin（最低）< global < workspace。同名后者覆盖前者。
   */
  async discover(): Promise<SkillMeta[]> {
    const globalMetas = await scanSkillsDir(this.host, globalSkillsDir(this.homeDir), "global");
    const wsMetasArrays = await Promise.all(
      this.workspaces.map((ws) => scanSkillsDir(this.host, workspaceSkillsDir(ws), "workspace")),
    );

    // 内置方法论包作为最低优先级基底
    const builtinMetas: SkillMeta[] = BUILTIN_SKILLS.map((s) => ({
      name: s.name,
      description: s.description,
      when: s.when,
      skillFile: "",
      dir: "",
      source: "builtin" as const,
      disabled: false,
    }));

    // 后写入的覆盖先写入的：builtin → 全局 → 工作区
    const byName = new Map<string, SkillMeta>();
    for (const m of builtinMetas) byName.set(m.name, m);
    for (const m of globalMetas) byName.set(m.name, m);
    for (const arr of wsMetasArrays) {
      for (const m of arr) byName.set(m.name, m);
    }
    return [...byName.values()];
  }

  /** 按名称加载完整 skill（含正文），找不到或已禁用返回 null。builtin 来源从内存常量取正文。 */
  async load(name: string): Promise<LoadedSkill | null> {
    const metas = await this.discover();
    const meta = metas.find((m) => m.name === name);
    if (!meta) return null;
    // 已禁用的 skill 不可加载（即便 AI 凭记忆调用 use_skill 也挡掉）
    if (meta.disabled) return null;
    // 内置方法论：正文来自内存常量
    if (meta.source === "builtin") {
      const builtin = getBuiltinSkill(name);
      if (!builtin) return null;
      return { ...meta, body: builtin.body };
    }
    const raw = await this.host.fs.read(meta.skillFile);
    if (raw === null) return null;
    const { body } = parseFrontmatter(raw);
    return { ...meta, body };
  }

  /**
   * 生成注入主 agent 系统提示的 skill 清单文本（渐进式披露的轻量层）。
   * 无 skill 时返回 null（不污染提示）。
   * 含 when（触发场景）的 skill 会标注触发时机，配合"动手前先扫 skill"纪律实现自动触发。
   */
  async buildSkillsPrompt(): Promise<string | null> {
    const metas = await this.discover();
    const enabled = metas.filter((m) => !m.disabled);
    if (enabled.length === 0) return null;
    const lines = enabled.map((m) => {
      const trigger = m.when ? `（触发场景：${m.when}）` : "";
      const tag = m.source === "builtin" ? "[内置] " : "";
      return `- ${tag}${m.name}：${m.description}${trigger}`;
    });
    return (
      `你可以调用以下"技能（skill）"来完成专门任务。每个 skill 封装了某类任务的完整执行步骤和方法论：\n` +
      `${lines.join("\n")}\n\n` +
      `⚠️ 自动触发纪律（重要）：在开始任何任务前，先扫一遍上面的 skill 清单——\n` +
      `如果当前任务命中了某个 skill 的【触发场景】，你【必须】先用 use_skill 加载它、按它的方法论执行，\n` +
      `而不是凭直觉自由发挥。这些方法论是经过验证的工程纪律（如调试、TDD、评审），能显著提升产出质量。\n` +
      `命中即用，不要跳过；确实不匹配再按常规方式做。\n\n` +
      `使用方式（两种，按任务选）：\n` +
      `1. use_skill(name)：把该技能的完整说明加载进【你自己】的上下文，由你直接按说明执行。` +
      `适合轻量、需要过程对用户可见、或你想边做边参考技能步骤的情况。\n` +
      `2. delegate_task(skill, prompt)：把任务连同技能交给【隔离的子 Agent】执行，你只拿回最终结论。` +
      `适合大型、独立、可压缩成摘要的任务。\n\n` +
      `上下文隔离：use_skill 的说明只进调用方自己的上下文——你用不会污染子 Agent，子 Agent 用也不会污染你。\n` +
      `注意：普通小问题（读个文件、答个概念）直接自己回答，不要为了用 skill 而用。`
    );
  }
}
