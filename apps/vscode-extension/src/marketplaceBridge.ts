/**
 * Marketplace 源配置 ↔ VS Code 设置的桥接层。
 *
 * 源配置属于扩展设置（Settings → Axon），不该挤在 Skills 视图的溢出菜单里。
 * 但真正的落盘位置仍是 `~/.axon/settings/marketplaces.json` —— core 的 MarketplaceRegistry
 * 读写它，server / webview 形态共用同一份。所以这里做惰性同步，避免出现两个真相源：
 *
 *  - 读：设置里被显式写过就以设置为准（写回文件）；没写过就以文件为准，
 *        这样从面板里增删源的老用户不会被一个空默认值抹掉配置。
 *  - 写：面板增删源后把最新列表回写设置，保证设置页看到的就是实际生效的源。
 *
 * 判断「显式写过」必须用 inspect() 而不是 get()：get() 在未设置时返回默认的 [],
 * 与用户手动清空无法区分，会把面板里的配置误判成「已被清空」。
 */

import * as vscode from "vscode";
import { homedir } from "node:os";
import { MarketplaceRegistry, type MarketplaceSource } from "@axon/core";
import { createVSCodeAgentHost } from "@axon/host-vscode";

const SECTION = "axon";
const KEY = "marketplace.sources";

/** 设置里的源列表是否被用户显式写过（默认空数组不算） */
function hasExplicitSources(): boolean {
  const info = vscode.workspace.getConfiguration(SECTION).inspect<MarketplaceSource[]>(KEY);
  if (!info) return false;
  return [info.globalValue, info.workspaceValue, info.workspaceFolderValue].some((v) => Array.isArray(v));
}

/**
 * 读取设置里的源列表；未显式配置返回 null（表示「以文件为准」）。
 * 顺手过滤掉残缺条目，避免一条格式错误的配置让整个源列表不可用。
 */
export function readSourcesFromSettings(): MarketplaceSource[] | null {
  if (!hasExplicitSources()) return null;
  const value = vscode.workspace.getConfiguration(SECTION).get<MarketplaceSource[]>(KEY, []);
  if (!Array.isArray(value)) return null;
  return value
    .filter((s): s is MarketplaceSource => !!s && typeof s.name === "string" && typeof s.url === "string")
    .map((s) => ({
      name: s.name.trim(),
      url: s.url.trim(),
      description: typeof s.description === "string" && s.description.trim() ? s.description.trim() : undefined,
    }))
    .filter((s) => s.name && s.url);
}

/**
 * 把源列表写回设置（用户级）。
 * 写失败只记日志不抛错——设置写不进去不该阻断安装 / 浏览流程。
 */
export async function persistSourcesToSettings(sources: MarketplaceSource[]): Promise<void> {
  try {
    await vscode.workspace.getConfiguration(SECTION).update(KEY, sources, vscode.ConfigurationTarget.Global);
  } catch (err) {
    console.warn(`[marketplace] 回写设置失败：${(err as Error).message}`);
  }
}

/**
 * 统一构造 MarketplaceRegistry，并完成「设置 → 文件」同步。
 *
 * 所有调用点（REST 路由与命令）都走这里，同步逻辑只存在一份。
 * 设置里的条目校验不过时（URL 非 http/https、重名等）退回文件里的旧列表，
 * 不让一条配错的源把整个功能封死。
 */
export async function createMarketplaceRegistry(): Promise<MarketplaceRegistry> {
  const registry = new MarketplaceRegistry(homedir(), createVSCodeAgentHost());
  const fromSettings = readSourcesFromSettings();
  if (fromSettings) {
    try {
      // 内容一致就不重复写盘：这条路径会被每次 GET /api/marketplaces 走到，
      // 无脑 saveSources 会让「只是刷新一下源列表」也产生一次文件写入。
      const current = await registry.listSources();
      const fingerprint = (list: MarketplaceSource[]) =>
        JSON.stringify([...list].sort((a, b) => a.name.localeCompare(b.name)));
      if (fingerprint(current) !== fingerprint(fromSettings)) {
        await registry.saveSources(fromSettings);
      }
    } catch (err) {
      console.warn(`[marketplace] 设置中的源列表未通过校验，已忽略：${(err as Error).message}`);
    }
  }
  return registry;
}
