/**
 * Skill 文件操作 - 为 Skill 文件管理器提供目录树构建与安全的增删改查
 *
 * 安全约束（核心）：
 * - 所有文件操作必须严格限制在对应 skill 目录内（防路径穿越）
 * - 校验请求的相对 path 不含 ".." 片段、不为绝对路径
 * - 最终绝对路径必须落在 skill 目录边界内，否则拒绝
 *
 * 设计：定位 skill 目录复用 SkillRegistry.discover()（全局 + 工作区两级，
 * 工作区级覆盖全局级），保证与列表/加载逻辑一致。
 */

import { readFile, writeFile, readdir, rm, mkdir, stat, access } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { SkillRegistry } from "@axon/core";
import { createNodeAgentHost } from "@axon/host-node";

/** 目录树节点（path 为相对 skill 目录的 POSIX 风格相对路径） */
export interface FileTreeNode {
  /** 文件/目录名 */
  name: string;
  /** 相对 skill 目录的路径，使用 "/" 分隔（前端展示与回传用） */
  path: string;
  /** 节点类型 */
  type: "file" | "directory";
  /** 子节点（仅 directory 有） */
  children?: FileTreeNode[];
}

/** 单个目录扫描时跳过的噪音条目 */
const IGNORED_ENTRIES = new Set([".git", ".DS_Store", "node_modules", "__pycache__"]);

/**
 * 按名称定位 skill 目录绝对路径，找不到返回 null。
 * @param name skill 名称
 * @param workspace 可选工作区路径（用于发现工作区级 skill）
 */
export async function resolveSkillDir(name: string, workspace?: string): Promise<string | null> {
  const registry = new SkillRegistry(workspace ? [workspace] : [], createNodeAgentHost(), homedir());
  const metas = await registry.discover();
  const meta = metas.find((m) => m.name === name);
  return meta ? meta.dir : null;
}

/**
 * 把请求的相对 path 安全地解析为绝对路径。
 * 任何越界、绝对路径、含 ".." 的输入都会抛错（Fail-Fast）。
 */
export function safeResolve(skillDir: string, relPath: string): string {
  if (typeof relPath !== "string" || relPath.trim() === "") {
    throw new Error("path 必填");
  }
  // 统一分隔符后检查穿越片段
  const segments = relPath.replace(/\\/g, "/").split("/");
  if (segments.some((seg) => seg === "..")) {
    throw new Error("path 不允许包含 .. 片段");
  }
  if (path.isAbsolute(relPath)) {
    throw new Error("path 不允许为绝对路径");
  }
  const base = path.resolve(skillDir);
  const full = path.resolve(base, relPath);
  // 最终边界校验：必须等于 base 或位于 base 之下
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error("path 超出 skill 目录范围");
  }
  return full;
}

/** 递归构建目录树（目录在前、文件在后，各自按名称排序） */
async function buildTree(absDir: string, relDir: string): Promise<FileTreeNode[]> {
  const entries = await readdir(absDir, { withFileTypes: true });
  const nodes: FileTreeNode[] = [];
  for (const entry of entries) {
    if (IGNORED_ENTRIES.has(entry.name)) continue;
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: relPath,
        type: "directory",
        children: await buildTree(path.join(absDir, entry.name), relPath),
      });
    } else if (entry.isFile()) {
      nodes.push({ name: entry.name, path: relPath, type: "file" });
    }
  }
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

/** 返回 skill 目录的完整文件树 */
export async function getSkillTree(skillDir: string): Promise<FileTreeNode[]> {
  return buildTree(skillDir, "");
}

/** 读取 skill 目录下指定文件内容（UTF-8） */
export async function readSkillFile(skillDir: string, relPath: string): Promise<string> {
  const full = safeResolve(skillDir, relPath);
  const info = await stat(full);
  if (!info.isFile()) {
    throw new Error("目标不是文件");
  }
  return readFile(full, "utf-8");
}

/** 写入/更新 skill 目录下指定文件（自动创建父目录，UTF-8） */
export async function writeSkillFile(skillDir: string, relPath: string, content: string): Promise<void> {
  const full = safeResolve(skillDir, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content ?? "", "utf-8");
}

/** 判断路径是否已存在 */
async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 新建文件或目录（path 以 "/" 结尾视为目录）。
 * 已存在则抛错（Fail-Fast），避免误覆盖。
 */
export async function createSkillEntry(skillDir: string, relPath: string, content: string): Promise<void> {
  const isDirEntry = relPath.endsWith("/") || relPath.endsWith("\\");
  const cleaned = isDirEntry ? relPath.replace(/[/\\]+$/, "") : relPath;
  const full = safeResolve(skillDir, cleaned);
  if (await exists(full)) {
    throw new Error("目标已存在");
  }
  if (isDirEntry) {
    await mkdir(full, { recursive: true });
    return;
  }
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content ?? "", "utf-8");
}

/** 删除 skill 目录下指定文件或目录（不允许删除 skill 根目录） */
export async function deleteSkillEntry(skillDir: string, relPath: string): Promise<void> {
  const full = safeResolve(skillDir, relPath);
  if (full === path.resolve(skillDir)) {
    throw new Error("不允许删除 skill 根目录");
  }
  await rm(full, { recursive: true, force: true });
}
