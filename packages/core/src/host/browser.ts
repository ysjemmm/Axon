/**
 * 目录浏览抽象（执行端 ① 的一部分）
 *
 * 直接复用现有 fsBrowser.ts 的 DirectoryBrowser 契约（接口稳定、已被前端目录选择器依赖）。
 * - NodeAgentHost：NodeDirectoryBrowser（列盘符 / 列子目录）
 * - VSCodeAgentHost：可基于 workspace.workspaceFolders + workspace.fs 实现，
 *   或在进程内形态下沿用 Node 实现（扩展宿主也是 Node 环境）。
 */

import type { DirEntry } from "./fs.js";

/** 目录浏览结果（与现有 fsBrowser.BrowseResult 对齐） */
export interface BrowseResult {
  /** 当前所在路径（盘符根列表时为空字符串） */
  current: string;
  /** 上级目录路径（已在盘符列表层时为 null） */
  parent: string | null;
  /** 是否为盘符根列表（Windows 顶层） */
  isRoot: boolean;
  /** 子目录列表 */
  entries: DirEntry[];
}

/** 浏览能力契约 */
export interface DirectoryBrowser {
  browse(path?: string): Promise<BrowseResult>;
  isValidDir(path: string): Promise<boolean>;
}
