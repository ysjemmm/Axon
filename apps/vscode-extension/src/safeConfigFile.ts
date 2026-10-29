/**
 * 配置文件的安全读写（providers.json 这类写着 API Key 的文件）。
 *
 * · 读：文件不存在 → 返回 null（正常的「还没配置」）；存在但不是合法 JSON → 抛错。
 *   早先两种情况都当成「空配置」返回，下一次保存就会拿这个空配置整个覆盖回去 ——
 *   一次写到一半的损坏，就把用户配好的所有 Provider 和 Key 全部清空。
 * · 写：先写同目录的临时文件再改名（同一文件系统内改名是原子的，不会出现写了一半的文件）；
 *   文件权限 0600、目录 0700，只有本人可读（Windows 上权限位不生效，但原子写仍然有效）。
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJsonConfig<T>(path: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`配置文件 ${path} 不是合法的 JSON，已停止写入以免覆盖原有配置。请先修复或删除这个文件。`);
  }
}

export async function writeJsonConfig(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => { /* Windows 等不支持权限位 */ });
}

/** webview 请求打开的外部链接是否安全：只允许 http(s) 与 mailto */
export function isSafeExternalUrl(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url.trim());
}
