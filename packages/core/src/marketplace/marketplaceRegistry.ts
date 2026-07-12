/**
 * MarketplaceRegistry —— Skill/Power 远程源的配置读写 + 索引拉取 + 内容下载
 *
 * 职责单一：
 * - 管理 ~/.axon/settings/marketplaces.json（用户级，源列表增删改查）
 * - 按源拉取远程 index.json，解析出可安装的 skill/power 条目
 * - 下载指定条目的 SKILL.md / POWER.md 原文，交给上层 SkillService/PowerService 落盘
 *
 * 安全边界：
 * - 源 URL 与条目 path 拼接后的最终地址必须是 http/https，拒绝其他协议（file:// 等）防 SSRF
 * - 下载内容大小限制（防止远程返回超大文件拖垮内存/磁盘）
 * - 网络异常/解析失败均转换为清晰的 Error，不静默吞掉
 */

import { join } from "node:path";
import type { AgentHost } from "../host/index.js";
import type {
  MarketplaceSource,
  MarketplaceConfigFile,
  MarketplaceIndex,
  MarketplaceItem,
} from "./types.js";

/** 下载内容大小上限（字节），约 1MB，SKILL.md/POWER.md 是文本文件，远超此值基本是配置错误或异常响应 */
const MAX_CONTENT_BYTES = 1024 * 1024;
/** index.json 大小上限（字节），约 512KB，正常索引文件远小于此 */
const MAX_INDEX_BYTES = 512 * 1024;
/** 网络请求超时（ms） */
const FETCH_TIMEOUT_MS = 15_000;

/** 用户级 marketplace 配置路径：~/.axon/settings/marketplaces.json */
export function userMarketplaceConfigPath(homeDir: string): string {
  return join(homeDir, ".axon", "settings", "marketplaces.json");
}

/** 校验 URL 是否为合法的 http/https 地址，拒绝其他协议防 SSRF 到本地文件等 */
function assertHttpUrl(url: string, context: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${context}：不是合法的 URL："${url}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${context}：只允许 http/https 协议，收到："${parsed.protocol}"`);
  }
}

/** 把源根 URL 与相对路径安全拼接（避免 "../" 穿越到源域名之外的路径） */
function joinSourceUrl(baseUrl: string, relPath: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  const resolved = new URL(relPath.replace(/^\/+/, ""), base);
  // 穿越检测：解析后的 origin 必须与源一致，防止 relPath 里塞绝对 URL 跳到别的域名
  const baseOrigin = new URL(base).origin;
  if (resolved.origin !== baseOrigin) {
    throw new Error(`路径 "${relPath}" 解析后跳出了源域名（${resolved.origin} ≠ ${baseOrigin}），拒绝访问`);
  }
  return resolved.toString();
}

/** 带超时与大小限制的 fetch 文本下载 */
async function fetchTextLimited(url: string, maxBytes: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`请求失败：HTTP ${res.status} ${res.statusText}`);
    }
    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > maxBytes) {
      throw new Error(`响应内容过大（${contentLength} 字节），超过上限 ${maxBytes} 字节`);
    }
    const text = await res.text();
    if (text.length > maxBytes) {
      throw new Error(`响应内容过大（${text.length} 字节），超过上限 ${maxBytes} 字节`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export class MarketplaceRegistry {
  constructor(private homeDir: string, private host: AgentHost) {}

  private configPath(): string {
    return userMarketplaceConfigPath(this.homeDir);
  }

  /** 读取源列表（文件不存在/损坏返回空列表，不抛错） */
  async listSources(): Promise<MarketplaceSource[]> {
    const raw = await this.host.fs.read(this.configPath());
    if (!raw) return [];
    try {
      const cfg = JSON.parse(raw) as MarketplaceConfigFile;
      return cfg.sources || [];
    } catch {
      return [];
    }
  }

  /** 覆盖写入完整源列表（供可视化编辑与 JSON 直接编辑两种前端交互复用同一落盘方法） */
  async saveSources(sources: MarketplaceSource[]): Promise<void> {
    for (const s of sources) {
      if (!s.name || !s.name.trim()) throw new Error("源名称不能为空");
      assertHttpUrl(s.url, `源「${s.name}」的 URL`);
    }
    const names = new Set<string>();
    for (const s of sources) {
      if (names.has(s.name)) throw new Error(`源名称重复：${s.name}`);
      names.add(s.name);
    }
    const dir = join(this.homeDir, ".axon", "settings");
    await this.host.fs.mkdirp(dir);
    await this.host.fs.write(this.configPath(), JSON.stringify({ sources }, null, 2));
  }

  /** 新增一个源（重名校验），可视化编辑入口用 */
  async addSource(source: MarketplaceSource): Promise<void> {
    const sources = await this.listSources();
    if (sources.some((s) => s.name === source.name)) {
      throw new Error(`源「${source.name}」已存在`);
    }
    await this.saveSources([...sources, source]);
  }

  /** 删除一个源 */
  async removeSource(name: string): Promise<void> {
    const sources = await this.listSources();
    await this.saveSources(sources.filter((s) => s.name !== name));
  }

  /** 读取原始 JSON 文件内容（供前端"JSON 编辑"模式展示，文件不存在时返回空骨架） */
  async readRawConfig(): Promise<string> {
    const raw = await this.host.fs.read(this.configPath());
    if (raw) return raw;
    return JSON.stringify({ sources: [] }, null, 2);
  }

  /** 覆盖写入原始 JSON 文本（"JSON 编辑"模式的保存），写入前校验格式与内容合法性 */
  async writeRawConfig(content: string): Promise<void> {
    let parsed: MarketplaceConfigFile;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(`JSON 格式错误：${(err as Error).message}`);
    }
    await this.saveSources(parsed.sources || []);
  }

  /** 拉取指定源的 index.json，解析出可安装条目列表 */
  async fetchItems(sourceName: string): Promise<MarketplaceItem[]> {
    const sources = await this.listSources();
    const source = sources.find((s) => s.name === sourceName);
    if (!source) throw new Error(`源不存在：${sourceName}`);

    const indexUrl = joinSourceUrl(source.url, "index.json");
    assertHttpUrl(indexUrl, `源「${sourceName}」的 index.json 地址`);
    const raw = await fetchTextLimited(indexUrl, MAX_INDEX_BYTES);
    let index: MarketplaceIndex;
    try {
      index = JSON.parse(raw);
    } catch (err) {
      throw new Error(`源「${sourceName}」的 index.json 解析失败：${(err as Error).message}`);
    }

    const items: MarketplaceItem[] = [];
    for (const s of index.skills || []) {
      if (!s.name || !s.path) continue;
      items.push({ ...s, kind: "skill", sourceName });
    }
    for (const p of index.powers || []) {
      if (!p.name || !p.path) continue;
      items.push({ ...p, kind: "power", sourceName });
    }
    return items;
  }

  /** 下载指定源下某条目的原文内容（SKILL.md / POWER.md），交给上层落盘 */
  async downloadItemContent(sourceName: string, itemPath: string): Promise<string> {
    const sources = await this.listSources();
    const source = sources.find((s) => s.name === sourceName);
    if (!source) throw new Error(`源不存在：${sourceName}`);

    const fileUrl = joinSourceUrl(source.url, itemPath);
    assertHttpUrl(fileUrl, `条目文件地址`);
    return fetchTextLimited(fileUrl, MAX_CONTENT_BYTES);
  }
}
