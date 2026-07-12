/**
 * Marketplace 业务服务层 - Skill/Power 远程源的管理 + 拉取 + 安装。
 *
 * 对齐项目分层规范：路由层只做请求解析与响应包装，业务逻辑收敛于此。
 * 安装动作复用已有的 SkillService.upload / PowerService.install，
 * 保证"从远程源安装"与"手动粘贴内容安装"走同一套落盘与重名校验逻辑。
 */

import { homedir } from "node:os";
import {
  MarketplaceRegistry,
  type MarketplaceSource,
  type MarketplaceItem,
} from "@axon/core";
import { createNodeAgentHost } from "@axon/host-node";
import { SkillService } from "../skills/skillService.js";
import { PowerService } from "../powers/powerService.js";

export class MarketplaceService {
  private registry = new MarketplaceRegistry(homedir(), createNodeAgentHost());
  private skillService = new SkillService();
  private powerService = new PowerService();

  /** 列出所有已配置的源 */
  async listSources(): Promise<MarketplaceSource[]> {
    return this.registry.listSources();
  }

  /** 新增一个源（可视化编辑入口） */
  async addSource(source: MarketplaceSource): Promise<void> {
    if (!source.name || !source.name.trim()) throw new Error("源名称必填");
    if (!source.url || !source.url.trim()) throw new Error("源 URL 必填");
    await this.registry.addSource(source);
  }

  /** 删除一个源 */
  async removeSource(name: string): Promise<void> {
    await this.registry.removeSource(name);
  }

  /** 读取原始 JSON 配置内容（"JSON 编辑"模式） */
  async readRawConfig(): Promise<string> {
    return this.registry.readRawConfig();
  }

  /** 覆盖写入原始 JSON 配置（"JSON 编辑"模式保存） */
  async writeRawConfig(content: string): Promise<void> {
    if (typeof content !== "string") throw new Error("content 必须是字符串");
    await this.registry.writeRawConfig(content);
  }

  /** 拉取指定源的可安装条目列表 */
  async fetchItems(sourceName: string): Promise<MarketplaceItem[]> {
    return this.registry.fetchItems(sourceName);
  }

  /**
   * 从远程源安装一个条目：下载原文 → 按 kind 分发到 SkillService.upload / PowerService.install。
   * workspace 传则装到项目级，否则装到全局（与手动安装的语义一致）。
   */
  async installItem(sourceName: string, itemPath: string, kind: "skill" | "power", workspace?: string): Promise<{ name: string; dir: string }> {
    const content = await this.registry.downloadItemContent(sourceName, itemPath);
    if (kind === "skill") {
      return this.skillService.upload(content, workspace);
    }
    return this.powerService.install(content, workspace);
  }
}
