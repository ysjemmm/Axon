import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

/**
 * 应用全局状态管理
 * 管理侧边栏折叠、主题、面包屑等 UI 状态
 */
export const useAppStore = defineStore('app', () => {
  // State
  const sidebarCollapsed = ref(false)
  const theme = ref<'light' | 'dark'>('light')
  const breadcrumbs = ref<{ title: string; path?: string }[]>([])
  const loading = ref(false)

  // Getters
  const isDarkMode = computed(() => theme.value === 'dark')
  const sidebarWidth = computed(() => (sidebarCollapsed.value ? 48 : 220))

  // Actions
  /** 切换侧边栏折叠状态 */
  function toggleSidebar() {
    sidebarCollapsed.value = !sidebarCollapsed.value
  }

  /** 切换主题 */
  function toggleTheme() {
    theme.value = theme.value === 'light' ? 'dark' : 'light'
    document.body.setAttribute('arco-theme', theme.value)
  }

  /** 设置面包屑 */
  function setBreadcrumbs(items: { title: string; path?: string }[]) {
    breadcrumbs.value = items
  }

  /** 设置全局加载状态 */
  function setLoading(status: boolean) {
    loading.value = status
  }

  return {
    sidebarCollapsed,
    theme,
    breadcrumbs,
    loading,
    isDarkMode,
    sidebarWidth,
    toggleSidebar,
    toggleTheme,
    setBreadcrumbs,
    setLoading,
  }
})
