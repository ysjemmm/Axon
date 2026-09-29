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
import { getBuiltinPowersDir } from "../powers/powerLoader.js";
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
  /** 来源：global（用户级）/ workspace（工作区级）/ builtin（Axon 内置方法论）/ power（Power 能力包捆绑） */
  source: "global" | "workspace" | "builtin" | "power";
  /** 是否被禁用（目录下存在 .disabled 文件） */
  disabled: boolean;
}

/**
 * 该 skill 是否位于「内置 Power」的捆绑目录里。
 *
 * 内置 Power 位于产物包内（扩展的 media/powers 等），是只读目录：禁用要写 .disabled、
 * 编辑要写 SKILL.md，都会失败或升级后丢失。这类 skill 只能随整个能力包启停（在 Powers 面板），
 * 或放同名 skill 覆盖。调用方据此给出可操作的提示，而不是让用户撞上一个写文件错误。
 */
export function isBuiltinPowerBundledSkill(source: SkillMeta["source"], dir: string): boolean {
  if (source !== "power" || !dir) return false;
  const root = getBuiltinPowersDir();
  if (!root) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const d = norm(dir);
  const r = norm(root);
  return d === r || d.startsWith(`${r}/`);
}

/**
 * 判断一个 skill 能否被删除；不能则返回给用户看的原因。
 *
 * 为什么要有它：删除的实现在各形态里都是「rm 掉 skill 目录」，而下面两类 skill 根本没有
 * 属于自己的可删目录 —— rm 一个不存在的路径会因 force 静默成功，
 * 表现为「点了删除、提示成功、列表里还在」，用户只能反复点（"删不掉"的经典观感）。
 * 所以必须在动手之前显式拒绝，把静默失败变成一句能看懂、能照做的话。
 *
 * 抽成纯函数是为了三种形态（扩展 / webview / server）共用同一套判定与文案，且可单测。
 */
export function skillDeleteRejection(meta: { name: string; source: SkillMeta["source"]; dir: string }): string | null {
  if (meta.source === "builtin") {
    return `「${meta.name}」是 Axon 内置方法论（编译进产物、磁盘上没有目录），不能删除。` +
      `如需替换，可在工作区或全局创建一个同名 skill 覆盖它；如需关闭，请改用禁用。`;
  }
  if (meta.source === "power") {
    return isBuiltinPowerBundledSkill(meta.source, meta.dir)
      ? `「${meta.name}」来自内置能力包的捆绑（只读目录），不能删除。如需关闭，请在 Powers 面板禁用整个能力包。`
      : `「${meta.name}」属于某个能力包（Power），由该能力包管理，不能在这里单独删除。请在 Powers 面板中管理它的 Skills。`;
  }
  return null;
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
 * Skill 注册表：聚合内置方法论 + 全局 + Power 捆绑 + 工作区四级 skill，提供发现与加载能力。
 * 每次发现都实时扫描磁盘（skill 数量少，无需缓存，保证新增即生效）。
 */
/**
 * 内置 skill 的禁用名单：~/.axon/settings/builtin-skills.json
 *
 * 与内置 Power 的启用名单（builtin-powers.json）刻意相反——Power 默认关闭、存「启用名单」，
 * 内置 skill 默认开启、存「禁用名单」。差别来自两者的分量：Power 会带来 MCP 服务器与整包提示词，
 * 不用的用户不该被动承担；内置 skill 只是几段方法论，默认提供是合理的，只有想关掉个别几个时才需要记录。
 *
 * 为什么不能沿用 .disabled 标记文件：内置 skill 是编译进产物的 TS 常量，dir 为空串，
 * 根本没有目录可放标记；即便有，产物目录也应当只读。
 */
export function builtinSkillsConfigPath(homeDir: string): string {
  return join(homeDir, ".axon", "settings", "builtin-skills.json");
}

interface BuiltinSkillsConfig {
  disabled?: string[];
}

/** 读取内置 skill 禁用名单（文件缺失/损坏一律视为「一个都没禁用」） */
async function readDisabledBuiltin(host: AgentHost, homeDir: string): Promise<Set<string>> {
  const raw = await host.fs.read(builtinSkillsConfigPath(homeDir));
  if (!raw) return new Set();
  try {
    const cfg = JSON.parse(raw) as BuiltinSkillsConfig;
    return new Set((cfg.disabled || []).filter((n): n is string => typeof n === "string"));
  } catch {
    return new Set();
  }
}

/** 写入内置 skill 禁用状态（保留名单里的其它条目） */
async function writeBuiltinDisabled(host: AgentHost, homeDir: string, name: string, disabled: boolean): Promise<void> {
  const names = await readDisabledBuiltin(host, homeDir);
  if (disabled) names.add(name);
  else names.delete(name);
  await host.fs.mkdirp(join(homeDir, ".axon", "settings"));
  await host.fs.write(builtinSkillsConfigPath(homeDir), JSON.stringify({ disabled: [...names].sort() }, null, 2));
}

export class SkillRegistry {
  constructor(
    private workspaces: string[],
    private host: AgentHost,
    private homeDir: string,
    /**
     * Power 捆绑的 skill 目录提供者（只返回已启用的 Power）。
     *
     * 用回调而非数组：Power 的启用状态会在运行期变化（用户在面板里开关），
     * 每次 discover 都要取当时的最新值。回调也避免了 SkillRegistry 反向依赖 PowerRegistry。
     */
    private powerSkillDirs?: () => Promise<string[]>,
  ) {}

  /** 更新工作区列表（会话切换工作区组时调用） */
  setWorkspaces(workspaces: string[]): void {
    this.workspaces = workspaces;
  }

  /**
   * 启用/禁用某个 skill。
   * - 内置方法论：写用户级禁用名单（它是编译进产物的内存常量，没有磁盘目录可放标记）
   * - 其它：在自身目录写/删 .disabled 标记（沿用既有约定）
   *
   * ⚠️ 只读产物目录里的 skill（Power 捆绑于内置包、或内置包本身）由调用方先拦截，
   * 否则会写失败——那是"禁不掉"的另一种表现。
   */
  async setEnabled(meta: SkillMeta, disabled: boolean): Promise<void> {
    if (meta.source === "builtin") {
      await writeBuiltinDisabled(this.host, this.homeDir, meta.name, disabled);
      return;
    }
    const markerPath = join(meta.dir, ".disabled");
    if (disabled) {
      await this.host.fs.write(markerPath, "");
    } else {
      await this.host.fs.remove(markerPath).catch(() => {});
    }
  }

  /**
   * 发现所有可用 skill（仅元信息，用于渐进式披露）。
   * 优先级：builtin（最低）< global < power < workspace。同名后者覆盖前者。
   */
  async discover(): Promise<SkillMeta[]> {
    const globalMetas = await scanSkillsDir(this.host, globalSkillsDir(this.homeDir), "global");
    const wsMetasArrays = await Promise.all(
      this.workspaces.map((ws) => scanSkillsDir(this.host, workspaceSkillsDir(ws), "workspace")),
    );
    // Power 捆绑的 skills：只有用户启用过的能力包才会返回目录。
    // 取不到（回调缺失/抛错）时静默退化为空——技能发现不该因为 Power 出问题而整体失败。
    const powerDirs = this.powerSkillDirs ? await this.powerSkillDirs().catch(() => []) : [];
    const powerMetasArrays = await Promise.all(
      powerDirs.map((d) => scanSkillsDir(this.host, d, "power")),
    );

    // 内置方法论包作为最低优先级基底。
    // 启用状态不写产物（内存常量、无磁盘目录），改读用户级禁用名单——默认全开。
    const builtinDisabled = await readDisabledBuiltin(this.host, this.homeDir);
    const builtinMetas: SkillMeta[] = BUILTIN_SKILLS.map((s) => ({
      name: s.name,
      description: s.description,
      when: s.when,
      skillFile: "",
      dir: "",
      source: "builtin" as const,
      disabled: builtinDisabled.has(s.name),
    }));

    // 后写入的覆盖先写入的：builtin → 全局 → Power → 工作区
    // Power 排在全局之后：它是用户显式启用的能力包，应能覆盖同名的方法论/全局 skill；
    // 但排在项目级之前——当前项目里放的 skill 才是这个项目最贴切的做法。
    const byName = new Map<string, SkillMeta>();
    for (const m of builtinMetas) byName.set(m.name, m);
    for (const m of globalMetas) byName.set(m.name, m);
    for (const arr of powerMetasArrays) {
      for (const m of arr) byName.set(m.name, m);
    }
    for (const arr of wsMetasArrays) {
      for (const m of arr) byName.set(m.name, m);
    }
    // 自定义 Agent 作为最低优先级（可被同名 skill 覆盖）
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
      const tag = m.source === "builtin" ? "[内置] " : m.source === "power" ? "[Power] " : "";
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
