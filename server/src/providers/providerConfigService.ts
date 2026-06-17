/**
 * Provider 配置服务（Service 层）—— 读写 .axon/settings/providers.json（用户级 / 工作区级）
 *
 * 路径约定与 core 的 ProviderRegistry 完全一致：
 *   · 用户级：  ~/.axon/settings/providers.json
 *   · 工作区级：<workspace>/.axon/settings/providers.json
 *
 * 只负责文件 CRUD；解析合并（内置目录 + 自定义 + env）与运行时注入交给 core 的 ProviderRegistry。
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { RESERVED_PROVIDER_NAMES, type ProviderConfigFile, type ProviderModel, type RawProviderEntry } from "@axon/core";

export type ProviderLevel = "user" | "workspace";

const EMPTY: ProviderConfigFile = { providers: {}, builtinApiKeys: {} };

export class ProviderConfigService {
  /** 解析某 level 的 providers.json 绝对路径 */
  private configPath(level: ProviderLevel, workspace?: string): string {
    if (level === "workspace") {
      if (!workspace) throw new Error("工作区级配置需要 workspace 参数");
      return join(workspace, ".axon", "settings", "providers.json");
    }
    return join(homedir(), ".axon", "settings", "providers.json");
  }

  /** 读取某 level 的配置（文件不存在/损坏返回空配置，不抛） */
  async read(level: ProviderLevel, workspace?: string): Promise<ProviderConfigFile> {
    try {
      const raw = await fs.readFile(this.configPath(level, workspace), "utf8");
      const parsed = JSON.parse(raw) as ProviderConfigFile;
      return { providers: parsed.providers || {}, builtinApiKeys: parsed.builtinApiKeys || {} };
    } catch {
      return { providers: {}, builtinApiKeys: {} };
    }
  }

  /** 一次读取用户级 + 工作区级（供管理 UI 拉取，供编辑原始配置） */
  async readAll(workspace?: string): Promise<{ user: ProviderConfigFile; workspace: ProviderConfigFile }> {
    return {
      user: await this.read("user"),
      workspace: workspace ? await this.read("workspace", workspace) : EMPTY,
    };
  }

  /** 覆盖写入某 level 的完整配置（自动建目录，校验结构） */
  async write(level: ProviderLevel, config: ProviderConfigFile, workspace?: string): Promise<void> {
    if (!config || typeof config !== "object") {
      throw new Error("配置非法：必须是对象");
    }
    const normalized: ProviderConfigFile = {
      providers: config.providers || {},
      builtinApiKeys: config.builtinApiKeys || {},
    };
    const path = this.configPath(level, workspace);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify(normalized, null, 2), "utf8");
  }

  /** 新增/覆盖一个自定义 provider（保留名不可占用） */
  async addProvider(level: ProviderLevel, name: string, entry: RawProviderEntry, workspace?: string): Promise<void> {
    const key = name.trim();
    if (!key) throw new Error("provider 名称不能为空");
    if (RESERVED_PROVIDER_NAMES.includes(key)) throw new Error(`「${key}」是内置 provider 的保留名，不能自定义`);
    if (!entry.baseUrl?.trim()) throw new Error("baseUrl 必填");
    const config = await this.read(level, workspace);
    config.providers = config.providers || {};
    config.providers[key] = entry;
    await this.write(level, config, workspace);
  }

  /** 删除一个自定义 provider */
  async removeProvider(level: ProviderLevel, name: string, workspace?: string): Promise<void> {
    const config = await this.read(level, workspace);
    if (!config.providers || !(name in config.providers)) throw new Error(`provider 不存在：${name}`);
    delete config.providers[name];
    await this.write(level, config, workspace);
  }

  /** 设置内置 provider（esign / zhipu）的 apiKey 覆盖（esign 仅此项可改） */
  async setBuiltinKey(level: ProviderLevel, name: string, apiKey: string, workspace?: string): Promise<void> {
    if (!RESERVED_PROVIDER_NAMES.includes(name)) throw new Error(`「${name}」不是内置 provider`);
    const config = await this.read(level, workspace);
    config.builtinApiKeys = config.builtinApiKeys || {};
    if (apiKey.trim()) config.builtinApiKeys[name] = apiKey.trim();
    else delete config.builtinApiKeys[name];
    await this.write(level, config, workspace);
  }

  /**
   * 覆盖某自定义 provider 的模型数组（add/edit/delete/disable 都由前端在数组上算好后整存）。
   * 只动 models，apiKey / baseUrl 等其它字段原样保留；内置 provider 不允许改模型。
   */
  async setCustomProviderModels(level: ProviderLevel, name: string, models: ProviderModel[], workspace?: string): Promise<void> {
    if (RESERVED_PROVIDER_NAMES.includes(name)) throw new Error(`「${name}」是内置 provider，模型不可修改`);
    const config = await this.read(level, workspace);
    const entry = config.providers?.[name];
    if (!entry) throw new Error(`provider 不存在：${name}`);
    entry.models = Array.isArray(models) ? models : [];
    await this.write(level, config, workspace);
  }
}
