import { createPinia } from 'pinia'

/**
 * Pinia Store 创建与导出
 * 统一管理应用状态
 */

const pinia = createPinia()

export default pinia

// 重新导出各 Store 模块，方便外部引入
export { useUserStore } from './user'
export { useAppStore } from './app'
