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
import { RESERVED_PROVIDER_NAMES, assertUniqueModelIds, providerEnvKeys, stripProviderEnvLines, normalizePricing, validateQuotaRule, type ProviderConfigFile, type ProviderModel, type ProviderQuotaConfig, type RawProviderEntry } from "@axon/core";

export type ProviderLevel = "user" | "workspace";

const EMPTY: ProviderConfigFile = { providers: {}, builtinApiKeys: {}, builtinBaseUrls: {} };

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
      // 其余字段（builtinModels / builtinQuota / visionFallbackModel 等）原样带上，写回时才不会丢
      return { ...parsed, providers: parsed.providers || {}, builtinApiKeys: parsed.builtinApiKeys || {}, builtinBaseUrls: parsed.builtinBaseUrls || {} };
    } catch {
      return { providers: {}, builtinApiKeys: {}, builtinBaseUrls: {} };
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
      ...config,
      providers: config.providers || {},
      builtinApiKeys: config.builtinApiKeys || {},
      builtinBaseUrls: config.builtinBaseUrls || {},
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
    assertUniqueModelIds(entry.models, key);
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

  /**
   * 移除「纯环境变量来源」的 provider。
   *
   * 为什么必须单独一条：provider 有三个来源（内置 / providers.json / 纯环境变量），
   * 面板把三类混在一起展示；env 来源的根本不在 providers.json 里，
   * 走 removeProvider 只会报「provider 不存在」——这正是"删不掉、重启又回来"的原因。
   * 要真正移除它，必须改它的真实来源。
   *
   * 候选文件两处：用户共享的 ~/.axon/.env（与 IDE 形态同一份），
   * 以及服务端启动时 dotenv 读的 <cwd>/.env。逐行摘除，注释与排版原样保留。
   */
  async removeEnvProvider(name: string): Promise<{ removed: string[]; files: string[] }> {
    const key = name.trim();
    if (!key) throw new Error("provider 名称不能为空");
    const candidates = [join(homedir(), ".axon", ".env"), join(process.cwd(), ".env")];
    const removed: string[] = [];
    const files: string[] = [];
    for (const file of candidates) {
      let text: string;
      try {
        text = await fs.readFile(file, "utf8");
      } catch {
        continue; // 该文件不存在，跳过
      }
      const hit = stripProviderEnvLines(text, key);
      if (hit.removed.length === 0) continue;
      await fs.mkdir(dirname(file), { recursive: true });
      await fs.writeFile(file, hit.text, "utf8");
      removed.push(...hit.removed);
      files.push(file);
    }
    // 同步清掉进程内 env：core 每次 resolve 都读 process.env，
    // 删掉后当前进程立即不再解析出它（否则要等下次重启读 .env 才生效）。
    for (const k of providerEnvKeys(key)) delete process.env[k];
    return { removed, files };
  }

  /** 在用户级 / 工作区级之间迁移一个自定义 provider（迁移后源层级删除） */
  async moveProvider(fromLevel: ProviderLevel, toLevel: ProviderLevel, name: string, workspace?: string): Promise<void> {
    if (fromLevel === toLevel) throw new Error("源层级与目标层级相同，无需迁移");
    if (RESERVED_PROVIDER_NAMES.includes(name)) throw new Error(`「${name}」是内置 provider，不能迁移`);

    const fromConfig = await this.read(fromLevel, workspace);
    const entry = fromConfig.providers?.[name];
    if (!entry) throw new Error(`provider 不存在：${name}`);

    const toConfig = await this.read(toLevel, workspace);
    toConfig.providers = toConfig.providers || {};
    toConfig.providers[name] = entry;

    delete fromConfig.providers?.[name];

    await this.write(toLevel, toConfig, workspace);
    await this.write(fromLevel, fromConfig, workspace);
  }

  /** 设置内置 provider 的 API Key 覆盖 */
  async setBuiltinKey(level: ProviderLevel, name: string, apiKey: string, workspace?: string): Promise<void> {
    if (!RESERVED_PROVIDER_NAMES.includes(name)) throw new Error(`「${name}」不是内置 provider`);
    const config = await this.read(level, workspace);
    config.builtinApiKeys = config.builtinApiKeys || {};
    if (apiKey.trim()) config.builtinApiKeys[name] = apiKey.trim();
    else delete config.builtinApiKeys[name];
    await this.write(level, config, workspace);
  }

  /** 设置 / 删除用量查询规则（内置 provider 存 builtinQuota，与 API Key 分开） */
  async setQuota(level: ProviderLevel, name: string, quota: ProviderQuotaConfig | null, workspace?: string): Promise<void> {
    if (quota) validateQuotaRule(quota);
    const config = await this.read(level, workspace);
    if (RESERVED_PROVIDER_NAMES.includes(name)) {
      config.builtinQuota = config.builtinQuota || {};
      if (quota) config.builtinQuota[name] = quota;
      else delete config.builtinQuota[name];
    } else {
      const entry = config.providers?.[name];
      if (!entry) throw new Error(`provider 不存在：${name}`);
      if (quota) entry.quota = quota;
      else delete entry.quota;
    }
    await this.write(level, config, workspace);
  }

  /** 设置 / 删除计费单价（只用于回复底部的花费估算；官方 provider 用 Credits，不支持） */
  async setPricing(level: ProviderLevel, name: string, raw: unknown, workspace?: string): Promise<void> {
    if (RESERVED_PROVIDER_NAMES.includes(name)) throw new Error("官方 Provider 按 Credits 计费，不支持自定义单价");
    const pricing = normalizePricing(raw);
    const config = await this.read(level, workspace);
    const entry = config.providers?.[name];
    if (!entry) throw new Error(`provider 不存在：${name}`);
    if (pricing) entry.pricing = pricing;
    else delete entry.pricing;
    await this.write(level, config, workspace);
  }

  /**
   * 覆盖某自定义 provider 的模型数组（add/edit/delete/disable 都由前端在数组上算好后整存）。
   * 只动 models，apiKey / baseUrl 等其它字段原样保留；内置 provider 不允许改模型。
   * 同一 provider 内 model id 必须唯一：发现重复直接抛错，不静默去重（避免用户以为加成功了）。
   */
  async setCustomProviderModels(level: ProviderLevel, name: string, models: ProviderModel[], workspace?: string): Promise<void> {
    if (RESERVED_PROVIDER_NAMES.includes(name)) throw new Error(`「${name}」是内置 provider，模型不可修改`);
    assertUniqueModelIds(models, name);
    const config = await this.read(level, workspace);
    const entry = config.providers?.[name];
    if (!entry) throw new Error(`provider 不存在：${name}`);
    entry.models = Array.isArray(models) ? models : [];
    await this.write(level, config, workspace);
  }
}
