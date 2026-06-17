import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { UserInfo } from '@/types/user'

/**
 * 用户状态管理
 * 管理当前登录用户信息、权限、Token 等
 */
export const useUserStore = defineStore('user', () => {
  // State
  const userInfo = ref<UserInfo | null>(null)
  const token = ref<string>(localStorage.getItem('access_token') || '')
  const permissions = ref<string[]>([])

  // Getters
  const isLoggedIn = computed(() => !!token.value)
  const userName = computed(() => userInfo.value?.name || '未登录')
  const userAvatar = computed(() => userInfo.value?.avatar || '')
  const isAdmin = computed(() => permissions.value.includes('admin'))

  // Actions
  /** 设置 Token */
  function setToken(newToken: string) {
    token.value = newToken
    localStorage.setItem('access_token', newToken)
  }

  /** 设置用户信息 */
  function setUserInfo(info: UserInfo) {
    userInfo.value = info
    permissions.value = info.permissions || []
  }

  /** 退出登录 */
  function logout() {
    token.value = ''
    userInfo.value = null
    permissions.value = []
    localStorage.removeItem('access_token')
  }

  /** 检查是否拥有指定权限 */
  function hasPermission(permission: string): boolean {
    if (isAdmin.value) return true
    return permissions.value.includes(permission)
  }

  return {
    userInfo,
    token,
    permissions,
    isLoggedIn,
    userName,
    userAvatar,
    isAdmin,
    setToken,
    setUserInfo,
    logout,
    hasPermission,
  }
})
