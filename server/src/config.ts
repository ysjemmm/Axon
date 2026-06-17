/**
 * 全局配置管理 - 工作区组等用户级配置
 *
 * 存储位置：~/.axon/config.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/** 工作区组 */
export interface WorkspaceGroup {
  id: string;        // 唯一标识（UUID 或短 slug）
  name: string;      // 展示名称
  paths: string[];   // 组内工作区路径列表
}

/** 全局配置结构 */
export interface AxonConfig {
  workspaceGroups: WorkspaceGroup[];
}

const CONFIG_PATH = join(homedir(), ".axon", "config.json");

const DEFAULT_CONFIG: AxonConfig = {
  workspaceGroups: [],
};

/** 读取配置文件 */
export async function loadConfig(): Promise<AxonConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** 保存配置文件 */
export async function saveConfig(config: AxonConfig): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}
