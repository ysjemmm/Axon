/** 权限模式（与后端 core/session/permissionMode.ts 一致）：安全 ⊂ 自动 ⊂ 完全访问 */
export type PermissionMode = "safe" | "auto" | "full";

export function normalizePermissionMode(raw: unknown): PermissionMode {
  return raw === "auto" || raw === "full" ? raw : "safe";
}
