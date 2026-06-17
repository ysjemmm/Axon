import { computed } from 'vue'
import { useUserStore } from '@/store/user'

/**
 * 权限逻辑 composable
 * 封装权限检查、角色判断等功能
 */
export function usePermission() {
  const userStore = useUserStore()

  /** 当前用户是否是管理员 */
  const isAdmin = computed(() => userStore.isAdmin)

  /** 当前用户权限列表 */
  const permissions = computed(() => userStore.permissions)

  /**
   * 检查是否拥有指定权限
   * @param permission 权限标识
   */
  function hasPermission(permission: string): boolean {
    return userStore.hasPermission(permission)
  }

  /**
   * 检查是否拥有任一权限
   * @param permissionList 权限标识列表
   */
  function hasAnyPermission(permissionList: string[]): boolean {
    if (isAdmin.value) return true
    return permissionList.some((p) => permissions.value.includes(p))
  }

  /**
   * 检查是否拥有所有权限
   * @param permissionList 权限标识列表
   */
  function hasAllPermissions(permissionList: string[]): boolean {
    if (isAdmin.value) return true
    return permissionList.every((p) => permissions.value.includes(p))
  }

  /**
   * 检查当前用户是否为指定数据的负责人
   * @param ownerId 数据所有者 ID
   */
  function isOwner(ownerId: string): boolean {
    return userStore.userInfo?.id === ownerId
  }

  /**
   * 综合权限检查：状态 + 角色
   * @param validStatuses 有效状态列表
   * @param currentStatus 当前状态
   * @param ownerId 数据所有者（拥有者始终有权限）
   */
  function checkOperationPermission(
    validStatuses: number[],
    currentStatus: number,
    ownerId?: string
  ): boolean {
    const isValidStatus = validStatuses.includes(currentStatus)
    if (!isValidStatus) return false
    if (isAdmin.value) return true
    if (ownerId && isOwner(ownerId)) return true
    return false
  }

  return {
    isAdmin,
    permissions,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    isOwner,
    checkOperationPermission,
  }
}
