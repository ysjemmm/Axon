/**
 * artifactDir —— Chat 产物目录的解析规则（纯函数，无副作用）
 *
 * 产物 = AI 在对话里交付给用户的独立成品（HTML 页面、SVG、报告、脚本等），
 * 区别于「改项目源码」的普通文件编辑。它们统一落到一个目录里，便于集中管理与预览。
 *
 * 解析顺序：
 *   1. 用户在 + 菜单里设置了目录 → 用用户的（相对路径按工作区解析）
 *   2. 没设置 → 默认 ~/.axon/artifacts/<会话id>/
 *
 * 为什么默认放用户目录而不是工作区：产物是交付物，混进项目源码会污染 git、
 * 也会被构建/lint 误扫。为什么按会话分子目录：不同会话里同名产物（report.html）互不覆盖。
 *
 * 拿不到可靠位置时返回空串（没有 homeDir 或会话 id 尚未建立），由调用方据此判定
 * 「无法落盘」并报错，而不是悄悄写到进程工作目录。
 */

import { isAbsolute, resolve } from "node:path";

export interface ArtifactDirInput {
  /** 用户设置的目录；空串/未设置表示用默认位置 */
  configured: string;
  /** 工作区根，用于解析相对路径 */
  cwd: string;
  /** 用户主目录（~） */
  homeDir: string;
  /** 会话 id，默认位置按它分子目录 */
  sessionId: string;
}

export function resolveArtifactDir(input: ArtifactDirInput): string {
  const configured = (input.configured || "").trim();
  if (configured) {
    return isAbsolute(configured) ? resolve(configured) : resolve(input.cwd, configured);
  }
  if (!input.homeDir || !input.sessionId) return "";
  return resolve(input.homeDir, ".axon", "artifacts", input.sessionId);
}
